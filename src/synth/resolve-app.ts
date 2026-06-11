// Resolve the CDK app: explicit value (already covers --app + $CDKRD_APP via
// cli-args) → cdk.json "app". Mirrors cdk-local's resolveApp precedence.
import { existsSync, readFileSync } from 'node:fs';

export function resolveApp(explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  try {
    if (existsSync('cdk.json')) {
      const json = JSON.parse(readFileSync('cdk.json', 'utf8')) as { app?: unknown };
      if (typeof json.app === 'string' && json.app.length > 0) return json.app;
    }
  } catch {
    /* unreadable cdk.json → no app */
  }
  return undefined;
}
