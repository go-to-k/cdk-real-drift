import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// Byte budget for `.claude/skills/<name>/SKILL.md` — guarding the failure mode
// where a file that is loaded WHOLE into an agent's context accretes narrative
// PR-by-PR with no size feedback anywhere.
//
// A SKILL.md is injected in full the moment its skill is invoked, so its byte
// size is a fixed token toll paid at every invocation, re-paid on every context
// compaction. MEASURED on 2026-08-28, immediately before the split this fence
// guards: `work-issues/SKILL.md` was 123,168 B and `hunt-bugs/SKILL.md` was
// 107,327 B (~40k tokens each — a third of a context window spent before the
// run's first action), each grown by its own fold-back loop: every run appended
// lessons to the file every future run must load. The remedy was progressive
// disclosure — a thin SKILL.md orchestrator plus per-stage `references/*.md`
// files read only when the run enters that stage (mirrors the same split in the
// sibling repo, go-to-k/cdkd) — and this fence is what keeps the orchestrators
// from growing back.
//
// Three mechanical properties are fenced; content-worth stays a human call:
//
//   1. no SKILL.md may exceed MAX_SKILL_MD_BYTES;
//   2. a SPLIT skill (one with a `references/` dir) keeps its SKILL.md a thin
//      orchestrator, under MAX_ORCHESTRATOR_BYTES — the fold-back loop's
//      natural target is the file that is always loaded, so that file gets the
//      tight cap while stage files get a looser one;
//   3. no single reference file may exceed MAX_REFERENCE_FILE_BYTES — a stage
//      file is still loaded whole at stage entry, so unbounded growth there
//      re-creates the original problem one hop away.
//
// Plus a per-split-skill deletion floor: the split promised to MOVE content,
// not drop it, and every other assertion here is a one-sided upper bound — so
// without the floor, "reduce payload" by deleting the stage files outright
// would read as an improvement.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.join(ROOT, '.claude', 'skills');

const MAX_SKILL_MD_BYTES = 36_000; // largest non-split skill measured 12,175 B (verify-pr)
const MAX_ORCHESTRATOR_BYTES = 12_000; // orchestrators measured 7,952 B / 6,932 B at the split
const MAX_REFERENCE_FILE_BYTES = 64_000; // largest stage file measured 55,137 B (hunt-bugs gotchas.md); 41,922 B after the rule+citation compression pass (2026-08-28)

// The split skills' stage files must still exist and still carry the moved
// content. Floors sit far enough below the at-split measurement that narrative
// COMPRESSION stays legal while wholesale deletion fails.
// Calibration (probed, not guessed): a byte floor should sit ABOVE the corpus
// minus its LARGEST stage file, or deleting that one file — the likeliest
// wholesale drop — stays green (measured: hunt-bugs at a 50,000 B floor
// survived deleting its 55,137 B gotchas.md). `skill-doc-paths.test.ts` does
// not catch it either: its citation extractor only resolves spans whose first
// segment is a repo-root directory, and `references/...` is skill-relative
// (measured, not assumed). Beyond the floors, the pointer-integrity block below
// is what catches a single deleted stage file: every `references/<stage>.md`
// the orchestrator names must exist.
//
// Re-measured 2026-08-31. work-issues: corpus 109,106 B, largest implement.md
// 22,600 B, so the property needs a floor above 109,106 - 22,600 = 86,506 --
// which the 60,000 held here had stopped providing as the stage files grew.
// 89,000 restored it: strictly TIGHTER, and no upper bound was touched. The
// older note declined such a floor for work-issues because it leaves little
// compression room, and that is still the trade (~20 KB of room below the
// floor); the call is reversed to match the sibling cdk-local (88,000 on a
// 113,468 B corpus) because a floor that cannot catch the likeliest wholesale
// drop is not a weaker guard but a SILENT one. A genuine compression pass
// re-derives the floor downward in the same commit -- that stays legal; what
// the floor stops is a deletion with no re-derivation at all.
// Re-derived again 2026-08-31 (review round 2, after the LANE_TREE capture):
// corpus 111,362 B, largest implement.md 23,436 B, so the floor must exceed
// 111,362 - 23,436 = 87,926. 89,000 still HELD -- by 1,074 B, and is raised to
// 90,000 anyway, because the MARGIN is what decays: cdk-local was left at 759 B
// of it one day and had lapsed the next. 90,000 leaves 2,074 B of margin and
// ~21 KB of compression room below the floor.
// hunt-bugs stays at 60,000: 88,426 - 41,922 = 46,504 < 60,000, so its property
// still holds. Re-measure both numbers for each skill whenever a stage file
// changes size materially -- the property is silent when it lapses.
const SPLIT_SKILLS: Record<string, { minFiles: number; minCorpusBytes: number }> = {
  // 8 files / 125,139 B measured at the split (2026-08-28); largest 26,621 B; 94,136 B post-compression
  'work-issues': { minFiles: 6, minCorpusBytes: 90_000 },
  // 7 files / 108,940 B measured at the split (2026-08-28); largest 55,137 B; 87,180 B post-compression
  'hunt-bugs': { minFiles: 5, minCorpusBytes: 60_000 },
};

