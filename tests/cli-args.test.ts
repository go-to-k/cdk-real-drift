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
      expect(a.all).toBe(false);
      expect(a.yes).toBe(false);
      expect(a.showAll).toBe(false);
      expect(a.region).toBeUndefined(); // no silent us-east-1 default
    } finally {
      if (saved.r !== undefined) process.env.AWS_REGION = saved.r;
      if (saved.d !== undefined) process.env.AWS_DEFAULT_REGION = saved.d;
    }
  });

  it('recognizes --all, --show-all, --yes/-y, --pre-deploy', () => {
    expect(parseCommonArgs(['--all']).all).toBe(true);
    expect(parseCommonArgs(['S', '--show-all']).showAll).toBe(true);
    expect(parseCommonArgs(['S', '-y']).yes).toBe(true);
    expect(parseCommonArgs(['S', '--yes']).yes).toBe(true);
    expect(parseCommonArgs(['S', '--pre-deploy']).preDeploy).toBe(true);
    expect(parseCommonArgs(['S']).preDeploy).toBe(false);
  });
});
