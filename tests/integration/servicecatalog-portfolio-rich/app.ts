// CDK app for the cdk-real-drift servicecatalog-portfolio-rich false-positive
// integration test. AWS Service Catalog (AWS::ServiceCatalog::Portfolio) is a common
// governance primitive in enterprise CDK stacks. A portfolio folds AWS-assigned
// first-run values the template never declares — Id, and echoed defaults. A clean
// `record`->`check` (and a `check` BEFORE record) is a false-positive oracle for
// those undeclared first-run defaults.
import { App, Stack } from "aws-cdk-lib";
import { CfnPortfolio } from "aws-cdk-lib/aws-servicecatalog";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegServiceCatalogPortfolioRich");

new CfnPortfolio(stack, "Portfolio", {
  displayName: "cdkrd-portfolio-rich",
  providerName: "cdkrd",
  description: "cdkrd service catalog portfolio rich",
});

app.synth();
