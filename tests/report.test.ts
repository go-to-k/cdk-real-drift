import { describe, expect, it } from 'vite-plus/test';
import { jPair, report, safeSlice, stackSeparator } from '../src/report/report.js';
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
  it('unrecorded findings render as [Not Recorded: N], labelled "not drift", and do NOT count as drift', () => {
    const { code, text } = run([U(), U('Q')]);
    expect(code).toBe(0);
    expect(text).toContain('[Not Recorded: 2]');
    expect(text).toContain('not drift —'); // R112: the section says so up front
    expect(text).not.toContain('Undeclared Drift');
    expect(text).toContain(
      'result: CLEAN — 2 unrecorded value(s) await a baseline (run cdkrd record)'
    );
  });

  it('result note names the shown/folded split so the section count and total reconcile (R112)', () => {
    // 2 standout (shown in [Not Recorded: 2]) + 3 nested (folded) = 5 total
    const nested = (p: string): Finding => ({ ...U(p), nested: true });
    const { text } = run([U(), U('Q'), nested('a'), nested('b'), nested('c')]);
    expect(text).toContain('[Not Recorded: 2]'); // only the standout are listed
    expect(text).toContain(
      'result: CLEAN — 5 unrecorded value(s) await a baseline (2 shown, 3 folded; run cdkrd record)'
    );
  });

  it('R138/R139: first run (no baseline) expands nested + NO DRIFT verdict, one section name', () => {
    // All three nested — in steady state they would fold to "0 shown, 3 folded"; on a
    // first run they expand so the report lists the same set the record prompt offers.
    const nested = (p: string): Finding => ({ ...U(p), nested: true });
    const { code, text } = run([nested('a'), nested('b'), nested('c')], { firstRun: true });
    expect(code).toBe(0); // unrecorded never counts as drift
    expect(text).toContain('[Not Recorded: 3]'); // R139: one section name in both states
    expect(text).toContain('result: NO DRIFT — 3 value(s) to record (run cdkrd record)');
    expect(text).not.toContain('CLEAN'); // the contradiction we are fixing
    expect(text).not.toContain('shown'); // no "X shown, Y folded" split on a first run
    expect(text).not.toContain('folded');
  });

  it('R139: steady state, ALL unrecorded nested -> 0-shown guard expands them (never "0 shown")', () => {
    // No firstRun: nested would normally fold, but folding every value would print
    // "0 shown, 3 folded" and the record prompt would still ask about all 3. The guard
    // expands them so the report and the prompt agree. Verdict stays the steady CLEAN line.
    const nested = (p: string): Finding => ({ ...U(p), nested: true });
    const { code, text } = run([nested('a'), nested('b'), nested('c')]);
    expect(code).toBe(0);
    expect(text).toContain('[Not Recorded: 3]'); // all 3 listed, not folded away
    expect(text).toContain(
      'result: CLEAN — 3 unrecorded value(s) await a baseline (run cdkrd record)'
    );
    expect(text).not.toContain('0 shown'); // the residual this guard closes
    expect(text).not.toContain('folded');
  });

  it('R138: first run with drift keeps the combined mixed verdict (firstRun only refines no-drift)', () => {
    const { code, text } = run([F('declared'), U('Q')], { firstRun: true });
    expect(code).toBe(1);
    expect(text).toContain('result: 2 findings — 1 drift (declared=1) + 1 not-recorded to review');
    expect(text).not.toContain('NO DRIFT'); // the to-record verdict is suppressed when drift exists
  });

  it('R138: first run with nothing to record is still plain CLEAN', () => {
    const { code, text } = run([], { firstRun: true });
    expect(code).toBe(0);
    expect(text).toContain('result: CLEAN');
    expect(text).not.toContain('to record');
  });

  it('declared drift still fails, with unrecorded values noted beside the verdict', () => {
    const { code, text } = run([F('declared'), U('Q')]);
    expect(code).toBe(1);
    // R114: drift + standout unrecorded both visible -> combined findings framing so
    // the verdict matches the printed blocks (was a lone "1 drift(s)" beside 2 sections).
    expect(text).toContain('result: 2 findings — 1 drift (declared=1) + 1 not-recorded to review');
    expect(text).not.toContain('undeclared=1'); // unrecorded never appears as a drift count
  });

  it('undeclared DRIFT and Not Recorded coexist as separate sections (partial baseline)', () => {
    const { code, text } = run([F('undeclared'), U('Q')]);
    expect(code).toBe(1);
    expect(text).toContain('[CFn-Undeclared Drift: 1]');
    expect(text).toContain('[Not Recorded: 1]');
    expect(text).toContain(
      'result: 2 findings — 1 drift (undeclared=1) + 1 not-recorded to review'
    );
  });

  it('mixed findings line counts only SHOWN unrecorded; folded ones stay a parenthetical (R114)', () => {
    // 1 declared drift + 1 standout unrecorded (shown) + 2 nested unrecorded (folded)
    const nested = (p: string): Finding => ({ ...U(p), nested: true });
    const { code, text } = run([F('declared'), U('Q'), nested('a'), nested('b')]);
    expect(code).toBe(1);
    expect(text).toContain(
      'result: 2 findings — 1 drift (declared=1) + 1 not-recorded to review (2 folded; run cdkrd record)'
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
    expect(text).toContain('[CFn-Undeclared Drift: 1]');
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
    expect(text).toContain('Deleted');
  });

  it('added counts as drift (exit 1) and renders its own tier section', () => {
    const f: Finding = {
      tier: 'added',
      logicalId: 'Api/abc|root|ANY',
      physicalId: 'abc|root|ANY',
      constructPath: 'Stack/Api ▸ ANY /',
      resourceType: 'AWS::ApiGateway::Method',
      path: '',
      note: 'created out of band — not in your CloudFormation template',
    };
    const { code, text } = run([f]);
    expect(code).toBe(1);
    expect(text).toContain('Added Resource');
    expect(text).toContain('Stack/Api ▸ ANY /');
  });

  it('PR4: an UNRECORDED added resource renders in [Not Recorded], not as drift (exit 0)', () => {
    const f: Finding = {
      tier: 'added',
      logicalId: 'Api/abc|root|ANY',
      physicalId: 'abc|root|ANY',
      constructPath: 'Stack/Api ▸ ANY /',
      resourceType: 'AWS::ApiGateway::Method',
      path: '',
      unrecorded: true,
      note: 'created out of band — not in your CloudFormation template',
    };
    const { code, text } = run([f]);
    expect(code).toBe(0);
    expect(text).toContain('[Not Recorded: 1]');
    expect(text).not.toContain('[Added Resource');
  });

  it('PR4: a recorded-but-CHANGED added resource shows the baseline vs actual model', () => {
    const f: Finding = {
      tier: 'added',
      logicalId: 'Api/abc|root|ANY',
      constructPath: 'Stack/Api ▸ ANY /',
      resourceType: 'AWS::ApiGateway::Method',
      path: '',
      desired: { AuthorizationType: 'NONE' },
      actual: { AuthorizationType: 'AWS_IAM' },
      note: 'changed since record',
    };
    const { code, text } = run([f]);
    expect(code).toBe(1);
    expect(text).toContain('Added Resource');
    expect(text).toContain('changed since record');
    expect(text).toContain('baseline=');
    expect(text).toContain('actual  =');
    expect(text).toContain('NONE');
    expect(text).toContain('AWS_IAM');
  });

  it('the Added section sorts AFTER declared/undeclared (sections + result line)', () => {
    const added: Finding = {
      tier: 'added',
      logicalId: 'Api/x',
      constructPath: 'Stack/Api ▸ /x',
      resourceType: 'AWS::ApiGateway::Resource',
      path: '',
    };
    const { text } = run([added, F('declared', 'P'), F('undeclared', 'Q')]);
    // section order: CFn-Declared Drift -> CFn-Undeclared Drift -> Added Resource
    const iDeclared = text.indexOf('CFn-Declared Drift');
    const iUndeclared = text.indexOf('CFn-Undeclared Drift');
    const iAdded = text.indexOf('Added Resource');
    expect(iDeclared).toBeLessThan(iUndeclared);
    expect(iUndeclared).toBeLessThan(iAdded);
    // result-line counts in the same order, added last
    expect(text).toMatch(/declared=1 undeclared=1 added=1/);
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
    expect(text).toContain('Undeclared Drift');
    expect(text).toContain('result:');
  });

  it('section header carries the count INSIDE the brackets, note outside (R48)', () => {
    const { text } = run([F('undeclared'), F('declared', 'Q')]);
    expect(text).toContain(
      '[CFn-Undeclared Drift: 1] (live-only (not in your CloudFormation template), changed from your .cdkrd baseline — the differentiator)'
    );
    // declared is now anchored to the deployed CloudFormation template (CFn-) so it
    // can't be misread as "in my CDK code" or "in the .cdkrd baseline"
    expect(text).toContain(
      '[CFn-Declared Drift: 1] (declared in your CloudFormation template — the live value differs)'
    );
    // the old bare-digit-right-of-bracket form is gone
    expect(text).not.toMatch(/\] \d/);
  });

  it('R128 renders an identity-keyed arrayDelta element-by-element, not the whole array', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'Role',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      actual: [{ PolicyName: 'keep' }, { PolicyName: 'aaa' }],
      arrayDelta: {
        identityField: 'PolicyName',
        added: [{ id: 'aaa', value: { PolicyName: 'aaa' } }],
        changed: [],
        removed: [],
      },
    };
    const { text } = run([f]);
    expect(text).toContain('PolicyName-keyed element(s) changed vs .cdkrd baseline');
    expect(text).toContain('+ [aaa]');
    // the whole-array dump (the other element) is NOT shown — only the delta
    expect(text).not.toContain('"PolicyName":"keep"');
  });

  it('R130 puts a changed element id, baseline and actual on their own aligned lines', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'Role',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      actual: [{ PolicyName: 'p', v: 2 }],
      arrayDelta: {
        identityField: 'PolicyName',
        added: [{ id: 'add', value: { PolicyName: 'add' } }],
        changed: [
          { id: 'p', recorded: { PolicyName: 'p', v: 1 }, actual: { PolicyName: 'p', v: 2 } },
        ],
        removed: [{ id: 'gone', value: { PolicyName: 'gone' } }],
      },
    };
    const lines = run([f]).text.split('\n');
    // the marker line carries only the id; value(s) follow on their own indented lines
    expect(lines).toContain('      ~ [p]');
    const bIdx = lines.findIndex((l) => l.includes('baseline=') && l.includes('"v":1'));
    const aIdx = lines.findIndex((l) => l.includes('actual  =') && l.includes('"v":2'));
    expect(bIdx).toBeGreaterThan(-1);
    expect(aIdx).toBe(bIdx + 1); // actual directly under baseline
    // padded so the '=' aligns (len('baseline') === 'actual  '.length)
    expect(lines[bIdx]?.indexOf('=')).toBe(lines[aIdx]?.indexOf('='));
    // added shows actual only; removed shows baseline only
    expect(lines).toContain('      + [add]');
    expect(lines).toContain('      - [gone]');
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
      expect(text).not.toContain('Declared Drift');
      expect(text).not.toContain('UNDECLARED');
      expect(text).not.toContain('Deleted');
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
      expect(text).not.toContain('[Skipped');
      // R127: the skipped footer line carries the loud "NOT checked (coverage
      // incomplete)" framing (folded from the old pre-report stderr warning).
      expect(text).toContain(
        'info: skipped=1 — NOT checked (coverage incomplete: custom resource 1) — run with --verbose for the list'
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
      expect(text).not.toContain('[Skipped');
      expect(text).not.toContain('[Read Gap');
      const lines = text.split('\n');
      const infoIdx = lines.indexOf('info:');
      expect(infoIdx).toBeGreaterThan(-1);
      expect(lines[infoIdx + 1]).toBe(
        "  - readGap=1 (declared but unverifiable — AWS doesn't return them on read, not drift: 1 write-only)"
      );
      expect(lines[infoIdx + 2]).toMatch(
        /^ {2}- skipped=2 — NOT checked \(coverage incomplete: .*custom resource 1.*override target unresolved 1.*\)$/
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
      expect(text).toContain('[Skipped');
      expect(text).not.toContain('info:');
      const lines = text.split('\n');
      expect(lines.findIndex((l) => l.includes('[Skipped'))).toBeGreaterThan(
        lines.findIndex((l) => l.startsWith('result:'))
      );
    });

    it('drift tiers stay fully detailed regardless of verbose', () => {
      expect(run([F('declared')]).text).toContain('Declared Drift');
      expect(run([F('declared')], { verbose: true }).text).toContain('Declared Drift');
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
      expect(text).not.toContain('[Ignored');
    });

    it('--verbose expands ignored to a full section', () => {
      const { text } = run([ignored('*.DesiredCount')], { verbose: true });
      expect(text).toContain('[Ignored');
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
      expect(text).not.toContain('[At AWS Default');
      expect(text).not.toContain('TracingConfig =');
    });

    it('a real undeclared value is listed in the body while at-default values stay folded', () => {
      const { code, text } = run([U('RealEdit'), AD('TracingConfig'), AD('PackageType')]);
      // U() is unrecorded (not drift) → CLEAN, but the real value is shown; defaults fold
      expect(code).toBe(0);
      expect(text).toContain('[Not Recorded: 1]');
      expect(text).toContain('L.RealEdit');
      expect(text).toContain('atDefault=2');
      expect(text).not.toContain('[At AWS Default');
    });

    it('--verbose expands atDefault to a full section with each value shown', () => {
      const { text } = run([AD('TracingConfig')], { verbose: true });
      expect(text).toContain('[At AWS Default: 1]');
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
      expect(text).toContain('[At AWS Default: 1]'); // expanded
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
      expect(text).not.toContain('[AWS Generated');
      expect(text).not.toContain('TopicName =');
    });

    it('--verbose expands generated to a full section showing each value', () => {
      const { text } = run([G('TopicName')], { verbose: true });
      expect(text).toContain('[AWS Generated: 1]');
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
        'info: skipped=1 — NOT checked (coverage incomplete: custom resource 1) — run with --verbose for the list',
      ]);
    });

    it('drift: first section directly under the header; blank line BEFORE result: (R48)', () => {
      const lines = run([F('declared')]).text.split('\n');
      expect(lines[0]).toBe('=== cdkrd check: stack (us-east-1) ===');
      expect(lines[1]).toMatch(/^\[CFn-Declared Drift: 1\]/); // no stray blank after the header
      const resultIdx = lines.findIndex((l) => l.startsWith('result:'));
      expect(lines[resultIdx - 1]).toBe(''); // the verdict is separated from the section above
    });

    it('two drift sections: blank BETWEEN them, none after the header (R48)', () => {
      const lines = run([F('declared'), F('undeclared', 'Q')]).text.split('\n');
      expect(lines[0]).toBe('=== cdkrd check: stack (us-east-1) ===');
      expect(lines[1]).toMatch(/^\[CFn-Declared Drift: 1\]/);
      const undeclaredIdx = lines.findIndex((l) => l.startsWith('[CFn-Undeclared'));
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
  it('nested unrecorded folds into info:, top-level lists in [Not Recorded]', () => {
    const { text } = run([NU('TopLevel'), NU('Conf.A', true), NU('Conf.B', true)]);
    expect(text).toContain('[Not Recorded: 1]');
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

describe('jPair (pair-aware truncation keeps the divergence visible)', () => {
  it('short values pass through whole, both sides', () => {
    expect(jPair('abc', 'abd')).toEqual({ a: '"abc"', b: '"abd"' });
  });

  it('two long values that differ only PAST the 200-char cap do NOT render identical', () => {
    const prefix = 'x'.repeat(230);
    const { a, b } = jPair(`${prefix}AAA`, `${prefix}BBB`);
    expect(a).not.toBe(b); // the old fixed-prefix slice made these identical
    expect(a).toContain('AAA'); // the diverging tail is visible
    expect(b).toContain('BBB');
    expect(a.startsWith('…')).toBe(true); // windowed, with a leading ellipsis
  });

  it('the window is the SAME for both sides (aligned), centered on the first difference', () => {
    const prefix = 'y'.repeat(300);
    const { a, b } = jPair(`${prefix}_LEFT_only`, `${prefix}_RIGHT_x`);
    // both windows start at the same offset, so the shared lead-in lines up
    const lead = (s: string) => s.replace(/…/g, '').slice(0, 20);
    expect(lead(a)).toBe(lead(b));
  });

  it('a long value vs a short one still shows where they diverge', () => {
    const { a, b } = jPair('z'.repeat(250), 'z'.repeat(10));
    expect(a).not.toBe(b);
  });
});

describe('safeSlice (boundary-safe truncation — no split surrogate / escape)', () => {
  const hasLoneSurrogate = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = s.charCodeAt(i + 1);
        if (!(n >= 0xdc00 && n <= 0xdfff)) return true; // high not followed by low
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        return true; // lone low surrogate
      }
    }
    return false;
  };

  it('never ends on a half surrogate pair (tail cut through an emoji)', () => {
    const s = `${'a'.repeat(9)}🎉${'b'.repeat(5)}`; // emoji straddles index 9-10
    expect(hasLoneSurrogate(safeSlice(s, 0, 10))).toBe(false); // would cut the pair
    expect(hasLoneSurrogate(s.slice(0, 10))).toBe(true); // the unsafe slice DOES split it
  });

  it('never starts on a half surrogate pair (head cut through an emoji)', () => {
    const s = `${'a'.repeat(9)}🎉${'b'.repeat(5)}`;
    expect(hasLoneSurrogate(safeSlice(s, 10, 16))).toBe(false); // start mid-pair -> low dropped
  });

  it('never ends on an odd run of backslashes (tail cut through a \\n escape)', () => {
    const s = JSON.stringify(`${'a'.repeat(8)}\n\n\n${'b'.repeat(5)}`); // has \\n escapes
    // find a cut landing right after a backslash
    const idx = s.indexOf('\\') + 1; // between the \ and the n
    const out = safeSlice(s, 0, idx);
    // count trailing backslashes — must be EVEN (no dangling half-escape)
    let bs = 0;
    for (let k = out.length - 1; k >= 0 && out[k] === '\\'; k--) bs++;
    expect(bs % 2).toBe(0);
  });

  it('leaves a clean boundary untouched', () => {
    expect(safeSlice('hello world', 0, 5)).toBe('hello');
  });
});
