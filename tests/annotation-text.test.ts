import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  foldAnnotationText,
  foldAnnotationRuns,
  LINE_BREAKING_CHARS,
} from '../scripts/annotation-text.ts';
import {
  formatAnnotation,
  formatFoundRow,
  findNonEnglishLines,
} from '../scripts/check-pr-non-english-text.ts';
import { fencedQuote } from '../scripts/check-gh-body-english.ts';

/**
 * The Actions runner reads WORKFLOW COMMANDS out of a step's own output: it
 * splits the stream into lines, trims each, and treats one beginning `::` as a
 * command. Both English-only checks echo attacker-controlled text back -- a PR
 * or issue body, or a line of a fork PR's file content -- into a message.
 *
 * Each echoed line is PREFIXED, so the payload never starts at column 0 and
 * cannot be a command. That holds only while the payload cannot forge a LINE
 * BREAK. If it can, everything after the break is a fresh line the runner parses
 * on its own terms, and `::stop-commands::` / `::add-mask::` / `::error::`
 * become injectable.
 *
 * Ported from the sibling repo cdkd, minus the cases whose subject is a checker
 * this repo does not have.
 */

// Built from CODE POINTS, never written as string literals. Two reasons, and
// the second was measured on this file: a literal U+2028 is a byte no reviewer
// can see in a diff, in the one test whose subject is exactly that; and
// `vp fmt` REWRITES a `'\u2028'` escape into the literal character, so the
// escape spelling does not survive a format pass. `String.fromCharCode` does.
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NEL = String.fromCharCode(0x85);
const VT = String.fromCharCode(0x0b);
const FF = String.fromCharCode(0x0c);
const NUL = String.fromCharCode(0x00);
const TAB = String.fromCharCode(0x09);

describe('foldAnnotationText', () => {
  it.each([
    ['CR', CR],
    ['LF', LF],
    ['U+2028 line separator', LS],
    ['U+2029 paragraph separator', PS],
    ['U+0085 next line', NEL],
    ['vertical tab', VT],
    ['form feed', FF],
  ])('folds %s', (_label, ch) => {
    expect(foldAnnotationText(`a${ch}b`)).toBe('a b');
  });

  it('folds every occurrence, not just the first', () => {
    expect(foldAnnotationText(`a${CR}b${LF}c`)).toBe('a b c');
  });

  it('folds to a SPACE rather than deleting', () => {
    // A CR between two words becoming nothing silently changes the text a human
    // is being shown, and the point of the annotation is to quote the offending
    // line accurately.
    expect(foldAnnotationText(`one${CR}two`)).toBe('one two');
  });

  it('folds correctly even when the shared regex carries state', () => {
    // `LINE_BREAKING_CHARS` is a module-level /g regex, so `lastIndex` persists
    // across `.test()` calls. `String.replace` resets it, but a future caller
    // reaching for `.test()` would not -- prove the fold itself is unaffected by
    // a dirty lastIndex.
    LINE_BREAKING_CHARS.lastIndex = 5;
    expect(foldAnnotationText(`a${LF}b`)).toBe('a b');
    LINE_BREAKING_CHARS.lastIndex = 0;
  });

  it('leaves C0 bytes that cannot break a line alone', () => {
    // A checker whose job is to REPORT what it found must not quietly rewrite
    // the finding beyond the one property it needs.
    expect(foldAnnotationText(`a${NUL}b`)).toBe(`a${NUL}b`);
    expect(foldAnnotationText(`a${TAB}b`)).toBe(`a${TAB}b`);
  });
});

describe('foldAnnotationRuns', () => {
  it('collapses a RUN of breaks to exactly one space', () => {
    expect(foldAnnotationRuns(`a${CR}${LF}b`)).toBe('a b');
  });

  it('leaves runs it did NOT create alone', () => {
    // The obvious alternative -- fold each character, then `.replace(/ +/g, ' ')`
    // -- also collapses runs the fold never created, silently re-indenting code
    // inside a whitespace-preserving fence.
    expect(foldAnnotationRuns('    const x = 1;  // a')).toBe('    const x = 1;  // a');
  });
});

