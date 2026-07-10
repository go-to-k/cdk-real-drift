import { describe, expect, it } from 'vite-plus/test';
import { hashCaBundle, sha256Hex } from '../src/read/pem.js';

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

describe('sha256Hex (#1346 Glue job ETL script integrity signal)', () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('is a deterministic 64-hex digest of the exact bytes', () => {
    const b = bytes("print('etl')\n");
    expect(sha256Hex(b)).toBe(sha256Hex(b));
    expect(sha256Hex(b)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the canonical SHA-256 (known-answer for the empty-ish "abc")', () => {
    // sha256("abc") — the well-known test vector
    expect(sha256Hex(bytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('any byte change (a script swap) changes the hash', () => {
    expect(sha256Hex(bytes("print('v1')"))).not.toBe(sha256Hex(bytes("print('v2')")));
  });

  it('returns undefined for empty / undefined input (never a bogus hash)', () => {
    expect(sha256Hex(new Uint8Array(0))).toBeUndefined();
    expect(sha256Hex(undefined)).toBeUndefined();
  });
});
