// Read source router. Slice scope: Cloud Control API GetResource only.
// (SDK-override readCurrentState for CC-gap types is a later slice.)
import { GetResourceCommand, type CloudControlClient } from '@aws-sdk/client-cloudcontrol';

export interface ReadResult {
  live?: Record<string, unknown>; // CC API GetResource model (un-stripped)
  skippedReason?: string; // set when the resource could not be read
}

export async function readLive(client: CloudControlClient, resourceType: string, identifier: string): Promise<ReadResult> {
  try {
    const g = await client.send(new GetResourceCommand({ TypeName: resourceType, Identifier: identifier }));
    return { live: JSON.parse(g.ResourceDescription?.Properties ?? '{}') };
  } catch (e) {
    return { skippedReason: `CC API: ${(e as Error).name}` };
  }
}
