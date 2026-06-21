# cdk-real-drift (`cdkrd`)

Drift detection for AWS CDK — including the **undeclared properties `cdk drift`
can't see**. Detect it, record it, or revert it.

<!-- badges (enable on publish):
[![npm](https://img.shields.io/npm/v/cdk-real-drift)](https://www.npmjs.com/package/cdk-real-drift)
[![CI](https://github.com/go-to-k/cdk-real-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/go-to-k/cdk-real-drift/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
-->

## Why

Someone attaches an extra inline policy to one of your roles from the console.
CloudFormation drift detection only compares properties that **appear in your
template**, so:

```bash
$ npx cdk drift ApiStack
✨  Number of resources with drift: 0
```

`cdkrd` reads the **full** live resource model and subtracts everything
explainable — the same change shows up:

![cdkrd finds an out-of-band inline policy that `cdk drift` reports as zero](demo/demo.gif)

```console
$ npx cdkrd check ApiStack
=== cdkrd check: ApiStack (us-east-1) ===
[CFn-Undeclared Drift: 1] (live-only — not in your CloudFormation template; the differentiator)
  ApiStack/ApiRole.Policies (AWS::IAM::Role) = [{"PolicyName":"manual-debug-access", ...}]

result: 1 drift(s) (undeclared=1)
```

_The GIF is regenerated with [`demo/`](demo/) (`bash demo/setup.sh` → `vhs demo/cdkrd.tape`)._

| Capability                                                          | `cdkrd` | `cdk drift` / CFn drift detection |
| ------------------------------------------------------------------- | :-----: | :-------------------------------: |
| Detect drift on **declared** properties (incl. out-of-band deletes) |   ✅    |                ✅                 |
| Detect drift on **undeclared** properties                           |   ✅    |                ❌                 |
| Detect **added** out-of-band resources (not in template)            |   ✅    |                ❌                 |
| **Revert** declared drift                                           |   ✅    |  ✅ `cdk deploy --revert-drift`   |
| **Revert** undeclared drift                                         |   ✅    |                ❌                 |
| **Record** drift into a git-committed file, reviewed like any PR    |   ✅    |                ❌                 |

## Quick start

_Not yet on npm — coming with the first public release._

```bash
npm install -D cdk-real-drift   # in your CDK project
npx cdkrd check                 # checks every stack your app defines
```

**First run** — your template never pins every live value (AWS defaults,
generated names), so the report lists the UNRECORDED values (they are not drift —
there is nothing to compare them to yet), then offers to record a baseline:

```console
=== cdkrd check: ApiStack (us-east-1) ===
[Not Recorded: 2] (not drift — a live-only value not yet in your .cdkrd baseline; run cdkrd record to track it)
  ApiStack/Topic.DisplayName (AWS::SNS::Topic) = "test"
  ApiStack/Role.Policies (AWS::IAM::Role) = [{"PolicyName":"adhoc", ...}]

result: CLEAN — 42 unrecorded value(s) await a baseline (2 shown, 40 folded; run cdkrd record)
info:
  - atDefault=40 (undeclared values matching a known AWS default — not drift)
  ...

ApiStack: unrecorded values found — what do you want to do?
  ❯ Nothing (decide later)
    Record all undeclared (live-only) — snapshot into the .cdkrd baseline (keeps watching)
    Ignore all — stop reporting it (writes .cdkrd/config.json)
    Decide per finding — pick an action for each
```

The report always prints **first**, so you see the standout values before deciding
(no blind bulk-record). The count is the **complete** undeclared inventory, but
only the handful that **stand out** are listed — AWS defaults, auto-generated
names/identifiers, and nested sub-keys you never touched fold into the `info:`
footer (`atDefault=` / `generated=` / `nested=`, `--show-all` expands them).
Choosing Record opens a checklist (everything pre-selected — Enter to record all,
or deselect what you want to keep visible) and writes
`.cdkrd/ApiStack.<account>.<region>.json` — **a git file, nothing written to
AWS** — commit it; from here on `check` reports CLEAN until reality changes.
(Declared drift is detected from the very first run, baseline or not.)

**Day to day** — someone changes something from the console; the next `check`
reports it and asks right there:

```console
ApiStack: drift found — what do you want to do?
  ❯ Nothing (decide later)
    Record all undeclared (live-only) — snapshot into the .cdkrd baseline (keeps watching)
    Revert all — write the desired values to AWS
    Ignore all — stop reporting it (writes .cdkrd/config.json)
    Decide per finding — pick an action for each
```

- **Record all** records the undeclared values — and any out-of-band **added**
  resources — in the baseline, so `check` stays CLEAN until they change again (a
  multiselect lets you record some and keep reporting others). Keeps watching.
- **Ignore all** writes a path rule to `.cdkrd/config.json` so the drift (declared,
  undeclared, _or_ an out-of-band **added** resource) stops being reported entirely.
  Stops watching.
- **Decide per finding** opens a picker to assign a different action to each
  finding. On a stack with many findings, **just start typing to filter** the rows
  by name (↑↓ move · space cycles the row's actions · → applies the focused action
  to every _visible_ row · ⌫ clears the filter · enter applies · esc backs out).
- **Revert all** shows a plan, lets you pick which op(s) to write, confirms, then
  writes the desired values back to AWS:

```console
=== cdkrd revert: ApiStack (us-east-1) ===

  ApiStack/ApiRole (AWS::IAM::Role)
    - Policies -> remove (undeclared, not in baseline)

Apply 1 revert op(s) to ApiStack? This WRITES to AWS. · yes
  reverted: ApiStack/ApiRole

verifying convergence (re-reading 1 resource(s))...
ApiStack: CLEAN after revert.
```

`record`, `ignore`, and `revert` also exist as standalone commands; in CI, run
`npx cdkrd check --fail`.

Requirements: Node.js >= 20, AWS credentials via the standard SDK chain
(env vars, `--profile`, SSO).

## How it works

cdkrd compares the **live AWS resource** against your **CloudFormation template**
(the one you DEPLOYED by default; the local synth with `--pre-deploy`). The
vocabulary names exactly which of the three sources a finding relates to, so
"declared" is never ambiguous:

| term                           | source                                        | meaning                                                 |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------- |
| **CFn-declared**               | your CloudFormation template                  | the property IS in the template; the live value drifted |
| **CFn-undeclared** (live-only) | the live resource                             | the property is on the resource but NOT in the template |
| **Added Resource**             | the live resource                             | a whole resource exists live but is NOT in the template |
| **recorded / unrecorded**      | your `.cdkrd` baseline file (a separate axis) | whether you have snapshotted that live-only value yet   |

So `CFn-declared` ≠ "declared in my CDK code" and ≠ "in my `.cdkrd` baseline" — it
means the deployed **CloudFormation** template. `CFn-undeclared` and `unrecorded`
are different axes (template vs baseline file), not synonyms.

After `check` finds drift, you decide what each finding means — and the verbs mirror
the choice:

| verb           | meaning                                                               | writes                     |
| -------------- | --------------------------------------------------------------------- | -------------------------- |
| `cdkrd check`  | find drift                                                            | nothing                    |
| `cdkrd record` | "this undeclared / added state is the norm — tell me if it _changes_" | a git file (baseline)      |
| `cdkrd ignore` | "stop reporting this property, ever"                                  | a git file (`config.json`) |
| `cdkrd revert` | "this state is WRONG" — write the desired value back                  | AWS (plan + confirm)       |

The one distinction to keep straight: **`record` keeps watching** (it snapshots
the current undeclared value — or out-of-band **added** resource — and re-surfaces
drift if it later changes), while **`ignore` stops watching** (it writes a path
rule — declared, undeclared, _or_ an out-of-band added resource — and it is never
reported again). `record` snapshots undeclared properties **and** added resources;
`ignore` is the only in-tool way to accept a **declared** drift without editing
code or reverting.

- **CFn-declared** properties are compared against the **deployed CloudFormation
  template** — no baseline involved, drift is detected from the first run.
- **Undeclared** (live-only) properties are compared against a **baseline** you
  record with `record`: a JSON file at `.cdkrd/<stack>.<accountId>.<region>.json`, committed
  to git. A PR that changes it is a visible, reviewable change to "what real
  state we record". Account id and region are part of the filename, so the same
  stack deployed to several accounts never collides (gitignore personal-account
  baselines if you prefer).
- There is **no watch-list to maintain**. Every `check` snapshots the full live
  model (Cloud Control API + SDK readers for the gap types) and subtracts
  everything explainable — schema read-only/write-only/defaults, AWS-managed
  fields, `aws:*` tags, policy-document and ordering noise. What survives is
  signal.
- Anything not confidently comparable is reported honestly as informational
  (`readGap` / `unresolved` / `skipped`) — **never** guessed, so no false drift.
- A resource **deleted out of band** — the most blatant drift there is — is
  reported in the `deleted` tier and always counts as failing drift under
  `--fail`.
- A resource **added out of band** — a whole child resource that exists live but
  is not in your template (e.g. an API Gateway `ANY` method added on `/` via the
  console) — is the resource-level sibling of an undeclared property, and is
  reconciled the same way against your baseline: an added resource you have **not**
  recorded is reported under **Not Recorded** (inventory awaiting a decision, not
  failing drift), one you recorded and that is unchanged is suppressed, and one
  that **changed since you recorded it** is failing drift. `cdk drift` / CFn drift
  detection compare only template-declared resources, so an out-of-band addition
  is invisible to them. Decide it like any other finding: `cdkrd record` snapshots
  its full live model (and watches it for changes), `cdkrd ignore` accepts it, or
  `cdkrd revert` **deletes** it (Cloud Control `DeleteResource`, behind the usual
  confirm / `--dry-run` / picker; an unrecorded one needs `--remove-unrecorded`,
  exactly like removing an unrecorded undeclared value). Coverage grows per parent
  type (the `CHILD_ENUMERATORS` registry); API Gateway REST APIs (resources,
  methods, authorizers, models, request validators, and gateway responses),
  API Gateway V2 (HTTP / WebSocket) API routes,
  integrations, authorizers, and stages, SNS topic subscriptions, Lambda event source
  mappings, function URLs, aliases, and versions, EventBridge bus rules, Cognito
  user pool clients, groups, and
  resource servers, AppSync data sources, resolvers, and functions, CloudWatch
  Logs metric
  filters and subscription filters, Elastic Load Balancing v2 listeners, and ELBv2 listener rules, EC2
  VPC subnets, EC2 route table
  routes, ECS cluster services, KMS key aliases, AppConfig application
  environments and configuration profiles, EFS file system mount targets, and RDS
  database cluster instances are
  covered.

`cdkrd` is **reality vs intent**, not code vs template: it deliberately does not
reimplement `cdk diff`, so undeployed code changes never show up as drift
(see [`--pre-deploy`](#commands--options) for the opt-in inversion).

Full design and rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Selecting stacks

| invocation            | what is checked                                               |
| --------------------- | ------------------------------------------------------------- |
| `cdkrd check`         | every stack the CDK app defines, each in its own `env.region` |
| `cdkrd check 'Dev*'`  | glob, matched against the app's stack names                   |
| `cdkrd check MyStack` | one stack, selected by name from the app                      |

`cdkrd` is **CDK-only**: it always resolves your CDK app to discover which
stacks exist and to label findings by construct path. The app comes from
`cdk.json` when you run in the project directory, or from `--app`: a command
(`--app "node bin/app.js"`) or a pre-synthesized assembly (`--app cdk.out` —
read, not executed); `$CDKRD_APP` also works. The drift comparison itself still
reads each stack's **deployed** template + live state from AWS — synth only
tells cdkrd which stacks to look at.

## Commands & options

| command                     | does                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `cdkrd check [<stack>...]`  | compare live state vs template (declared) + baseline (undeclared)      |
| `cdkrd record [<stack>...]` | snapshot undeclared + added state into the baseline (CI: `--yes`)      |
| `cdkrd ignore [<stack>...]` | stop reporting chosen drift via `.cdkrd/config.json` (CI: `--yes`)     |
| `cdkrd revert [<stack>...]` | write the desired value back to AWS (confirms; `--dry-run` to preview) |

**`cdkrd check` is the entry point.** Run it and act from its interactive
prompt — it establishes the first baseline (on a fresh deploy) and offers
**record / revert / ignore** inline on whatever it finds, so day to day you only
run `cdkrd check`. The standalone `record` / `ignore` / `revert` verbs are the
**same actions** for scripting / non-TTY / CI (with `--yes`); a human rarely
needs to invoke them directly. (Baselines stay a reviewed, git-committed artifact
either way — CI never writes one; you record locally and commit it.)

**Exit codes:** `check` is **report-only by default** — drift prints but exits
`0` (a note names the flag). Pass **`--fail`** (the `cdk diff --fail` /
`cdk drift --fail` convention) to exit `1` on drift and suppress all prompts —
the one flag for scripts and CI. **`--strict`** is the orthogonal coverage axis:
it exits `1` when a run was incomplete — any resource skipped (unread) or a
nested stack not recursed into. The gap is always surfaced regardless: skipped
resources as the `skipped=N — NOT checked (coverage incomplete)` line in the
report's `info:` footer (a stderr `warning:` under `--json`, which has no footer),
a nested stack as a loud stderr `warning:`. `--strict` only decides whether that
gap fails the build.
Errors always exit `2`; `revert` exits `1` when drift remains after it.

```yaml
- run: npm ci # cdkrd resolves the CDK app, so its deps must be installed
- run: npx cdkrd check --fail --region us-east-1 # fails the job on drift
# or point at a prebuilt assembly artifact instead of synthesizing:
# - run: npx cdkrd check --fail --app cdk.out --region us-east-1
```

| option                     | meaning                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--region <r>`             | AWS region (or `$AWS_REGION` / `$AWS_DEFAULT_REGION`); CDK stacks with explicit `env.region` are auto-detected                                                                                                   |
| `--profile <p>`            | AWS profile (or `$AWS_PROFILE`)                                                                                                                                                                                  |
| `-a, --app <cmd\|cdk.out>` | CDK app command or pre-synthesized assembly dir (or `$CDKRD_APP` / cdk.json `"app"`) — stack auto-discovery + construct paths                                                                                    |
| `-c, --context key=value`  | context for synth (repeatable; cdk.json is the base layer)                                                                                                                                                       |
| `--all`                    | target EVERY stack the app defines (the default when no `<stack>` is named; overrides any positional names)                                                                                                      |
| `--json`                   | machine-readable output (see [JSON contract](#json-output-contract))                                                                                                                                             |
| `--fail`                   | (check) exit 1 on drift + never prompt — for scripts/CI; without it, check reports drift but exits 0                                                                                                             |
| `--strict`                 | (check) exit 1 when COVERAGE is incomplete — any resource skipped (unread) or a nested stack not recursed into. A coverage gap is always surfaced loudly; `--strict` makes it CI-failing. Orthogonal to `--fail` |
| `--show-all`               | inventory mode: show ALL current undeclared state, ignoring the baseline                                                                                                                                         |
| `--verbose` / `-v`         | (check) expand informational tiers from the `info:` footer / (revert) the per-reason NOT-revertable summary — to full lists                                                                                      |
| `--pre-deploy`             | (check) compare live vs the LOCAL synth template — the declared drift your next `cdk deploy` would silently overwrite                                                                                            |
| `--undeclared-only`        | (check) undeclared drift only — pair cdkrd with `cdk drift` / CFn drift detection for the declared side                                                                                                          |
| `--declared-only`          | (check) declared drift vs the DEPLOYED template only (undeclared tier skipped; baseline untouched). Not `--pre-deploy`                                                                                           |
| `--dry-run`                | (revert) print the plan; make no changes                                                                                                                                                                         |
| `--remove-unrecorded`      | (revert) REMOVE unrecorded values + DELETE unrecorded added resources in a NO-PROMPT run (`--yes`/CI); an interactive revert already lists them as opt-in REMOVE/DELETE                                          |
| `--yes` / `-y`             | skip confirmations (revert apply; record records all without the multiselect)                                                                                                                                    |

Unknown options (`--apq`) and options missing their value (`--app` at the end of
the line) are errors (exit `2`) — a typo'd flag never silently becomes a stack name.

### Interactive prompts (TTY only — CI is never prompted)

- **`check` with drift** offers `Record all / Revert all / Ignore all / Decide
per finding / Nothing` inline (shown above). Each option appears only when it
  applies (no Revert if nothing is revertable; "Decide per finding" only with >1
  finding). `Nothing` is the default; Enter keeps plain-check behavior. Every
  option runs exactly the same code as the standalone commands — including the
  per-finding picker, which passes each verb just the subset you chose. After a
  **Record** or **Ignore**, the menu **re-appears** for any drift that action
  could not resolve (e.g. a declared drift still standing after you recorded the
  undeclared values), so you can revert or ignore the remainder in the same run —
  no need to re-run `check`. Skipped under `--json`, `--show-all`,
  `--pre-deploy`, and `--fail`. Aborting the Revert confirmation writes nothing
  — the drift still stands and stays reported.
- **`revert`** shows the plan, then a multiselect of the op(s) to write. **Every
  op starts unselected** — `revert` is the one command that writes to AWS, so
  nothing is pre-armed; you opt in to each write explicitly. REMOVE ops (deleting
  a live value not in your template — a standout `[Not Recorded]` value, or one
  not in the baseline) are labeled `(REMOVE)` so a destructive delete stays
  visible. In the multiselect, **space** toggles the row, **→** selects all, **←**
  clears all, **enter** confirms. A final confirm states exactly how many selected
  op(s) will be written. `--yes` skips both and applies the full plan.
- **`record`** shows a multiselect of only the **delta** from the existing
  baseline (new + changed undeclared values, all pre-selected); already-recorded
  unchanged values are auto-kept and surfaced with a
  `keeping N already-recorded unchanged value(s)` note. Deselect a suspicious one
  and it stays reported by `check` — record the intentional changes without
  rubber-stamping the rest. With no baseline yet, the full set is shown.
  `record` snapshots **undeclared** state and out-of-band **added** resources —
  it does not "approve everything". Any **declared / deleted** drift (divergence
  from your template intent) is NOT written to the baseline and cannot be silenced
  by it; `record` prints a note that it still stands, to be resolved with `revert`
  or `cdk deploy`.
- **`check` with no baseline yet** asks what to do with the N undeclared values
  it found: **record ALL of them** into the baseline (the default — the common
  first-run choice; it writes only a git-tracked file, nothing to AWS), or
  **show them first** (the report prints, and a selective record is offered
  right after it). Even with **zero undeclared values** (a clean fresh deploy),
  `check` still offers to **record the current state as the baseline** — so the
  day-1 baseline is established through `check`'s own prompt, not a separate
  `cdkrd record` step; once a baseline exists, a clean run prompts nothing. After
  an interactive record, a closing note states what remains:
  a PARTIAL record is a success — unselected values simply stay reported as
  UNRECORDED from the next `check` on (recording one value never flips the
  rest into drift) — and any remaining declared/deleted drift is named —
  record cannot address it (fix the code or choose Revert).
- A non-TTY run (CI, cron, pipes) never prompts: required write **decisions**
  without `--yes` error with exit 2 (the safe side). `--yes` alone in a TTY
  auto-approves confirmations only (select prompts still show).

### Catching what your next deploy would overwrite (`--pre-deploy`)

Normal `check` asks "did reality drift from what I deployed?". `--pre-deploy`
asks the inverse, **right before a deploy**: "which LIVE values would my local
code overwrite?" It compares live state against your **local synth** template
(instead of the deployed one), so a console hot-fix someone made during an
incident shows up before `cdk deploy` silently reverts it:

```console
$ npx cdkrd check --pre-deploy
(--pre-deploy) comparing live state against the LOCAL synth template
=== cdkrd check: ApiStack (us-east-1) ===
[CFn-Declared Drift: 1]
  ApiStack/Api/Handler.MemorySize (AWS::Lambda::Function)
      desired=1024
      actual =2048

result: 1 drift(s) (declared=1)
```

Here `desired` is what your local code is about to set; `actual` is live right
now — someone bumped the memory to 2048 out of band. Deploying without porting
that into code would silently undo it: port it (or decide it should go away),
then deploy. As a pipeline gate, run it right before the deploy step:

```yaml
- run: npx cdkrd check --pre-deploy --fail # block the deploy on clobber risk
- run: npx cdk deploy --all --require-approval never
```

`--pre-deploy` reports **declared** drift only (the undeclared tier is defined
against the _deployed_ template, so it is excluded here) and never touches the
baseline.

### Ignoring externally-managed properties

Some properties are _legitimately_ rewritten by another system — Application
Auto Scaling moving an ECS Service `DesiredCount`, autoscaled DynamoDB capacity.
A recorded snapshot would re-flag every move. Run **`cdkrd ignore`** to pick the
drift to suppress (it appends exact rules to the file for you), or hand-edit the
git-committed `.cdkrd/config.json` (strict JSON — no comments or trailing commas,
and unknown keys are rejected so a typo can't silently disable your rules):

```json
{
  "ignore": [
    { "path": "*.DesiredCount" },
    { "path": "Fn*.ReservedConcurrentExecutions", "stack": "Prod*" },
    { "path": "*.DesiredCount", "region": "us-*" }
  ]
}
```

Every rule is an **object** `{ "path", "stack"?, "region"? }` — one uniform,
self-labelling shape (`path` says what the value is). `cdkrd ignore` writes the
unscoped form — `path` is an exact `<constructPath>.<path>` rule (or
`<logicalId>.<path>` on a non-CDK stack); the optional `stack` / `region`
scopes are a hand-edit. All three of `path` / `stack` / `region` accept the same
`*` / `?` glob, and a parent `path` rule covers child paths. **Region is an
independent axis** from the stack name: the same stack name can be deployed to
several regions (or matched by a `*` stack glob) and a property may legitimately
drift in only one. Matching findings move to the informational `ignored` tier —
still visible under `--verbose`, never exit-affecting, and excluded from `revert`
plans and `record`. A **deleted resource is never ignorable**.

## Output

Two parts: the **drift sections** in full detail, then a one-line `info:` footer
that folds everything informational.

- **Drift tiers** — `deleted` / `declared` / `undeclared` — are always listed in
  full and drive the `--fail` exit. They are the point.
- **`[Not Recorded: N]`** — undeclared values you have not recorded yet. Listed in
  full, but not drift (there is nothing to compare them to): they never fail the
  build, and `result:` points you at `cdkrd record`. Once a resource is fully
  snapshotted, a value that _appears_ later is real drift (`appeared since record`).
- **`info:` footer** folds the informational tiers to per-reason counts
  (`--verbose` expands them):
  - **`atDefault`** — undeclared values sitting at a known AWS default (a Lambda's
    `TracingConfig: PassThrough`, a bucket's default Block Public Access). The bulk
    of a first run, folded to a count so the body shows only what actually
    diverges. Equality-gated: a change away from the default still surfaces, and
    `--show-all` lists them. Applies at **any depth** — a value nested inside a
    declared property that equals the schema's `default` for that path folds here
    too (so config-dense types like CloudFront, whose schema annotates dozens of
    nested defaults, don't drown the report in `nested` inventory).
  - **`generated`** — undeclared values that are the **name or identifier AWS/CDK
    minted for the resource**, not anything you set: a topic's auto-generated
    `TopicName`, a Lambda's default `LoggingConfig` whose `LogGroup` is named after
    the generated function name. Keyed off the resource's physical id, so they
    appear on every first run yet you never chose (and often cannot edit) them.
    Folded to a count like `atDefault`, equality-gated against the physical-id
    template (change one out of band — say a `LogFormat: JSON` — and it re-surfaces
    as real undeclared drift); never recorded by `record`. `--verbose` lists them.
  - **`nested`** — undeclared values that live as a **sub-key inside a property
    you _did_ declare** (e.g. you set a cache behavior but never its
    `SmoothStreaming`, which AWS materializes underneath) — including inside the
    elements of an identity-keyed array you declared (a CloudFront `Origins[<id>]`
    gaining a `ConnectionTimeout`, a DynamoDB GSI gaining `WarmThroughput`). The
    live model carries many of these, so they fold to a count; `record` records
    them like any undeclared value (so a later out-of-band change to one surfaces),
    and `--show-all` / `--verbose` list them.
  - **`readGap` / `unresolved` / `skipped` / `ignored`** — values cdkrd can't
    confidently compare, reported honestly rather than guessed (never false drift).

`^result:` is the greppable verdict; `--json` is the formal machine contract.
Colorized on a TTY (`NO_COLOR` respected); piped / CI / `--json` output is plain
text.

```console
=== cdkrd check: ApiStack (us-east-1) ===
[CFn-Declared Drift: 1]
  ApiStack/UploadBucket.VersioningConfiguration.Status (AWS::S3::Bucket)
      desired="Enabled"
      actual ="Suspended"

result: 1 drift(s) (declared=1)
info:
  - readGap=1 (declared but unverifiable — AWS doesn't return them on read, not drift: 1 write-only)
  - skipped=2 (custom resource 2)
  run with --verbose for the list
```

### JSON output contract

`--json` emits
`{ "stack": "<name> (<region>)", "drifted": <n>, "findings": [...] }`.
Each finding has a stable shape: `tier` (`deleted` | `declared` | `undeclared` |
`readGap` | `unresolved` | `skipped` | `ignored`), `logicalId`, `resourceType`,
`path`, `desired`, `actual`, `note`, `physicalId`, `constructPath`. An
unrecorded value keeps `tier: "undeclared"` and carries `"unrecorded": true`;
`drifted` excludes it. The output always carries every finding regardless of
`--verbose`. After publication this shape is treated as a backward-compatible
API.

## IAM permissions

`check` / `record` are **read-only**. The AWS managed `ReadOnlyAccess` policy
covers them. If you scope tighter, the calls are:

<details>
<summary>Minimal read permissions (check / record)</summary>

- `cloudformation:GetTemplate`, `ListStackResources`, `DescribeStacks`,
  `DescribeType`; `ListExports` (only for templates using `Fn::ImportValue`)
- `cloudcontrol:GetResource` — Cloud Control invokes each type's own read handler,
  so it needs that type's read permissions (this is why `ReadOnlyAccess` is the
  simple answer)
- SDK readers for the Cloud-Control-gap types: `s3:GetBucketPolicy`,
  `sns:GetTopicAttributes`, `sqs:GetQueueAttributes`, `iam:GetRolePolicy`,
  `iam:GetUserPolicy`, `iam:GetGroupPolicy`, `iam:GetPolicy`, `iam:GetPolicyVersion`,
  `lambda:GetPolicy`, `budgets:ViewBudget`, `ec2:DescribeAddresses`,
  `route53:ListResourceRecordSets`, `glue:GetTable`, `logs:DescribeMetricFilters`,
  `scheduler:GetSchedule`
- Optional: `kms:ListAliases` — enables strict verification that a declared
  `alias/aws/*` key was not swapped for a customer-managed key. Without it that
  case is conservatively suppressed AND cdkrd prints a one-line warning per region
  (the swap would otherwise go undetected), so the reduced coverage is never silent

</details>

`revert` additionally needs write access to the resources you revert:
`cloudcontrol:UpdateResource` (which resolves to each type's own update permissions),
plus, for the SDK-written types: `s3:PutBucketPolicy` / `s3:DeleteBucketPolicy`,
`sns:SetTopicAttributes`, `sqs:SetQueueAttributes`, `iam:PutRolePolicy` /
`DeleteRolePolicy` / `PutUserPolicy` / `PutGroupPolicy`,
`iam:CreatePolicyVersion` / `DeletePolicyVersion` / `ListPolicyVersions`,
`elasticloadbalancing:ModifyLoadBalancerAttributes` /
`ModifyTargetGroupAttributes`.

**If you never run `revert`, cdkrd needs no write permissions at all.**

## Limitations

- **Fail-closed by design.** A property `cdkrd` cannot confidently compare (an
  exotic intrinsic, a write-only value, a Cloud-Control-unreadable type) is
  reported as informational, never guessed. You trade a little coverage for zero
  false drift.
- **Revert cannot do everything.** Not revertable, and reported as such:
  - **UNRECORDED values** (never recorded — including everything undeclared on
    a stack with no baseline yet) — there is no recorded state to write back,
    so `revert` refuses: record them if the live values are right, or opt into
    removal with `--remove-unrecorded`;
  - a `deleted` resource (recreate it with `cdk deploy`);
  - **nested undeclared values** (a sub-key inside a property you declared, incl.
    inside an identity-keyed array element) — detect/record-only: a flat patch
    can't safely target a deep sub-field, so fix any real divergence in your IaC
    or re-record the live value;
  - **create-only** properties (changing them requires resource replacement);
  - toggle-style properties with no "absent" state (e.g. S3 transfer acceleration
    is only `Enabled`/`Suspended`);
  - `AWS::Lambda::Permission` and `AWS::Budgets::Budget` (their write APIs cannot
    safely reconstruct the desired state from what is readable).

  Not-revertable findings fold into a one-line-per-reason summary (`--verbose`
  for the full list). When findings exist but **nothing** is revertable, `revert`
  prints a `nothing revertable — ... remain.` summary (drift and unrecorded
  values counted separately) and exits 1 (they still stand); exit 0 means there
  was no drift to revert at all.

- **Revert writes the canonical form** of the desired value — semantically equal
  to your template, but statement/tag ordering or scalar-vs-array may differ
  textually.
- **Custom resources** (`Custom::*`) have no cloud-side model and are always
  `skipped` (without an API call).
- **Nested stacks** (the CDK `NestedStack` construct / any
  `AWS::CloudFormation::Stack` resource) are deployed as separate child stacks;
  `cdkrd` checks the parent's `AWS::CloudFormation::Stack` resource but does **not**
  recurse into the child, so the resources **inside** a nested stack are not checked.
  This is never silent — `check` prints a prominent `warning:` line naming each
  nested stack so an incomplete-coverage run is never mistaken for a fully-checked
  CLEAN one. (Check a nested stack directly by passing its deployed child stack name.)
- **Lambda Permission:** if only the specific statement was removed out of band
  (while the function's policy still exists), it is reported as `skipped`, not
  `deleted` — identifying the exact statement would need its `StatementId`.
- **IAM ManagedPolicy attachments:** `cdkrd` compares a managed policy's
  `Roles`/`Users`/`Groups` **attachment** lists **asymmetrically**. A managed policy
  is commonly attached from several places (the `AWS::IAM::ManagedPolicy`'s own
  lists, a role's `ManagedPolicyArns`, a separate attachment resource, the console),
  so the live attachment set is a **union** that legitimately exceeds any one stack's
  intent. cdkrd therefore reports only a **declared attachment that is MISSING from
  live** (an out-of-band **detach** — a privilege the stack intends was removed)
  and **ignores** live-only members (the union). This catches the real removal
  without the false drift a symmetric compare (e.g. `cdk drift`) raises on every
  shared policy. A detach is revertable: `revert` re-attaches the declared member
  (`AttachRolePolicy`/`AttachUserPolicy`/`AttachGroupPolicy`) without touching the
  union members. The policy **document** (and Path/Description) is compared as usual.
- **AppSync GraphQL schema.** The `AWS::AppSync::GraphQLSchema` resource (a CDK
  `GraphqlApi`'s schema `Definition`) is reported `skipped`: Cloud Control has
  **no READ** for the type (`UnsupportedActionException`), and AppSync's only
  schema-read API returns the **compiled introspection** form — AWS scalars /
  directives / built-in types expanded — not the source SDL you declared, so a
  faithful comparison is not possible without false drift. The rest of the API
  **is** checked (the `GraphqlApi` body — auth / X-Ray / logging — plus its
  DataSources, Resolvers and Functions via the out-of-band added-resource
  enumerators); only the raw schema text is out of scope.
- **Stack state.** A stack with no meaningful deployed reality is **skipped with a
  clear note**, not compared to a meaningless CLEAN: `REVIEW_IN_PROGRESS` (a change
  set created but never deployed) and a delete in progress. A stack mid-operation
  (any other `*_IN_PROGRESS`) or in a `*_FAILED` state is still checked, but `check`
  prints a `warning:` that the deployed template may not match live reality so
  results may be transient. Only stable `*_COMPLETE` states are a fully reliable
  comparison.
- **SDK-override coverage.** The handful of CC-gap types read via an SDK override
  (see "CC-gap types" above) compare the properties that override returns. A few
  readers project a subset of the resource: a declared property the reader doesn't
  return shows as `readGap` (not silently CLEAN — it's surfaced), and an undeclared
  one on an unprojected property isn't compared. Coverage is widened as needed
  (e.g. a budget's `CostFilters` scope is compared); fully CC-readable types (the
  vast majority) always get the complete live model.
- **Unsupported / unreadable resource types.** A resource type Cloud Control can't
  read — one with no Cloud Control support, or one whose CC handler errors (e.g. a
  server-side CC bug) and that has no SDK override — is reported as `skipped`
  (coverage incomplete), surfaced in the `skipped=N — NOT checked` line and
  **never** silently treated as CLEAN; `--strict` makes such a gap CI-failing.

## FAQ

**How is this different from `cdk deploy --revert-drift`?**
Two axes. **Coverage:** `--revert-drift` (aws-cdk ≥ v2.1110.0) is built on
CloudFormation drift detection, so it only sees properties in your template —
undeclared drift is invisible to it, and is exactly what `cdkrd` exists to
catch. **Mechanism:** `--revert-drift` reconciles to the **synth** template as
part of a `cdk deploy`, so any pending local code changes ship in the same
operation. `cdkrd revert` is drift-only and per-finding: it reverts to the
**deployed** template / baseline (never your un-deployed code), touches just the
divergence, and previews with `--dry-run`.

**Why a committed baseline file — isn't the CloudFormation schema enough?**
A stateless schema comparison gives each property only two modes: report forever
(noise) or ignore forever (blind). The baseline adds the third one drift
detection actually needs: _this value is OK — alarm only when it changes_.
Example: account-level "EBS encryption by default" makes every volume
`Encrypted: true`. The schema is no help — it declares no default for
`Encrypted` at all, like ~99% of CloudFormation properties — so without a
recorded value the only choices are "report `true` forever" or "ignore the
property forever". The baseline pins `true` and alarms only when it changes.
Full rationale (with measurements):
[docs/why-a-baseline-file.md](docs/why-a-baseline-file.md).

**How can `cdkrd` catch a change to a property that is in neither my template
nor the baseline?**
The baseline is not a watch-list. Every `check` reads the _full_ live model,
then subtracts template + schema + baseline. A property that newly appears (or
changes) with a meaningful value survives the subtraction and is reported.
Why neither the schema nor `.cdkrd/config.json` can play the baseline's role is
covered in [docs/why-a-baseline-file.md](docs/why-a-baseline-file.md).

**Why doesn't `--show-all` list a feature that is explicitly OFF?**
Undeclared values that are `false`/empty are suppressed — AWS returns an
"off/empty" value for nearly every unset option, and keeping them would flood
the output. The case that matters is still caught: an recorded value that later
flips to `false`/empty out of band is reported via baseline removal-detection.

**A property keeps drifting because an autoscaler manages it — do I have to
re-record forever?**
No — list it in `.cdkrd/config.json`
(see [Ignoring externally-managed properties](#ignoring-externally-managed-properties)).

**Is it safe to run in CI / on production accounts?**
`check` and `record` make read-only AWS calls (plus a local baseline file write
for `record`). `revert` is the only mutating command; it never runs without
`--yes` or an interactive confirmation, and `--dry-run` shows the plan without
changes.

## Contributing

```bash
pnpm install
vp run test         # unit tests        vp run typecheck
vp run check        # lint + format     vp run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Integration tests (real AWS, self-cleaning)
live under [tests/integration/](tests/integration/README.md). Design rationale:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [DESIGN.md](DESIGN.md).
