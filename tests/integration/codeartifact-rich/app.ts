// CDK app for the cdk-real-drift CodeArtifact false-positive test. CodeArtifact is
// a common managed package registry (npm/PyPI/Maven/NuGet proxy), and neither
// AWS::CodeArtifact::Domain nor ::Repository has been exercised. Both carry a
// resource policy (PermissionsPolicyDocument — runs through cdkrd's policy
// canonicalization) and the repository adds ExternalConnections / Upstreams /
// Description, each its own normalization edge. A freshly deployed + recorded
// stack with NO out-of-band change MUST report CLEAN.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnDomain, CfnRepository } from "aws-cdk-lib/aws-codeartifact";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCodeArtifactRich");

const domain = new CfnDomain(stack, "Domain", {
  domainName: "cdkrd-ca-domain",
  permissionsPolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadFromDomain",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${stack.account}:root` },
        Action: [
          "codeartifact:GetDomainPermissionsPolicy",
          "codeartifact:ListRepositoriesInDomain",
          "codeartifact:GetAuthorizationToken",
        ],
        Resource: "*",
      },
    ],
  },
});

const repo = new CfnRepository(stack, "Repo", {
  repositoryName: "cdkrd-ca-repo",
  domainName: domain.domainName,
  description: "cdk-real-drift integ repository",
  externalConnections: ["public:npmjs"],
  permissionsPolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadFromRepo",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${stack.account}:root` },
        Action: ["codeartifact:ReadFromRepository", "codeartifact:GetRepositoryEndpoint"],
        Resource: "*",
      },
    ],
  },
});
repo.addDependency(domain);

Tags.of(stack).add("team", "platform");

app.synth();
