// EC2 managed prefix list (AWS::EC2::PrefixList) — a common, FREE VPC/SG building block
// no fixture exercises yet. Its `Entries` is an object array ({Cidr, Description}), the
// classic set-like-reorder FP axis, and MaxEntries/AddressFamily/Tags are mutable props
// good for the FN (detect->revert) half. Clean record->check is the FP oracle;
// PrefixList is CC-readable and FULLY_MUTABLE.
import { App, Stack } from "aws-cdk-lib";
import { PrefixList } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEc2PrefixListRich");

new PrefixList(stack, "PL", {
  prefixListName: "cdkrd-prefixlist-rich",
  maxEntries: 10,
  entries: [
    { cidr: "10.0.0.0/16", description: "corp-a" },
    { cidr: "10.1.0.0/16", description: "corp-b" },
    { cidr: "192.168.0.0/24", description: "branch" },
  ],
});

app.synth();
