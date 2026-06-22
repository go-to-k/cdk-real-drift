# FAQ

Common questions about `cdkrd`. See the [README](../README.md) for the workflow,
[why-a-baseline-file.md](why-a-baseline-file.md) for the baseline rationale, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

**How is this different from `cdk deploy --revert-drift`?**
Two axes. **Coverage:** `--revert-drift` (aws-cdk ≥ v2.1110.0) is built on
CloudFormation drift detection, so it only sees properties in your template —
undeclared drift, exactly what `cdkrd` exists to catch, is invisible to it.
**Mechanism:** `--revert-drift` reconciles to the **synth** template as part of a
`cdk deploy`, so pending local code changes ship in the same operation. `cdkrd
revert` is drift-only and per-finding: it reverts to the **deployed** template /
baseline (never your un-deployed code), touches just the divergence, and previews
with `--dry-run`.

**Why a committed baseline file — isn't the CloudFormation schema enough?**
A stateless schema comparison gives each property only two modes: report forever
(noise) or ignore forever (blind). The baseline adds the third one drift detection
actually needs: _this value is OK — alarm only when it changes_. Example:
account-level "EBS encryption by default" makes every volume `Encrypted: true`. The
schema declares no default for `Encrypted` at all (like ~99% of CloudFormation
properties), so without a recorded value the only choices are "report `true`
forever" or "ignore the property forever". The baseline pins `true` and alarms only
when it changes. Full rationale:
[docs/why-a-baseline-file.md](why-a-baseline-file.md).

**Why do `ignore` rules live in a separate `.cdkrd/config.json` instead of the
baseline file?**
(1) The baseline is machine-generated — `record` rewrites it _wholesale_ every
time, so a hand-written ignore rule kept there would be erased. (2) An ignore rule
expresses an _app-wide_ intent ("this property is managed externally"), not a
per-stack/account/region fact like a recorded value, so it should live once.
`config.json` is the `.driftignore` / Terraform `ignore_changes` equivalent; the
baseline is closer to state.

**How can `cdkrd` catch a change to a property in neither my template nor the
baseline?**
The baseline is not a watch-list. Every `check` reads the _full_ live model, then
subtracts template + schema + baseline. A property that newly appears (or changes)
with a meaningful value survives the subtraction and is reported.

**Why doesn't `--show-all` list a feature that is explicitly OFF?**
Undeclared values that are `false`/empty are suppressed — AWS returns an off/empty
value for nearly every unset option, and keeping them would flood the output. The
case that matters is still caught: a recorded value that later flips to
`false`/empty out of band is reported via baseline removal-detection.

**A property keeps drifting because an autoscaler manages it — do I re-record
forever?**
No — list it in `.cdkrd/config.json` (see
[Ignoring externally-managed properties](../README.md#ignoring-externally-managed-properties)).

**Is it safe to run in CI / on production accounts?**
`check` and `record` make read-only AWS calls (plus a local baseline file write for
`record`). `revert` is the only mutating command; it never runs without `--yes` or
an interactive confirmation, and `--dry-run` shows the plan without changes.
