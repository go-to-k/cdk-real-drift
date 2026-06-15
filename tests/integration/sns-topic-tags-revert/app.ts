// Revert integration fixture for the aws:* managed-tag preservation fix.
// A single SNS Topic with NO declared Tags. verify.sh records the baseline (the
// topic carries only AWS-managed aws:cloudformation:* tags, which cdkrd strips on
// the compare side, so it is snapshot-complete with zero user Tags), then adds a
// USER tag out of band. `cdkrd revert` must remove the user tag WITHOUT trying to
// drop the aws:* managed tags (which AWS rejects: "aws: prefixed tag key names are
// not allowed for external use").
import { App, Stack } from 'aws-cdk-lib';
import { Topic } from 'aws-cdk-lib/aws-sns';

const app = new App();
const stack = new Stack(app, 'CdkRealDriftIntegSnsTagsRevert');
new Topic(stack, 'AlarmTopic', { displayName: 'integ-tags-revert' });
app.synth();
