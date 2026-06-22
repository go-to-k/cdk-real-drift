#!/usr/bin/env bash
# First-run-noise sweep: replay the classify pipeline over the golden corpus and
# print the undeclared (type, path) buckets, ranked so constant-looking values
# (KNOWN_DEFAULTS / KNOWN_DEFAULT_PATHS candidates) come first. Use it to shrink
# first-run [Not Recorded] noise — the fold is equality-gated, so a promoted
# default can never hide a real change. See tests/measure-noise.test.ts and
# docs/ARCHITECTURE.md § 6. The /hunt-bugs skill runs this after deploying
# uncovered types (which record fresh corpus via CDKRD_CORPUS_DIR).
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -t cdkrd-noise.XXXXXX)"
trap 'rm -f "$out"' EXIT
# `vp test run` intercepts console output, so the spec writes the report to $out.
CDKRD_MEASURE_NOISE=1 CDKRD_NOISE_OUT="$out" vp test run tests/measure-noise.test.ts
echo
echo "=== first-run-noise report ==="
cat "$out"
