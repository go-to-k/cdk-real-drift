import { describe, expect, it } from 'vite-plus/test';
import { isInteractive, parseCommonArgs } from '../src/cli-args.js';

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

  it('validates --fail-on, rejecting typos instead of falling back to undeclared (R41)', () => {
    expect(parseCommonArgs(['S', '--fail-on', 'declared']).failOn).toBe('declared');
    expect(parseCommonArgs(['S', '--fail-on', 'undeclared']).failOn).toBe('undeclared');
    expect(() => parseCommonArgs(['S', '--fail-on', 'declarred'])).toThrow(
      /--fail-on expects "declared" or "undeclared", got "declarred"/
    );
    expect(() => parseCommonArgs(['S', '--fail-on', 'deleted'])).toThrow(/--fail-on expects/);
  });

  it('accepts --flag=value form, equal to the space form (R41)', () => {
    expect(parseCommonArgs(['--app=cdk.out'])).toEqual(parseCommonArgs(['--app', 'cdk.out']));
    expect(parseCommonArgs(['-a=cdk.out'])).toEqual(parseCommonArgs(['--app', 'cdk.out']));
    expect(parseCommonArgs(['MyStack', '--region=eu-west-1']).region).toBe('eu-west-1');
    expect(parseCommonArgs(['MyStack', '--region=eu-west-1']).stackNames).toEqual(['MyStack']);
    expect(parseCommonArgs(['--fail-on=declared']).failOn).toBe('declared');
  });

  it('splits --context=key=value on the first = only (R41)', () => {
    expect(parseCommonArgs(['--context=env=prod']).context).toEqual({ env: 'prod' });
    // and the value may itself contain more '='
    expect(parseCommonArgs(['-c=token=a=b']).context).toEqual({ token: 'a=b' });
  });

  it('errors on --flag= with an empty inline value (R41)', () => {
    expect(() => parseCommonArgs(['--app='])).toThrow(/option "--app" requires a value/);
    expect(() => parseCommonArgs(['--region='])).toThrow(/option "--region" requires a value/);
  });

  it('rejects a value attached to a boolean flag, e.g. --json=true (R41)', () => {
    expect(() => parseCommonArgs(['--json=true'])).toThrow(/option "--json" does not take a value/);
    expect(() => parseCommonArgs(['--dry-run=1'])).toThrow(
      /option "--dry-run" does not take a value/
    );
  });

  it('recognizes --no-interactive (default false)', () => {
    expect(parseCommonArgs(['S', '--no-interactive']).noInteractive).toBe(true);
    expect(parseCommonArgs(['S']).noInteractive).toBe(false);
  });
});

describe('isInteractive (TTY × --no-interactive truth matrix)', () => {
  const args = (noInteractive: boolean) =>
    parseCommonArgs(noInteractive ? ['--no-interactive'] : []);

  // Stub process.stdin.isTTY across the matrix; restore in finally so other tests
  // (and the real terminal) are unaffected.
  const withTTY = (tty: boolean, fn: () => void) => {
    const saved = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    try {
      fn();
    } finally {
      if (saved) Object.defineProperty(process.stdin, 'isTTY', saved);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  };

  it('true ONLY when TTY && !noInteractive', () => {
    withTTY(true, () => {
      expect(isInteractive(args(false))).toBe(true); // TTY, interactive allowed
      expect(isInteractive(args(true))).toBe(false); // TTY but opted out
    });
    withTTY(false, () => {
      expect(isInteractive(args(false))).toBe(false); // no TTY
      expect(isInteractive(args(true))).toBe(false); // no TTY + opted out
    });
  });
});
