// #1726 / #1727 — non-Standard log classes, live-found on the 2026-08-03 varpack hunt:
//   - #1726: the LogGroup child enumerator's DescribeMetricFilters REJECTS
//     INFREQUENT_ACCESS and DELIVERY groups (ValidationException "This operation is only
//     supported on the Standard log class"), which failed the whole added-resource scan
//     and demoted the resource to `skipped` on EVERY check. The guard treats that exact
//     rejection as an empty inventory (the child kind cannot exist there).
//   - #1727: a DELIVERY-class group materializes the FIXED 2-day retention
//     (RetentionInDays: 2) — a barest DELIVERY group first-ran it as [Potential Drift].
//     Derived (tier-2) from the declared LogGroupClass; PutRetentionPolicy rejects
//     DELIVERY groups, so the fold hides no reachable out-of-band change.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { logsDeliveryDerivedRetention } from '../src/normalize/derived-defaults.js';
import { tolerateNonStandardLogClass } from '../src/read/child-enumerators.js';
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

const tierPaths = (findings: Finding[]) => findings.map((f) => `${f.tier}:${f.path}`).sort();

describe('#1726: tolerateNonStandardLogClass', () => {
  const classError = () =>
    Object.assign(new Error('This operation is only supported on the Standard log class.'), {
      name: 'ValidationException',
    });

  it('treats the Standard-log-class rejection as an empty inventory', async () => {
    await expect(tolerateNonStandardLogClass(() => Promise.reject(classError()))).resolves.toEqual(
      []
    );
  });

  it('passes a successful inventory through', async () => {
    await expect(
      tolerateNonStandardLogClass(() => Promise.resolve([{ filterName: 'f1' }]))
    ).resolves.toEqual([{ filterName: 'f1' }]);
  });

  it('rethrows any OTHER failure (a real scan failure must stay loud)', async () => {
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    await expect(tolerateNonStandardLogClass(() => Promise.reject(denied))).rejects.toThrow(
      /not authorized/
    );
    const otherValidation = Object.assign(new Error('Invalid parameter'), {
      name: 'ValidationException',
    });
    await expect(
      tolerateNonStandardLogClass(() => Promise.reject(otherValidation))
    ).rejects.toThrow(/Invalid parameter/);
  });
});

// The live varpack shape: a barest DELIVERY-class group (name + class declared only).
const deliveryGroup: DesiredResource = {
  logicalId: 'DeliveryLg',
  resourceType: 'AWS::Logs::LogGroup',
  physicalId: 'cdkrd-hunt-varpack-0803-delivery',
  declared: {
    LogGroupName: 'cdkrd-hunt-varpack-0803-delivery',
    LogGroupClass: 'DELIVERY',
  },
};

const liveDelivery = (retention: number) => ({
  LogGroupName: 'cdkrd-hunt-varpack-0803-delivery',
  LogGroupClass: 'DELIVERY',
  RetentionInDays: retention,
});

describe('#1727: DELIVERY-class LogGroup RetentionInDays derived fold', () => {
  it('derives 2 for DELIVERY and nothing for the other classes', () => {
    expect(logsDeliveryDerivedRetention('DELIVERY')).toBe(2);
    expect(logsDeliveryDerivedRetention('STANDARD')).toBeUndefined();
    expect(logsDeliveryDerivedRetention('INFREQUENT_ACCESS')).toBeUndefined();
    expect(logsDeliveryDerivedRetention(undefined)).toBeUndefined();
  });

  it('folds the materialized 2-day retention to atDefault (zero potential drift)', () => {
    const f = classifyResource(deliveryGroup, liveDelivery(2), emptySchema);
    expect(tierPaths(f)).toEqual(['atDefault:RetentionInDays']);
  });

  it('stays equality-gated: a non-default retention would still surface', () => {
    const f = classifyResource(deliveryGroup, liveDelivery(7), emptySchema);
    expect(tierPaths(f)).toEqual(['undeclared:RetentionInDays']);
  });

  it('does NOT fold a STANDARD group retention (live only carries it when set)', () => {
    const standard: DesiredResource = {
      ...deliveryGroup,
      declared: { LogGroupName: 'lg-std' },
    };
    const f = classifyResource(
      standard,
      { LogGroupName: 'lg-std', RetentionInDays: 2 },
      emptySchema
    );
    expect(tierPaths(f)).toEqual(['undeclared:RetentionInDays']);
  });
});
