// Minimal CDK app for the AWS::Budgets::Budget CostFilters (scope) false-negative test.
// The budget declares CostFilters (which service it watches). The SDK-override reader
// used to project a THIN model (BudgetName/Type/TimeUnit/BudgetLimit) WITHOUT CostFilters,
// so an out-of-band change to the budget's SCOPE was undetectable (declared CostFilters
// became a benign readGap). verify-budget-scope.sh changes CostFilters out of band and
// asserts cdkrd now DETECTS it.
import { App, Stack } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegBudget");
new CfnBudget(stack, "Budget", {
  budget: {
    budgetType: "COST",
    timeUnit: "MONTHLY",
    budgetLimit: { amount: 100, unit: "USD" },
    costFilters: { Service: ["Amazon Simple Storage Service"] },
  },
});
app.synth();
