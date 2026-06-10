import { describe, expect, it } from "vitest";
import { hasUnresolved, NOVALUE, resolve, resolveProperties, UNRESOLVED } from "../src/normalize/intrinsic-resolver.js";
import type { ResolverContext } from "../src/types.js";

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return {
    params: { Env: "prod" },
    pseudo: {
      "AWS::Region": "us-east-1",
      "AWS::AccountId": "123",
      "AWS::Partition": "aws",
      "AWS::URLSuffix": "amazonaws.com",
      "AWS::StackName": "S",
      "AWS::StackId": "id",
    },
    conditions: {},
    physIds: { MyBucket: "bucket-phys" },
    condCache: new Map(),
    ...over,
  };
}

describe("intrinsic resolver", () => {
  it("resolves Ref to params / pseudo / physical id, UNRESOLVED otherwise", () => {
    expect(resolve({ Ref: "Env" }, ctx())).toBe("prod");
    expect(resolve({ Ref: "AWS::Region" }, ctx())).toBe("us-east-1");
    expect(resolve({ Ref: "MyBucket" }, ctx())).toBe("bucket-phys");
    expect(resolve({ Ref: "Nope" }, ctx())).toBe(UNRESOLVED);
  });

  it("resolves Fn::Sub with pseudo + vars, marks GetAtt-form unresolved", () => {
    expect(resolve({ "Fn::Sub": "a-${Env}-${AWS::Region}" }, ctx())).toBe("a-prod-us-east-1");
    expect(resolve({ "Fn::Sub": "${Thing.Arn}" }, ctx())).toBe(UNRESOLVED);
  });

  it("evaluates Fn::If via conditions", () => {
    const c = ctx({ conditions: { IsProd: { "Fn::Equals": [{ Ref: "Env" }, "prod"] } } });
    expect(resolve({ "Fn::If": ["IsProd", "yes", "no"] }, c)).toBe("yes");
  });

  it("Fn::GetAtt is UNRESOLVED; Fn::Join drops NoValue", () => {
    expect(resolve({ "Fn::GetAtt": ["X", "Arn"] }, ctx())).toBe(UNRESOLVED);
    expect(resolve({ "Fn::Join": ["-", ["a", { Ref: "AWS::NoValue" }, "b"]] }, ctx())).toBe("a-b");
  });

  it("resolveProperties prunes NoValue keys", () => {
    const out = resolveProperties({ A: "x", B: { Ref: "AWS::NoValue" } }, ctx());
    expect(out).toEqual({ A: "x" });
  });

  it("FAIL-CLOSED: Fn::If with an unresolvable condition → UNRESOLVED (no guessed branch)", () => {
    const c = ctx({ conditions: { C: { "Fn::Equals": [{ Ref: "Unknown" }, "x"] } } });
    expect(resolve({ "Fn::If": ["C", "then", "else"] }, c)).toBe(UNRESOLVED);
  });

  it("FAIL-CLOSED: Fn::Equals / And / Or / Not with an unresolved operand → UNRESOLVED", () => {
    expect(resolve({ "Fn::Equals": [{ Ref: "Unknown" }, "x"] }, ctx())).toBe(UNRESOLVED);
    const c = ctx({ conditions: { U: { "Fn::Equals": [{ Ref: "Unknown" }, "x"] } } });
    expect(resolve({ "Fn::And": [{ Condition: "U" }, true] }, c)).toBe(UNRESOLVED);
    expect(resolve({ "Fn::Not": [{ Condition: "U" }] }, c)).toBe(UNRESOLVED);
  });

  it("CommaDelimitedList param resolves to an array (Fn::Join + HasX condition work)", () => {
    const empty = ctx({ params: { List: [] } });
    expect(resolve({ "Fn::Join": ["", { Ref: "List" }] }, empty)).toBe("");
    // HasList = Not(Equals(Join('', List), '')) → false for empty list
    const c = ctx({
      params: { List: [] },
      conditions: { HasList: { "Fn::Not": [{ "Fn::Equals": [{ "Fn::Join": ["", { Ref: "List" }] }, ""] }] } },
    });
    expect(resolve({ "Fn::If": ["HasList", "yes", "no"] }, c)).toBe("no");
    const c2 = ctx({
      params: { List: ["a", "b"] },
      conditions: { HasList: { "Fn::Not": [{ "Fn::Equals": [{ "Fn::Join": ["", { Ref: "List" }] }, ""] }] } },
    });
    expect(resolve({ "Fn::If": ["HasList", "yes", "no"] }, c2)).toBe("yes");
  });

  it("hasUnresolved detects sentinel at depth", () => {
    expect(hasUnresolved({ a: { b: [UNRESOLVED] } })).toBe(true);
    expect(hasUnresolved({ a: 1 })).toBe(false);
    expect(NOVALUE).toBeTypeOf("symbol");
  });
});
