# Why a baseline file?

This document is the long answer to one design question: **could `cdkrd` be
stateless** — template + schema + a hand-written `.cdkrd/config.json`, with no
machine-written baseline file? Users ask it in several forms ("isn't the
CloudFormation schema enough?", "couldn't config.json cover this?", "do I really
need a committed file?"), and the short FAQ answers in [README.md](../README.md)
link here. [ARCHITECTURE.md §8](ARCHITECTURE.md#8-baseline-model) describes how
the baseline works; this document explains why it exists at all.

The honest summary up front: yes, a stateless `cdkrd` is buildable — but it is a
different, smaller product (§9). Every section below is one reason the state is
load-bearing.

## 1. Why state at all

Declared properties compare statelessly: the template records the intent, and
`check` compares live values against it. Undeclared properties have no intent
recorded anywhere — that is what "undeclared" means. Without a remembered value,
a stateless comparison gives each undeclared property exactly two modes:

- **report forever** — the value differs from whatever static reference you
  pick, every run, with no way to say "that's fine" (noise);
- **ignore forever** — suppress the property and never see it again (blind).

Drift detection needs a third mode: _this value is OK — alarm only when it
changes_. That mode is, by definition, a remembered value — i.e. state.

Two properties of that state follow immediately:

- **It cannot be recomputed.** Recordance is a human judgment about the live
  value; it is not derivable from template + schema + live, because live is the
  thing being judged.
- **It is the definition of undeclared drift.** Undeclared "drift" is only
  meaningful relative to an recorded reference. With no reference there is
  nothing to violate — which is exactly why a value you never recorded renders
  as `[Potential Drift]`, not confirmed drift (R60; per VALUE since R62 — a partial
  record leaves the unpicked values unrecorded rather than flipping them to drift).

## 2. Why schema defaults cannot substitute

The most tempting stateless reference is the CloudFormation resource schema's
`default` values: report an undeclared property only when its live value differs
from the schema default. Three independent reasons this fails:

**Coverage is ~1%.** Measured 2026-06-12 against the us-east-1 registry schema
bundle: 1,602 resource types, 14,691 top-level properties, of which **161
properties (1.1%) carry a `default`** — and only 88 types (5.5%) have even one.
For ~99% of properties the comparison has no right-hand side. Reproduce with:

```sh
curl -sO https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip
unzip -oq CloudformationSchema.zip -d schemas
python3 - <<'EOF'
import json, glob
props = [(k, v) for f in glob.glob('schemas/*.json')
         for k, v in (json.load(open(f)).get('properties') or {}).items()]
withdef = [1 for _, v in props if isinstance(v, dict) and 'default' in v]
print(f'{len(withdef)}/{len(props)} top-level properties carry a default')
EOF
```

Even the flagship example has no schema help: `AWS::EC2::Volume` declares **no
default at all** for `Encrypted` (only `type` + `description`).

**Where a default exists, it can be environmentally wrong.** Real defaults are
service-side behavior, and can be account- or region-dependent: account-level
"EBS encryption by default" makes every volume `Encrypted: true`; org policies
and default tags shift other properties. `live ≠ schema-default` does not imply
"someone changed this out of band" — it often means "this environment's
legitimate default differs". A stateless comparison reports such values as
permanent false positives, and the only stateless remedy is an ignore rule
(blind).

**Change _toward_ the default is invisible by definition.** Under
default-comparison, "matches the default" means clean. But the dangerous
direction of undeclared security drift is almost always toward the default:
encryption disabled, a permissions boundary removed, logging stopped, a
public-access block dropped. When an attacker resets a good non-default value,
the stateless report does not fire — it _disappears_. The alarm vanishing IS the
incident, and the model has no vocabulary for it. The baseline does: the value
was recorded, and the change from it is reported.

## 3. The false/empty asymmetry

The pipeline deliberately suppresses trivially-empty undeclared values
(`false`, `""`, empty structs — `isTrivialEmpty` in
[src/normalize/noise.ts](../src/normalize/noise.ts)): AWS returns an off/empty
value for nearly every unset option, and keeping them would flood the output
(see the README FAQ "Why doesn't `--show-all` list a feature that is explicitly
OFF?").

The consequence for a stateless design: "a good value was LOST" lands exactly in
the blind spot, because the bad end-state (`false`/empty/absent) looks like
nothing. Additions are visible statelessly — a meaningful value exists and
survives the subtraction. Losses are not. The asymmetry points the blind side
precisely at the security-relevant direction (§2's disable cases). The only
mechanism that catches a loss is **baseline removal-detection** — "a value
present at `record` has disappeared" — and that requires the recorded value.

## 4. Why revert needs the baseline

Undeclared properties have no template value, so the baseline value is the only
possible restore target. Without it, undeclared revert degrades to "remove /
reset toward the default", which breaks in two ways:

- **It cannot restore, only bulldoze.** A console-set logging destination that
  someone later changes should revert to the _recorded_ destination; a
  reset-to-default "revert" turns logging off entirely.
- **It proposes actively harmful operations.** Every environment-legitimate
  deviation (§2) doubles as a standing offer to "fix" it — e.g. setting
  `Encrypted: false` across an encryption-by-default account.

It also cannot distinguish "changed out of band yesterday" from "has been this
way since before cdkrd existed" — reverting the latter bulldozes recorded
reality. This is exactly why the existing no-baseline guard marks undeclared
findings `notRevertable` and why `--remove-unrecorded` is an explicit opt-in:
the guard is the temporary form of a blindness that would become permanent
without the file.

## 5. Why not `.cdkrd/config.json`

`.cdkrd/config.json` already exists (path-level ignore rules), so "couldn't the
baseline live there?" is natural. Two answers, depending on what would be
stored:

**Store values there → it's the baseline, relocated badly.** config.json is
hand-written JSONC (comments included) and stable; the baseline is rewritten
wholesale by every `record`. Merging them means either machine writes erase
human edits and comments, or `record` churns a hand-edited file on every run.
And the scopes differ: an ignore rule is app-wide intent ("autoscaling owns
`DesiredCount` everywhere"), while a baseline entry is a per-stack × account ×
region **fact** — the filename `<stack>.<accountId>.<region>.json` is the
isolation mechanism that keeps a personal-account run from colliding with a
committed shared-account baseline. Value-pinned rules would leak per-account
facts into the single app-wide file.

**Store only paths there → the third mode is gone.** An ignore rule has no
value, so it can only express "never look at X again" (mode two of §1). Ignoring
`*.Encrypted` to silence the encryption-by-default noise makes the tool blind to
encryption being disabled. And the review artifact degrades: a PR adding
`ignore *.PermissionsBoundary` records that watching stopped, but not _which_
boundary ARN was deemed recordable — exactly the information a security review
needs.

## 6. Why a git-committed file (vs DynamoDB / SSM / AWS Config)

Given that state must exist (§1), it could live in AWS-side storage. It is a
git-committed file instead because recordance is a **contract about recordable
real state**: committing it makes every recordance a reviewable PR diff
alongside the IaC it protects ("we now record value V for X" — value-level,
auditable, blame-able). It also keeps the project tenets: no extra
infrastructure, no AWS Config dependency, and the contract is readable in review
without AWS access.

## 7. Zero-config vs zero-state

The file does not cost the first-run experience:

- The **first `check` needs no file** and is fully functional: the declared and
  deleted tiers are stateless (template vs live) and fail the run from run #1;
  the undeclared tier shows as `[Potential Drift: N]` with the record path spelled
  out (R49/R60).
- The baseline is **never hand-authored** — it is the machine-recorded byproduct
  of one human decision (the interactive record after the first check, or
  `cdkrd record`).

So zero-CONFIG holds for the product's whole life (config.json stays optional),
while zero-STATE is impossible only for the undeclared tier — because without an
recorded reference, "undeclared drift" has no definition (§1). Designs that
claim otherwise just relocate the state somewhere worse: Terraform relocates it
into a state file that self-updates on the next `apply` with no human record
gate (§8), and schema-comparison pretends AWS wrote the state, when 99% of it
was never written (§2).

## 8. Prior art: what `terraform plan` actually does here

Lumping `terraform plan` with "compares only declared properties" is an
oversimplification worth spelling out, because Terraform _does_ hold the raw
material: its state file stores the full provider-schema model of each resource
(every attribute the provider's Read returns, declared or not), and since
TF 0.15.4 `terraform plan` prints "Note: Objects have changed outside of
Terraform" — a refresh diff that includes attributes never written in config.
Plain `Optional` (non-computed) attributes (e.g.
`aws_iam_role.permissions_boundary`) even produce a planned revert when set out
of band.

The accurate, narrower claim — and the actual contrast with `cdkrd`:

1. **No operational signal.** The refresh notice is informational. With no
   planned actions, plan reports "No changes" and exits 0 (`-detailed-exitcode`
   included). `Optional+Computed` attributes — the AWS provider's idiom for
   "unset means AWS/external decides" — never produce planned actions.
2. **Silent auto-recordance.** The next `apply` (or refresh write) absorbs the
   new live value into state and the notice disappears. Terraform's state IS a
   baseline — but a self-updating one, with no human record gate and no
   reviewable diff of "what we now record". `cdkrd`'s baseline moves only when a
   human runs `record`, and the move is a PR diff.
3. **Undeclared sub-resources are fully invisible.** The AWS provider models
   many properties as separate resources (`aws_s3_bucket_ownership_controls`,
   `aws_s3_bucket_public_access_block`, `aws_iam_role_policy`, ...). Never
   declared → no state entry → not even refreshed. The flagship examples
   (ownership controls, an extra inline policy) hit exactly this gap.

## 9. What a stateless `cdkrd` would be

Dropping the third mode ("record this value, alarm when it changes") removes
the need for the file entirely — and produces a coherent, smaller product:
declared/deleted drift detection plus an undeclared _inventory_ with ignore
rules. The honest degradation table:

| capability                               | with baseline                           | stateless (config.json only)                          |
| ---------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| declared / deleted drift                 | works, fails the run                    | unchanged — works, fails the run                      |
| undeclared change detection              | alarm on change from the recorded value | gone — existence inventory only                       |
| new vs always-been-there                 | distinguished (vs baseline)             | indistinguishable                                     |
| loss of a good value (disable direction) | removal-detection alarms                | invisible (the §3 blind spot)                         |
| undeclared revert                        | restore the recorded value              | remove/reset only — can't restore; proposes harm (§4) |
| recordance record                        | reviewable value-level PR diff          | "stopped watching X" only                             |

That product no longer answers this project's thesis — the most dangerous
direction (disabling security posture) becomes the least visible one — which is
why the baseline stays.

## 10. The shortest framing

The baseline is **the per-environment defaults database AWS never wrote**:
14,691 top-level properties whose real, account-specific defaults exist only as
service behavior, populated by observation (`check` reads the full live model)
and ratified by a human (`record`), one decision at a time, as a reviewable git
artifact.