describe('no echo in either checker can emit a forged workflow command', () => {
  // The question is never "does this output begin with `::`" -- `formatAnnotation`
  // deliberately does. It is whether the PAYLOAD can add a SECOND line, since
  // everything after a break is a fresh line the runner parses on its own terms.
  // So the property is: one emitted row is one line. The split models the
  // runner's own splitter, which breaks on CR and on LF -- a `/\r?\n/` split
  // would miss a LONE CR, the shape that matters.
  const forgesLine = (text: string) => text.split(/[\r\n]/).length > 1;

  it('the control: an unfolded string DOES forge a second line starting a command', () => {
    const raw = `x${CR}::stop-commands::y`;
    expect(forgesLine(raw)).toBe(true);
    expect(
      raw
        .split(/[\r\n]/)[1]!
        .trimStart()
        .startsWith('::')
    ).toBe(true);
  });

  it('check-pr-non-english-text: a CR in the file LINE stays on one row', () => {
    const offender = { file: 'src/foo.ts', line: 1, text: `x${CR}::stop-commands::y` };
    expect(forgesLine(formatAnnotation(offender))).toBe(false);
    expect(forgesLine(formatFoundRow(offender))).toBe(false);
  });

  it('check-pr-non-english-text: a CR in the FILE PATH stays on one row', () => {
    // The path has no construction-time twin -- `findNonEnglishLines` folds the
    // TEXT at construction, but the file name arrives straight from
    // `git diff --name-only`, so each emitter has to fold it itself.
    const offender = { file: `src/a${CR}::stop-commands::x`, line: 1, text: 'ascii' };
    expect(forgesLine(formatAnnotation(offender))).toBe(false);
    expect(forgesLine(formatFoundRow(offender))).toBe(false);
  });

  it('findNonEnglishLines folds at CONSTRUCTION, so every future echo is safe', () => {
    const jp = String.fromCodePoint(0x3042);
    const hit = findNonEnglishLines(`${jp}${LS}::stop-commands::x`)[0];
    expect(hit).toBeDefined();
    expect(hit!.text).not.toContain(LS);
  });

  it('the `Found:` row carries a NON-WHITESPACE prefix, not only an indent', () => {
    // The runner TRIM-STARTS each line before deciding whether it is a command,
    // so a whitespace-only indent protects nothing -- and `git diff --name-only`
    // never quotes `:`, `,`, `=` or a space, so a fork PR can add a file
    // literally NAMED `::error file=src/index.ts,line=1::x` and forge a command
    // with no control character at all. Only a non-whitespace prefix helps.
    const row = formatFoundRow({ file: '::error file=x,line=1::y', line: 1, text: 'ascii' });
    expect(row.trimStart().startsWith('- ')).toBe(true);
  });

  it('check-gh-body-english: fencedQuote folds a multi-line payload to one line', () => {
    expect(fencedQuote(`a${LF}b${LF}c`).split('\n')).toHaveLength(3);
  });

  it('check-gh-body-english: the fence is longer than the longest backtick run', () => {
    const quoted = fencedQuote('a ```` b');
    const fence = quoted.split('\n')[0]!;
    expect(fence.length).toBeGreaterThan(4);
    expect(/^`+$/.test(fence)).toBe(true);
  });
});

describe('the rule reaches every emitter in this family', () => {
  it('every script that writes a `::` annotation imports the shared fold', () => {
    // Derived from the directory, not listed: a new checker written with its own
    // private answer is exactly how the three cdkd copies drifted apart before
    // the fold was shared.
    const dir = join(import.meta.dirname, '..', 'scripts');
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f === 'annotation-text.ts') continue;
      const src = readFileSync(join(dir, f), 'utf8');
      if (!/['"`]::(error|warning|notice)/.test(src)) continue;
      if (!src.includes("from './annotation-text.ts'")) offenders.push(f);
    }
    expect(
      offenders,
      `these scripts emit a workflow-command annotation without importing the shared ` +
        `fold from scripts/annotation-text.ts: ${offenders.join(', ')}`
    ).toEqual([]);
  });
});
