import { describe, expect, it } from 'vite-plus/test';
import { parseCommonArgs } from '../src/cli-args.js';

describe('parseCommonArgs', () => {
  it('collects positional stack names, not flag values', () => {
    const a = parseCommonArgs(['StackA', 'StackB', '--region', 'eu-west-1', '--json']);
    expect(a.stackNames).toEqual(['StackA', 'StackB']);
    expect(a.region).toBe('eu-west-1');
    expect(a.json).toBe(true);
  });

  it("does not treat a value-flag's value as a stack name", () => {
    const a = parseCommonArgs([
      '--region',
      'us-east-1',
      'MyStack',
      '--fail-on',
      'declared',
      '--app',
      'node app.js',
    ]);
    expect(a.stackNames).toEqual(['MyStack']);
    expect(a.failOn).toBe('declared');
    expect(a.app).toBe('node app.js');
  });

  it('defaults: fail-on undeclared, flags false, region undefined when no flag/env', () => {
    const saved = { r: process.env.AWS_REGION, d: process.env.AWS_DEFAULT_REGION };
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      const a = parseCommonArgs(['S']);
      expect(a.failOn).toBe('undeclared');
      expect(a.yes).toBe(false);
      expect(a.showAll).toBe(false);
      expect(a.region).toBeUndefined(); // no silent us-east-1 default
    } finally {
      if (saved.r !== undefined) process.env.AWS_REGION = saved.r;
      if (saved.d !== undefined) process.env.AWS_DEFAULT_REGION = saved.d;
    }
  });

  it('recognizes --show-all, --yes/-y, --pre-deploy', () => {
    expect(parseCommonArgs(['S', '--show-all']).showAll).toBe(true);
    expect(parseCommonArgs(['S', '-y']).yes).toBe(true);
    expect(parseCommonArgs(['S', '--yes']).yes).toBe(true);
    expect(parseCommonArgs(['S', '--pre-deploy']).preDeploy).toBe(true);
    expect(parseCommonArgs(['S']).preDeploy).toBe(false);
    expect(parseCommonArgs(['S', '--remove-unblessed']).removeUnblessed).toBe(true);
    expect(parseCommonArgs(['S']).removeUnblessed).toBe(false);
    expect(parseCommonArgs(['S', '--verbose']).verbose).toBe(true);
    expect(parseCommonArgs(['S', '-v']).verbose).toBe(true);
    expect(parseCommonArgs(['S']).verbose).toBe(false);
  });

  it('accepts --dry-run as a known flag (interpreted by revert)', () => {
    expect(parseCommonArgs(['S', '--dry-run']).stackNames).toEqual(['S']);
  });

  it('-a is an alias for --app — value goes to app, never to stackNames', () => {
    const a = parseCommonArgs(['MyStack', '-a', 'cdk.out']);
    expect(a.app).toBe('cdk.out');
    expect(a.stackNames).toEqual(['MyStack']);
    expect(parseCommonArgs(['-a', 'cdk.out'])).toEqual(parseCommonArgs(['--app', 'cdk.out']));
  });

  it('collects repeatable -c/--context key=value', () => {
    const a = parseCommonArgs(['-c', 'k1=v1', '--context', 'k2=v=2']);
    expect(a.context).toEqual({ k1: 'v1', k2: 'v=2' });
    expect(a.stackNames).toEqual([]);
  });

  it('fails fast on unknown options instead of silently dropping them', () => {
    expect(() => parseCommonArgs(['--apq', 'cdk.out'])).toThrow(/unknown option "--apq"/);
    expect(() => parseCommonArgs(['-x'])).toThrow(/unknown option "-x"/);
    expect(() => parseCommonArgs(['S', '--dryrun'])).toThrow(/unknown option "--dryrun"/);
  });

  it('errors when a value flag is missing its value', () => {
    expect(() => parseCommonArgs(['--app'])).toThrow(/option "--app" requires a value/);
    expect(() => parseCommonArgs(['-a'])).toThrow(/option "-a" requires a value/);
    // the next token being another flag is NOT a value
    expect(() => parseCommonArgs(['--region', '--json'])).toThrow(
      /option "--region" requires a value/
    );
    expect(() => parseCommonArgs(['-c', '--json'])).toThrow(/option "-c" requires a value/);
  });

  it('errors on malformed -c/--context (no key=value)', () => {
    expect(() => parseCommonArgs(['-c', 'noequals'])).toThrow(/expects key=value/);
    expect(() => parseCommonArgs(['--context', '=v'])).toThrow(/expects key=value/);
  });
});
