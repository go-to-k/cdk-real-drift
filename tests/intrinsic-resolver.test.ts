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

  it("hasUnresolved detects sentinel at depth", () => {
    expect(hasUnresolved({ a: { b: [UNRESOLVED] } })).toBe(true);
    expect(hasUnresolved({ a: 1 })).toBe(false);
    expect(NOVALUE).toBeTypeOf("symbol");
  });
});
