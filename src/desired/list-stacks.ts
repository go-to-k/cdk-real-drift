// List deployed CloudFormation stack names in a region (for `--all`).
import { CloudFormationClient, ListStacksCommand, type StackStatus } from "@aws-sdk/client-cloudformation";

const ACTIVE: StackStatus[] = ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE", "IMPORT_ROLLBACK_COMPLETE"];

export async function listAllStacks(region: string): Promise<string[]> {
  const cfn = new CloudFormationClient({ region });
  const names: string[] = [];
  let token: string | undefined;
  do {
    const r = await cfn.send(new ListStacksCommand({ StackStatusFilter: ACTIVE, NextToken: token }));
    for (const s of r.StackSummaries ?? []) {
      if (s.StackName && !s.RootId) names.push(s.StackName); // top-level stacks only (skip nested)
    }
    token = r.NextToken;
  } while (token);
  return names;
}
