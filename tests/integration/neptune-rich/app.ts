// False-positive integration fixture (real AWS): Neptune DBCluster with a PARTIAL
// (MAJOR.MINOR) EngineVersion that AWS expands to the concrete patch it provisions.
//
// We declare `EngineVersion: "1.3"`. Neptune accepts a 2-segment MAJOR.MINOR version
// and provisions the latest available patch in that track (currently "1.3.5.0"), so
// the LIVE EngineVersion attribute reads back as the longer 4-segment concrete patch
// (e.g. "1.3.x.x"). The declared "1.3" is a dotted-segment PREFIX of the live value.
//
// This is the exact shape of the suppressed RDS/Aurora EngineVersion rule
// (VERSION_PREFIX_PATHS in src/normalize/noise.ts) — declared track "8.0" reads back
// "8.0.45". But that suppression set covers ONLY AWS::RDS::DBInstance and
// AWS::RDS::DBCluster; AWS::Neptune::DBCluster is NOT in it. So a clean
// record -> check should false-drift POSITIONALLY on EngineVersion: the partial
// declared value compared char-for-char against the concrete live patch.
//
// Probe (region ap-northeast-1) confirming the partial -> concrete expansion:
//   aws neptune describe-db-engine-versions --engine neptune --engine-version 1.3
//     -> 1.3.0.0  1.3.1.0  1.3.2.1  1.3.3.0  1.3.4.0  1.3.5.0   (a 2-seg prefix is a family)
//   aws neptune describe-db-engine-versions --engine neptune --engine-version 1.3.4.0
//     -> 1.3.4.0                                                (a full 4-seg is exact)
//
// L1 Cfn constructs are used for full control over EngineVersion (the L2 NeptuneEngine
// enum would force a concrete pinned version and hide the FP).

import { App, Stack } from "aws-cdk-lib";
import { Vpc, SubnetType } from "aws-cdk-lib/aws-ec2";
import {
  CfnDBSubnetGroup,
  CfnDBCluster,
  CfnDBInstance,
} from "aws-cdk-lib/aws-neptune";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegNeptuneRich");

// Minimal VPC: 2 AZs, a single PRIVATE_ISOLATED subnet group, no NAT (cost saving).
const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [
    {
      name: "Isolated",
      subnetType: SubnetType.PRIVATE_ISOLATED,
      cidrMask: 24,
    },
  ],
});

const subnetGroup = new CfnDBSubnetGroup(stack, "SubnetGroup", {
  dbSubnetGroupDescription: "Neptune subnet group across isolated subnets",
  subnetIds: vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED })
    .subnetIds,
});

const cluster = new CfnDBCluster(stack, "Cluster", {
  // PARTIAL major.minor — AWS expands to the concrete provisioned patch (the FP).
  engineVersion: "1.3",
  dbSubnetGroupName: subnetGroup.ref,
  deletionProtection: false,
});
cluster.addDependency(subnetGroup);

new CfnDBInstance(stack, "Instance", {
  // db.t4g.medium is a Neptune-supported small class in ap-northeast-1 for 1.3.x.
  dbInstanceClass: "db.t4g.medium",
  dbClusterIdentifier: cluster.ref,
});

app.synth();
