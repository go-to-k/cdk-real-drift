# Demo GIF kit

Records the README hero GIF: **`cdk drift` reports 0 drift, but `cdkrd` finds —
and reverts — an out-of-band change to a property the template never declared.**

The demo stack is one IAM role (`cdkrd-demo-api-role`) that declares no inline
policies. `setup.sh` deploys it, records a clean baseline, then adds an inline
policy out-of-band with the AWS CLI — exactly the kind of change CloudFormation
drift detection can't see.

## Record it

Prereqs: AWS credentials + a bootstrapped account, [VHS](https://github.com/charmbracelet/vhs)
installed (`brew install vhs`), and the `cdkrd` CLI on your PATH. Before publish,
build it from the repo and link it:

```bash
vp run build          # at the repo root — builds dist/cli.js
npm link              # exposes `cdkrd` on PATH (or: npm i -g cdk-real-drift once published)
```

Then, from the repo root:

```bash
bash demo/setup.sh        # deploy + baseline + inject the out-of-band drift
( cd demo && vhs cdkrd.tape )   # records demo/demo.gif
bash demo/teardown.sh     # drop the injected policy + destroy the stack
```

The `Sleep` values in `cdkrd.tape` cover the live AWS calls (`cdk drift` takes
~40s); trim the resulting GIF if you want it snappier.

The top-level `README.md` already embeds `demo/demo.gif`, so re-recording just
overwrites the committed file — no README edit needed.

> Account note: the demo deploys a real (free) IAM role to your default AWS
> account/region. `teardown.sh` removes everything.
