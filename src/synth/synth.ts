// Synthesize a CDK app via @aws-cdk/toolkit-lib (the same dependency cdk-local
// uses) to discover stacks. Records a CDK app COMMAND (`node app.js`) or a
// pre-synthesized cloud-assembly DIRECTORY (`cdk.out`). Drift detection itself
// does not need this — it is used for stack auto-discovery (and later clobber).
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseCredentials, CdkAppMultiContext, Toolkit } from '@aws-cdk/toolkit-lib';
import { QuietIoHost } from './io-host.js';
import {
  collectMissingRecursively,
  missingContextKeys,
  missingContextWarning,
} from './missing-context.js';

export interface SynthOptions {
  region?: string | undefined;
  profile?: string | undefined;
  context?: Record<string, string>;
  // When the caller uses the synth template as the DECLARED source (`--pre-deploy`), an
  // assembly synthesized with unresolved context lookups is fabricated (CDK's dummy
  // `vpc-12345` placeholders). Escalate the missing-context surface from a warning to a
  // hard refusal (throw) in that mode (#907). Discovery (default) only warns.
  preDeploy?: boolean;
}

export interface SynthStack {
  stackName: string;
  region: string | undefined; // the stack's own env.region (concrete) — for per-stack drift reads
  template: Record<string, unknown>;
}

// A concrete AWS region pin. Allows the multi-part infixes of GovCloud / ISO partitions
// (`us-gov-west-1`, `us-iso-east-1`, `us-isob-east-1`, `eu-isoe-west-1`), not just the
// three-segment commercial form — otherwise those pins test false and env.region is silently
// discarded, so the stack is read against the wrong region (#742).
export const CONCRETE_REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * Build the stderr message body (no `warning:` prefix — the caller adds it) for the case where
 * `--app` points at a pre-synthesized cloud-assembly DIRECTORY (`cdk.out`) yet the user also
 * passed `-c/--context`. There is no CDK app subprocess to feed context to — the assembly's
 * templates were frozen at synth time — so the `-c` values are silently dropped. Returns `null`
 * when it does NOT apply (a real CDK app command, or no context given), so the caller warns only
 * on the ignored case (#956). Advisory only (a warning, not a refusal): the frozen assembly is
 * still a valid drift source, the user is just misled into thinking their `-c` mattered.
 */
export function contextIgnoredWarning(
  isDir: boolean,
  context: Record<string, string>
): string | null {
  const keys = Object.keys(context);
  if (!isDir || keys.length === 0) return null;
  return (
    `ignoring -c/--context (${keys.join(', ')}): --app points at a pre-synthesized cloud-assembly ` +
    'directory, whose context was baked in at synth time — there is no CDK app to re-run with new ' +
    'context. To apply new context, point --app at the CDK app itself (not its cdk.out).'
  );
}

/**
 * Decide whether to remove a `cdk.context.json` that synth may have written (#906).
 *
 * For an app with context lookups but no cached context, toolkit-lib's default
 * `CdkAppMultiContext` persists the resolved lookups into `<cwd>/cdk.context.json` — even
 * when EVERY lookup FAILED, in which case it writes an empty `{}`. That empty file dirties
 * the user's git tree for no benefit (it caches nothing). We remove it, but ONLY when it is
 * safe: the file must NOT have pre-existed (so we never touch a user's committed context),
 * AND it must be empty (`{}` / whitespace-only) now (so we never delete a file that captured
 * real lookup results). Returns true iff the file at `file` should be deleted.
 */
export function shouldRemoveEmptyContextFile(existedBefore: boolean, existsNow: boolean): boolean {
  return !existedBefore && existsNow;
}

/** An object with no own enumerable keys — a persisted `{}` context (an all-failed lookup). */
function isEmptyContextJson(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '{}') return true;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 0
    );
  } catch {
    // Not valid JSON — leave it alone (never our empty-write; do not delete).
    return false;
  }
}

/**
 * Remove a `cdk.context.json` at `file` iff synth JUST created it AND it is empty (an
 * all-failed lookup that persisted `{}`). Guarded so a pre-existing or non-empty user file
 * is NEVER touched (#906). No-op on any read/remove error — cleanup is best-effort.
 */
function cleanupEmptyContextFile(file: string, existedBefore: boolean): void {
  if (!shouldRemoveEmptyContextFile(existedBefore, existsSync(file))) return;
  try {
    if (isEmptyContextJson(readFileSync(file, 'utf-8'))) rmSync(file);
  } catch {
    // best-effort: never fail a check because we could not tidy an empty context file.
  }
}

