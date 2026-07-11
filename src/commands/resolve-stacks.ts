// Resolve which stacks a command operates on, each with the region to query it in.
// cdkrd is CDK-only: it ALWAYS resolves a CDK app (synth, or a pre-synthesized
// `cdk.out` assembly via `--app`) and operates on the stacks that app defines —
// there is no "check an arbitrary deployed CloudFormation stack by name" mode. The
// drift comparison still reads each stack's DEPLOYED template + live state from AWS
// (reality vs intent); the app is used only to discover stack names + their regions
// (and, downstream, construct-path display).
//
//   no positional args    → every stack the app defines, each in its OWN env.region
//                           (env-agnostic stacks fall back to --region / $AWS_REGION,
//                           then the active profile's configured region)
//   <stack>... positional → exact names must exist in the app; a name with a glob
//                           char (`*`/`?`) is matched against the app's stack names
import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommonArgs } from '../cli-args.js';
import { resolveApp } from '../synth/resolve-app.js';
import type { DiscoveredStack } from '../synth/synth.js';
import { discoverStacks } from '../synth/synth.js';
import { isGlob, matchesGlob } from './glob-match.js';

// Read the `region` of a named section from an AWS shared-config-style ini file. Minimal
// parser: locate the `[<section>]` header, then the first `region = <value>` before the
// next header. Returns undefined on any miss / unreadable file. (#955.)
function regionFromIniFile(path: string, section: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined; // no such file / unreadable
  }
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue; // blank / comment
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      inSection = header[1]!.trim() === section;
      continue;
    }
    if (inSection) {
      const m = /^region\s*=\s*(\S+)/.exec(line);
      if (m) return m[1];
    }
  }
  return undefined;
}

// The `[default]` profile's region from the shared config, mirroring the AWS CLI / cdk
// (toolkit-lib) fallback the raw SDK region chain skips: when the SELECTED profile has no
// region, they fall back to the `default` profile's ini region. Credentials file before
// config file ("credentials before config"); the default section is `[default]` in BOTH
// (config uses `[profile x]` only for NAMED profiles). Pure file read, no network.
// Exported for tests.
export function defaultProfileRegionFromIni(): string | undefined {
  const home = homedir();
  const credPath = process.env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials');
  const cfgPath = process.env.AWS_CONFIG_FILE || join(home, '.aws', 'config');
  return regionFromIniFile(credPath, 'default') ?? regionFromIniFile(cfgPath, 'default');
}

// The EC2 instance-identity region via IMDS — the toolkit-lib fallback for an
// instance-role box with no env vars and no ini files at all. Guarded by
// AWS_EC2_METADATA_DISABLED exactly like toolkit-lib, best-effort with a short timeout so
// a non-EC2 host (where the link-local IMDS address blackholes) never hangs the CLI.
// IMDSv2: fetch a token, then placement/region. Any error → undefined. Exported for tests.
export async function regionFromImds(): Promise<string | undefined> {
  if (process.env.AWS_EC2_METADATA_DISABLED === 'true') return undefined;
  const base = 'http://169.254.169.254';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1000);
  try {
    const tokenRes = await fetch(`${base}/latest/api/token`, {
      method: 'PUT',
      headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '60' },
      signal: ac.signal,
    });
    const headers: Record<string, string> = {};
    if (tokenRes.ok) headers['x-aws-ec2-metadata-token'] = (await tokenRes.text()).trim();
    const regionRes = await fetch(`${base}/latest/meta-data/placement/region`, {
      headers,
      signal: ac.signal,
    });
    if (!regionRes.ok) return undefined;
    const region = (await regionRes.text()).trim();
    return region.length > 0 ? region : undefined;
  } catch {
    return undefined; // not on EC2 / IMDS unreachable / timed out
  } finally {
    clearTimeout(timer);
  }
}

