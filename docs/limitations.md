# Limitations

What `cdkrd` deliberately does not do, and where its coverage stops. See the
[README](../README.md) for the workflow and [ARCHITECTURE.md](ARCHITECTURE.md) for
the full design.

- **Fail-closed by design.** A property cdkrd can't confidently compare (an exotic
  intrinsic, a write-only value, a Cloud-Control-unreadable type) is reported as
  informational, never guessed. You trade a little coverage for zero false drift.
- **Revert can't do everything.** Not revertable, and reported as such: unrecorded
  values (record them, or opt into removal with `--remove-unrecorded`); a `deleted`
  resource (recreate with `cdk deploy`); nested undeclared values (a flat patch
  can't safely target a deep sub-field — fix in IaC or re-record); create-only
  properties (changing them needs replacement); toggle-style properties with no
  "absent" state (e.g. S3 transfer acceleration); `AWS::Lambda::Permission` and
  `AWS::Budgets::Budget` (their write APIs can't reconstruct the desired state).
  Not-revertable findings fold into a one-line-per-reason summary (`--verbose` for
  the full list). When findings exist but nothing is revertable, `revert` prints
  `nothing revertable` and exits 1.
- **Revert writes the canonical form** of the desired value — semantically equal to
  your template, but statement/tag ordering or scalar-vs-array may differ textually.
- **Custom resources** (`Custom::*`) have no cloud-side model and are always
  `skipped` (without an API call).
- **Nested stacks** are checked at the parent's `AWS::CloudFormation::Stack`
  resource but **not** recursed into — resources inside a nested stack aren't
  checked. Never silent: `check` prints a `warning:` naming each nested stack.
  (Check one directly by passing its deployed child stack name.)
- **Lambda Permission:** if only the specific statement was removed out of band, it
  is reported as `skipped`, not `deleted` — identifying the exact statement would
  need its `StatementId`.
- **IAM ManagedPolicy attachments** are tiered **per member** (a managed policy is
  commonly attached from several places — its own lists, a role's
  `ManagedPolicyArns`, a separate attachment resource, the console — so the live set
  is a union that exceeds any one stack's intent, on which a symmetric compare like
  `cdk drift` false-drifts). A declared attachment missing from live is an
  out-of-band **detach** — reported and revertable (re-attaches that one member); a
  live-only member is surfaced as **undeclared** (not false drift) — `record` it,
  and a new unexpected attachment then shows as drift. Detach an unwanted one with
  `revert --remove-unrecorded`. Both directions caught, no union false positive.
- **AppSync GraphQL schema** (`AWS::AppSync::GraphQLSchema`) is `skipped`: Cloud
  Control has no READ, and AppSync's schema-read API returns the compiled
  introspection form, not your source SDL — so a faithful compare is impossible. The
  rest of the API (auth / X-Ray / logging, plus DataSources / Resolvers / Functions)
  **is** checked.
- **Stack state.** A stack with no meaningful deployed reality is **skipped with a
  clear note** (`REVIEW_IN_PROGRESS`, a delete in progress). A stack mid-operation
  or in a `*_FAILED` state is still checked, but `check` warns that results may be
  transient. Only stable `*_COMPLETE` states are fully reliable.
- **SDK-override coverage.** The CC-gap types read via an SDK override compare the
  properties that override returns. A declared property the reader doesn't return
  shows as `readGap` (not silently CLEAN); an undeclared one on an unprojected
  property isn't compared. Coverage is widened as needed.
- **Unsupported / unreadable types.** A type Cloud Control can't read (no CC
  support, or a CC handler error with no SDK override) is `skipped`, surfaced in the
  `skipped=N` line and never silently CLEAN; `--strict` makes such a gap CI-failing.
- **Non-ASCII template literals.** CloudFormation's `GetTemplate` (cdkrd's
  declared source) returns every non-ASCII character in a stored string literal
  as a literal `?` — so a declared value like an `AWS::SSM::Parameter`
  `Value: áéíóúABC` comes back `?????ABC` while the live value is intact
  (CloudFormation compares the intact value server-side, so its own drift
  detection reports such a property IN_SYNC). cdkrd **recovers** the real value
  from the LOCAL synth template (the `cdk.out` assembly it already produces for
  stack discovery): when the synth value at the same path masks to the deployed
  `?`-value (same ASCII skeleton + length), it is the deployed declared value
  with its non-ASCII restored, so the compare runs on real text. When recovery
  is impossible (no synth template, or the synth value's skeleton diverged), the
  property degrades to `readGap` (declared but unverifiable) rather than a false
  declared drift. Two consequences: (1) for these specific values the "intent" is
  the local synth rather than the deployed template, so a same-length
  non-ASCII-only edit made in code but **not yet deployed** surfaces as drift
  (code-vs-reality); (2) a pure-ASCII template is never affected (GetTemplate
  does not mask ASCII).
