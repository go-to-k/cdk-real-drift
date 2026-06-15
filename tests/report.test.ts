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

const U = (path = 'P'): Finding => ({ ...F('undeclared', path), unrecorded: true });

describe('report unrecorded findings (R60/R62 — per finding: never decided is inventory, not drift)', () => {
  it('unrecorded findings render as [UNRECORDED: N], labelled "not drift", and do NOT count as drift', () => {
    const { code, text } = run([U(), U('Q')]);
    expect(code).toBe(0);
    expect(text).toContain('[UNRECORDED: 2]');
    expect(text).toContain('not drift —'); // R112: the section says so up front
    expect(text).not.toContain('UNDECLARED DRIFT');
    expect(text).toContain(
      'result: CLEAN — 2 unrecorded value(s) await a baseline (run cdkrd record)'
    );
  });

  it('result note names the shown/folded split so the section count and total reconcile (R112)', () => {
    // 2 standout (shown in [UNRECORDED: 2]) + 3 nested (folded) = 5 total
    const nested = (p: string): Finding => ({ ...U(p), nested: true });
    const { text } = run([U(), U('Q'), nested('a'), nested('b'), nested('c')]);
    expect(text).toContain('[UNRECORDED: 2]'); // only the standout are listed
    expect(text).toContain(
      'result: CLEAN — 5 unrecorded value(s) await a baseline (2 shown, 3 folded; run cdkrd record)'
    );
  });

  it('declared drift still fails, with unrecorded values noted beside the verdict', () => {
    const { code, text } = run([F('declared'), U('Q')]);
    expect(code).toBe(1);
    // R114: drift + standout unrecorded both visible -> combined findings framing so
    // the verdict matches the printed blocks (was a lone "1 drift(s)" beside 2 sections).
    expect(text).toContain('result: 2 findings — 1 drift (declared=1) + 1 undeclared to review');
    expect(text).not.toContain('undeclared=1'); // unrecorded never appears as a drift count
  });

  it('undeclared DRIFT and UNRECORDED coexist as separate sections (partial baseline)', () => {
    const { code, text } = run([F('undeclared'), U('Q')]);
    expect(code).toBe(1);
    expect(text).toContain('[UNDECLARED DRIFT: 1]');
    expect(text).toContain('[UNRECORDED: 1]');
    expect(text).toContain('result: 2 findings — 1 drift (undeclared=1) + 1 undeclared to review');
  });

  it('mixed findings line counts only SHOWN unrecorded; folded ones stay a parenthetical (R114)', () => {
    // 1 declared drift + 1 standout unrecorded (shown) + 2 nested unrecorded (folded)
    const nested = (p: string): Finding => ({ ...U(p), nested: true });
    const { code, text } = run([F('declared'), U('Q'), nested('a'), nested('b')]);
    expect(code).toBe(1);
    expect(text).toContain(
      'result: 2 findings — 1 drift (declared=1) + 1 undeclared to review (2 folded; run cdkrd record)'
    );
  });

  it('deleted still fails alongside unrecorded values (a gone resource is drift, baseline or not)', () => {
    expect(run([F('deleted', ''), U()]).code).toBe(1);
  });

  it('json: drifted excludes unrecorded values; findings keep the undeclared tier + the flag', () => {
    const { code, text } = run([U()], { json: true });
    const parsed = JSON.parse(text);
    expect(code).toBe(0);
    expect(parsed.drifted).toBe(0);
    expect(parsed.findings[0].tier).toBe('undeclared');
    expect(parsed.findings[0].unrecorded).toBe(true);
  });

  it('untagged undeclared (recorded value changed / appeared since record) is drift as before', () => {
    const { code, text } = run([F('undeclared')]);
    expect(code).toBe(1);
    expect(text).toContain('[UNDECLARED DRIFT: 1]');
  });
});

