// 2026-07-14 revert-convergence hunt (revconv-hunt fixture, live-proven):
// writeOnlyReincludeOps re-included Lambda `Code.ZipFile` into a patch that
// only reverted TracingConfig — the update handler treated it as an
// UpdateFunctionCode, re-packaging the zip and CHANGING the live CodeSha256
// (the #646 synthetic read signal) off the recorded baseline: the revert
// itself manufactured a permanent post-revert drift. Code must not be
// re-included when the patch does not target it. (The same run live-proved the
// #1571 batch: ECR ImageTagMutability no-oped — fixed upstream as #1580/#1581 —
// while Lambda TracingConfig / SQS DelaySeconds / KMS Enabled converged via
// bare `remove`.)
import { describe, expect, it } from 'vite-plus/test';
import { writeOnlyReincludeOps } from '../src/revert/plan.js';
import type { SchemaInfo } from '../src/types.js';

const lambdaSchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: ['Code.S3Bucket', 'Code.S3Key', 'Code.ZipFile'],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

describe('Lambda Code is never re-included into an unrelated CC revert patch', () => {
  const declared = { Code: { ZipFile: "exports.handler = async () => 'ok';" }, Handler: 'h' };
  it('a TracingConfig-only patch does NOT re-include Code.ZipFile (side-effectful write)', () => {
    const ops = writeOnlyReincludeOps(
      declared,
      lambdaSchema,
      [{ op: 'remove', path: '/TracingConfig', human: 'TracingConfig -> remove' }],
      'AWS::Lambda::Function'
    );
    expect(ops).toEqual([]);
  });
  it('without the type-specific skip, the same shape IS re-included (contract preserved for other types)', () => {
    const ops = writeOnlyReincludeOps(declared, lambdaSchema, [
      { op: 'remove', path: '/TracingConfig', human: 'TracingConfig -> remove' },
    ]);
    expect(ops).toMatchObject([{ op: 'add', path: '/Code/ZipFile' }]);
  });
});
