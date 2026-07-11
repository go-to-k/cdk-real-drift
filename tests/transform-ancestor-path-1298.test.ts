// #1298 — a registry-schema `propertyTransform` keyed at an ANCESTOR path is consulted for a
// CHILD-path drift. A schema can key its transform at a PARENT object (AWS::Config::ConfigRule keys
// it at `Source`, an expression of the shape `$ ~> |Source|...|` that returns the whole transformed
// ROOT). When the service materializes an extra element into a CHILD of that ancestor (a
// CUSTOM_LAMBDA rule's `Source.SourceDetails` gains an `OversizedConfigurationItemChangeNotification`
// entry), calculateResourceDrift reports the divergence at the CHILD path `Source.SourceDetails`,
// where no transform is keyed. Before the fix the exact/`*` lookup at the drift path missed and the
// finding was a permanent declared False Positive (and `revert` would strip the service-required
// detail). classify now walks UP the ancestor paths and folds when transform(declaredRoot) deep-
// equals live AT the ancestor — exactly what CloudFormation's own drift detection folds. STRICTLY
// equality-gated + FAIL-OPEN, so a genuinely different live value still surfaces.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const baseSchema: Omit<SchemaInfo, 'propertyTransforms'> = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const schema = (propertyTransforms: Record<string, string>): SchemaInfo => ({
  ...baseSchema,
  propertyTransforms,
});
const declaredPaths = (fs: Finding[]): string[] =>
  fs
    .filter((f) => f.tier === 'declared')
    .map((f) => f.path)
    .sort();
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

// The transform keyed at the ancestor `Source`: evaluated on the declared ROOT it returns the whole
// transformed root, appending the service-materialized Oversized detail to Source.SourceDetails.
const SOURCE_TRANSFORM =
  '$ ~> |Source|{ "SourceDetails": [SourceDetails, { "EventSource": "aws.config", ' +
  '"MessageType": "OversizedConfigurationItemChangeNotification" }] }|';

const declaredSource = {
  Source: {
    Owner: 'CUSTOM_LAMBDA',
    SourceDetails: [
      { EventSource: 'aws.config', MessageType: 'ConfigurationItemChangeNotification' },
    ],
  },
};
// live = declared but SourceDetails carries BOTH the declared element and the Oversized one.
const liveSource = {
  Source: {
    Owner: 'CUSTOM_LAMBDA',
    SourceDetails: [
      { EventSource: 'aws.config', MessageType: 'ConfigurationItemChangeNotification' },
      { EventSource: 'aws.config', MessageType: 'OversizedConfigurationItemChangeNotification' },
    ],
  },
};

describe('#1298 ancestor-path propertyTransform folds a child-path drift', () => {
  it('Config::ConfigRule Source.SourceDetails — transform keyed at ancestor Source folds the child drift', () => {
    const res = mk('AWS::Config::ConfigRule', declaredSource);
    const s = schema({ Source: SOURCE_TRANSFORM });
    // WITHOUT the ancestor walk, the array-length change at Source.SourceDetails is a declared FP.
    const f = classifyResource(res, liveSource, s);
    expect(declaredPaths(f)).not.toContain('Source.SourceDetails');
    expect(declaredPaths(f)).not.toContain('Source');
  });

  it('CONTROL: with NO propertyTransform the same materialized element surfaces as declared drift', () => {
    const res = mk('AWS::Config::ConfigRule', declaredSource);
    const f = classifyResource(res, liveSource, baseSchema);
    // the child-path divergence must surface when nothing folds it
    expect(declaredPaths(f).some((p) => p.startsWith('Source'))).toBe(true);
  });

  it('NEGATIVE: a GENUINELY different live value at the child path STILL surfaces as drift', () => {
    const res = mk('AWS::Config::ConfigRule', declaredSource);
    const s = schema({ Source: SOURCE_TRANSFORM });
    // live is NOT transform(declared): a real out-of-band change (a THIRD, unexpected detail) —
    // transform(declaredRoot).Source != live.Source at the ancestor, so the drift must surface.
    const liveOutOfBand = {
      Source: {
        Owner: 'CUSTOM_LAMBDA',
        SourceDetails: [
          { EventSource: 'aws.config', MessageType: 'ConfigurationItemChangeNotification' },
          {
            EventSource: 'aws.config',
            MessageType: 'OversizedConfigurationItemChangeNotification',
          },
          { EventSource: 'aws.config', MessageType: 'ScheduledNotification' },
        ],
      },
    };
    const f = classifyResource(res, liveOutOfBand, s);
    expect(declaredPaths(f).some((p) => p.startsWith('Source'))).toBe(true);
  });

  it('FAIL-OPEN: a malformed ancestor transform never throws and does not fold', () => {
    const res = mk('AWS::Config::ConfigRule', declaredSource);
    const s = schema({ Source: 'this is (not valid jsonata $$$' });
    const f = classifyResource(res, liveSource, s);
    // cannot transform → the child divergence surfaces unchanged (no crash, no silent suppression)
    expect(declaredPaths(f).some((p) => p.startsWith('Source'))).toBe(true);
  });
});
