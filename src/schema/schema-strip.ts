// NEW (the tool's differentiator — cdkd does not do this).
// Fetch the CloudFormation resource schema via `describe-type` and derive the
// auto-strip / auto-skip sets from readOnlyProperties / writeOnlyProperties.
// Paths are JSON pointers, nested + wildcard:
//   /properties/Arn
//   /properties/LifecycleConfiguration/Rules/*/Transition
// Also exposes schema `default` values for scalar-default noise suppression.
//
// PoC-verified: these sets matched the observed noise exactly (S3 + IAM Role).

export interface ResourceSchemaInfo {
  readOnlyPaths: string[];   // strip from live before comparing (computed attrs)
  writeOnlyPaths: string[];  // skip from drift (cannot read back)
  defaults: Record<string, unknown>; // dotted-path → default (suppress undeclared-at-default)
}

const cache = new Map<string, ResourceSchemaInfo>();

export async function getSchemaInfo(_resourceType: string, _region: string): Promise<ResourceSchemaInfo> {
  // TODO(phase2): DescribeTypeCommand → parse Schema JSON → map pointer paths to
  //   dotted paths (and '*' for array elements); cache per type; tolerate
  //   unsupported types (return empty sets).
  void cache;
  throw new Error('not implemented');
}
