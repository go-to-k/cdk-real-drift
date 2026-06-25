# cdk-real-drift demo — VHS tape (https://github.com/charmbracelet/vhs).
# Records the differentiator side by side: `cdkrd check` (left) reads the FULL
# live model and finds the out-of-band undeclared inline policy that
# demo/setup.sh injected; `cdk drift` (right) only compares declared properties
# and settles on "Number of resources with drift: 0". demo/run.sh drives the
# two tmux panes.
#
# Prereqs: `bash demo/setup.sh` has run (stack deployed, baseline recorded,
# drift injected). cdkrd is taken from the local build (dist/cli.js) by run.sh,
# so just `vp run build` at the repo root first — no global install needed.
# The demo stack pins no env, so export AWS_REGION before recording:
#   AWS_REGION=us-east-1 vhs demo/cdkrd.tape   ->   demo/demo.gif
# The trailing Sleep covers the live `cdk drift` CloudFormation drift-detection
# call; bump it if the right pane hasn't printed its "drift: 0" line yet.

Output "demo.gif"

Set Shell "bash"
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 16
Set Width 1600
Set Height 720
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set PlaybackSpeed 1.0

# Hide the harness launch so the GIF opens straight on the two panes, each
# echoing its own real command ($ cdkrd check / $ cdk drift).
Hide
Type "export PS1='$ ' && clear"
Enter
Sleep 500ms
Type "bash run.sh"
Enter
Sleep 2s
Show

# Covers the live AWS calls: cdkrd finishes in ~12s; the right pane keeps
# running CloudFormation drift detection until it reports drift: 0.
Sleep 40s
