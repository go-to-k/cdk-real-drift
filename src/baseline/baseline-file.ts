// Git-committed baseline file: .cdkrd/<stack>.<region>.json
// Stores the BLESSED undeclared property values (the only thing with no other
// source of truth — declared desired comes live from GetTemplate). `check`
// reports an undeclared finding only when it differs from / is absent in the
// baseline; with no baseline, every non-default undeclared value is shown.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deepEqual } from "../diff/drift-calculator.js";
import type { Finding } from "../types.js";

export interface AcceptedEntry {
  logicalId: string;
  resourceType: string;
  path: string;
  value: unknown;
}

export interface BaselineFile {
  schemaVersion: 1;
  stackName: string;
  region: string;
  capturedAt: string;
  templateHash: string;
  accepted: AcceptedEntry[];
}

export function baselinePath(stackName: string, region: string): string {
  return `.cdkrd/${stackName}.${region}.json`;
}

export function hashTemplate(rawTemplate: string): string {
  return "sha256:" + createHash("sha256").update(rawTemplate).digest("hex");
}

export async function loadBaseline(stackName: string, region: string): Promise<BaselineFile | undefined> {
  try {
    return JSON.parse(await readFile(baselinePath(stackName, region), "utf8")) as BaselineFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export async function writeBaseline(b: BaselineFile): Promise<string> {
  const p = baselinePath(b.stackName, b.region);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(b, null, 2) + "\n", "utf8"); // pretty + stable for clean PR diffs
  return p;
}

/** Build the blessed-undeclared set from a check run's findings. */
export function buildAccepted(findings: Finding[]): AcceptedEntry[] {
  return findings
    .filter((f) => f.tier === "undeclared")
    .map((f) => ({ logicalId: f.logicalId, resourceType: f.resourceType, path: f.path, value: f.actual }));
}

/**
 * Reconcile undeclared findings against the blessed baseline:
 *  - an undeclared finding matching a blessed entry (same value) is suppressed;
 *  - a changed value / new path survives (= real drift);
 *  - a blessed entry with NO corresponding current undeclared value is reported as
 *    a removal (drift in the other direction — something blessed disappeared).
 * Non-undeclared findings pass through untouched.
 */
export function applyBaseline(findings: Finding[], baseline: BaselineFile | undefined): Finding[] {
  if (!baseline) return findings;
  const blessed = baseline.accepted;
  const kept = findings.filter((f) => {
    if (f.tier !== "undeclared") return true;
    const match = blessed.find((a) => a.logicalId === f.logicalId && a.path === f.path && deepEqual(a.value, f.actual));
    return match === undefined;
  });
  // removed: blessed entries whose path is no longer present in any current undeclared finding
  const currentPaths = new Set(findings.filter((f) => f.tier === "undeclared").map((f) => `${f.logicalId}.${f.path}`));
  for (const a of blessed) {
    if (!currentPaths.has(`${a.logicalId}.${a.path}`)) {
      kept.push({
        tier: "undeclared",
        logicalId: a.logicalId,
        resourceType: a.resourceType,
        path: a.path,
        desired: a.value,
        actual: undefined,
        note: "blessed value removed since accept",
      });
    }
  }
  return kept;
}
