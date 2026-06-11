import { describe, expect, it } from 'vite-plus/test';
import { report } from '../src/report/report.js';
import type { Finding } from '../src/types.js';

const F = (tier: Finding['tier'], path = 'P'): Finding => ({
  tier,
  logicalId: 'L',
  resourceType: 'AWS::X::Y',
  path,
  actual: 1,
});

function run(findings: Finding[], opts: Parameters<typeof report>[2] = {}) {
  const lines: string[] = [];
  const code = report(findings, 'stack (us-east-1)', { ...opts, log: (s) => lines.push(s) });
  return { code, text: lines.join('\n') };
}

describe('report', () => {
  it('exit 0 when no drift tiers present', () => {
    expect(run([F('readGap'), F('skipped'), F('unresolved')]).code).toBe(0);
  });

  it('exit 1 on declared or undeclared (default fail-on)', () => {
    expect(run([F('declared')]).code).toBe(1);
    expect(run([F('undeclared')]).code).toBe(1);
  });

  it('--fail-on declared ignores undeclared for exit code', () => {
    expect(run([F('undeclared')], { failOn: 'declared' }).code).toBe(0);
    expect(run([F('declared')], { failOn: 'declared' }).code).toBe(1);
  });

  it('deleted is ALWAYS exit 1, regardless of --fail-on', () => {
    expect(run([F('deleted')]).code).toBe(1);
    expect(run([F('deleted')], { failOn: 'declared' }).code).toBe(1);
  });

  it('deleted appears as its own tier section in text output', () => {
    const { text } = run([F('deleted', '')]);
    expect(text).toContain('DELETED');
  });

  it('json mode emits parseable JSON with findings + drifted count', () => {
    const { code, text } = run([F('undeclared'), F('skipped')], { json: true });
    const parsed = JSON.parse(text);
    expect(code).toBe(1);
    expect(parsed.drifted).toBe(1);
    expect(parsed.findings).toHaveLength(2);
  });

  it('text mode groups by tier with counts', () => {
    const { text } = run([F('undeclared')]);
    expect(text).toContain('UNDECLARED DRIFT');
    expect(text).toContain('result:');
  });

  it('shows the CDK construct path instead of the logical id when present', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'Bucket83908E77',
      constructPath: 'MyStack/Bucket',
      resourceType: 'AWS::S3::Bucket',
      path: 'AbacStatus',
      actual: 'Disabled',
    };
    const { text } = run([f]);
    expect(text).toContain('MyStack/Bucket.AbacStatus');
    expect(text).not.toContain('Bucket83908E77');
  });

  describe('R25 default terseness + --verbose', () => {
    const reason = (tier: Finding['tier'], note: string, resourceType = 'AWS::X::Y'): Finding => ({
      tier,
      logicalId: 'L',
      resourceType,
      path: tier === 'unresolved' ? 'P' : '',
      note,
    });

    it('does NOT print a 0-count tier header (CLEAN stack is compact)', () => {
      const { text } = run([reason('readGap', 'write-only — cannot be read back')]);
      expect(text).not.toContain('DECLARED DRIFT');
      expect(text).not.toContain('UNDECLARED');
      expect(text).not.toContain('DELETED');
    });

    it('result: line lists only non-zero DRIFT counts; CLEAN prints just CLEAN', () => {
      expect(
        run([reason('skipped', 'custom resource — no cloud-side model to read')]).text
      ).toContain('\nresult: CLEAN');
      // the old full (deleted=0 declared=0 ...) enumeration is gone
      expect(run([F('undeclared')]).text).not.toContain('deleted=0');
      expect(run([F('undeclared')]).text).toMatch(/result: 1 drift\(s\) \(undeclared=1\)/);
    });

    it('fail-on=declared is noted only when set', () => {
      expect(run([F('declared')]).text).not.toContain('fail-on');
      expect(run([F('declared')], { failOn: 'declared' }).text).toContain('(fail-on=declared)');
    });

    it('folds informational tiers into a single info: line with a reason breakdown', () => {
      const findings: Finding[] = [
        reason('readGap', 'write-only — cannot be read back'),
        reason('skipped', 'custom resource — no cloud-side model to read', 'Custom::Foo'),
        reason(
          'skipped',
          'SDK override: target not resolvable from template',
          'AWS::Lambda::Permission'
        ),
      ];
      const { text } = run(findings);
      expect(text).not.toContain('[SKIPPED');
      expect(text).not.toContain('[READ GAP');
      expect(text).toMatch(/info: .*readGap=1 \(write-only 1\)/);
      expect(text).toMatch(/skipped=2 \(.*custom resource 1.*override target unresolved 1.*\)/);
      expect(text).toContain('--verbose');
    });

    it('result: appears ABOVE the info: footer', () => {
      const lines = run([reason('readGap', 'write-only — cannot be read back')]).text.split('\n');
      const resultIdx = lines.findIndex((l) => l.startsWith('result:'));
      const infoIdx = lines.findIndex((l) => l.startsWith('info:'));
      expect(resultIdx).toBeGreaterThanOrEqual(0);
      expect(infoIdx).toBeGreaterThan(resultIdx);
    });

    it('--verbose expands informational tiers to full sections below result', () => {
      const { text } = run(
        [reason('skipped', 'custom resource — no cloud-side model to read', 'Custom::Foo')],
        {
          verbose: true,
        }
      );
      expect(text).toContain('[SKIPPED');
      expect(text).not.toContain('info:');
      const lines = text.split('\n');
      expect(lines.findIndex((l) => l.includes('[SKIPPED'))).toBeGreaterThan(
        lines.findIndex((l) => l.startsWith('result:'))
      );
    });

    it('drift tiers stay fully detailed regardless of verbose', () => {
      expect(run([F('declared')]).text).toContain('DECLARED DRIFT');
      expect(run([F('declared')], { verbose: true }).text).toContain('DECLARED DRIFT');
    });

    it('no info: line when there are no informational findings', () => {
      expect(run([F('declared')]).text).not.toContain('info:');
    });
  });
});
