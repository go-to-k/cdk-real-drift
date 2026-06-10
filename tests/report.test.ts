import { describe, expect, it } from "vitest";
import { report } from "../src/report/report.js";
import type { Finding } from "../src/types.js";

const F = (tier: Finding["tier"], path = "P"): Finding => ({ tier, logicalId: "L", resourceType: "AWS::X::Y", path, actual: 1 });

function run(findings: Finding[], opts: Parameters<typeof report>[2] = {}) {
  const lines: string[] = [];
  const code = report(findings, "stack (us-east-1)", { ...opts, log: (s) => lines.push(s) });
  return { code, text: lines.join("\n") };
}

describe("report", () => {
  it("exit 0 when no drift tiers present", () => {
    expect(run([F("readGap"), F("skipped"), F("unresolved")]).code).toBe(0);
  });

  it("exit 1 on declared or undeclared (default fail-on)", () => {
    expect(run([F("declared")]).code).toBe(1);
    expect(run([F("undeclared")]).code).toBe(1);
  });

  it("--fail-on declared ignores undeclared for exit code", () => {
    expect(run([F("undeclared")], { failOn: "declared" }).code).toBe(0);
    expect(run([F("declared")], { failOn: "declared" }).code).toBe(1);
  });

  it("json mode emits parseable JSON with findings + drifted count", () => {
    const { code, text } = run([F("undeclared"), F("skipped")], { json: true });
    const parsed = JSON.parse(text);
    expect(code).toBe(1);
    expect(parsed.drifted).toBe(1);
    expect(parsed.findings).toHaveLength(2);
  });

  it("text mode groups by tier with counts", () => {
    const { text } = run([F("undeclared")]);
    expect(text).toContain("UNDECLARED DRIFT");
    expect(text).toContain("result:");
  });
});