// Resolve the region the AWS SDK / cdk would use for the active profile. Used as the LAST
// region fallback for an env-agnostic CDK stack — one with no `env` on the stack and no
// --region / $AWS_REGION — so it still has a region to query instead of erroring. Mirrors
// the AWS CLI / toolkit-lib chain the raw SDK region provider omits (#955): the selected
// profile's region (env AWS_REGION / that profile's ini region), then the `default`
// profile's ini region (a common layout: credentials in a named profile, region under
// `[default]`), then the EC2 IMDS instance region. Returns undefined only when NONE
// resolve (the caller keeps the loud "no region" error as the true last resort — never a
// silent us-east-1). AWS_PROFILE is already exported into the environment by the calling
// command, so the SDK's provider chain selects the right profile even when `profile` is
// undefined here (e.g. $AWS_PROFILE was used instead of --profile).
export async function resolveProfileRegion(
  profile: string | undefined
): Promise<string | undefined> {
  try {
    const client = new CloudControlClient(profile ? { profile } : {});
    const region = await client.config.region();
    client.destroy();
    if (typeof region === 'string' && region.length > 0) return region;
  } catch {
    // the SDK throws "Region is missing" when nothing resolves — fall through to the
    // richer fallbacks the AWS CLI / cdk (toolkit-lib) also apply.
  }
  return defaultProfileRegionFromIni() ?? (await regionFromImds());
}

export interface ResolvedStack {
  stackName: string;
  region: string | undefined; // region to query this stack in (may be undefined → caller errors)
  // #740: the stack's own env.account (concrete 12-digit id, else undefined). Carried from
  // discovery so check can skip a stack pinned to an account the active creds are NOT for
  // (rather than misreporting it "not deployed yet") and never wrong-account compare it.
  account: string | undefined;
  // the synthesized template for this stack — used by check to recover GetTemplate's
  // `?`-masked non-ASCII literals. Carried from the same synth that discovered the stack.
  template: Record<string, unknown>;
}

/**
 * #1316: does a CLI positional select this discovered stack? A positional matches against BOTH
 * the deployed CloudFormation `stackName` AND the toolkit `hierarchicalId` (`Stage/Stack` for a
 * stack nested in a CDK `Stage`), so BOTH `check Dev-Net` (the stage-qualified stackName cdkrd
 * historically accepted) AND the cdk-native `check Dev/Net` (what `cdk ls`/`cdk synth` show, and
 * what the #905 selector actually matches on) resolve to the staged stack. A positional with a
 * glob metachar (`*`/`?`) is matched as a glob against each identifier; a plain positional matches
 * either identifier EXACTLY (equivalent to a metachar-free glob, but kept as `===` for clarity and
 * to preserve the exact-name semantics). For a top-level stack the two identifiers are identical,
 * so behavior there is unchanged. Pure + exported for unit tests.
 */
export function positionalMatchesStack(
  positional: string,
  stack: { stackName: string; hierarchicalId?: string | undefined }
): boolean {
  // `hierarchicalId` falls back to `stackName` for a top-level stack (they are identical there),
  // so an absent id degrades to a stackName-only match — never a crash.
  const hierarchicalId = stack.hierarchicalId ?? stack.stackName;
  if (isGlob(positional)) {
    return matchesGlob(positional, stack.stackName) || matchesGlob(positional, hierarchicalId);
  }
  return positional === stack.stackName || positional === hierarchicalId;
}

/**
 * #1316: the residual-hole guard. toolkit.synth's metadata validation aborts on a stack's
 * error-level annotations (`Annotations.addError(...)` — cdk-nag, a security aspect, a
 * "do not deploy" guard), but ONLY for the SELECTOR-matched collection, and the #905 selector
 * matches on hierarchicalId. A stackName-form positional (`Dev-Net`) matches zero hierarchicalIds,
 * so that validation is silently skipped — cdkrd would then read (and `revert --yes` write back)
 * a template from an app in an error state. After selecting the target stacks, re-check THEIR
 * error annotations and throw so the caller aborts (check maps a resolveStacks throw to exit 2),
 * restoring the no-args abort behavior for the named case. The no-args / --all path already had
 * toolkit.synth validate every stack (no selector), so this is a belt for the named case.
 * Aggregates messages across every selected stack. Pure + exported for unit tests.
 */
export function assertNoStackErrors(
  selected: readonly { stackName: string; errorMessages?: readonly string[] | undefined }[]
): void {
  const lines: string[] = [];
  for (const s of selected) {
    // An absent `errorMessages` (an older/looser caller) degrades to "no errors" — never a crash.
    for (const msg of s.errorMessages ?? []) lines.push(`  ${s.stackName}: ${msg}`);
  }
  if (lines.length > 0) {
    throw new Error(
      `the CDK app synthesized with ${lines.length} error(s) (an Annotations.addError — cdk-nag / ` +
        'security aspect / do-not-deploy guard) on the selected stack(s); refusing to read or ' +
        `revert an app in an error state:\n${lines.join('\n')}`
    );
  }
}

