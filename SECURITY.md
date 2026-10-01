# Security Policy

## Reporting a Vulnerability

Please do **not** report security vulnerabilities through public GitHub issues.

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab
2. Click **Report a vulnerability**
3. Fill in the details (affected version, reproduction steps, impact)

This opens a private channel with the maintainer.

## Supported Versions

Only the latest released version receives security fixes.

## Scope Notes

`cdkrd` reads live AWS state with the caller's AWS credentials, writes reports
and baseline files locally, and `cdkrd revert` writes desired values back to
AWS after a confirmation.

In scope:

- A secret or credential (a `NoEcho` parameter, a `{{resolve:...}}` dynamic
  reference, a secret-bearing live property) reaching a report, a log, CLI
  output or a baseline file unredacted.
- Terminal control characters or escape sequences from a template, live AWS
  value or baseline file reaching the terminal unstripped.
- `cdkrd` itself passing an untrusted value to a shell or a child process, or
  resolving a file path outside where it belongs.
- `cdkrd revert` writing to a resource, or a property, that the confirmed plan
  did not name.

Out of scope:

- **A value `cdkrd` prints that would run if an operator copied the line into a
  shell.** The values in question — logical ids, stack names, physical ids,
  property values, AWS error text — come from the operator's own CDK app (which
  already runs arbitrary code at synth), the operator's own stacks, or a
  principal in the account who can already change the deployed resources
  directly. The attack also needs the operator to paste a crafted line. The AWS
  CDK CLI prints the same values as-is.
