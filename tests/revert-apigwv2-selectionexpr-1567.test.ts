// #1567: the ApiGatewayV2 Response-type update handlers keep an omitted *SelectionExpression,
// so a bare `remove` revert of an out-of-band expression is a silent no-op (live-proven on a
// WebSocket API 2026-07-13: TemplateSelectionExpression "200" on an IntegrationResponse and
// ModelSelectionExpression "huntexpr" on a RouteResponse both survived a `remove` that
// reported success). An explicit empty string clears the value to null (also live-proven), so
// the plan must emit an `add ''` set-default write instead of a `remove` — the
// REVERT_SET_DEFAULT_PATHS + REVERT_SET_DEFAULT_VALUES ('') pair.
import { describe, expect, it } from 'vite-plus/test';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

const unrecordedUndeclared = (resourceType: string, path: string, actual: unknown): Finding => ({
  tier: 'undeclared',
  logicalId: 'R',
  resourceType,
  path,
  physicalId: 'api|parent|child',
  actual,
});

describe('#1567 ApiGatewayV2 SelectionExpression revert plans an explicit empty-string write', () => {
  it("IntegrationResponse.TemplateSelectionExpression -> add ''", () => {
    const f = unrecordedUndeclared(
      'AWS::ApiGatewayV2::IntegrationResponse',
      'TemplateSelectionExpression',
      '200'
    );
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/TemplateSelectionExpression',
      value: '',
    });
  });

  it("RouteResponse.ModelSelectionExpression -> add ''", () => {
    const f = unrecordedUndeclared(
      'AWS::ApiGatewayV2::RouteResponse',
      'ModelSelectionExpression',
      'huntexpr'
    );
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/ModelSelectionExpression',
      value: '',
    });
  });

  it('an unrelated ApiGatewayV2 undeclared path still plans a plain remove', () => {
    const f = unrecordedUndeclared('AWS::ApiGatewayV2::RouteResponse', 'ResponseModels', {
      x: 'y',
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items[0]!.ops[0]).toMatchObject({ op: 'remove', path: '/ResponseModels' });
  });
});
