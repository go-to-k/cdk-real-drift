# cdk-real-drift demo — VHS tape (https://github.com/charmbracelet/vhs).
# Records the differentiator: `cdk drift` reports 0, but `cdkrd check` reads the FULL
# live model and finds the out-of-band undeclared inline policy that demo/setup.sh
# injected. (Revert/record are shown in the top-level README; this GIF is the
# detection "aha" and stays short.)
#
# Prereqs: `bash demo/setup.sh` has run (stack deployed, baseline recorded, drift
# injected), `cdkrd` is on PATH (e.g. `npm i -g cdk-real-drift` or `npm link`), and
# you run from the demo/ directory so cdk.json is found.
# Record with:  vhs demo/cdkrd.tape   ->   demo/demo.gif
# The Sleep values cover live AWS calls; trim the recorded GIF if you want it snappier.

Output "demo.gif"

Set Shell "bash"
Set FontSize 18
Set Width 1180
Set Height 560
Set Padding 18
Set Theme "Dracula"
Set TypingSpeed 45ms
Set PlaybackSpeed 2

# 1. CloudFormation's own drift detection sees nothing — the changed property was
#    never in the template.
Type "npx cdk drift CdkrdDemo"
Enter
Sleep 40s

# 2. cdkrd reads the FULL live model and finds the undeclared inline policy.
Type "cdkrd check CdkrdDemo"
Enter
Sleep 12s