export async function synthApp(app: string, opts: SynthOptions = {}): Promise<SynthStack[]> {
  const { region, profile, context = {} } = opts;
  const toolkit = new Toolkit({
    ioHost: new QuietIoHost(),
    sdkConfig: {
      baseCredentials: BaseCredentials.awsCliCompatible({
        ...(region && { defaultRegion: region }),
        ...(profile && { profile }),
      }),
    },
  });

  const p = resolve(app);
  const isDir = existsSync(p) && statSync(p).isDirectory();
  // toolkit-lib's default CdkAppMultiContext persists resolved lookups into
  // <cwd>/cdk.context.json on the fromCdkApp path (the dir path uses MemoryContext, no
  // write). Snapshot whether that file already exists so we only ever clean up one WE
  // caused, and only when it is empty (an all-failed `{}` lookup) (#906).
  const contextFile = resolve(process.cwd(), 'cdk.context.json');
  const contextFileExistedBefore = !isDir && existsSync(contextFile);
  let source;
  if (isDir) {
    // pre-synthesized assembly: no subprocess to feed region/profile/context to. Any
    // -c/--context the user passed is therefore dropped; warn so they are not misled (#956).
    const ignored = contextIgnoredWarning(isDir, context);
    if (ignored) console.error(`warning: ${ignored}`);
    source = await toolkit.fromAssemblyDirectory(p, { failOnMissingContext: false });
  } else {
    const hasOverrides = Object.keys(context).length > 0;
    // feed the app subprocess the same region/profile the user gave so `this.region`
    // / env-based credential lookups resolve as they would under `cdk` (cdk-local).
    const env: Record<string, string> = {};
    if (region) {
      env.AWS_REGION = region;
      env.CDK_DEFAULT_REGION = region;
    }
    if (profile) env.AWS_PROFILE = profile;
    source = await toolkit.fromCdkApp(app, {
      ...(Object.keys(env).length > 0 && { env }),
      // CdkAppMultiContext reads cdk.json / cdk.context.json / ~/.cdk.json as the
      // base layer; our -c/--context overrides win on top (mirrors cdk CLI).
      ...(hasOverrides && { contextStore: new CdkAppMultiContext(process.cwd(), context) }),
    });
  }

  const cached = await toolkit.synth(source);
  // Best-effort: if synth just created an EMPTY cdk.context.json (every lookup failed → `{}`),
  // remove it so a read-only `check` does not dirty the user's git tree with a useless file.
  // Guarded to never touch a pre-existing or non-empty file (#906). Skipped on the dir path.
  if (!isDir) cleanupEmptyContextFile(contextFile, contextFileExistedBefore);
  try {
    // A CDK app whose context lookups are unresolved still synthesizes — CDK fills every
    // gap with a well-known DUMMY value (`vpc-12345`, ...) and records the gap in the
    // manifest's `missing` array. Surface that loudly (#907): a template carrying those
    // placeholders does not reflect real infrastructure. Always warn on discovery; under
    // `--pre-deploy` (synth template = declared source) REFUSE, because the fabricated
    // values would drive false declared drift and a revert would write them back to AWS.
    // Aggregate `missing` RECURSIVELY across nested-Stage assemblies (mirroring the
    // `stacksRecursively` descent below): a stack nested inside a CDK `Stage` records its
    // unresolved lookups in its OWN nested manifest, not the top-level one, so a
    // top-level-only read would let a dummy `vpc-12345` inside a staged stack slip past
    // `--pre-deploy` — reintroducing exactly the false declared drift #907 blocks (#987).
    const missingKeys = missingContextKeys(collectMissingRecursively(cached.cloudAssembly));
    if (missingKeys.length > 0) {
      const msg = missingContextWarning(missingKeys, { preDeploy: opts.preDeploy });
      if (opts.preDeploy) throw new Error(msg ?? 'unresolved CDK context lookups');
      console.error(`warning: ${msg}`);
    }

    // `stacksRecursively` (NOT `stacks`): `stacks` returns only the TOP-LEVEL
    // assembly's stacks, so every stack nested inside a CDK `Stage` (the CDK
    // Pipelines / multi-env pattern) is silently invisible — never discovered, never
    // checked, with no error. `stacksRecursively` descends into nested assemblies and
    // is a SUPERSET of `stacks`, so a non-staged app is unaffected. `s.stackName` is
    // the deployed CloudFormation stack name (CDK stage-qualifies it), which is the
    // correct live-read target.
    return cached.cloudAssembly.stacksRecursively.map((s) => ({
      stackName: s.stackName,
      region: CONCRETE_REGION.test(s.environment.region) ? s.environment.region : undefined,
      template: s.template as Record<string, unknown>,
    }));
  } finally {
    await cached.dispose();
  }
}

export interface DiscoveredStack {
  stackName: string;
  region: string | undefined; // the stack's own env.region, when concrete
  // the synthesized template — carried through so the check path can recover GetTemplate's
  // `?`-masked non-ASCII literals from it without re-synthesizing (synthApp already built it).
  template: Record<string, unknown>;
}

/** Synth and return each stack's name + its own (concrete) region + template, for discovery. */
export async function discoverStacks(
  app: string,
  opts: SynthOptions = {}
): Promise<DiscoveredStack[]> {
  return (await synthApp(app, opts)).map((s) => ({
    stackName: s.stackName,
    region: s.region,
    template: s.template,
  }));
}
