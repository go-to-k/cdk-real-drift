import { describe, expect, it } from 'vite-plus/test';
import { hashCaBundle } from '../src/read/pem.js';

const cert = (body: string): string =>
  `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;

describe('hashCaBundle (#505 TrustStore CA bundle integrity signal)', () => {
  it('is deterministic for the same bundle', () => {
    const pem = cert('AAAA') + cert('BBBB');
    expect(hashCaBundle(pem)).toBe(hashCaBundle(pem));
    expect(hashCaBundle(pem)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is order-insensitive (trust anchors are a SET)', () => {
    expect(hashCaBundle(cert('AAAA') + cert('BBBB'))).toBe(
      hashCaBundle(cert('BBBB') + cert('AAAA'))
    );
  });

  it('is whitespace/line-wrap insensitive within a cert body', () => {
    expect(hashCaBundle(cert('AAAABBBB'))).toBe(
      hashCaBundle('-----BEGIN CERTIFICATE-----\nAAAA\nBBBB\n-----END CERTIFICATE-----')
    );
  });

  it('a bundle swap (added / removed / changed anchor) changes the hash', () => {
    const one = cert('AAAA');
    const two = cert('AAAA') + cert('BBBB'); // the #505 repro: a 2nd CA concatenated
    const swapped = cert('CCCC');
    expect(hashCaBundle(two)).not.toBe(hashCaBundle(one));
    expect(hashCaBundle(swapped)).not.toBe(hashCaBundle(one));
  });

  it('returns undefined for a body with no CERTIFICATE block (e.g. a failed fetch returned HTML)', () => {
    expect(hashCaBundle('<html>Access Denied</html>')).toBeUndefined();
    expect(hashCaBundle('')).toBeUndefined();
  });

  it('returns undefined for a non-string', () => {
    expect(hashCaBundle(undefined)).toBeUndefined();
    expect(hashCaBundle(42)).toBeUndefined();
  });
});
