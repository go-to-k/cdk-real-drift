// #660 follow-up: reverting an out-of-band EKS endpoint lockdown must CONVERGE. EKS
// `update-cluster-config` rejects an endpoint patch that omits either access flag ("The new
// template must include all the properties specified in the previous template, property
// EndpointPrivateAccess missing" — live-proven on Cdkrd660EksRevertVerify). So the plan's bare
// `remove` of the out-of-band `EndpointPrivateAccess=true` failed the WHOLE patch, taking the
// paired `EndpointPublicAccess` set-default down with it. Pinning `EndpointPrivateAccess: false`
// in KNOWN_DEFAULT_PATHS routes it through the nested set-default fallback (`add false`), so the
// patch carries both flags and reverts to the default {public:true, private:false}.
import { describe, expect, it } from 'vite-plus/test';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

const undeclaredF = (over: Partial<Finding>): Finding => ({
  tier: 'undeclared',
  unrecorded: true,
  logicalId: 'Cluster',
  physicalId: 'cdkrd660eks',
  resourceType: 'AWS::EKS::Cluster',
  path: 'ResourcesVpcConfig.EndpointPrivateAccess',
  ...over,
});

describe('#660 EKS endpoint revert converges (nested set-default, not remove)', () => {
  it('an out-of-band undeclared EndpointPrivateAccess=true reverts as set-default `false`, NOT a remove', () => {
    const f = undeclaredF({ path: 'ResourcesVpcConfig.EndpointPrivateAccess', actual: true });
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.items).toHaveLength(1);
    // Without the KNOWN_DEFAULT_PATHS pin this would be `{ op: 'remove' }`, which EKS rejects.
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/ResourcesVpcConfig/EndpointPrivateAccess',
      value: false,
    });
  });

  it('the paired EndpointPublicAccess=false reverts as set-default `true` (patch then carries both flags)', () => {
    const f = undeclaredF({ path: 'ResourcesVpcConfig.EndpointPublicAccess', actual: false });
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/ResourcesVpcConfig/EndpointPublicAccess',
      value: true,
    });
  });
});
