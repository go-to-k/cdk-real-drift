// Tiny shared CLI arg parser (no dependency).
import type { FailOn } from "./report/report.js";

export interface CommonArgs {
  stackName?: string;
  region: string;
  json: boolean;
  failOn: FailOn;
  noBaseline: boolean;
}

export function parseCommonArgs(args: string[]): CommonArgs {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);
  const failOnRaw = get("--fail-on");
  return {
    stackName: args.find((a) => !a.startsWith("-")),
    region: get("--region") ?? process.env.AWS_REGION ?? "us-east-1",
    json: has("--json"),
    failOn: failOnRaw === "declared" ? "declared" : "undeclared",
    noBaseline: has("--no-baseline"),
  };
}
