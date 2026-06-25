# Demo GIF kit

Records the README hero GIF **side by side**: `cdkrd check` (left) finds an
out-of-band inline policy the template never declared, while `cdk drift` (right)
compares only declared properties and reports `Number of resources with drift: 0`.

The demo stack is one IAM role (`cdkrd-demo-api-role`) that declares no inline
policies. `setup.sh` deploys it, records a clean baseline, then adds an inline
policy out-of-band with the AWS CLI — exactly the kind of change CloudFormation
drift detection can't see.

## How the split-pane recording works

`cdkrd.tape` types a single `bash run.sh`. `run.sh` opens a two-pane tmux session
(`tmux-clean.conf` for clean borders) and runs both tools read-only against the
already-deployed stack:

- **left** — `cdkrd check` (shadowed on PATH to the local `dist/cli.js`, so the
  visible command stays a plain `cdkrd`). Returns in ~12s with the undeclared drift.
- **right** — `cdk drift`, which kicks off CloudFormation drift detection and
  takes longer before settling on `drift: 0`.

cdkrd is on the left so left-to-right readers hit the featured tool — and its
"found it" punchline — first.

## Record it

Prereqs: AWS credentials + a bootstrapped account, [VHS](https://github.com/charmbracelet/vhs)
and `tmux` installed (`brew install vhs tmux`). `run.sh` uses the local build,
so just build it from the repo root — no global install or `npm link` needed:

```bash
vp run build          # at the repo root — builds dist/cli.js
```

Then, from the repo root:

```bash
bash demo/setup.sh        # deploy + baseline + inject the out-of-band drift
( cd demo && AWS_REGION=us-east-1 vhs cdkrd.tape )   # -> demo/demo.gif
bash demo/teardown.sh     # drop the injected policy + destroy the stack
```

The demo stack pins no env, so `cdkrd check` (no stack arg) synthesizes the app
and needs a region — export `AWS_REGION` before `vhs` so the inner tmux panes
inherit it. The trailing `Sleep` in `cdkrd.tape` covers the live `cdk drift`
call; bump it if the right pane hasn't printed its `drift: 0` line by the end.

The top-level `README.md` already embeds `demo/demo.gif`, so re-recording just
overwrites the committed file — no README edit needed.

> Account note: the demo deploys a real (free) IAM role to your default AWS
> account/region. `teardown.sh` removes everything.