describe('report', () => {
  it('exit 0 when no drift tiers present', () => {
    expect(run([F('readGap'), F('skipped'), F('unresolved')]).code).toBe(0);
  });

  it('exit 1 on declared or undeclared', () => {
    expect(run([F('declared')]).code).toBe(1);
    expect(run([F('undeclared')]).code).toBe(1);
  });

  it('deleted counts as drift (exit 1)', () => {
    expect(run([F('deleted')]).code).toBe(1);
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

  it('section header carries the count INSIDE the brackets, note outside (R48)', () => {
    const { text } = run([F('undeclared'), F('declared', 'Q')]);
    expect(text).toContain(
      '[UNDECLARED DRIFT: 1] (live-only (not in your CloudFormation template), changed from your .cdkrd baseline — the differentiator)'
    );
    // declared is now anchored to the deployed CloudFormation template (CFn-) so it
    // can't be misread as "in my CDK code" or "in the .cdkrd baseline"
    expect(text).toContain(
      '[CFn-DECLARED DRIFT: 1] (declared in your CloudFormation template — the live value differs)'
    );
    // the old bare-digit-right-of-bracket form is gone
    expect(text).not.toMatch(/\] \d/);
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
      expect(lines[infoIdx + 1]).toBe(
        "  - readGap=1 (declared but unverifiable — AWS doesn't return them on read, not drift: 1 write-only)"
      );
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

  describe('R86 atDefault tier (undeclared values at a known AWS default — folded, never drift)', () => {
    const AD = (path = 'P'): Finding => ({
      tier: 'atDefault',
      logicalId: 'L',
      resourceType: 'AWS::Lambda::Function',
      path,
      actual: { Mode: 'PassThrough' },
    });

    it('folds into the info: footer and never sets exit 1 (CLEAN)', () => {
      const { code, text } = run([AD('TracingConfig'), AD('PackageType')]);
      expect(code).toBe(0);
      expect(text).toMatch(/^result: CLEAN$/m);
      expect(text).toContain(
        'info: atDefault=2 (undeclared values matching a known AWS default — not drift)'
      );
      // never listed in the body by default, and never a drift section
      expect(text).not.toContain('[AT AWS DEFAULT');
      expect(text).not.toContain('TracingConfig =');
    });

    it('a real undeclared value is listed in the body while at-default values stay folded', () => {
      const { code, text } = run([U('RealEdit'), AD('TracingConfig'), AD('PackageType')]);
      // U() is unrecorded (not drift) → CLEAN, but the real value is shown; defaults fold
      expect(code).toBe(0);
      expect(text).toContain('[UNRECORDED: 1]');
      expect(text).toContain('L.RealEdit');
      expect(text).toContain('atDefault=2');
      expect(text).not.toContain('[AT AWS DEFAULT');
    });

    it('--verbose expands atDefault to a full section with each value shown', () => {
      const { text } = run([AD('TracingConfig')], { verbose: true });
      expect(text).toContain('[AT AWS DEFAULT: 1]');
      expect(text).toContain('L.TracingConfig (AWS::Lambda::Function) = {"Mode":"PassThrough"}');
      expect(text).not.toContain('info:');
    });

    it('--show-all (expandAtDefault) expands ONLY atDefault; other info tiers stay folded', () => {
      const { text } = run(
        [
          AD('TracingConfig'),
          { ...F('skipped'), note: 'custom resource', resourceType: 'Custom::X' },
        ],
        { expandAtDefault: true }
      );
      expect(text).toContain('[AT AWS DEFAULT: 1]'); // expanded
      expect(text).toContain('info: skipped=1'); // still folded
    });
  });

  describe('generated tier (AWS/CDK auto-generated names/identifiers — folded, never drift)', () => {
    const G = (path = 'TopicName'): Finding => ({
      tier: 'generated',
      logicalId: 'L',
      resourceType: 'AWS::SNS::Topic',
      path,
      actual: 'Stack-TopicABC123-9F16VRgpExOs',
    });

    it('folds into the info: footer with a plain-English label and never sets exit 1', () => {
      const { code, text } = run([G('TopicName'), G('LoggingConfig')]);
      expect(code).toBe(0);
      expect(text).toMatch(/^result: CLEAN$/m);
      expect(text).toContain(
        'info: generated=2 (auto-generated identifiers not in your template, AWS-assigned at deploy — not drift)'
      );
      expect(text).not.toContain('[AWS GENERATED');
      expect(text).not.toContain('TopicName =');
    });

    it('--verbose expands generated to a full section showing each value', () => {
      const { text } = run([G('TopicName')], { verbose: true });
      expect(text).toContain('[AWS GENERATED: 1]');
      expect(text).toContain('L.TopicName (AWS::SNS::Topic) = "Stack-TopicABC123-9F16VRgpExOs"');
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

    it('drift: first section directly under the header; blank line BEFORE result: (R48)', () => {
      const lines = run([F('declared')]).text.split('\n');
      expect(lines[0]).toBe('=== cdkrd check: stack (us-east-1) ===');
      expect(lines[1]).toMatch(/^\[CFn-DECLARED DRIFT: 1\]/); // no stray blank after the header
      const resultIdx = lines.findIndex((l) => l.startsWith('result:'));
      expect(lines[resultIdx - 1]).toBe(''); // the verdict is separated from the section above
    });

    it('two drift sections: blank BETWEEN them, none after the header (R48)', () => {
      const lines = run([F('declared'), F('undeclared', 'Q')]).text.split('\n');
      expect(lines[0]).toBe('=== cdkrd check: stack (us-east-1) ===');
      expect(lines[1]).toMatch(/^\[CFn-DECLARED DRIFT: 1\]/);
      const undeclaredIdx = lines.findIndex((l) => l.startsWith('[UNDECLARED'));
      expect(lines[undeclaredIdx - 1]).toBe(''); // grouping blank between sections
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

    // R78: an ELB attribute-bag drift names the changed attribute by Key
    // (LoadBalancerAttributes[idle_timeout.timeout_seconds]) instead of a bare path.
    it('declared drift with attributeKey names the attribute by Key', () => {
      const finding: Finding = {
        tier: 'declared',
        logicalId: 'Edge',
        resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        path: 'LoadBalancerAttributes',
        attributeKey: 'idle_timeout.timeout_seconds',
        desired: '120',
        actual: '300',
      };
      const { text } = run([finding]);
      expect(text).toContain('LoadBalancerAttributes[idle_timeout.timeout_seconds]');
      expect(text).toContain('desired=');
    });
  });
});

describe('R96 nested unrecorded folding', () => {
  const NU = (path: string, nested?: boolean): Finding => ({
    tier: 'undeclared',
    logicalId: 'L',
    resourceType: 'T',
    path,
    actual: 1,
    unrecorded: true,
    ...(nested ? { nested: true } : {}),
  });
  it('nested unrecorded folds into info:, top-level lists in [UNRECORDED]', () => {
    const { text } = run([NU('TopLevel'), NU('Conf.A', true), NU('Conf.B', true)]);
    expect(text).toContain('[UNRECORDED: 1]');
    expect(text).toContain('L.TopLevel');
    expect(text).toContain('nested=2');
    expect(text).not.toContain('Conf.A');
  });
  it('--show-all expands nested into the body (no fold line)', () => {
    const { text } = run([NU('Conf.A', true)], { expandAtDefault: true });
    expect(text).toContain('L.Conf.A');
    expect(text).not.toContain('nested=1');
  });
  it('--verbose also expands nested', () => {
    const { text } = run([NU('Conf.A', true)], { verbose: true });
    expect(text).toContain('L.Conf.A');
  });
});
