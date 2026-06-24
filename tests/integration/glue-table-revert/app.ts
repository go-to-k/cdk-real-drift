// cdk-real-drift Glue Table detect->revert->clean integration test.
// AWS::Glue::Table is read via the Glue GetTable SDK override (Cloud Control cannot
// read/write the Glue family — UnsupportedActionException) and was NOT revertable —
// `revert` said "type not revertable yet" while detection worked, so an out-of-band
// TableInput edit (schema, parameters, description) was detected but could not be undone.
// The new writeGlueTable (GetTable -> UpdateTable, sibling of writeGlueJob) closes that
// gap. verify.sh mutates the declared TableInput.Description out of band, asserts check
// DETECTS it, reverts, and asserts check is CLEAN + the live description is restored.
import { App, Stack } from "aws-cdk-lib";
import { CfnDatabase, CfnTable } from "aws-cdk-lib/aws-glue";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegGlueTableRevert");

new CfnDatabase(stack, "Db", {
  catalogId: stack.account,
  databaseInput: { name: "cdkrd_revert_db" },
});

const tbl = new CfnTable(stack, "Tbl", {
  catalogId: stack.account,
  databaseName: "cdkrd_revert_db",
  tableInput: {
    name: "cdkrd_revert_table",
    description: "declared table description",
    tableType: "EXTERNAL_TABLE",
    parameters: { classification: "json" },
    storageDescriptor: {
      location: "s3://cdkrd-revert-placeholder/data/",
      columns: [{ name: "id", type: "string" }],
    },
  },
});
tbl.addDependency(stack.node.findChild("Db") as CfnDatabase);

app.synth();
