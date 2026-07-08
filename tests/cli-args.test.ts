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
    const a = parseCommonArgs(['--region', 'us-east-1', 'MyStack', '--app', 'node app.js']);
    expect(a.stackNames).toEqual(['MyStack']);
    expect(a.app).toBe('node app.js');
  });

  it('defaults: flags false, region undefined when no flag/env', () => {
    const saved = { r: process.env.AWS_REGION, d: process.env.AWS_DEFAULT_REGION };
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      const a = parseCommonArgs(['S']);
      expect(a.fail).toBe(false);
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
    expect(parseCommonArgs(['S', '--remove-unrecorded']).removeUnrecorded).toBe(true);
    expect(parseCommonArgs(['S']).removeUnrecorded).toBe(false);
    expect(parseCommonArgs(['S', '--verbose']).verbose).toBe(true);
    expect(parseCommonArgs(['S', '-v']).verbose).toBe(true);
    expect(parseCommonArgs(['S']).verbose).toBe(false);
  });

  it('recognizes --all (was documented but unparsed → "unknown option" error)', () => {
    expect(parseCommonArgs(['--all']).all).toBe(true);
    expect(parseCommonArgs(['S']).all).toBe(false);
    // --all coexists with positional names (it overrides them to "all" in resolveStacks)
    const a = parseCommonArgs(['S', '--all']);
    expect(a.all).toBe(true);
    expect(a.stackNames).toEqual(['S']);
  });

  it('records --dry-run as a known flag (interpreted by revert)', () => {
    expect(parseCommonArgs(['S', '--dry-run']).stackNames).toEqual(['S']);
  });

  it('revert --wait: undefined by default, 10m bare, inline durations (issue #467)', () => {
    expect(parseCommonArgs(['S']).waitMs).toBeUndefined();
    expect(parseCommonArgs(['S', '--wait']).waitMs).toBe(10 * 60 * 1000);
    expect(parseCommonArgs(['S', '--wait=5m']).waitMs).toBe(300_000);
    expect(parseCommonArgs(['S', '--wait=90s']).waitMs).toBe(90_000);
    expect(parseCommonArgs(['S', '--wait=1h']).waitMs).toBe(3_600_000);
    expect(parseCommonArgs(['S', '--wait=45']).waitMs).toBe(45_000); // bare number = seconds
  });

  it('revert --wait consumes NO following token (inline form only — avoids stack misparse)', () => {
    const a = parseCommonArgs(['revertMe', '--wait', '5m']);
    expect(a.waitMs).toBe(10 * 60 * 1000); // bare --wait; "5m" is a positional
    expect(a.stackNames).toEqual(['revertMe', '5m']);
  });

  it('revert --wait rejects a malformed inline duration', () => {
    expect(() => parseCommonArgs(['S', '--wait=5min'])).toThrow(/invalid --wait duration/);
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
    // an empty separate-token value is also "no value" — else `''` would shadow the
    // env fallback (e.g. $AWS_REGION) and the inline form `--region=` already rejects it
    expect(() => parseCommonArgs(['--region', ''])).toThrow(/option "--region" requires a value/);
    expect(() => parseCommonArgs(['--profile', ''])).toThrow(/option "--profile" requires a value/);
    expect(() => parseCommonArgs(['MyStack', '--app', ''])).toThrow(
      /option "--app" requires a value/
    );
  });

  it('errors on malformed -c/--context (no key=value)', () => {
    expect(() => parseCommonArgs(['-c', 'noequals'])).toThrow(/expects key=value/);
    expect(() => parseCommonArgs(['--context', '=v'])).toThrow(/expects key=value/);
  });

  it('--fail parses as a boolean; default is report-only (fail false) (R53)', () => {
    expect(parseCommonArgs(['S']).fail).toBe(false);
    expect(parseCommonArgs(['S', '--fail']).fail).toBe(true);
  });

  it('scope flags parse and are mutually exclusive (R59)', () => {
    expect(parseCommonArgs(['S', '--undeclared-only']).undeclaredOnly).toBe(true);
    expect(parseCommonArgs(['S', '--declared-only']).declaredOnly).toBe(true);
    expect(parseCommonArgs(['S']).undeclaredOnly).toBe(false);
    expect(parseCommonArgs(['S']).declaredOnly).toBe(false);
    expect(() => parseCommonArgs(['S', '--pre-deploy', '--undeclared-only'])).toThrow(
      /mutually exclusive/
    );
    expect(() => parseCommonArgs(['S', '--pre-deploy', '--declared-only'])).toThrow(
      /mutually exclusive/
    );
    expect(() => parseCommonArgs(['S', '--declared-only', '--undeclared-only'])).toThrow(
      /mutually exclusive/
    );
  });

  it('--fail takes no value — the =tier form is GONE (R58)', () => {
    expect(() => parseCommonArgs(['S', '--fail=declared'])).toThrow(
      /option "--fail" does not take a value/
    );
    expect(() => parseCommonArgs(['S', '--fail=undeclared'])).toThrow(
      /option "--fail" does not take a value/
    );
  });

  it('--fail-on is GONE — fails fast as an unknown option (R56)', () => {
    expect(() => parseCommonArgs(['S', '--fail-on', 'declared'])).toThrow(/unknown option/);
    expect(() => parseCommonArgs(['S', '--fail-on=declared'])).toThrow(/unknown option/);
  });

  it('--fail never consumes the NEXT token — it stays a stack name', () => {
    const a = parseCommonArgs(['--fail', 'declared']);
    expect(a.fail).toBe(true);
    expect(a.stackNames).toEqual(['declared']); // a (oddly named) stack arg, not a tier
  });

  it('records --flag=value form, equal to the space form (R41)', () => {
    expect(parseCommonArgs(['--app=cdk.out'])).toEqual(parseCommonArgs(['--app', 'cdk.out']));
    expect(parseCommonArgs(['-a=cdk.out'])).toEqual(parseCommonArgs(['--app', 'cdk.out']));
    expect(parseCommonArgs(['MyStack', '--region=eu-west-1']).region).toBe('eu-west-1');
    expect(parseCommonArgs(['MyStack', '--region=eu-west-1']).stackNames).toEqual(['MyStack']);
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

  it('--no-interactive is GONE — fails fast as an unknown option (R58)', () => {
    expect(() => parseCommonArgs(['S', '--no-interactive'])).toThrow(/unknown option/);
  });
});

