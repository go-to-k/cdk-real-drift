// cdk-real-drift ApiGateway DocumentationVersion read-gap test.
// AWS::ApiGateway::DocumentationVersion primaryIdentifier is the COMPOSITE
// [DocumentationVersion, RestApiId] — CHILD first, the same shape as the
// already-adapted ApiGateway::DocumentationPart (#354) and ::Deployment. The CFn
// physical id (Ref) is only the bare DocumentationVersion, so Cloud Control
// GetResource rejects it (ValidationException) and the version is silently `skipped`
// (read-gap). After the CC_IDENTIFIER_ADAPTERS fix (DocumentationVersion|RestApiId)
// it reads, so a fresh deploy + record + check is CLEAN.
import { App, Stack } from "aws-cdk-lib";
import {
  CfnDocumentationPart,
  CfnDocumentationVersion,
  CfnRestApi,
} from "aws-cdk-lib/aws-apigateway";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegApigwDocVersionRich");

const api = new CfnRestApi(stack, "Api", {
  name: "cdkrd-docversion-api",
  description: "cdkrd docversion read-gap test api",
});

// A documentation part is required before a version can be published.
const part = new CfnDocumentationPart(stack, "DocPart", {
  restApiId: api.ref,
  location: { type: "API" },
  properties: JSON.stringify({ info: { description: "cdkrd test API docs" } }),
});

const version = new CfnDocumentationVersion(stack, "DocVersion", {
  restApiId: api.ref,
  documentationVersion: "v1",
  description: "cdkrd test documentation version",
});
version.addDependency(part);

app.synth();
