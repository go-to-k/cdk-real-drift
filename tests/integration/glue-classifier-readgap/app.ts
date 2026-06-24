// CDK app for the cdk-real-drift glue-classifier-readgap integration test.
//
// AWS::Glue::Classifier is a CC read gap: GetResource throws UnsupportedActionException,
// so the classifier is silently `skipped` and any out-of-band change to it (a delimiter,
// a grok pattern, a JSON path) is INVISIBLE — a false negative on a common Glue catalog
// resource. The new SDK_OVERRIDES reader (Glue GetClassifier) closes it. This fixture
// declares all three common classifier kinds (CSV / Grok / JSON) so the projection of each
// one-of member is exercised, and doubles as the false-NEGATIVE half (a delimiter is a
// declared MUTABLE property a console edit can change). Cheap: classifiers are standalone
// account-level resources — no role, no crawler, no NAT.
import { App, Stack } from "aws-cdk-lib";
import { CfnClassifier } from "aws-cdk-lib/aws-glue";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegGlueClassifierReadgap");

new CfnClassifier(stack, "CsvClassifier", {
  csvClassifier: {
    name: "cdkrd-csv-classifier",
    delimiter: ",",
    quoteSymbol: '"',
    containsHeader: "PRESENT",
    header: ["id", "name", "value"],
  },
});

new CfnClassifier(stack, "GrokClassifier", {
  grokClassifier: {
    name: "cdkrd-grok-classifier",
    classification: "syslog",
    grokPattern: "%{TIMESTAMP_ISO8601:timestamp} %{GREEDYDATA:message}",
  },
});

new CfnClassifier(stack, "JsonClassifier", {
  jsonClassifier: {
    name: "cdkrd-json-classifier",
    jsonPath: "$.records[*]",
  },
});

app.synth();
