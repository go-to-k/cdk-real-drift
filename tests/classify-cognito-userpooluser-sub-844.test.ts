// #844 — a Cognito UserPoolUser's UserAttributes reads back the server-generated immutable `sub`
// (a per-user UUID assigned at creation, never declared). It must fold atDefault, but ONLY `sub`:
// a console/OOB-added attribute (custom:role, email_verified, …) MUST still surface as undeclared
// (folding all UserAttributes would hide out-of-band attribute injection = a security FN). The
// fold is a PER-ELEMENT value-independent gate keyed on the attribute Name === 'sub'.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const pathsOf = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const SUB = { Name: 'sub', Value: '04c894d8-20e1-70ed-175e-9a01d11f7f45' };
const ROLE = { Name: 'custom:role', Value: 'admin' };
const EMAIL = { Name: 'email', Value: 'cdkrd@example.com' };

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'User',
  resourceType: 'AWS::Cognito::UserPoolUser',
  physicalId: 'cdkrd-user',
  declared,
});

describe('#844 Cognito UserPoolUser UserAttributes[sub] value-independent fold', () => {
  it('folds the AWS-assigned `sub` to atDefault (declared email present)', () => {
    // Template declares only `email`; live returns email + the AWS-injected `sub`.
    const f = classifyResource(
      mk({ UserAttributes: [EMAIL] }),
      {
        UserAttributes: [EMAIL, SUB],
      },
      emptySchema,
      {}
    );
    expect(pathsOf(f, 'atDefault')).toContain('UserAttributes[sub]');
    expect(pathsOf(f, 'undeclared')).not.toContain('UserAttributes[sub]');
  });

  it('STILL surfaces a non-sub undeclared attribute (custom:role) while folding sub', () => {
    // sub folds; a console/OOB-added custom:role must remain undeclared (security-relevant).
    const f = classifyResource(
      mk({ UserAttributes: [EMAIL] }),
      {
        UserAttributes: [EMAIL, SUB, ROLE],
      },
      emptySchema,
      {}
    );
    expect(pathsOf(f, 'atDefault')).toContain('UserAttributes[sub]');
    expect(pathsOf(f, 'undeclared')).toContain('UserAttributes[custom:role]');
    expect(pathsOf(f, 'undeclared')).not.toContain('UserAttributes[sub]');
  });

  it('folds sub value-independently even in a fully-undeclared UserAttributes array', () => {
    // Nothing declared: the whole live array reaches the undeclared subset path; sub still folds,
    // a non-sub attribute still surfaces. Proves the fold is sub-ONLY, not whole-array.
    const f = classifyResource(
      mk({}),
      {
        UserAttributes: [SUB, ROLE],
      },
      emptySchema,
      {}
    );
    expect(pathsOf(f, 'atDefault')).toContain('UserAttributes[sub]');
    expect(pathsOf(f, 'undeclared')).toContain('UserAttributes[custom:role]');
    expect(pathsOf(f, 'undeclared')).not.toContain('UserAttributes[sub]');
  });
});