function skillNames(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')))
    .sort();
}

function referenceFiles(name: string): string[] {
  const dir = path.join(SKILLS_DIR, name, 'references');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f));
}

describe('skill file payload budget', () => {
  const names = skillNames();

  it('actually sees the skills (the scan is not vacuous)', () => {
    // 6 skills at the time of writing; a scan that stopped matching would
    // otherwise report "0 files over budget" as green.
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names).toContain('work-issues');
    expect(names).toContain('hunt-bugs');
  });

  for (const name of names) {
    const skillMd = path.join(SKILLS_DIR, name, 'SKILL.md');
    const isSplit = referenceFiles(name).length > 0;
    const cap = isSplit ? MAX_ORCHESTRATOR_BYTES : MAX_SKILL_MD_BYTES;

    it(`${name}/SKILL.md stays under ${cap} B`, () => {
      const size = statSync(skillMd).size;
      expect(
        size,
        `.claude/skills/${name}/SKILL.md is ${size} B, over the ${cap} B cap. ` +
          (isSplit
            ? `This skill is SPLIT: its SKILL.md is a thin orchestrator and lessons ` +
              `belong in the references/<stage>.md file where they fire — not here.`
            : `Split it: move per-stage detail into references/*.md files read at ` +
              `stage entry (see work-issues for the shape), or trim narrative into ` +
              `the file it belongs to. Every byte here is loaded on every ` +
              `invocation of the skill.`)
      ).toBeLessThanOrEqual(cap);
    });
  }

  for (const name of names) {
    for (const ref of referenceFiles(name)) {
      it(`${name}/references/${path.basename(ref)} stays under ${MAX_REFERENCE_FILE_BYTES} B`, () => {
        const size = statSync(ref).size;
        expect(
          size,
          `${ref} is ${size} B, over the ${MAX_REFERENCE_FILE_BYTES} B cap. A stage file ` +
            `is loaded whole at stage entry, so it carries a cap too — compress the ` +
            `narrative (rule + one-line incident citation) or split the stage at a ` +
            `\`###\` boundary.`
        ).toBeLessThanOrEqual(MAX_REFERENCE_FILE_BYTES);
      });
    }
  }

  for (const [name, floors] of Object.entries(SPLIT_SKILLS)) {
    it(`${name}/SKILL.md's stage pointers all resolve (no stranded stage)`, () => {
      const text = readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
      const pointed = [
        ...new Set([...text.matchAll(/references\/[A-Za-z0-9_.-]+\.md/g)].map((m) => m[0])),
      ];
      // The orchestrator must actually point into the stage files — a table
      // rewritten to drop the pointers would otherwise make this block vacuous.
      expect(pointed.length).toBeGreaterThanOrEqual(floors.minFiles);
      const missing = pointed.filter((rel) => !existsSync(path.join(SKILLS_DIR, name, rel)));
      expect(
        missing,
        `.claude/skills/${name}/SKILL.md points at stage file(s) that do not exist — ` +
          `a deleted stage file strands its stage:\n${missing.join('\n')}`
      ).toEqual([]);
    });
    it(`${name} keeps its stage files (the split moved content, it did not drop it)`, () => {
      const refs = referenceFiles(name);
      expect(
        refs.length,
        `.claude/skills/${name}/references/ holds ${refs.length} stage files, below the ` +
          `floor of ${floors.minFiles}. The orchestrator SKILL.md points into these; ` +
          `deleting one strands its stage.`
      ).toBeGreaterThanOrEqual(floors.minFiles);
      const total = refs.reduce((n, f) => n + statSync(f).size, 0);
      expect(
        total,
        `.claude/skills/${name}/references/ totals ${total} B, below the ` +
          `${floors.minCorpusBytes} B floor. Every upper bound in this file reads a ` +
          `wholesale deletion as an improvement; this floor is what notices content ` +
          `being DROPPED rather than moved or compressed.`
      ).toBeGreaterThanOrEqual(floors.minCorpusBytes);
    });
  }
});
