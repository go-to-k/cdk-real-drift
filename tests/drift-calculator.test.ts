import { describe, expect, it } from "vitest";
import { calculateResourceDrift, deepEqual } from "../src/diff/drift-calculator.js";

describe("calculateResourceDrift", () => {
  it("only walks declared (state) keys; ignores extra aws keys", () => {
    const d = calculateResourceDrift({ A: 1 }, { A: 1, B: 2 });
    expect(d).toEqual([]);
  });

  it("reports nested leaf with dotted path", () => {
    const d = calculateResourceDrift({ V: { Status: "Enabled" } }, { V: { Status: "Suspended" } });
    expect(d).toEqual([{ path: "V.Status", stateValue: "Enabled", awsValue: "Suspended" }]);
  });

  it("reports whole-array drift on a single parent path (length change)", () => {
    const d = calculateResourceDrift({ L: ["a"] }, { L: ["a", "b"] });
    expect(d).toEqual([{ path: "L", stateValue: ["a"], awsValue: ["a", "b"] }]);
  });

  it("same-length array of objects: AWS-enriched element is NOT drift (subset)", () => {
    const d = calculateResourceDrift({ Enc: [{ SSE: { Alg: "AES256" } }] }, { Enc: [{ BucketKeyEnabled: false, SSE: { Alg: "AES256" } }] });
    expect(d).toEqual([]);
  });

  it("same-length array of objects: a CHANGED declared sub-value IS drift", () => {
    const d = calculateResourceDrift({ Enc: [{ SSE: { Alg: "AES256" } }] }, { Enc: [{ SSE: { Alg: "aws:kms" } }] });
    expect(d).toEqual([{ path: "Enc.0.SSE.Alg", stateValue: "AES256", awsValue: "aws:kms" }]);
  });

  it("declared key absent in aws surfaces as drift with undefined actual", () => {
    const d = calculateResourceDrift({ A: 1 }, {});
    expect(d).toEqual([{ path: "A", stateValue: 1, awsValue: undefined }]);
  });

  it("ignorePaths skips a subtree", () => {
    const d = calculateResourceDrift({ Code: { S3Key: "x" } }, { Code: { S3Key: "y" } }, { ignorePaths: ["Code"] });
    expect(d).toEqual([]);
  });

  it("deepEqual treats arrays + objects structurally", () => {
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});
