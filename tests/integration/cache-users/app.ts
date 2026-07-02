// CDK app for the cdk-real-drift cache-users false-positive integration test.
// Zero-corpus-coverage cache RBAC staples (no cluster — all four are free):
// - AWS::ElastiCache::User x2 — AccessString is service-CANONICALIZED (AWS is
//   known to expand/normalize Redis ACL strings, e.g. appending "-@all"), a
//   predicted unguarded declared-FP class; one password user (writeOnly strip
//   probe) + the mandatory "default" user.
// - AWS::ElastiCache::UserGroup — UserIds declared NON-sorted (reader before
//   default) as a set-like reorder probe.
// - AWS::MemoryDB::User (IAM auth) + AWS::MemoryDB::ACL — same AccessString
//   canonicalization probe on the MemoryDB side.
import { App, Stack } from "aws-cdk-lib";
import { CfnUser, CfnUserGroup } from "aws-cdk-lib/aws-elasticache";
import { CfnACL, CfnUser as MemDbCfnUser } from "aws-cdk-lib/aws-memorydb";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCacheUsers");

const defaultUser = new CfnUser(stack, "HuntEcDefaultUser", {
  engine: "redis",
  userId: "cdkrd-hunt-default",
  userName: "default",
  accessString: "off ~* -@all",
  noPasswordRequired: true,
});

const readerUser = new CfnUser(stack, "HuntEcReaderUser", {
  engine: "redis",
  userId: "cdkrd-hunt-reader",
  userName: "cdkrd-hunt-reader",
  accessString: "on ~app:* +@read",
  passwords: ["cdkrd-hunt-Passw0rd-123456"],
});

const group = new CfnUserGroup(stack, "HuntEcUserGroup", {
  engine: "redis",
  userGroupId: "cdkrd-hunt-group",
  userIds: [readerUser.userId, defaultUser.userId],
});
group.addDependency(defaultUser);
group.addDependency(readerUser);

const mdbUser = new MemDbCfnUser(stack, "HuntMdbUser", {
  userName: "cdkrd-hunt-mdb-user",
  accessString: "on ~* &* +@read",
  authenticationMode: { Type: "iam" },
});

const acl = new CfnACL(stack, "HuntMdbAcl", {
  aclName: "cdkrd-hunt-mdb-acl",
  userNames: [mdbUser.userName ?? "cdkrd-hunt-mdb-user"],
});
acl.addDependency(mdbUser);

app.synth();
