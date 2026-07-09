// When a CDK app's context lookups (VPC / AZ / AMI / hosted-zone / ...) are unresolved,
// CDK still synthesizes: it fills every gap with a well-known DUMMY value (`vpc-12345`,
// `availability-zone-1a`, ...) and records the gap in the assembly manifest's `missing`
// array. A template carrying those placeholders does not reflect real infrastructure, so
// any drift computed against it is fabricated. That is invisible on a normal check (the
// deployed template is the declared source), but under `--pre-deploy` the SYNTH template
// IS the declared source: live `VpcId=vpc-0abc...` compared against desired `vpc-12345`
// becomes guaranteed false declared drift, `--fail` turns it into a CI failure, and an
// interactive revert would offer to write `vpc-12345` back to AWS. This module surfaces
// that gap loudly (#907) — a plain warning on discovery, a hard refusal under --pre-deploy.

/** Minimal shape of a cx-api `MissingContext` entry — only its `key` matters here. */
export interface MissingContextEntry {
  readonly key: string;
}

/**
 * Minimal structural shape of a cx-api `CloudAssembly` for missing-context aggregation. A CDK
 * app that nests stacks inside a `Stage` synthesizes each Stage into its OWN nested assembly
 * (`assembly-<Stage>/manifest.json`) carrying its own `missing` array; the top-level manifest's
 * `missing` does NOT include them. We only need the per-assembly `manifest.missing` plus the
 * recursion edge into nested assemblies (each `NestedCloudAssemblyArtifact.nestedAssembly`).
 */
export interface CloudAssemblyLike {
  readonly manifest: { readonly missing?: readonly MissingContextEntry[] | undefined };
  readonly nestedAssemblies: readonly { readonly nestedAssembly: CloudAssemblyLike }[];
}

/**
 * Collect `missing` context entries across the top-level assembly AND every nested assembly
 * (recursively — a Stage-in-Stage app nests arbitrarily deep). Mirrors how `stacksRecursively`
 * descends `nestedAssemblies` so a dummy `vpc-12345` lookup inside a staged stack is not missed
 * (#987 — the top-level-only read in #907 let one slip past `--pre-deploy`). Concatenates each
 * assembly's raw entries; dedup/sort is left to `missingContextKeys`.
 */
export function collectMissingRecursively(assembly: CloudAssemblyLike): MissingContextEntry[] {
  const out: MissingContextEntry[] = [...(assembly.manifest.missing ?? [])];
  for (const nested of assembly.nestedAssemblies) {
    out.push(...collectMissingRecursively(nested.nestedAssembly));
  }
  return out;
}

/** Unique, sorted missing-context keys (dedup by key). Empty array when nothing is missing. */
export function missingContextKeys(missing: readonly MissingContextEntry[] | undefined): string[] {
  if (!missing || missing.length === 0) return [];
  return [...new Set(missing.map((m) => m.key))].sort();
}

/**
 * Build the stderr message body (no `warning:`/`error:` prefix — the caller adds it) for an
 * assembly synthesized with unresolved context lookups. Returns `null` when `keys` is empty
 * (a clean assembly — behavior unchanged). Under `preDeploy` the wording escalates to an
 * explicit REFUSAL: the placeholders are the declared source there, so proceeding on
 * fabricated values (false drift, a bad `--fail`, a revert that writes dummies back) is worse
 * than stopping — the user must supply the context or deploy so the lookups resolve.
 */
export function missingContextWarning(
  keys: string[],
  opts: { preDeploy?: boolean | undefined } = {}
): string | null {
  if (keys.length === 0) return null;
  const lead = `the CDK app synthesized with ${keys.length} unresolved context lookup(s): ${keys.join(', ')}`;
  const why =
    'CDK filled these with placeholder dummy values (e.g. vpc-12345), so the synthesized ' +
    'template does not reflect real infrastructure.';
  if (opts.preDeploy) {
    return (
      `${lead}\n${why}\n` +
      '(--pre-deploy) refusing: those placeholders are the DECLARED source, so every check ' +
      'would report fabricated declared drift and a revert would write the dummy values back ' +
      'to AWS. Provide the context (commit cdk.context.json, pass -c key=value, or deploy so ' +
      'the lookups resolve) and re-run.'
    );
  }
  return `${lead}\n${why}`;
}
