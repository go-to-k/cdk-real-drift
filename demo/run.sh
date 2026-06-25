#!/usr/bin/env bash
# Side-by-side demo recording: `cdkrd check` (left) vs `cdk drift` (right),
# both run READ-ONLY against the already-deployed + drift-injected demo stack
# (run `bash demo/setup.sh` first). The contrast is the whole point:
#
#   left  — cdkrd reads the FULL live model and finds the out-of-band inline
#           policy the template never declared.
#   right — `cdk drift` (CloudFormation drift detection) only compares declared
#           properties, so it settles on "Number of resources with drift: 0".
#
# cdkrd is on the LEFT so left-to-right readers hit the featured tool — and its
# "found it" punchline — first. `cdkrd check` returns in ~12s; `cdk drift` kicks
# off CloudFormation drift detection and takes longer, ending empty-handed.
set -e

# Force a UTF-8 locale so tmux renders multibyte glyphs (the em-dashes in
# cdkrd's output and the interactive menu markers) instead of substituting `_`.
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$DEMO_DIR/tmux-clean.conf"

# Drop any session left detached by a previous recording (its panes `sleep 9999`),
# otherwise `new-session -s demo` fails with "duplicate session: demo".
tmux kill-session -t demo 2>/dev/null || true

# Shadow `cdkrd` on PATH with the freshly-built local dist/cli.js so the visible
# command stays a plain `cdkrd` regardless of what's globally installed.
CDKRD_BIN="$(cd "$DEMO_DIR/.." && pwd)/dist/cli.js"
SHADOW_BIN="$(mktemp -d)"
printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$CDKRD_BIN" >"$SHADOW_BIN/cdkrd"
chmod +x "$SHADOW_BIN/cdkrd"
export PATH="$SHADOW_BIN:$PATH"
trap 'rm -rf "$SHADOW_BIN"' EXIT

# Pre-synth the CDK app ONCE to cdk.out, then point BOTH tools at the assembly
# with `-a cdk.out`. Without this they would each synth into the same default
# cdk.out concurrently and collide ("Another CLI is currently synthing to
# cdk.out"). Consuming a pre-synthed assembly means neither pane synths (no lock)
# and both start their real work immediately.
(cd "$DEMO_DIR" && cdk synth --all >/dev/null 2>&1)

# FORCE_COLOR / COLORTERM so both tools emit colors through tmux's pseudo-TTY.
ENV='FORCE_COLOR=1 COLORTERM=truecolor'

# The demo stack pins no env, so cdkrd needs a region; the recorder exports
# AWS_REGION before launching vhs and tmux inherits it.
LEFT_CMD="echo '\$ cdkrd check -a cdk.out'; echo; $ENV cdkrd check -a cdk.out"
RIGHT_CMD="echo '\$ cdk drift -a cdk.out'; echo; $ENV npx cdk drift -a cdk.out"

tmux -f "$CONF" new-session -d -s demo -x 230 -y 40 -c "$DEMO_DIR" "bash -c \"$LEFT_CMD; sleep 9999\""
tmux select-pane -t demo:0.0 -T '#[fg=#a6e3a1,bold]  cdkrd ─ reads the FULL live model '
tmux split-window -h -t demo:0.0 -c "$DEMO_DIR" "bash -c \"$RIGHT_CMD; sleep 9999\""
tmux select-pane -t demo:0.1 -T '#[fg=#f38ba8,bold]  cdk drift ─ declared properties only '
tmux attach -t demo
