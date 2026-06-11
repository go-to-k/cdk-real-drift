// Apply a revert via Cloud Control API UpdateResource (RFC6902 patch), polling
// the async request to completion. This is the only AWS-MUTATING path in cdkrd.
import {
  type CloudControlClient,
  GetResourceRequestStatusCommand,
  UpdateResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import { type RevertItem, toPatchDocument } from './plan.js';

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 5 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function applyRevertItem(
  cc: CloudControlClient,
  item: RevertItem
): Promise<ApplyResult> {
  try {
    const res = await cc.send(
      new UpdateResourceCommand({
        TypeName: item.resourceType,
        Identifier: item.physicalId,
        PatchDocument: toPatchDocument(item),
      })
    );
    let event = res.ProgressEvent;
    const token = event?.RequestToken;
    if (!token) return { ok: false, error: 'no request token returned' };

    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = event?.OperationStatus;
      if (status === 'SUCCESS') return { ok: true };
      if (status === 'FAILED' || status === 'CANCEL_COMPLETE') {
        return { ok: false, error: event?.StatusMessage ?? status };
      }
      await sleep(POLL_INTERVAL_MS);
      const polled = await cc.send(new GetResourceRequestStatusCommand({ RequestToken: token }));
      event = polled.ProgressEvent;
    }
    return { ok: false, error: 'timed out waiting for Cloud Control update' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
