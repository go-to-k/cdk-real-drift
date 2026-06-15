// cdk-real-drift demo app — the stack used to record the README demo GIF.
// A single IAM role that declares NO inline policies. demo/setup.sh adds one
// out-of-band (the kind of change `cdk drift` can't see because the property was
// never in the template); demo/cdkrd.tape records cdkrd catching and reverting it.
import { App, Stack } from 'aws-cdk-lib';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';

const app = new App();
const stack = new Stack(app, 'CdkrdDemo');

new Role(stack, 'ApiRole', {
  roleName: 'cdkrd-demo-api-role',
  assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
  description: 'Demo role for cdk-real-drift - declares no inline policies.',
});

app.synth();
