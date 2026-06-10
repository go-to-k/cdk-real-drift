import { describe, expect, it } from "vitest";
import { parseCommonArgs } from "../src/cli-args.js";

describe("parseCommonArgs", () => {
  it("collects positional stack names, not flag values", () => {
    const a = parseCommonArgs(["StackA", "StackB", "--region", "eu-west-1", "--json"]);
    expect(a.stackNames).toEqual(["StackA", "StackB"]);
    expect(a.region).toBe("eu-west-1");
    expect(a.json).toBe(true);
  });

  it("does not treat a value-flag's value as a stack name", () => {
    const a = parseCommonArgs(["--region", "us-east-1", "MyStack", "--fail-on", "declared"]);
    expect(a.stackNames).toEqual(["MyStack"]);
    expect(a.failOn).toBe("declared");
  });

  it("defaults: fail-on undeclared, region from env or us-east-1, flags false", () => {
    const a = parseCommonArgs(["S"]);
    expect(a.failOn).toBe("undeclared");
    expect(a.all).toBe(false);
    expect(a.yes).toBe(false);
    expect(a.noBaseline).toBe(false);
  });

  it("recognizes --all, --no-baseline, --yes/-y", () => {
    expect(parseCommonArgs(["--all"]).all).toBe(true);
    expect(parseCommonArgs(["S", "--no-baseline"]).noBaseline).toBe(true);
    expect(parseCommonArgs(["S", "-y"]).yes).toBe(true);
    expect(parseCommonArgs(["S", "--yes"]).yes).toBe(true);
  });
});
