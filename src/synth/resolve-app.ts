// Resolve the CDK app: explicit value (already covers --app + $CDKRD_APP via
// cli-args) → cdk.json "app". Mirrors cdk-local's resolveApp precedence.
import { existsSync, readFileSync } from 'node:fs';

// Decode a cdk.json buffer the way the real `cdk` CLI does (via fs-extra/jsonfile, which
// strips a BOM before JSON.parse) PLUS the UTF-16 cases Windows tooling produces (#1076):
// a UTF-8 BOM (EF BB BF — Notepad / PowerShell 5.1 `Out-File -Encoding utf8`), UTF-16 LE
// (FF FE — PowerShell 5.1's DEFAULT for `> cdk.json`), or UTF-16 BE (FE FF). A default
// TextDecoder consumes the BOM (`ignoreBOM` defaults to false), so the decoded text is
// clean JSON. Node's own `readFileSync(…, 'utf8')` does neither — it leaves the BOM as a
// leading U+FEFF and turns UTF-16 into mojibake, both of which then throw in JSON.parse.
function decodeCdkJson(buf: Buffer): string {
  const encoding =
    buf[0] === 0xff && buf[1] === 0xfe
      ? 'utf-16le'
      : buf[0] === 0xfe && buf[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  return new TextDecoder(encoding).decode(buf);
}

export function resolveApp(explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  // No cdk.json at all → genuinely no app here (the caller's "run in a directory with
  // cdk.json / pass --app" message is correct). Only a cdk.json that EXISTS but can't be
  // read/parsed is turned into a SPECIFIC error below, instead of being swallowed into the
  // misleading "there is no CDK app here" (#1076 — a Windows user whose cdk.json `cdk`
  // itself accepts was sent hunting for a missing file / flag).
  if (!existsSync('cdk.json')) return undefined;
  let text: string;
  try {
    text = decodeCdkJson(readFileSync('cdk.json'));
  } catch (e) {
    throw new Error(`cdk.json exists but could not be read: ${(e as Error).message}`);
  }
  let json: { app?: unknown };
  try {
    json = JSON.parse(text) as { app?: unknown };
  } catch (e) {
    throw new Error(
      `cdk.json exists but is not valid JSON (an unsupported encoding or a syntax error?): ${(e as Error).message}`
    );
  }
  // A parseable cdk.json with no `app` is a valid case (the app may come from --app /
  // $CDKRD_APP) — return undefined, not an error.
  return typeof json.app === 'string' && json.app.length > 0 ? json.app : undefined;
}
