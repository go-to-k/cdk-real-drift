import { describe, expect, it } from 'vite-plus/test';
import { planIoMessage } from '../src/synth/io-host.js';

describe('planIoMessage (QuietIoHost routing)', () => {
  it('re-tags CDK app stderr passthrough (E1002, error) to info so it is not red', () => {
    // toolkit-lib relays the app subprocess stderr (bundling progress) as an ERROR;
    // we downgrade to info so it prints in the default color, matching cdk-local.
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_E1002', level: 'error' })).toEqual({
      action: 'emit',
      level: 'info',
    });
  });

  it('re-tags CDK app stdout passthrough (I1001) to info (default color)', () => {
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_I1001', level: 'info' })).toEqual({
      action: 'emit',
      level: 'info',
    });
  });

  it('still surfaces a REAL toolkit error unchanged (stays red)', () => {
    // a genuine synth failure (not the app-stderr passthrough) keeps its error level
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_E1111', level: 'error' })).toEqual({
      action: 'emit',
      level: 'error',
    });
  });

  it('still surfaces warnings', () => {
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_W0010', level: 'warn' })).toEqual({
      action: 'emit',
      level: 'warn',
    });
  });

  it('drops toolkit info / debug / trace chatter', () => {
    expect(planIoMessage({ code: 'CDK_ASSEMBLY_I0010', level: 'info' })).toEqual({
      action: 'drop',
    });
    expect(planIoMessage({ code: 'CDK_TOOLKIT_I0001', level: 'debug' })).toEqual({
      action: 'drop',
    });
    expect(planIoMessage({ code: undefined, level: 'trace' })).toEqual({ action: 'drop' });
  });
});
