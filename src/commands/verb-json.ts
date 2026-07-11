// #868: the `--json` output contract for record / ignore / revert. Symmetric with
// `check --json` (src/report/report.ts): stdout is ONE top-level JSON array, one element
// per stack, and every note / warning / progress line goes to stderr so stdout stays a
// single `JSON.parse`-able value. A whole-run failure before any stack is reached still
// emits `[]` (never empty bytes) — the verbs call `emitJsonArray([])` on their early error
// returns, mirroring check (#871). `error` appears only on a stack that failed or was
// skipped before the action ran (like check's element).

export interface RecordJson {
  stack: string;
  recorded: number; // undeclared value(s) written into the baseline
  wrote: boolean; // a baseline file was actually written
  refused?: boolean; // a decision was required but the run was non-interactive without --yes
  // The baseline file path (when written). Named `baselinePath` — self-describing, and
  // parallel to ignore's `config` path field — so it never collides with check's BOOLEAN
  // `baseline` presence flag (#1095): one `--json` key, one type across verbs (#1336).
  baselinePath?: string;
  error?: string; // set only on a pre-record failure / skip
}

export interface IgnoreJson {
  stack: string;
  added: number; // new ignore rule(s) appended to .cdkrd/ignore.yaml
  wrote: boolean;
  refused?: boolean;
  config?: string; // the .cdkrd/ignore.yaml path (when written)
  error?: string;
}

export interface RevertJson {
  stack: string;
  reverted: number; // resources successfully reverted
  failed: number; // resources whose revert op failed
  aborted: boolean; // the confirm prompt was cancelled (no AWS write)
  exit: number; // this stack's exit contribution (0 clean / 1 drift remains / 2 failure)
  plannedOps?: number; // #1096: --dry-run only — ops a real revert would apply
  plannedResources?: number; // #1096: --dry-run only — resources those ops touch
  refusedReason?: string; // #1096: why the revert refused (nothing revertable / needs --yes)
  error?: string; // set only on a pre-revert failure / skip
}

// The per-stack element label — `<stack> (<region>)`, or bare `<stack>` when the region
// could not be resolved. Matches check's element `stack` field so consumers key uniformly.
export function stackLabel(stackName: string, region: string | undefined): string {
  return region ? `${stackName} (${region})` : stackName;
}

// Print the whole invocation's JSON array once, on stdout (the machine channel).
export function emitJsonArray(reports: readonly unknown[]): void {
  console.log(JSON.stringify(reports, null, 2));
}