export async function resolveStacks(a: CommonArgs): Promise<ResolvedStack[]> {
  // #1327: --all means "every stack the app defines" and SILENTLY discarded any positional
  // names below (`if (a.all || a.stackNames.length === 0)`), so `cdkrd revert Prod --all --yes`
  // — a plausible "revert all drift in Prod" scripted line — non-interactively targeted EVERY
  // stack while the word `Prod` had zero effect. Fail loud, not silent (the #778 zero-match-glob
  // throw principle): combining named stacks with --all is a contradiction, so error rather than
  // pick one silently. Runs before discovery/synth — a bad invocation should not cost an app read.
  if (a.all && a.stackNames.length > 0) {
    throw new Error(
      `--all cannot be combined with named stacks (${a.stackNames.join(', ')}): --all targets every stack the app defines. Drop --all to scope to the named stacks, or drop the names to target all.`
    );
  }
  const app = resolveApp(a.app);
  if (!app) {
    throw new Error(
      'cdkrd needs a CDK app: run in a directory with cdk.json, pass --app "<cmd>" or --app <cdk.out> (a pre-synthesized assembly), or set $CDKRD_APP'
    );
  }
  // #905: scope synth's metadata validation to the TARGET stacks. When the user named
  // specific stacks (exact and/or glob) and did NOT pass --all, forward those patterns so a
  // failing context lookup in an UNRELATED sibling stack does not abort the whole command —
  // the standard multi-account CI shape (creds for account A only; app defines A+B with
  // lookups in B). For --all or no-args discovery the user asked for EVERYTHING, so we pass
  // no scope (undefined) and toolkit-lib validates every stack, exactly as before. Discovery
  // still returns every stack the app defines regardless — this only narrows VALIDATION — so
  // the exact-name-typo / no-match-glob errors below still see the full known-stack list.
  const scopePatterns = !a.all && a.stackNames.length > 0 ? a.stackNames : undefined;

  // Region fallback chain for an env-agnostic stack (no `env` on the stack): an
  // explicit --region / $AWS_REGION (`a.region`) first, then the active AWS
  // profile's configured region. Resolve the profile region BEFORE the discovery
  // synth (#957): `discoverStacks` synthesizes the app in a subprocess that inherits
  // AWS_REGION / CDK_DEFAULT_REGION from `a.region`, and check's --pre-deploy path
  // synthesizes it a SECOND time. If the backfill happened only AFTER discovery, the
  // second synth would see a region the first did not — an app whose stack set or
  // templates branch on process.env.AWS_REGION would then synthesize DIFFERENTLY
  // across the two passes (a stack silently skipped as "not in synth output", or
  // compared against the wrong template). Resolving + backfilling `a.region` here
  // makes both synths see the SAME region env. This costs one local config read even
  // for a fully region-pinned app (the previous "peek at discovered stacks first"
  // optimization is deliberately dropped, per #957) — but only when no region is set
  // at all. If resolveProfileRegion resolves nothing, `a.region` stays undefined and
  // behavior is IDENTICAL to before: discovery gets undefined, env-agnostic stacks
  // end up with region undefined, and the loud "no region" error still fires
  // downstream as the last resort (never a silent us-east-1).
  if (!a.region) {
    a.region = await resolveProfileRegion(a.profile);
  }
  const fallbackRegion = a.region;

  const discovered = await discoverStacks(app, {
    region: a.region,
    profile: a.profile,
    context: a.context,
    stackPatterns: scopePatterns,
  });

  // --all, or no names → every stack the app defines. --all is the explicit form of the
  // no-argument default; it also overrides any positional names (target everything).
  if (a.all || a.stackNames.length === 0) {
    // #1316: every stack is selected here, so surface any error-level annotation and abort —
    // mirroring the named case below. (toolkit.synth already validated all stacks with no
    // selector on this path, so it normally threw first; this keeps the guard uniform.)
    assertNoStackErrors(discovered);
    return discovered.map((s) => ({
      stackName: s.stackName,
      region: s.region ?? fallbackRegion,
      account: s.account, // #740: carry env.account through so check can gate on it
      template: s.template,
    }));
  }

  // names (exact and/or glob) matched against the app's stacks — matched against BOTH the
  // deployed stackName AND the toolkit hierarchicalId (#1316, positionalMatchesStack).
  const seen = new Set<string>();
  const out: ResolvedStack[] = [];
  // #1316: the DISCOVERED stacks a positional selected — so we can re-check their error-level
  // annotations after selection and abort (the residual hole a stackName-form positional opened:
  // the #905 hierarchicalId-scoped selector skipped their validation). Keyed like `add`'s dedup.
  const selectedByKey = new Map<string, DiscoveredStack>();
  const add = (
    stackName: string,
    region: string | undefined,
    account: string | undefined, // #740: the stack's own env.account (concrete, else undefined)
    template: Record<string, unknown>
  ): void => {
    // #1320: dedup on name + region + ACCOUNT. #884 added the region axis but not
    // the account axis, so a #740 multi-account app that defines the SAME stackName
    // in the SAME region for TWO different accounts (a fixed stackName with env.account
    // varying per stage — the multi-account CI staple) had its SECOND instance silently
    // dropped when selected by name or glob, while --all (no dedup) returned both — the
    // two selection forms then disagreed (the prod stack never checked by any named leg).
    // A same-name/same-region/same-account duplicate (or env-agnostic account undefined)
    // still collapses, so #884's behavior is unchanged.
    const key = `${stackName}\0${region ?? ''}\0${account ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ stackName, region, account, template });
  };
  // The known-stacks hint lists BOTH identifier forms when they differ (`Stage/Stack (Stage-Stack)`,
  // mirroring `cdk ls`), so a user who mistyped one form sees the other they could have used (#1316).
  const known = (): string =>
    discovered
      .map((s) =>
        s.hierarchicalId === s.stackName ? s.stackName : `${s.hierarchicalId} (${s.stackName})`
      )
      .join(', ') || 'none';
  // Record a positional-selected discovered stack for the post-selection error check (#1316).
  const select = (s: DiscoveredStack): void => {
    add(s.stackName, s.region ?? fallbackRegion, s.account, s.template);
    selectedByKey.set(`${s.stackName}\0${s.region ?? ''}\0${s.account ?? ''}`, s);
  };
  for (const name of a.stackNames) {
    // Match a positional against BOTH the stackName AND the hierarchicalId (#1316) — a plain
    // positional matches either EXACTLY, a `*`/`?` positional globs either. This is what makes
    // the cdk-native `Dev/Net` form resolve (and scope the #905 selector correctly), while the
    // stage-qualified `Dev-Net` stackName form keeps working.
    const hits = discovered.filter((s) => positionalMatchesStack(name, s));
    if (isGlob(name)) {
      // Count MATCHES (positionalMatchesStack true), NOT net add() calls: `add` dedups via
      // `seen`, so a glob hitting an already-added stack is still a match and must
      // NOT error. A glob that matches ZERO discovered stacks is a hard error,
      // mirroring the exact-name-typo throw — otherwise `check 'Pord-*' Dev --fail`
      // (a typo'd prod glob) silently checks nothing for the glob and exits 0, so
      // CI believes prod was covered.
      if (hits.length === 0)
        throw new Error(
          `glob "${name}" matched no stacks defined by the CDK app (found: ${known()})`
        );
      for (const hit of hits) select(hit);
    } else {
      // Collect ALL discovered stacks matching this exact name/hierarchicalId, NOT just the
      // first (#884). A multi-REGION app can define the same stackName in two envs
      // (e.g. `Dup` in us-east-1 AND us-west-2); `add` dedups on name+region so
      // the two distinct-region instances are both kept while a same-name
      // same-region duplicate still collapses. `find` silently dropped every
      // instance but the first, so `check Dup --fail` greenlit the other region.
      if (hits.length === 0)
        throw new Error(`stack "${name}" is not defined by the CDK app (found: ${known()})`);
      for (const hit of hits) select(hit);
    }
  }
  // #1316: abort on any error-level annotation of the SELECTED stacks — the validation
  // toolkit.synth's hierarchicalId-scoped #905 selector skipped for a stackName-form positional.
  assertNoStackErrors([...selectedByKey.values()]);
  if (out.length === 0) {
    throw new Error(`no stacks match ${a.stackNames.join(', ')} (found: ${known()})`);
  }
  return out;
}
