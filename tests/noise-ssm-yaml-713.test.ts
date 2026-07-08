import { describe, expect, it } from 'vite-plus/test';
import { isJsonStringStructEqual } from '../src/normalize/noise.js';

// #713: an AWS::SSM::Document declared with `DocumentFormat: YAML` and a YAML-string
// `Content` reads back re-serialized as canonical JSON. The declared YAML string can
// never string-match the live JSON string even though they are semantically identical,
// producing a first-run declared-tier false positive. isJsonStringStructEqual must parse
// BOTH sides (JSON is a YAML subset) and structurally compare — without over-folding
// unrelated scalar strings, and while still detecting a genuinely different document.

// The exact repro strings from the issue.
const DECLARED_YAML =
  'schemaVersion: "2.2"\ndescription: hunt yaml doc\nmainSteps:\n  - action: aws:runShellScript\n    name: run\n    inputs:\n      runCommand:\n        - echo hi\n';
const LIVE_JSON =
  '{"description":"hunt yaml doc","mainSteps":[{"action":"aws:runShellScript","inputs":{"runCommand":["echo hi"]},"name":"run"}],"schemaVersion":"2.2"}';

describe('isJsonStringStructEqual — SSM Document YAML Content (#713)', () => {
  it('folds a declared YAML-string Content against the live JSON-string re-serialization', () => {
    expect(isJsonStringStructEqual(DECLARED_YAML, LIVE_JSON)).toBe(true);
    // symmetric (declared/live order must not matter)
    expect(isJsonStringStructEqual(LIVE_JSON, DECLARED_YAML)).toBe(true);
  });

  it('still folds a declared parsed OBJECT against a live YAML string', () => {
    const declaredObj = {
      schemaVersion: '2.2',
      description: 'hunt yaml doc',
      mainSteps: [
        { action: 'aws:runShellScript', name: 'run', inputs: { runCommand: ['echo hi'] } },
      ],
    };
    expect(isJsonStringStructEqual(declaredObj, DECLARED_YAML)).toBe(true);
    expect(isJsonStringStructEqual(DECLARED_YAML, declaredObj)).toBe(true);
  });

  it('DETECTS a genuinely different document (changed command)', () => {
    const changedYaml = DECLARED_YAML.replace('echo hi', 'echo bye');
    expect(isJsonStringStructEqual(changedYaml, LIVE_JSON)).toBe(false);
  });

  it('DETECTS a genuinely different document (changed field value)', () => {
    const changedJson = LIVE_JSON.replace('"2.2"', '"2.3"');
    expect(isJsonStringStructEqual(DECLARED_YAML, changedJson)).toBe(false);
  });

  it('does NOT vacuously fold an unrelated YAML-looking scalar string', () => {
    // Two bare scalar strings that happen to parse as YAML scalars must not fold —
    // the object/array guard rejects scalar operands.
    expect(isJsonStringStructEqual('hello world', 'goodbye world')).toBe(false);
    // A scalar string vs a structured document must not fold either.
    expect(isJsonStringStructEqual('hello world', LIVE_JSON)).toBe(false);
    expect(isJsonStringStructEqual(LIVE_JSON, 'hello world')).toBe(false);
    // A scalar string vs an object: still no fold (guard on the parsed scalar).
    expect(isJsonStringStructEqual('just a plain description', { a: 1 })).toBe(false);
  });

  it('returns false for two unparseable strings (no accidental equality)', () => {
    expect(isJsonStringStructEqual('{unclosed', '{unclosed')).toBe(false);
  });
});
