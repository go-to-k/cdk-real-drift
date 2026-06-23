// CDK app for the cdk-real-drift apigw-rest-subres read-gap integration test.
// API Gateway REST sub-resources (RequestValidator, Model, DocumentationPart) all
// carry a COMPOSITE Cloud Control primaryIdentifier (e.g. RequestValidator is
// [RestApiId, RequestValidatorId], Model is [RestApiId, Name], DocumentationPart is
// [DocumentationPartId, RestApiId]) while their CFn Ref returns only the CHILD
// segment. If cdkrd does not derive the composite id, Cloud Control GetResource
// rejects the bare child id with ValidationException and the resource is silently
// `skipped` — a read-gap false negative (the Logs SubscriptionFilter class, PR #344).
// This fixture deploys all three so a `check` reveals whether they are read or skipped.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  CfnDocumentationPart,
  JsonSchemaType,
  JsonSchemaVersion,
  MockIntegration,
  PassthroughBehavior,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegApigwRestSubres");

const api = new RestApi(stack, "Api", {
  restApiName: "cdkrd-rest-subres",
});
api.applyRemovalPolicy(RemovalPolicy.DESTROY);

// A method is required for the RestApi to deploy a usable stage.
api.root.addMethod(
  "GET",
  new MockIntegration({
    integrationResponses: [{ statusCode: "200" }],
    passthroughBehavior: PassthroughBehavior.NEVER,
    requestTemplates: { "application/json": '{"statusCode": 200}' },
  }),
  { methodResponses: [{ statusCode: "200" }] },
);

// Composite-id sub-resource #1: RequestValidator [RestApiId, RequestValidatorId].
api.addRequestValidator("Validator", {
  requestValidatorName: "cdkrd-validator",
  validateRequestBody: true,
  validateRequestParameters: true,
});

// Composite-id sub-resource #2: Model [RestApiId, Name].
api.addModel("Model", {
  modelName: "cdkrdModel",
  contentType: "application/json",
  schema: {
    schema: JsonSchemaVersion.DRAFT4,
    title: "cdkrdModel",
    type: JsonSchemaType.OBJECT,
    properties: { id: { type: JsonSchemaType.STRING } },
  },
});

// Composite-id sub-resource #3: DocumentationPart [DocumentationPartId, RestApiId].
new CfnDocumentationPart(stack, "DocPart", {
  restApiId: api.restApiId,
  location: { type: "API" },
  properties: JSON.stringify({ description: "cdkrd doc part" }),
});

app.synth();
