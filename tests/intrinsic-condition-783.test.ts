import { describe, expect, it } from 'vite-plus/test';
import { resolve } from '../src/normalize/intrinsic-resolver.js';
import type { ResolverContext } from '../src/types.js';

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return {
    params: { Env: 'prod' },
    pseudo: {
      'AWS::Region': 'us-east-1',
      'AWS::AccountId': '123',
      'AWS::Partition': 'aws',
      'AWS::URLSuffix': 'amazonaws.com',
      'AWS::StackName': 'S',
      'AWS::StackId': 'id',
    },
    conditions: {},
    physIds: {},
    liveAttrs: {},
    mappings: {},
    exports: {},
    condCache: new Map(),
    ...over,
  };
}

// Regression tests for #783: inside resource Properties, a single-key object
// `{"Condition": "SomeName"}` is LITERAL DATA (a one-key map named `Condition` inside a
// free-form JSON document), not the condition-reference intrinsic. CloudFormation honors
// `Condition:` as a function only in the top-level `Conditions` section, as a
// resource-level attribute, or inside `Fn::And/Or/Not` operands — NOT as a property
// value. Evaluating it in property position corrupted the declared value
// (`{Foo: {Condition: 'IsProd'}}` -> `Foo: false`) or dropped it to UNRESOLVED for an
// unknown name.
describe('intrinsic resolver: {Condition: name} in property position is literal (#783)', () => {
  it('passes a single-key {Condition: <known name>} through UNCHANGED in property position', () => {
    // The condition `IsProd` exists and is TRUE — but a property value must NOT be
    // evaluated to `false`/`true`; it is literal data.
    const c = ctx({ conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } } });
    expect(resolve({ Foo: { Condition: 'IsProd' } }, c)).toEqual({ Foo: { Condition: 'IsProd' } });
  });

  it('keeps a single-key {Condition: <unknown name>} literal, not UNRESOLVED', () => {
    // An unknown condition name previously resolved to UNRESOLVED (silent per-prop
    // compare skip). It must stay literal data.
    const c = ctx();
    expect(resolve({ Bar: { Condition: 'Nope' } }, c)).toEqual({ Bar: { Condition: 'Nope' } });
  });

  it('leaves a bare top-level {Condition: name} literal in a property bag', () => {
    const c = ctx({ conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } } });
    expect(resolve({ Condition: 'IsProd' }, c)).toEqual({ Condition: 'IsProd' });
  });

  it('still resolves nested intrinsics that SHARE the object with a literal Condition key', () => {
    // A property document may carry `Condition` as data alongside real intrinsics; only
    // the >1-key object walk applies, and the sibling Ref must still resolve while the
    // `Condition` string is untouched.
    const c = ctx();
    expect(resolve({ Condition: 'IsProd', Region: { Ref: 'AWS::Region' } }, c)).toEqual({
      Condition: 'IsProd',
      Region: 'us-east-1',
    });
  });

  // Regression guard: legitimate condition machinery must be UNAFFECTED.
  it('REGRESSION: Fn::If still evaluates its named condition correctly', () => {
    const c = ctx({ conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } } });
    expect(resolve({ 'Fn::If': ['IsProd', 'yes', 'no'] }, c)).toBe('yes');
    const cNo = ctx({ conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'dev'] } } });
    expect(resolve({ 'Fn::If': ['IsProd', 'yes', 'no'] }, cNo)).toBe('no');
  });

  it('REGRESSION: {Condition: name} as an Fn::And/Or/Not OPERAND is still honored', () => {
    // In condition-evaluation context (an operand inside Fn::And/Or/Not) the
    // `{Condition: name}` reference is still evaluated — only PROPERTY position is data.
    const c = ctx({ conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } } });
    expect(resolve({ 'Fn::And': [{ Condition: 'IsProd' }, true] }, c)).toBe(true);
    expect(resolve({ 'Fn::Not': [{ Condition: 'IsProd' }] }, c)).toBe(false);
    // And a condition BODY that references another condition through Fn::If's name still
    // works end-to-end.
    const chained = ctx({
      conditions: {
        Base: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] },
        Derived: { 'Fn::And': [{ Condition: 'Base' }, true] },
      },
    });
    expect(resolve({ 'Fn::If': ['Derived', 'then', 'else'] }, chained)).toBe('then');
  });
});
