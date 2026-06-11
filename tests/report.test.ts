import { describe, expect, it } from 'vite-plus/test';
import { report, stackSeparator } from '../src/report/report.js';
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
      ).toMatch(/^result: CLEAN$/m);
      // the old full (deleted=0 declared=0 ...) enumeration is gone
      expect(run([F('undeclared')]).text).not.toContain('deleted=0');
      expect(run([F('undeclared')]).text).toMatch(/result: 1 drift\(s\) \(undeclared=1\)/);
    });

    it('fail-on=declared is noted only when set', () => {
      expect(run([F('declared')]).text).not.toContain('fail-on');
      expect(run([F('declared')], { failOn: 'declared' }).text).toContain('(fail-on=declared)');
    });

    it('folds a single informational tier into a one-line info: footer', () => {
      const { text } = run([
        reason('skipped', 'custom resource — no cloud-side model to read', 'Custom::Foo'),
      ]);
      expect(text).not.toContain('[SKIPPED');
      expect(text).toContain(
        'info: skipped=1 (custom resource 1) — run with --verbose for the list'
      );
    });

    it('expands 2+ informational tiers to one bullet per tier with ONE --verbose hint (R37)', () => {
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
      const lines = text.split('\n');
      const infoIdx = lines.indexOf('info:');
      expect(infoIdx).toBeGreaterThan(-1);
      expect(lines[infoIdx + 1]).toBe('  - readGap=1 (write-only 1)');
      expect(lines[infoIdx + 2]).toMatch(
        /^ {2}- skipped=2 \(.*custom resource 1.*override target unresolved 1.*\)$/
      );
      expect(lines[infoIdx + 3]).toBe('  run with --verbose for the list');
      expect(text.match(/--verbose/g)).toHaveLength(1);
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

  describe('R32 ignored tier', () => {
    const ignored = (rule: string): Finding => ({
      tier: 'ignored',
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      path: 'DesiredCount',
      note: `ignored by config rule "${rule}"`,
    });

    it('ignored is informational — folds into info: and never sets exit 1', () => {
      const { code, text } = run([ignored('*.DesiredCount')]);
      expect(code).toBe(0);
      expect(text).toMatch(/^result: CLEAN$/m);
      expect(text).toMatch(/info: ignored=1 \("\*\.DesiredCount" 1\)/);
      expect(text).not.toContain('[IGNORED');
    });

    it('--verbose expands ignored to a full section', () => {
      const { text } = run([ignored('*.DesiredCount')], { verbose: true });
      expect(text).toContain('[IGNORED');
      expect(text).not.toContain('info:');
    });
  });

  describe('R37 spacing', () => {
    const skipped: Finding = {
      tier: 'skipped',
      logicalId: 'L',
      resourceType: 'Custom::Foo',
      path: '',
      note: 'custom resource — no cloud-side model to read',
    };

    it('CLEAN with one informational tier is exactly 3 lines: header/result/info, no blanks', () => {
      const { text } = run([skipped]);
      expect(text.split('\n')).toEqual([
        '=== cdkrd check: stack (us-east-1) ===',
        'result: CLEAN',
        'info: skipped=1 (custom resource 1) — run with --verbose for the list',
      ]);
    });

    it('drift keeps a blank line after the header but none before result:', () => {
      const lines = run([F('declared')]).text.split('\n');
      expect(lines[0]).toBe('=== cdkrd check: stack (us-east-1) ===');
      expect(lines[1]).toBe(''); // blank between header and the drift section (grouping)
      expect(lines[2]).toBe('[DECLARED DRIFT] 1');
      const resultIdx = lines.findIndex((l) => l.startsWith('result:'));
      expect(lines[resultIdx - 1]).not.toBe(''); // result follows the section directly
    });

    it('multi-stack: ONE blank line between consecutive reports, none before the first', () => {
      const out: string[] = [];
      const log = (s: string) => out.push(s);
      const separate = stackSeparator(log);
      separate();
      report([], 'StackA (ap-northeast-1)', { log });
      separate();
      report([], 'StackB (us-east-1)', { log });
      expect(out.join('\n').split('\n')).toEqual([
        '=== cdkrd check: StackA (ap-northeast-1) ===',
        'result: CLEAN',
        '',
        '=== cdkrd check: StackB (us-east-1) ===',
        'result: CLEAN',
      ]);
    });
  });
});
