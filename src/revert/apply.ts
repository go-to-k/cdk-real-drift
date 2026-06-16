// Apply a revert via Cloud Control API — UpdateResource (RFC6902 patch) for a
// property revert, or DeleteResource for an `added` out-of-band resource — polling the
// async request to completion. This is the only AWS-MUTATING path in cdkrd.
import {
  type CloudControlClient,
  DeleteResourceCommand,
  GetResourceRequestStatusCommand,
  type ProgressEvent,
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

// Poll a Cloud Control ProgressEvent (Update or Delete) to a terminal state.
async function pollToCompletion(
  cc: CloudControlClient,
  first: ProgressEvent | undefined
): Promise<ApplyResult> {
  let event = first;
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
  return { ok: false, error: 'timed out waiting for Cloud Control request' };
}

export async function applyRevertItem(
  cc: CloudControlClient,
  item: RevertItem,
  // The Cloud Control resource identifier. Defaults to the CFn physical id, but
  // composite-identifier types (e.g. AWS::ECS::Service = `${ServiceArn}|${Cluster}`)
  // need the same adapted identifier the READ path uses — the caller resolves it via
  // CC_IDENTIFIER_ADAPTERS and passes it here, else UpdateResource ValidationExceptions.
  identifier: string = item.physicalId
): Promise<ApplyResult> {
  try {
    const res = await cc.send(
      new UpdateResourceCommand({
        TypeName: item.resourceType,
        Identifier: identifier,
        PatchDocument: toPatchDocument(item),
      })
    );
    return await pollToCompletion(cc, res.ProgressEvent);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// DELETE an `added` (out-of-band) resource via Cloud Control DeleteResource. The
// identifier is the resource's CC primaryIdentifier (for API Gateway children, the
// `RestApiId|ResourceId[|HttpMethod]` composite already carried on the finding).
export async function applyRevertDelete(
  cc: CloudControlClient,
  item: RevertItem,
  identifier: string = item.physicalId
): Promise<ApplyResult> {
  try {
    const res = await cc.send(
      new DeleteResourceCommand({ TypeName: item.resourceType, Identifier: identifier })
    );
    return await pollToCompletion(cc, res.ProgressEvent);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
