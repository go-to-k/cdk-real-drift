// #975 item 4 — an AWS::GlobalAccelerator::EndpointGroup that omits HealthCheckPort reads back
// its LISTENER's port (AWS resolves the schema -1 sentinel default to the listener's first
// PortRanges FromPort). classify derives + equality-gates the undeclared HealthCheckPort from the
// sibling listener's port, threaded via opts.siblingListenerPorts (keyed by the declared
// ListenerArn). Assert the clean-deploy fold to atDefault AND that a value away from the derived
// port still surfaces as undeclared (out-of-band change detection preserved).
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
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const LISTENER_ARN = 'arn:aws:globalaccelerator::111111111111:accelerator/abc/listener/98a22ab1';

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Group',
  resourceType: 'AWS::GlobalAccelerator::EndpointGroup',
  physicalId: `${LISTENER_ARN}/endpoint-group/363328af8002`,
  declared,
});

describe('#975 GlobalAccelerator EndpointGroup HealthCheckPort derived from sibling listener', () => {
  it('folds HealthCheckPort to the sibling listener first PortRanges FromPort', () => {
    const res = mk({ EndpointGroupRegion: 'us-east-1', ListenerArn: LISTENER_ARN });
    const f = classifyResource(res, { HealthCheckPort: 80 }, emptySchema, {
      siblingListenerPorts: { [LISTENER_ARN]: 80 },
    });
    expect(tier(f, 'atDefault')).toContain('HealthCheckPort');
    expect(tier(f, 'undeclared')).not.toContain('HealthCheckPort');
  });

  it('surfaces an out-of-band HealthCheckPort away from the listener port — detection preserved', () => {
    const res = mk({ EndpointGroupRegion: 'us-east-1', ListenerArn: LISTENER_ARN });
    const f = classifyResource(res, { HealthCheckPort: 9999 }, emptySchema, {
      siblingListenerPorts: { [LISTENER_ARN]: 80 },
    });
    expect(tier(f, 'undeclared')).toContain('HealthCheckPort');
    expect(tier(f, 'atDefault')).not.toContain('HealthCheckPort');
  });

  it('does NOT fold when no sibling listener port is threaded (fail-open, surfaces)', () => {
    const res = mk({ EndpointGroupRegion: 'us-east-1', ListenerArn: LISTENER_ARN });
    const f = classifyResource(res, { HealthCheckPort: 80 }, emptySchema, {});
    expect(tier(f, 'undeclared')).toContain('HealthCheckPort');
    expect(tier(f, 'atDefault')).not.toContain('HealthCheckPort');
  });

  it('does NOT fold when the listener declares a different port (443 listener, 80 live)', () => {
    const res = mk({ EndpointGroupRegion: 'us-east-1', ListenerArn: LISTENER_ARN });
    const f = classifyResource(res, { HealthCheckPort: 80 }, emptySchema, {
      siblingListenerPorts: { [LISTENER_ARN]: 443 },
    });
    expect(tier(f, 'undeclared')).toContain('HealthCheckPort');
  });
});
