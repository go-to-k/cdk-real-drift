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
import { NonInteractiveIoHost } from '@aws-cdk/toolkit-lib';
import type { IoMessage } from '@aws-cdk/toolkit-lib';

type Level = IoMessage<unknown>['level'];

// CDK app subprocess passthrough message codes (toolkit-lib source-builder.ts).
const APP_STDOUT = 'CDK_ASSEMBLY_I1001';
const APP_STDERR = 'CDK_ASSEMBLY_E1002';

export type IoPlan = { action: 'drop' } | { action: 'emit'; level: Level };

/**
 * Decide what QuietIoHost does with a message (pure, so it is unit-testable):
 *  - the CDK app's own stdout/stderr passthrough -> emit at INFO (default color, like
 *    cdk-local; never the alarming red the E1002/error tag would otherwise produce);
 *  - a real toolkit warning / error -> emit unchanged (still yellow / red);
 *  - everything else (toolkit info/debug/trace chatter) -> drop.
 */
export function planIoMessage(msg: Pick<IoMessage<unknown>, 'code' | 'level'>): IoPlan {
  if (msg.code === APP_STDOUT || msg.code === APP_STDERR) return { action: 'emit', level: 'info' };
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
