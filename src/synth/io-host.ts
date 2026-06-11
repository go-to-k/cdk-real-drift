// Quiet IoHost for toolkit-lib synth: drop info/debug/trace chatter so synth does
// not pollute cdkrd's output; warnings + errors still surface. (Mirrors the spirit
// of cdk-local's CdklIoHost.)
import { NonInteractiveIoHost } from '@aws-cdk/toolkit-lib';
import type { IoMessage } from '@aws-cdk/toolkit-lib';

export class QuietIoHost extends NonInteractiveIoHost {
  override async notify(msg: IoMessage<unknown>): Promise<void> {
    if (msg.level !== 'warn' && msg.level !== 'error') return;
    return super.notify(msg);
  }
}
