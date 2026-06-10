import { describe, expect, it } from "vitest";
import { classifyResource } from "../src/diff/classify.js";
import { UNRESOLVED } from "../src/normalize/intrinsic-resolver.js";
import type { DesiredResource, Finding, SchemaInfo } from "../src/types.js";

function tiers(findings: Finding[]) {
  const by = (t: string) =>
    findings
      .filter((f) => f.tier === t)
      .map((f) => f.path)
      .sort();
  return { declared: by("declared"), undeclared: by("undeclared"), readGap: by("readGap"), unresolved: by("unresolved") };
}

describe("classifyResource (the heart)", () => {
  const schema: SchemaInfo = {
    readOnly: new Set(["Arn", "RoleId"]),
    writeOnly: new Set(["AssumeRolePolicyDocument"]),
    readOnlyPaths: ["Arn", "RoleId"],
    writeOnlyPaths: ["AssumeRolePolicyDocument"],
    defaults: {},
  };
  const resource: DesiredResource = {
    logicalId: "Role",
    resourceType: "AWS::IAM::Role",
    physicalId: "my-role-phys",
    declared: {
      ManagedPolicyArns: ["arnA"], // will drift
      Description: "hi", // matches live → no drift
      MissingFromLive: "x", // → readGap
      ComputedArn: UNRESOLVED, // → unresolved
      AssumeRolePolicyDocument: { Version: "1" }, // writeOnly → ignored
    },
  };
  const liveRaw: Record<string, unknown> = {
    ManagedPolicyArns: ["arnB"],
    Description: "hi",
    MaxSessionDuration: 3600, // known default → suppressed
    Path: "/", // known default → suppressed
    GuardrailPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"], // ★ undeclared signal
    SelfName: "my-role-phys", // == physicalId → suppressed
    EmptyList: [], // trivial empty → suppressed
    Tags: [{ Key: "aws:cloudformation:stack-id", Value: "x" }], // aws:* → suppressed
    Arn: "arn:...", // readOnly → stripped
    RoleId: "AID", // readOnly → stripped
    CreationDate: "2020", // managed → stripped
  };

  it("classifies declared / undeclared / readGap / unresolved correctly", () => {
    const t = tiers(classifyResource(resource, liveRaw, schema));
    expect(t.declared).toEqual(["ManagedPolicyArns"]);
    expect(t.undeclared).toEqual(["GuardrailPolicies"]); // only the real signal survives noise subtraction
    expect(t.readGap).toEqual(["MissingFromLive"]);
    expect(t.unresolved).toEqual(["ComputedArn"]);
  });

  it("declared drift carries desired + actual values", () => {
    const drift = classifyResource(resource, liveRaw, schema).find((f) => f.tier === "declared")!;
    expect(drift.desired).toEqual(["arnA"]);
    expect(drift.actual).toEqual(["arnB"]);
  });
});
