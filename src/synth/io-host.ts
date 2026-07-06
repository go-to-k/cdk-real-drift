// IoHost for toolkit-lib synth. Two jobs:
//  1. Drop toolkit-lib's own info/debug/trace chatter so synth does not pollute
//     cdkrd's drift output (warnings + real errors still surface).
//  2. Render the CDK app subprocess's OWN output in the default color.
//
// toolkit-lib's source-builder relays the app subprocess stdout as
// `CDK_ASSEMBLY_I1001` and its stderr as `CDK_ASSEMBLY_E1002`. The stderr one is
// tagged at ERROR level, so the default NonInteractiveIoHost prints it in red — but
// bundlers (esbuild / tsc / pip / docker, …) write ordinary progress ("Bundling
// asset …", file-size tables) to stderr, so red is misleading and alarming. We
// re-tag both passthrough codes to INFO so they print in the default color, matching
// cdk-local. A genuine synth failure still surfaces: the subprocess exits non-zero,
// toolkit-lib throws, and cdkrd's own error handling reports it (a different path
// from these per-line E1002 passthrough messages).
//
// A third code needs re-tagging: `CDK_TOOLKIT_E9600`, the construct-annotation
// validation report (the `aws:cdk:warning|error` a synth emits, e.g.
// noSubnetRouteTableId). toolkit-lib registers this ONE code at ERROR level even for
// a report whose only contents are WARNINGS, so NonInteractiveIoHost paints the
// entire block RED (chalk.red) — bleeding red over the description + construct path,
// while only the pre-baked yellow "WARNING" label survives (via chalk's nested-reset
// restoration). Red for a mere warning is misleading.
//
// We re-tag it to WARN (not INFO): every line of this report is headed by the
// formatter's own severity label — a yellow `WARNING` for the ubiquitous
// aws:cdk:warning annotations cdkrd sees — so a WARN wrap (chalk.yellow) paints the
// WHOLE block yellow to MATCH that label, exactly like every other cdkrd synth
// warning (which is already emitted at WARN = yellow). The formatter's explicit
// per-severity label colors still survive the outer yellow: an ERROR-severity line
// keeps its orange `ERROR` label (its own ansi256 code wins over the wrap), and the
// grey rule hints stay grey — only the otherwise-default body inherits the yellow.
// So a warnings-only report reads as one consistent yellow warning, and a mixed
// report still shows each line's severity via its label.
import { NonInteractiveIoHost } from '@aws-cdk/toolkit-lib';
import type { IoMessage } from '@aws-cdk/toolkit-lib';

type Level = IoMessage<unknown>['level'];

// CDK app subprocess passthrough message codes (toolkit-lib source-builder.ts).
const APP_STDOUT = 'CDK_ASSEMBLY_I1001';
const APP_STDERR = 'CDK_ASSEMBLY_E1002';
// Construct-annotation validation report (toolkit-lib validate-formatting.ts) —
// ERROR-level (misleading red) but every line is severity-labelled, so we re-tag to
// WARN: a yellow wrap matches the yellow WARNING label, like every other cdkrd warning.
const VALIDATION_REPORT = 'CDK_TOOLKIT_E9600';

export type IoPlan = { action: 'drop' } | { action: 'emit'; level: Level };

/**
 * Decide what QuietIoHost does with a message (pure, so it is unit-testable):
 *  - the CDK app's own stdout/stderr passthrough -> emit at INFO (default color, like
 *    cdk-local; never the alarming red the E1002/error tag would otherwise produce);
 *  - the construct-annotation validation report -> emit at WARN so the whole block is
 *    yellow (matching its WARNING label) instead of the misleading ERROR-level red
 *    wrap; per-severity labels still survive (see file header);
 *  - a real toolkit warning / error -> emit unchanged (still yellow / red);
 *  - everything else (toolkit info/debug/trace chatter) -> drop.
 */
export function planIoMessage(msg: Pick<IoMessage<unknown>, 'code' | 'level'>): IoPlan {
  if (msg.code === APP_STDOUT || msg.code === APP_STDERR) return { action: 'emit', level: 'info' };
  if (msg.code === VALIDATION_REPORT) return { action: 'emit', level: 'warn' };
  if (msg.level === 'warn' || msg.level === 'error') return { action: 'emit', level: msg.level };
  return { action: 'drop' };
}

export class QuietIoHost extends NonInteractiveIoHost {
  override async notify(msg: IoMessage<unknown>): Promise<void> {
    const plan = planIoMessage(msg);
    if (plan.action === 'drop') return;
    return super.notify(plan.level === msg.level ? msg : { ...msg, level: plan.level });
  }
}
