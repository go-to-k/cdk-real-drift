# cdk-real-drift demo — VHS tape (https://github.com/charmbracelet/vhs).
# Records the differentiator in one shot: `cdkrd check` reads the FULL live model and
# finds the out-of-band undeclared inline policy that demo/setup.sh injected — the change
# CloudFormation drift detection can't see. (The `cdk drift` reports-0 contrast is shown
# in the top-level README prose directly above this GIF, so the GIF skips it and stays
# short. Revert/record are likewise covered in the README.)
#
# Prereqs: `bash demo/setup.sh` has run (stack deployed, baseline recorded, drift
# injected), `cdkrd` is on PATH (e.g. `npm i -g cdk-real-drift` or `npm link`), and
# you run from the demo/ directory so cdk.json is found.
# Record with:  vhs demo/cdkrd.tape   ->   demo/demo.gif
# The Sleep value covers the live AWS call; trim the recorded GIF if you want it snappier.

Output "demo.gif"

Set Shell "bash"
Set FontSize 18
Set Width 1180
Set Height 560
Set Padding 18
Set Theme "Dracula"
Set TypingSpeed 45ms
Set PlaybackSpeed 2

# cdkrd reads the FULL live model and finds the undeclared inline policy.
# No stack arg — cdkrd synthesizes the app and checks every stack it defines (CDK-style).
# The demo stack pins no env, so the recorder exports AWS_REGION before launching vhs
# (AWS_REGION=us-east-1 vhs cdkrd.tape) — the inner shell inherits it, keeping the
# visible command a clean `cdkrd check`.
Type "cdkrd check"
Enter
Sleep 12s
