// CDK app for the cdk-real-drift mediaconvert-min false-positive integration
// test. BAREST-possible MediaConvert Queue + JobTemplate — both types are
// NON_PROVISIONABLE via Cloud Control (issue #497) and read through SDK
// overrides that have ZERO corpus cases and ZERO fixtures, so the barest
// first-run path (undeclared PricingPlan/Status/Priority defaults) has never
// been exercised live. A JobTemplate is deliberately PARTIAL (job templates
// merge into jobs, so a minimal settings body is valid). A first `check`
// (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnJobTemplate, CfnQueue } from "aws-cdk-lib/aws-mediaconvert";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegMediaConvertMin");

new CfnQueue(stack, "HuntQueue", {
  name: "cdkrd-hunt-mc-queue",
});

new CfnJobTemplate(stack, "HuntJobTemplate", {
  name: "cdkrd-hunt-mc-jobtemplate",
  // MediaConvert templates may be PARTIAL, but the API still requires at least
  // one output group ("outputGroups is a required property" on create).
  settingsJson: {
    OutputGroups: [
      {
        Name: "File Group",
        OutputGroupSettings: {
          Type: "FILE_GROUP_SETTINGS",
          FileGroupSettings: {},
        },
        // Each output must carry video, audio, or captions — audio-only AAC is
        // the smallest valid output.
        Outputs: [
          {
            ContainerSettings: { Container: "MP4" },
            AudioDescriptions: [
              {
                CodecSettings: {
                  Codec: "AAC",
                  AacSettings: {
                    Bitrate: 96000,
                    CodingMode: "CODING_MODE_2_0",
                    SampleRate: 48000,
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  },
});
