import { describe, expect, it } from 'vite-plus/test';
import { withinStackPath } from '../src/construct-path.js';

describe('withinStackPath (strip the stack/Stage prefix off a construct path)', () => {
  it('plain stack: strips the single leading stack-id segment', () => {
    expect(withinStackPath('MyStack/Api/Handler', 'MyStack')).toBe('Api/Handler');
  });

  it('a stack id composed with the stage (e.g. `${stage}-Name`) strips as ONE segment', () => {
    // the common manual pattern: `new Stack(app, `${stage}-AuroraDB`)` — the whole first
    // segment IS the stack name, so it strips even though it contains a hyphen.
    expect(withinStackPath('dev-main-AuroraDB/Database/ParameterGroup', 'dev-main-AuroraDB')).toBe(
      'Database/ParameterGroup'
    );
  });

  it('CDK Stage: strips BOTH the stage and stack segments (path is /-joined, name is -joined)', () => {
    // aws:cdk:path = `dev-main/AuroraDB/Database/ParameterGroup`, CFn stackName =
    // `dev-main-AuroraDB` — the two leading segments `-`-join to the stack name.
    expect(withinStackPath('dev-main/AuroraDB/Database/ParameterGroup', 'dev-main-AuroraDB')).toBe(
      'Database/ParameterGroup'
    );
  });

  it('nested Stages strip every enclosing segment', () => {
    expect(withinStackPath('a/b/Stack/Res/Sub', 'a-b-Stack')).toBe('Res/Sub');
  });

  it('a stage/stack id that itself contains a hyphen still matches (whole segments joined)', () => {
    expect(withinStackPath('dev-main/aurora-db/Res', 'dev-main-aurora-db')).toBe('Res');
  });

  it('overridden stackName that no longer mirrors the construct ids: returns UNCHANGED (safe)', () => {
    // `new Stack(app, 'AuroraDB', { stackName: 'prod-db' })` — construct path leads with the
    // construct id `AuroraDB`, not `prod-db`, so nothing strips rather than stripping wrongly.
    expect(withinStackPath('AuroraDB/Database/PG', 'prod-db')).toBe('AuroraDB/Database/PG');
  });

  it('empty stackName (direct/unit call): returns UNCHANGED (no strip)', () => {
    expect(withinStackPath('MyStack/Api', '')).toBe('MyStack/Api');
  });

  it('a resource directly under the stack (single trailing segment) still strips the stack', () => {
    expect(withinStackPath('MyStack/Api', 'MyStack')).toBe('Api');
  });
});
