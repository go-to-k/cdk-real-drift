// #727: under `--pre-deploy`, a resource that exists in the LOCAL synth template but is
// not yet deployed has no physical id → gather.ts lands it in the `skipped` tier with
// reason "no physical id". On the normal (deployed) path that IS a real coverage gap
// (a deployed template resource should have a physical id — cf. #689). Under --pre-deploy
// it is EXPECTED (pending creation), so it must NOT drive the `--strict` coverage exit,
// while OTHER skip reasons (CC-unsupported / read errors) stay genuine gaps even there.
import { describe, expect, it } from 'vite-plus/test';
import {
  coverageWarning,
  hasCoverageGap,
  isPendingCreationSkip,
  pendingCreationInfo,
  strictCoverageExit,
} from '../src/commands/check.js';
import type { DesiredResource, Finding } from '../src/types.js';

// The exact "no physical id" skip gather.ts emits for a template resource with no
// deployed physical id (src/commands/gather.ts classifyRead: tier 'skipped', note
// 'no physical id').
const noPhysId = (logicalId: string, over: Partial<Finding> = {}): Finding => ({
  tier: 'skipped',
  logicalId,
  resourceType: 'AWS::SQS::Queue',
  path: '',
  note: 'no physical id',
  ...over,
});

// A DIFFERENT skip reason (an unread / CC-unsupported resource) — a genuine coverage
// gap regardless of --pre-deploy.
const unread = (logicalId: string, over: Partial<Finding> = {}): Finding => ({
  tier: 'skipped',
  logicalId,
  resourceType: 'AWS::X::Y',
  path: '',
  note: 'not readable',
  ...over,
});

const dr = (resourceType: string): DesiredResource => ({
  logicalId: 'L',
  resourceType,
  declared: {},
});

const topic = [dr('AWS::SNS::Topic')];

describe('isPendingCreationSkip (#727 — matches ONLY the no-physical-id skip)', () => {
  it('matches a skipped finding whose note is exactly "no physical id"', () => {
    expect(isPendingCreationSkip(noPhysId('Q'))).toBe(true);
  });

  it('does NOT match other skip reasons (CC-unsupported / read error)', () => {
    expect(isPendingCreationSkip(unread('Q'))).toBe(false);
    expect(isPendingCreationSkip({ ...noPhysId('Q'), note: 'not readable' })).toBe(false);
  });

  it('does NOT match a non-skipped tier even with the same note', () => {
    expect(isPendingCreationSkip({ ...noPhysId('Q'), tier: 'declared' })).toBe(false);
  });
});

describe('hasCoverageGap under --pre-deploy (#727)', () => {
  it('NON-pre-deploy: a no-physical-id skip is a real coverage gap (unchanged behavior)', () => {
    expect(hasCoverageGap([noPhysId('Q')], topic)).toBe(true);
    expect(hasCoverageGap([noPhysId('Q')], topic, false)).toBe(true);
  });

  it('--pre-deploy: a no-physical-id skip is NOT a coverage gap (pending creation)', () => {
    expect(hasCoverageGap([noPhysId('Q')], topic, true)).toBe(false);
  });

  it('--pre-deploy: a DIFFERENT skip reason still IS a coverage gap', () => {
    expect(hasCoverageGap([unread('Q')], topic, true)).toBe(true);
  });

  it('--pre-deploy: a nested stack still IS a coverage gap even with only pending-creation skips', () => {
    expect(hasCoverageGap([noPhysId('Q')], [dr('AWS::CloudFormation::Stack')], true)).toBe(true);
  });
});

describe('strictCoverageExit under --pre-deploy (#727 — the core false-fail fix)', () => {
  it('WITHOUT --pre-deploy, --strict on a no-physical-id skip exits 1 (real gap)', () => {
    // The regression this fixes: without the preDeploy flag threaded, this stays 1.
    expect(strictCoverageExit(true, [noPhysId('Q')], topic /* preDeploy defaults false */)).toBe(1);
  });

  it('WITH --pre-deploy, --strict on a no-physical-id skip exits 0 (pending creation, not a gap)', () => {
    // The exact --pre-deploy workflow: a feature branch ADDS a queue, zero real drift.
    expect(strictCoverageExit(true, [noPhysId('Q')], topic, true)).toBe(0);
  });

  it('WITH --pre-deploy, a DIFFERENT skip reason still fails --strict (genuine gap)', () => {
    expect(strictCoverageExit(true, [unread('Q')], topic, true)).toBe(1);
  });

  it('WITH --pre-deploy but no --strict, a genuine gap still exits 0 (strict axis only)', () => {
    expect(strictCoverageExit(false, [unread('Q')], topic, true)).toBe(0);
  });
});

describe('coverageWarning under --pre-deploy (#727 — no false under-coverage warning)', () => {
  it('--pre-deploy: a pure no-physical-id skip produces NO coverage warning', () => {
    expect(coverageWarning([noPhysId('Q')], 'S', true)).toBeNull();
  });

  it('NON-pre-deploy: a no-physical-id skip still warns (unchanged behavior)', () => {
    expect(coverageWarning([noPhysId('Q')], 'S')).toContain('1 resource(s) were NOT checked');
  });

  it('--pre-deploy: a genuine unread skip still warns, and its count excludes pending-creation', () => {
    const w = coverageWarning([noPhysId('Q'), unread('R')], 'S', true)!;
    expect(w).toContain('1 resource(s) were NOT checked');
  });
});

describe('pendingCreationInfo (#727 — informational surface)', () => {
  it('is null when nothing is pending creation', () => {
    expect(
      pendingCreationInfo([unread('Q'), { ...noPhysId('Q'), tier: 'declared' }], 'S')
    ).toBeNull();
  });

  it('counts + lists not-yet-deployed local resources (framed as pending, not a gap)', () => {
    const info = pendingCreationInfo(
      [noPhysId('B', { constructPath: 'S/Zeta' }), noPhysId('A', { constructPath: 'S/Alpha' })],
      'MyStack'
    )!;
    expect(info).toContain('MyStack: 2 resource(s) not yet deployed');
    expect(info).toContain('pending creation, not a coverage gap');
    expect(info).toContain('S/Alpha, S/Zeta'); // construct path preferred, sorted
  });

  it('ignores other skip reasons entirely', () => {
    expect(pendingCreationInfo([unread('Q')], 'S')).toBeNull();
  });
});
