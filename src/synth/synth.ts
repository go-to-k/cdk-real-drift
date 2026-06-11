// Synthesize a CDK app via @aws-cdk/toolkit-lib (the same dependency cdk-local
// uses) to discover stacks. Accepts a CDK app COMMAND (`node app.js`) or a
// pre-synthesized cloud-assembly DIRECTORY (`cdk.out`). Drift detection itself
// does not need this — it is used for stack auto-discovery (and later clobber).
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseCredentials, CdkAppMultiContext, Toolkit } from '@aws-cdk/toolkit-lib';
import { QuietIoHost } from './io-host.js';

export interface SynthStack {
  stackName: string;
  template: Record<string, unknown>;
}

export async function synthApp(
  app: string,
  region: string | undefined,
  context: Record<string, string> = {}
): Promise<SynthStack[]> {
  const toolkit = new Toolkit({
    ioHost: new QuietIoHost(),
    sdkConfig: {
      baseCredentials: BaseCredentials.awsCliCompatible(region ? { defaultRegion: region } : {}),
    },
  });

  const p = resolve(app);
  // CdkAppMultiContext reads cdk.json / cdk.context.json / ~/.cdk.json as the base
  // layer; our -c/--context overrides win on top (mirrors cdk-local / cdk CLI).
  const hasOverrides = Object.keys(context).length > 0;
  const source =
    existsSync(p) && statSync(p).isDirectory()
      ? await toolkit.fromAssemblyDirectory(p, { failOnMissingContext: false })
      : await toolkit.fromCdkApp(app, {
          ...(hasOverrides && { contextStore: new CdkAppMultiContext(process.cwd(), context) }),
        });

  const cached = await toolkit.synth(source);
  try {
    return cached.cloudAssembly.stacks.map((s) => ({
      stackName: s.stackName,
      template: s.template as Record<string, unknown>,
    }));
  } finally {
    await cached.dispose();
  }
}

/** Synth and return just the deployed CFn stack names (for auto-discovery). */
export async function discoverStackNames(
  app: string,
  region: string | undefined,
  context: Record<string, string> = {}
): Promise<string[]> {
  return (await synthApp(app, region, context)).map((s) => s.stackName);
}
