// CDK app for the cdk-real-drift mediaconvert-min false-positive integration test.
// BAREST-possible configs of the two MediaConvert SDK-override readers (#497),
// which were added from a live report but never exercised by any fixture/corpus:
// - AWS::MediaConvert::Queue: on-demand queue, name only.
// - AWS::MediaConvert::JobTemplate: minimal H.264/MP4 file-group settings.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnJobTemplate, CfnQueue } from "aws-cdk-lib/aws-mediaconvert";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713MediaConv");

new CfnQueue(stack, "HuntQueue", {
  name: "cdkrd-hunt-mc-queue",
});

new CfnJobTemplate(stack, "HuntJobTemplate", {
  name: "cdkrd-hunt-mc-jobtemplate",
  settingsJson: {
    OutputGroups: [
      {
        Name: "File Group",
        OutputGroupSettings: {
          Type: "FILE_GROUP_SETTINGS",
          FileGroupSettings: {
            Destination: "s3://cdkrd-hunt-placeholder-output/",
          },
        },
        Outputs: [
          {
            ContainerSettings: { Container: "MP4", Mp4Settings: {} },
            VideoDescription: {
              CodecSettings: {
                Codec: "H_264",
                H264Settings: {
                  RateControlMode: "QVBR",
                  QvbrSettings: { QvbrQualityLevel: 7 },
                  MaxBitrate: 5000000,
                },
              },
            },
          },
        ],
      },
    ],
  },
});
