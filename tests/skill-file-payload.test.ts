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

const MAX_SKILL_MD_BYTES = 36_000; // largest non-split skill re-measured 12,571 B (verify-pr, 2026-09-01, unchanged in round 6) -- the 12,175 B this line used to quote was stale
const MAX_ORCHESTRATOR_BYTES = 12_000; // orchestrators were 7,952 B / 6,932 B at the 2026-08-28 split; re-measured at the release-please switch (batched releases): work-issues 11,756 B (244 B of margin — the switch removed "release → global install" from the ship-stage flow text), hunt-bugs 6,932 B
// The re-measurement is the point, not trivia: work-issues has repeatedly grown to
// within a few hundred bytes of its cap while this comment still quoted the
// at-split figure, so nobody adding a paragraph could see how little room was
// left. Round 6 added the parent-runs-the-probe design and paid for it three ways
// rather than by loosening anything: the probe and its edge-case reading moved to
// references/launch-mode.md (9,519 B, read once before stage 0), the IN-PLACE
// consequence list became a pointer to that file's table, and the stage table's
// widest cells were shortened -- which, since `vp fmt` pads markdown table columns
// to the widest cell, reclaimed the padding on all fourteen rows at once.
// Re-measure whenever an orchestrator is edited -- a cap with an unmeasured margin
// is one nobody can plan against. work-issues/SKILL.md is 11,812 B again after the
// mirror round below, having briefly been 11,801 B mid-round: that round corrected
// "the markgate store is SHARED across worktrees" to "PER-WORKTREE" (-11 B) and
// then spent the same 11 B making `SKILL.md:47` say "concurrent lane count", so
// the net is zero and the margin is unchanged at 188 B. Recorded because a figure
// that returns to its old value is exactly the one a reader assumes was never
// re-measured. It was UNCHANGED at 11,812 B by the round before
// (go-to-k/cdk-real-drift#1856), which landed entirely in stage files. The LAUNCH_BRANCH round before it spent 118 B of the 306 B that
// were left: the fourth probe value has to be NAMED in the
// always-loaded file (a lane cannot pass on a value it was never told to record),
// while its reading, its restore recipe and the IN-PLACE consequence rows all
// went to references/launch-mode.md and references/ship.md.
const MAX_REFERENCE_FILE_BYTES = 64_000; // largest stage file measured 55,137 B (hunt-bugs gotchas.md); 41,922 B after the rule+citation compression pass (2026-08-28), re-measured unchanged 2026-09-01

