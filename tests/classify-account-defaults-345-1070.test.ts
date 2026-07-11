// #1070 items 4 + 5 — two more "constant/derived" undeclared defaults are actually a function of an
// ACCOUNT/REGION-level setting the owner can change:
//   item 4: EC2::Instance CreditSpecification.CPUCredits per-family default
//           (ec2:modify-default-credit-specification) — was a fixed t2→standard / t3·t3a·t4g→unlimited
//           derivation; now the account-effective default (opts.accountDefaults.ec2FamilyCreditDefaults)
//           overrides it, falling back to the factory default when the lookup is unavailable.
//   item 5: RDS/DocDB DBInstance CACertificateIdentifier account default CA (rds:modify-certificates) —
//           was a fixed rds-ca-rsa2048-g1 constant; now the account customer-override CA
//           (opts.accountDefaults.rdsDefaultCaIdentifier) overrides it, falling back to the constant.
// Each: folds atDefault when live == the account default; surfaces when it differs; fail-open with no
// prefetch reproduces today's factory-default behavior.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

describe('#1070 item 4 EC2::Instance CreditSpecification — account-derived per-family default', () => {
  // A t3 instance; the account flipped the t3 family default to `standard`
  // (ec2:modify-default-credit-specification --instance-family t3 --cpu-credits standard).
  const t3 = mk('AWS::EC2::Instance', { ImageId: 'ami-1', InstanceType: 't3.micro' });
  const live = (c: string) => ({ CreditSpecification: { CPUCredits: c } });

  it('folds the ACCOUNT default (t3 flipped to standard) over the factory unlimited', () => {
    const f = classifyResource(t3, live('standard'), emptySchema, {
      accountDefaults: { ec2FamilyCreditDefaults: { t3: 'standard' } },
    });
    expect(tier(f, 'atDefault')).toContain('CreditSpecification');
    expect(tier(f, 'undeclared')).not.toContain('CreditSpecification');
  });

  it('SURFACES a value differing from the account default (account standard, live unlimited)', () => {
    const f = classifyResource(t3, live('unlimited'), emptySchema, {
      accountDefaults: { ec2FamilyCreditDefaults: { t3: 'standard' } },
    });
    expect(tier(f, 'undeclared')).toContain('CreditSpecification');
    expect(tier(f, 'atDefault')).not.toContain('CreditSpecification');
  });

  it('folds a t2 account default flipped to unlimited (over the factory standard)', () => {
    const t2 = mk('AWS::EC2::Instance', { ImageId: 'ami-1', InstanceType: 't2.small' });
    const f = classifyResource(t2, live('unlimited'), emptySchema, {
      accountDefaults: { ec2FamilyCreditDefaults: { t2: 'unlimited' } },
    });
    expect(tier(f, 'atDefault')).toContain('CreditSpecification');
  });

  it('fail-open: no prefetch → factory default (t3 unlimited folds, t3 standard surfaces)', () => {
    const unlimited = classifyResource(t3, live('unlimited'), emptySchema, {});
    expect(tier(unlimited, 'atDefault')).toContain('CreditSpecification');
    const standard = classifyResource(t3, live('standard'), emptySchema, {});
    expect(tier(standard, 'undeclared')).toContain('CreditSpecification');
  });

  it('fail-open: a family absent from the prefetch falls back to the factory default', () => {
    // Prefetch resolved t2 but not t3; the t3 instance must still use the factory t3 default.
    const f = classifyResource(t3, live('unlimited'), emptySchema, {
      accountDefaults: { ec2FamilyCreditDefaults: { t2: 'unlimited' } },
    });
    expect(tier(f, 'atDefault')).toContain('CreditSpecification');
  });
});

describe('#1070 item 5 RDS/DocDB CACertificateIdentifier — account-derived default CA', () => {
  for (const type of ['AWS::RDS::DBInstance', 'AWS::DocDB::DBInstance']) {
    describe(type, () => {
      const res = mk(type, { Engine: 'x' });
      const OVERRIDE = 'rds-ca-ecc384-g1'; // the account customer-override CA
      const SYSTEM = 'rds-ca-rsa2048-g1'; // the KNOWN_DEFAULTS system-default constant

      it('folds the account customer-override CA', () => {
        const f = classifyResource(res, { CACertificateIdentifier: OVERRIDE }, emptySchema, {
          accountDefaults: { rdsDefaultCaIdentifier: OVERRIDE },
        });
        expect(tier(f, 'atDefault')).toContain('CACertificateIdentifier');
        expect(tier(f, 'undeclared')).not.toContain('CACertificateIdentifier');
      });

      it('SURFACES a CA differing from the account override', () => {
        const f = classifyResource(res, { CACertificateIdentifier: SYSTEM }, emptySchema, {
          accountDefaults: { rdsDefaultCaIdentifier: OVERRIDE },
        });
        expect(tier(f, 'undeclared')).toContain('CACertificateIdentifier');
        expect(tier(f, 'atDefault')).not.toContain('CACertificateIdentifier');
      });

      it('fail-open: no override → KNOWN_DEFAULTS constant (system CA folds, override CA surfaces)', () => {
        const sys = classifyResource(res, { CACertificateIdentifier: SYSTEM }, emptySchema, {});
        expect(tier(sys, 'atDefault')).toContain('CACertificateIdentifier');
        const other = classifyResource(res, { CACertificateIdentifier: OVERRIDE }, emptySchema, {});
        expect(tier(other, 'undeclared')).toContain('CACertificateIdentifier');
      });
    });
  }
});