describe('isInteractive (non-interactive simply means non-TTY, R58)', () => {
  // Stub process.stdin.isTTY; restore in finally so other tests
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

  it('true exactly when stdin is a TTY', () => {
    withTTY(true, () => expect(isInteractive()).toBe(true));
    withTTY(false, () => expect(isInteractive()).toBe(false));
  });
});

describe('parseCommonArgs per-verb flag applicability (#780)', () => {
  // The dangerous pair: a preview/no-op flag on a FILE-WRITING verb used to be silently
  // accepted, inverting intent (`record --dry-run --yes` WROTE the baseline).
  it('rejects `--dry-run` on every verb except revert', () => {
    for (const verb of ['check', 'record', 'ignore'] as const)
      expect(() => parseCommonArgs(['--dry-run'], verb)).toThrow(
        new RegExp(`"--dry-run" is not valid for the \`${verb}\` command`)
      );
    expect(() => parseCommonArgs(['--dry-run'], 'revert')).not.toThrow();
  });

  it('rejects `--fail` outside check', () => {
    for (const verb of ['record', 'ignore', 'revert'] as const)
      expect(() => parseCommonArgs(['--fail'], verb)).toThrow(/"--fail" is not valid/);
    expect(() => parseCommonArgs(['--fail'], 'check')).not.toThrow();
  });

  it('rejects check-only scope/coverage flags on other verbs', () => {
    for (const flag of [
      '--strict',
      '--show-all',
      '--pre-deploy',
      '--undeclared-only',
      '--declared-only',
    ])
      expect(() => parseCommonArgs([flag], 'record')).toThrow(
        /is not valid for the `record` command/
      );
  });

  it('rejects `--wait` and `--remove-unrecorded` outside their verbs', () => {
    expect(() => parseCommonArgs(['--wait'], 'record')).toThrow(/"--wait" is not valid/);
    expect(() => parseCommonArgs(['--wait=5m'], 'check')).toThrow(/"--wait" is not valid/);
    expect(() => parseCommonArgs(['--remove-unrecorded'], 'record')).toThrow(/is not valid/);
    expect(() => parseCommonArgs(['--remove-unrecorded'], 'ignore')).toThrow(/is not valid/);
  });

  it('rejects `--verbose` (`-v`) on ignore but allows it on check/record/revert', () => {
    expect(() => parseCommonArgs(['--verbose'], 'ignore')).toThrow(/"--verbose" is not valid/);
    expect(() => parseCommonArgs(['-v'], 'ignore')).toThrow(/"-v" is not valid/);
    for (const verb of ['check', 'record', 'revert'] as const)
      expect(() => parseCommonArgs(['--verbose'], verb)).not.toThrow();
  });

  it('accepts each verb-appropriate flag set (no false rejection)', () => {
    expect(() =>
      parseCommonArgs(
        ['--fail', '--strict', '--show-all', '--pre-deploy', '--json', '--verbose'],
        'check'
      )
    ).not.toThrow();
    expect(() => parseCommonArgs(['--yes', '--verbose', '--json'], 'record')).not.toThrow();
    expect(() => parseCommonArgs(['--yes', '--json'], 'ignore')).not.toThrow();
    expect(() =>
      parseCommonArgs(['--dry-run', '--yes', '--wait=10m', '--remove-unrecorded'], 'revert')
    ).not.toThrow();
  });

  it('global identity/targeting flags are accepted on every verb', () => {
    for (const verb of ['check', 'record', 'ignore', 'revert'] as const)
      expect(() =>
        parseCommonArgs(
          [
            'MyStack',
            '--region',
            'us-east-1',
            '--profile',
            'p',
            '--app',
            'x',
            '-c',
            'k=v',
            '--all',
            '--json',
          ],
          verb
        )
      ).not.toThrow();
  });

  it('a no-verb call keeps the permissive parse (back-compat for internal callers)', () => {
    expect(() => parseCommonArgs(['--dry-run', '--fail', '--wait=5m'])).not.toThrow();
  });
});