// The split skills' stage files must still exist and still carry the moved
// content. Floors sit far enough below the at-split measurement that narrative
// COMPRESSION stays legal while wholesale deletion fails.
// Calibration (probed, not guessed): a byte floor should sit ABOVE the corpus
// minus its LARGEST stage file, or deleting that one file — the likeliest
// wholesale drop — stays green (measured: hunt-bugs at a 50,000 B floor
// survived deleting its 55,137 B gotchas.md). `skill-doc-paths.test.ts` does
// not catch it either: its citation extractor only resolves spans whose first
// segment is a repo-root directory, and `references/...` is skill-relative
// (measured, not assumed).
//
// A SINGLE deleted stage file is caught by `minFiles`, pinned to the EXACT
// count on disk rather than left slack. The pointer-integrity block below is
// NOT that guard, and this comment used to claim it was: deleting a stage file
// TOGETHER WITH the orchestrator row pointing at it leaves both sides
// consistent, so `retro.md` or `verify.md` could go with its pointer and stay
// green (measured 2026-09-01). Pointer integrity catches the OTHER half -- a
// row left dangling by a deletion -- and the two are complementary, not
// redundant. Raising `minFiles` when a stage file is ADDED is the price of the
// exact pin, and it is the same edit that already updates this comment.
//
// The older note declined such a floor for work-issues because it leaves little
// compression room, and that is still the trade; the call was reversed to match
// the sibling cdk-local because a floor that cannot catch the likeliest wholesale
// drop is not a weaker guard but a SILENT one. A genuine compression pass
// re-derives the floor downward in the same commit -- that stays legal; what
// the floor stops is a deletion with no re-derivation at all. The property is
// now ASSERTED at the bottom of this file as well as described here, because
// three consecutive rounds re-derived it BY HAND and one of them found it
// lapsed.
// Re-derived 2026-09-03 at the FINAL tree of the mirror round, every figure at
// that ONE tree. Re-derive this block LAST, after the stage files are final:
// earlier revisions of it went stale three times while being written, because
// editing a stage file to fix prose moves the very corpus the comment is about.
// Nothing else in this file shares that hazard.
//
// Re-measured at the release-please switch: corpus 150,695 B, largest
// implement.md 28,250 B, binding 150,695 - 28,250 = 122,445 — 130,000 still
// clears it, so the figures below (from the round that set the floor) stand as
// the derivation record.
// work-issues: 9 stage files, corpus 150,395 B, largest implement.md 28,148 B,
// so the BINDING requirement is 150,395 - 28,148 = 122,247. The 120,000 the
// previous round set is BELOW that, so this raise is a REPAIR and not a
// precaution: the assertion was already red at HEAD on the binding case alone,
// no flip needed. Probed rather than reasoned, as this derivation demands -- at
// 120,000 the suite fails with "deleting that one file would leave 122247 B and
// still pass", and 130,000 passes. How the margin went across the round:
// +7,708 B at the base, then +225, +91, -1,138. One round of PROSE consumed it
// while touching this file only to raise it, because the floor moves with the
// corpus and the largest file does not.
//
// THE FLIP CASE, stated correctly, because two rounds of reviewers and the
// author all got it wrong here first. When a file grows past implement.md and
// becomes the largest, the residual is `total - v`, where v is that file's size
// BEFORE the growth -- the growth cancels, landing in the corpus and in the new
// largest alike. So the residual is worst for the SMALLEST stage file, not the
// nearest: claim.md, the SMALLEST at 5,429 B, would leave 144,966. Covering
// every candidate would need a floor above that, leaving 5,429 B of compression
// room, which is not this floor's design. It is sized against the NEAR candidates -- triage.md
// needs +3,811 and leaves 126,057, retro.md +3,471 leaves 125,717, verify.md
// +1,837 leaves 124,083 -- and note the ranking is not by file size: rank by
// `total - v`, or the nearest-looking candidate is not the binding one. For
// everything past those the ASSERTION is the backstop BY DESIGN: it fires at the
// commit that causes the flip and its message names the number to raise to.
//
// Chosen 130,000, not the 128,000 an earlier revision of this round set. At
// 128,000 the binding margin was 5,753 B and the worst near flip cleared by only
// 1,943 B -- less than one ordinary edit -- so it would have red on the next
// routine round and taught the next author nothing except to raise it again.
// 130,000 clears binding by 7,753 B (restoring the round base's 7,708 B) and the
// worst near flip by 3,943 B, leaving 150,395 - 130,000 = 20,395 B of
// compression room (13.6%, against 14.2% at the 2026-09-02 derivation).
//
// HONEST LIMIT: 7,753 B is roughly what the previous round consumed in one pass,
// so this still buys about ONE round. A cap with an unmeasured margin is one
// nobody can plan against; so is one whose margin is measured and left unstated.
//
// The growth this round is +10,594 B across all 8 changed stage files, listed in
// FULL because a partial list is the same silent under-reporting
// references/retro.md now carries a rule against: retro.md +3,437,
// verify.md +3,008, gates-and-pr.md +1,237, triage.md +1,199, claim.md +898,
// implement.md +639, launch-mode.md +96, ship.md +80. Base corpus 139,801 +
// 10,594 = 150,395, which is the arithmetic that makes the list checkable.
//
// SUPERSEDED, kept because the reasoning is the same and only the numbers moved:
// work-issues: 9 stage files, corpus 139,801 B, largest implement.md 27,509 B, so
// the binding requirement is 139,801 - 27,509 = 112,292, which the 116,000 set
// hours earlier still clears -- the assertion below did NOT fire, and this raise
// is preventive rather than a repair. What no longer clears is the FLIP case the
// comment has been sized against since go-to-k/cdk-real-drift#1854: the next
// candidates to become largest are verify.md at 23,304 B and triage.md at
// 23,139 B, and the worst of those requires 139,801 - 23,139 = 116,662, which
// 116,000 sits BELOW. Probed rather than reasoned (2026-09-02): with triage.md
// grown past implement.md, the assertion reports "would leave 116,293 B and
// still pass" at 116,000 and passes at 120,000. So 120,000 -- clearing the
// binding number by 7,708 B and the flip by 3,338 B, and leaving ~19 KB
// (139,801 - 120,000 = 19,801 B) of compression room below the floor. The growth
// this round is the IN-PLACE branch rule and the byte-exact probe-restore rule
// in implement.md (+1,628 B) plus the reviewer-reporting and host-load lessons
// in verify.md (+2,316 B); the round before it was the LAUNCH_BRANCH restore
// contract across launch-mode.md, ship.md, retro.md and claim.md.
// hunt-bugs stays at 60,000: corpus 88,683 B at this round's final tree (+78 of
// it from this round's hunt-bugs/references/plan.md edit) and
// largest gotchas.md 41,922 B, so 88,683 - 41,922 = 46,761 < 60,000 and its
// property still holds. Re-measure both numbers for each skill whenever a stage
// file changes size materially -- the property is silent when it lapses.
const SPLIT_SKILLS: Record<string, { minFiles: number; minCorpusBytes: number }> = {
  // 8 files / 125,139 B measured at the split (2026-08-28); largest 26,621 B; 94,136 B
  // post-compression. 9 files as of 2026-09-01, when the launch-mode probe and its
  // reading moved out of triage.md into references/launch-mode.md, which the PARENT
  // reads before stage 0.
  'work-issues': { minFiles: 9, minCorpusBytes: 130_000 },
  // 7 files / 108,940 B measured at the split (2026-08-28); largest 55,137 B; 87,180 B post-compression
  'hunt-bugs': { minFiles: 7, minCorpusBytes: 60_000 },
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

      // The floor's OWN invariant, asserted rather than described. Everything
      // above only says "the corpus is big enough"; what the floor is FOR is
      // that deleting the single largest stage file cannot pass, which holds
      // only while the floor sits above `corpus - largest`. That property decays
      // silently as the OTHER files grow -- the comment above records it lapsing
      // at 60,000 and then holding by only 539 B at 90,000, each time found by a
      // human re-deriving it by hand. Asserting it makes the next lapse a red
      // test at the commit that causes it, including the flip case that comment
      // worries about (implement.md and triage.md are close enough that either
      // can become "largest"), and the message carries the number to raise to.
      const largest = Math.max(...refs.map((f) => statSync(f).size));
      expect(
        floors.minCorpusBytes,
        `minCorpusBytes (${floors.minCorpusBytes}) has lapsed for ${name}: the corpus is ` +
          `${total} B and its largest stage file is ${largest} B, so deleting that one ` +
          `file would leave ${total - largest} B and still pass. Raise the floor above ` +
          `${total - largest} (and re-derive the comment beside it), or re-derive it ` +
          `DOWNWARD in the same commit as a genuine compression pass.`
      ).toBeGreaterThan(total - largest);
    });
  }
});
