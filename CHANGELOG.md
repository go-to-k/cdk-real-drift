## [0.2.33](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.32...v0.2.33) (2026-07-08)


### Bug Fixes

* **noise:** fold ELBv2 TargetGroup first-run health-check + attribute + husk defaults ([#648](https://github.com/go-to-k/cdk-real-drift/issues/648)) ([#693](https://github.com/go-to-k/cdk-real-drift/issues/693)) ([d29a3c4](https://github.com/go-to-k/cdk-real-drift/commit/d29a3c49cd95780b267bec81617b3c96acc480fa))

## [0.2.32](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.31...v0.2.32) (2026-07-08)


### Bug Fixes

* **normalize:** drop bare null array-element husks in CC read (S3 TagFilters:[null], [#641](https://github.com/go-to-k/cdk-real-drift/issues/641)) ([#687](https://github.com/go-to-k/cdk-real-drift/issues/687)) ([f0f1f1c](https://github.com/go-to-k/cdk-real-drift/commit/f0f1f1cce769301f17a3866739bdf28495f2278c))

## [0.2.31](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.30...v0.2.31) (2026-07-08)


### Bug Fixes

* **added:** fold cross-stack sibling children so they are not flagged out of band ([#666](https://github.com/go-to-k/cdk-real-drift/issues/666)) ([#691](https://github.com/go-to-k/cdk-real-drift/issues/691)) ([b169210](https://github.com/go-to-k/cdk-real-drift/commit/b169210c7c36527776403fcae409124e0f976ee3))

## [0.2.30](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.29...v0.2.30) (2026-07-08)


### Bug Fixes

* **noise:** fold ASG first-run undeclared batch + EC2 LaunchTemplate generated-name echo ([#639](https://github.com/go-to-k/cdk-real-drift/issues/639)) ([#690](https://github.com/go-to-k/cdk-real-drift/issues/690)) ([a7a3629](https://github.com/go-to-k/cdk-real-drift/commit/a7a36296dcb803b64fd46bdc0d487d24750c9a13))

## [0.2.29](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.28...v0.2.29) (2026-07-08)


### Bug Fixes

* **noise:** fold VPCCidrBlock AmazonProvided ipv6 block + border group value-independent ([#684](https://github.com/go-to-k/cdk-real-drift/issues/684)) ([#686](https://github.com/go-to-k/cdk-real-drift/issues/686)) ([9c3f661](https://github.com/go-to-k/cdk-real-drift/commit/9c3f6619fad7b4d8d7cb7628ed7bba5a600472cb))

## [0.2.28](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.27...v0.2.28) (2026-07-08)


### Bug Fixes

* **baseline:** fold stale recorded entries on resource replacement + template removal ([#674](https://github.com/go-to-k/cdk-real-drift/issues/674), [#675](https://github.com/go-to-k/cdk-real-drift/issues/675)) ([#681](https://github.com/go-to-k/cdk-real-drift/issues/681)) ([ba73c43](https://github.com/go-to-k/cdk-real-drift/commit/ba73c43e9c7e02f3552dbaf28fea19e502a54a01))
* **revert:** converge revert for ApiGatewayV2 Stage autoDeploy + RestApi Policy JSON-string ([#667](https://github.com/go-to-k/cdk-real-drift/issues/667), [#677](https://github.com/go-to-k/cdk-real-drift/issues/677)) ([#680](https://github.com/go-to-k/cdk-real-drift/issues/680)) ([b424752](https://github.com/go-to-k/cdk-real-drift/commit/b424752a2b8558a85a86011ff7e44d0c5fe1bd10))

## [0.2.27](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.26...v0.2.27) (2026-07-08)


### Bug Fixes

* **revert:** converge [#651](https://github.com/go-to-k/cdk-real-drift/issues/651) sibling subnet attrs (PrivateDnsNameOptionsOnLaunch + AssignIpv6AddressOnCreation) ([#682](https://github.com/go-to-k/cdk-real-drift/issues/682)) ([35815dd](https://github.com/go-to-k/cdk-real-drift/commit/35815dd21de8857f69bee1601eec85855e076cbb))

## [0.2.26](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.25...v0.2.26) (2026-07-08)


### Bug Fixes

* **read,noise:** ApiGatewayV2 WebSocket RouteResponse read-gap + first-run folds ([#664](https://github.com/go-to-k/cdk-real-drift/issues/664), [#665](https://github.com/go-to-k/cdk-real-drift/issues/665)) ([#671](https://github.com/go-to-k/cdk-real-drift/issues/671)) ([c4bfb37](https://github.com/go-to-k/cdk-real-drift/commit/c4bfb37ae1bb90d86d88ca6e3c3135cee36b3b59))

## [0.2.25](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.24...v0.2.25) (2026-07-08)


### Bug Fixes

* **diff:** fold Firehose declared S3DestinationConfiguration echoed as undeclared ExtendedS3 twin ([#652](https://github.com/go-to-k/cdk-real-drift/issues/652)) ([#670](https://github.com/go-to-k/cdk-real-drift/issues/670)) ([6b31532](https://github.com/go-to-k/cdk-real-drift/commit/6b315326e418ab29dc550df8324086cbc31e4a56))
* **revert:** Subnet EnableDns64 set-default + Lambda EventInvokeConfig husk strip ([#651](https://github.com/go-to-k/cdk-real-drift/issues/651), [#650](https://github.com/go-to-k/cdk-real-drift/issues/650)) ([#669](https://github.com/go-to-k/cdk-real-drift/issues/669)) ([9967d5d](https://github.com/go-to-k/cdk-real-drift/commit/9967d5dafc45d9633bb4b07676798fbf161f098a))

## [0.2.24](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.23...v0.2.24) (2026-07-08)


### Bug Fixes

* **noise:** fold DynamoDB Table first-run FPs — ContributorInsights Mode + SSE type/KMS echoes ([#649](https://github.com/go-to-k/cdk-real-drift/issues/649)) ([#662](https://github.com/go-to-k/cdk-real-drift/issues/662)) ([6336f8b](https://github.com/go-to-k/cdk-real-drift/commit/6336f8b74f08a1e7717eb063930ff9f67917c639))
* **read:** add CC_IDENTIFIER_ADAPTERS entry for AWS::EC2::VPCCidrBlock composite id ([#647](https://github.com/go-to-k/cdk-real-drift/issues/647)) ([#663](https://github.com/go-to-k/cdk-real-drift/issues/663)) ([41149e1](https://github.com/go-to-k/cdk-real-drift/commit/41149e1c88ccb930043f16f7ada7890fd1c29662))

## [0.2.23](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.22...v0.2.23) (2026-07-08)


### Bug Fixes

* **revert:** converge revert for RolesAnywhere AttributeMappings + KinesisVideo StreamStorageConfiguration (follow-up 2) ([#661](https://github.com/go-to-k/cdk-real-drift/issues/661)) ([8632081](https://github.com/go-to-k/cdk-real-drift/commit/8632081d62a64f96c504fc9a562b154c08e8034a))

## [0.2.22](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.21...v0.2.22) (2026-07-08)


### Bug Fixes

* **diff:** extend MEANINGFUL_WHEN_OFF to the unconditional top-level [#632](https://github.com/go-to-k/cdk-real-drift/issues/632) blast-radius switches ([#659](https://github.com/go-to-k/cdk-real-drift/issues/659)) ([a257c9f](https://github.com/go-to-k/cdk-real-drift/commit/a257c9f359f1ca817afed15ebf435f9c59eb0e30))

## [0.2.21](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.20...v0.2.21) (2026-07-08)


### Bug Fixes

* **diff:** fold a fully-undeclared object atDefault when every leaf matches a schema nested default ([#624](https://github.com/go-to-k/cdk-real-drift/issues/624) general improvement) ([#657](https://github.com/go-to-k/cdk-real-drift/issues/657)) ([4a9a5fe](https://github.com/go-to-k/cdk-real-drift/commit/4a9a5fe59552c68adfa767b28e972f7d51a24a1d))

## [0.2.20](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.19...v0.2.20) (2026-07-08)


### Bug Fixes

* **diff:** fold VPNConnection VpnTunnelOptionsSpecifications declared-tier FP — subset-align + AWS-materialized husk tunnel ([#618](https://github.com/go-to-k/cdk-real-drift/issues/618)) ([#644](https://github.com/go-to-k/cdk-real-drift/issues/644)) ([62bd83d](https://github.com/go-to-k/cdk-real-drift/commit/62bd83dfffd0e5a840f1045442a6b34d968d4166))

## [0.2.19](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.18...v0.2.19) (2026-07-08)


### Bug Fixes

* **revert:** converge revert for InternetMonitor Status + RolesAnywhere DurationSeconds + KinesisVideo retention/TTL ([#597](https://github.com/go-to-k/cdk-real-drift/issues/597)-class follow-up) ([#656](https://github.com/go-to-k/cdk-real-drift/issues/656)) ([f44914e](https://github.com/go-to-k/cdk-real-drift/commit/f44914e7433d48ccbc59271bdc2a9b65e7b39a78)), closes [#597-class](https://github.com/go-to-k/cdk-real-drift/issues/597-class)

## [0.2.18](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.17...v0.2.18) (2026-07-08)


### Bug Fixes

* **diff:** fold IoT ThingType SearchableAttributes reorder — service re-sorts a schema-ordered set ([#623](https://github.com/go-to-k/cdk-real-drift/issues/623)) ([#636](https://github.com/go-to-k/cdk-real-drift/issues/636)) ([5eedb6f](https://github.com/go-to-k/cdk-real-drift/commit/5eedb6f3a22fa9e0d46c5cec99333b789dc0f8dd))

## [0.2.17](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.16...v0.2.17) (2026-07-08)


### Bug Fixes

* **revert:** stop calling a stack CLEAN when a revert did not converge — count FAILED updates + detect no-op removals ([#631](https://github.com/go-to-k/cdk-real-drift/issues/631)) ([#638](https://github.com/go-to-k/cdk-real-drift/issues/638)) ([91dd33d](https://github.com/go-to-k/cdk-real-drift/commit/91dd33d2ecddff46e95f9e162dd75a0d10d0798c))

## [0.2.16](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.15...v0.2.16) (2026-07-08)


### Bug Fixes

* **diff:** fold fully-undeclared Cognito Schema + KVS object/KMS + DynamoDB WarmThroughput derived defaults ([#624](https://github.com/go-to-k/cdk-real-drift/issues/624) [#627](https://github.com/go-to-k/cdk-real-drift/issues/627) [#629](https://github.com/go-to-k/cdk-real-drift/issues/629)) ([#645](https://github.com/go-to-k/cdk-real-drift/issues/645)) ([63d7556](https://github.com/go-to-k/cdk-real-drift/commit/63d75566278e98c355724bdfaf885ded8cc510ff))

## [0.2.15](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.14...v0.2.15) (2026-07-08)


### Bug Fixes

* **noise:** fold 2026-07-08 bug-hunt first-run FPs across 12 zero/low-coverage types ([#619](https://github.com/go-to-k/cdk-real-drift/issues/619) [#622](https://github.com/go-to-k/cdk-real-drift/issues/622) [#625](https://github.com/go-to-k/cdk-real-drift/issues/625) [#626](https://github.com/go-to-k/cdk-real-drift/issues/626) [#628](https://github.com/go-to-k/cdk-real-drift/issues/628) [#633](https://github.com/go-to-k/cdk-real-drift/issues/633)) ([#637](https://github.com/go-to-k/cdk-real-drift/issues/637)) ([b31fe4b](https://github.com/go-to-k/cdk-real-drift/commit/b31fe4b07f3296a8180ce6180268b7daaa03d48c))

## [0.2.14](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.13...v0.2.14) (2026-07-08)


### Bug Fixes

* **revert:** REVERT_SET_DEFAULT_PATHS gaps — Cognito UserPool + SNS Subscription ([#630](https://github.com/go-to-k/cdk-real-drift/issues/630)) ([#635](https://github.com/go-to-k/cdk-real-drift/issues/635)) ([008e227](https://github.com/go-to-k/cdk-real-drift/commit/008e2278bba802f92ef10bfea96a12ff20f2542f))

## [0.2.13](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.12...v0.2.13) (2026-07-08)


### Bug Fixes

* **diff:** surface an undeclared switch disabled out of band — isTrivialEmpty swallowed the false before the KNOWN_DEFAULTS gate ([#632](https://github.com/go-to-k/cdk-real-drift/issues/632)) ([#634](https://github.com/go-to-k/cdk-real-drift/issues/634)) ([ac0bdb7](https://github.com/go-to-k/cdk-real-drift/commit/ac0bdb796c40d1f308bb4049899c8c3e5479864b))

## [0.2.12](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.11...v0.2.12) (2026-07-08)


### Bug Fixes

* **read:** supplement MemoryDB ParameterGroup Parameters (writeOnly readGap) + surface the CFn-never-applied divergence ([#620](https://github.com/go-to-k/cdk-real-drift/issues/620)) ([f366284](https://github.com/go-to-k/cdk-real-drift/commit/f3662844259b7e74b043a30cc60e2b7abd6ff497))

## [0.2.11](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.10...v0.2.11) (2026-07-07)


### Bug Fixes

* **noise:** fold Batch JobDefinition auto-generated JobDefinitionName (bug hunt follow-up) ([#617](https://github.com/go-to-k/cdk-real-drift/issues/617)) ([a10707c](https://github.com/go-to-k/cdk-real-drift/commit/a10707c358ea1101d18434789d9e2be007eedb37))

## [0.2.10](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.9...v0.2.10) (2026-07-07)


### Bug Fixes

* **noise:** fold Cognito IdentityPool/UserPool auto-generated names (bug hunt: identity-obs) ([#616](https://github.com/go-to-k/cdk-real-drift/issues/616)) ([9c21e8e](https://github.com/go-to-k/cdk-real-drift/commit/9c21e8ea1b21be22b3f49515cc3aade2b28c6281))

## [0.2.9](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.8...v0.2.9) (2026-07-07)


### Bug Fixes

* **noise:** fold Events ApiDestination InvocationRateLimitPerSecond default (bug hunt: events-apidest-rich) ([#615](https://github.com/go-to-k/cdk-real-drift/issues/615)) ([66321d9](https://github.com/go-to-k/cdk-real-drift/commit/66321d916664e53d7576cf75e3ebaa171b30167a))

## [0.2.8](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.7...v0.2.8) (2026-07-07)


### Bug Fixes

* **noise:** fold ApplicationSignals SLO default Goal (bug hunt: slo-notif-rich) ([#613](https://github.com/go-to-k/cdk-real-drift/issues/613)) ([d75abc5](https://github.com/go-to-k/cdk-real-drift/commit/d75abc58be6738722ee3a1501eb7ade005e84c38))

## [0.2.7](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.6...v0.2.7) (2026-07-07)


### Bug Fixes

* **revert:** converge Location PlaceIndex DataSourceConfiguration revert (avoid silent no-op) ([#611](https://github.com/go-to-k/cdk-real-drift/issues/611)) ([519e837](https://github.com/go-to-k/cdk-real-drift/commit/519e837f143255a14e631a3af66fc6c307ca8590))

## [0.2.6](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.5...v0.2.6) (2026-07-07)


### Bug Fixes

* **noise:** read ElastiCache ParameterGroup Properties as the source=user modified set (zero first-run drift) ([#612](https://github.com/go-to-k/cdk-real-drift/issues/612)) ([537b53f](https://github.com/go-to-k/cdk-real-drift/commit/537b53f477124359afa08da2487f8aa8b85bd347))

## [0.2.5](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.4...v0.2.5) (2026-07-07)


### Bug Fixes

* **diff:** align unordered-object-array by identity + remap nested-sorted types to the template index ([#610](https://github.com/go-to-k/cdk-real-drift/issues/610)) ([31227a6](https://github.com/go-to-k/cdk-real-drift/commit/31227a62c7a895f80c9268d57d38b307c56116bc))

## [0.2.4](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.3...v0.2.4) (2026-07-07)


### Bug Fixes

* **noise:** fold Amazon Location first-run defaults (all 5 types) + converge Tracker PositionFiltering revert ([#609](https://github.com/go-to-k/cdk-real-drift/issues/609)) ([36f6ffb](https://github.com/go-to-k/cdk-real-drift/commit/36f6ffb53f04b2f9cc30e8bb5857a048225cd51a))

## [0.2.3](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.2...v0.2.3) (2026-07-07)


### Bug Fixes

* **report:** show unordered-object-array drift at the TEMPLATE index, not the sorted index ([#608](https://github.com/go-to-k/cdk-real-drift/issues/608)) ([ad76f62](https://github.com/go-to-k/cdk-real-drift/commit/ad76f629709623a2f2f4253647844d58a0fa0734))

## [0.2.2](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.1...v0.2.2) (2026-07-07)


### Bug Fixes

* **noise:** fold classic ELB HTTPS listener's AWS-assigned SSL negotiation Policies (zero first-run drift) ([#607](https://github.com/go-to-k/cdk-real-drift/issues/607)) ([65ed215](https://github.com/go-to-k/cdk-real-drift/commit/65ed215a64ccb5e8741626ca757b60178484fecb))

## [0.2.1](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.0...v0.2.1) (2026-07-07)


### Bug Fixes

* **revert:** whole-array replace for unordered-object-array drift + fold PrefixList Entries reorder ([#605](https://github.com/go-to-k/cdk-real-drift/issues/605)) ([589583a](https://github.com/go-to-k/cdk-real-drift/commit/589583a4fc42cb9a31ba6e2805dab3e5cd38bd3d))

# [0.2.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.11...v0.2.0) (2026-07-07)


### Features

* **read:** read EB Environment OptionSettings + fold multi-platform + null/empty option defaults ([#606](https://github.com/go-to-k/cdk-real-drift/issues/606)) ([628538a](https://github.com/go-to-k/cdk-real-drift/commit/628538ad0155762534f130bf05cc3217f67f3c1a))

## [0.1.11](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.10...v0.1.11) (2026-07-07)


### Bug Fixes

* **noise:** fold classic ELB first-run defaults + case-insensitive listener protocol (zero first-run drift) ([#604](https://github.com/go-to-k/cdk-real-drift/issues/604)) ([7c8e444](https://github.com/go-to-k/cdk-real-drift/commit/7c8e44418a88a61799f7cb99169a2504fd3bd917))

## [0.1.10](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.9...v0.1.10) (2026-07-07)


### Bug Fixes

* **noise:** fold Elastic Beanstalk ConfigurationTemplate OptionSettings to atDefault (zero first-run drift) ([#603](https://github.com/go-to-k/cdk-real-drift/issues/603)) ([ff34f6c](https://github.com/go-to-k/cdk-real-drift/commit/ff34f6c0277870513b4f9a84fa42ece810e569b6))

## [0.1.9](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.8...v0.1.9) (2026-07-07)


### Bug Fixes

* **revert:** set-default AppRunner HealthCheck/Network on revert (avoid silent no-op) ([#602](https://github.com/go-to-k/cdk-real-drift/issues/602)) ([0a23ebf](https://github.com/go-to-k/cdk-real-drift/commit/0a23ebf1c69f4fb77d77e5cdc26fafccda3f6a9d))

## [0.1.8](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.7...v0.1.8) (2026-07-07)


### Bug Fixes

* **revert:** add Elastic Beanstalk SDK writers (avoid spurious CC ServiceRole error) ([#600](https://github.com/go-to-k/cdk-real-drift/issues/600)) ([4e788db](https://github.com/go-to-k/cdk-real-drift/commit/4e788db9ce4f71fac7127339be23798e1658bcd7))

## [0.1.7](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.6...v0.1.7) (2026-07-07)


### Bug Fixes

* **noise:** fold Elastic Beanstalk first-run defaults (Application/Template/Environment) ([#598](https://github.com/go-to-k/cdk-real-drift/issues/598)) ([d50d79a](https://github.com/go-to-k/cdk-real-drift/commit/d50d79a7c57181424564976253f39958fe05fa2f))

## [0.1.6](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.5...v0.1.6) (2026-07-07)


### Bug Fixes

* **noise:** fold App Runner + Transfer Family first-run defaults ([#597](https://github.com/go-to-k/cdk-real-drift/issues/597)) ([04372d0](https://github.com/go-to-k/cdk-real-drift/commit/04372d0e87d31169692f0ef97d24af003e549f96))

## [0.1.5](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.4...v0.1.5) (2026-07-07)


### Bug Fixes

* **noise:** fold Grafana + DataSync first-run default noise ([#596](https://github.com/go-to-k/cdk-real-drift/issues/596)) ([e2b1d6c](https://github.com/go-to-k/cdk-real-drift/commit/e2b1d6c95b4686ebe5f1e96c1c7099134b01143b))

## [0.1.4](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.3...v0.1.4) (2026-07-07)


### Bug Fixes

* **noise:** fold VPC-networking first-run defaults (offline sweep + live vpc-common deploy) ([#595](https://github.com/go-to-k/cdk-real-drift/issues/595)) ([572f47e](https://github.com/go-to-k/cdk-real-drift/commit/572f47e855721f146a4ce9edd3f93257527c5807))

## [0.1.3](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.2...v0.1.3) (2026-07-07)


### Bug Fixes

* **noise:** fold DocDB + VolumeAttachment first-run default noise ([#594](https://github.com/go-to-k/cdk-real-drift/issues/594)) ([d299f47](https://github.com/go-to-k/cdk-real-drift/commit/d299f479932488f6365e61943218f3d1683767dd))

## [0.1.2](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.1...v0.1.2) (2026-07-06)


### Bug Fixes

* **synth:** color the construct-annotation report yellow, not red ([#591](https://github.com/go-to-k/cdk-real-drift/issues/591)) ([020b5fc](https://github.com/go-to-k/cdk-real-drift/commit/020b5fc63398513ac1f27e4deb464da4b9bdd9c0))

## [0.1.1](https://github.com/go-to-k/cdk-real-drift/compare/v0.1.0...v0.1.1) (2026-07-06)


### Bug Fixes

* **synth:** stop red-wrapping the construct-annotation validation report ([#590](https://github.com/go-to-k/cdk-real-drift/issues/590)) ([95a371c](https://github.com/go-to-k/cdk-real-drift/commit/95a371c052ade89dcdd9468999eb053e93b6c0bf))

# [0.1.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.0.0...v0.1.0) (2026-07-06)


### Bug Fixes

* **added:** exclude VGW-propagated routes from EC2 Route enumeration ([#210](https://github.com/go-to-k/cdk-real-drift/issues/210)) ([35a6441](https://github.com/go-to-k/cdk-real-drift/commit/35a6441c709e1c9bcc89777ded455e73ab67ffa9))
* **added:** filter AWS built-in Empty/Error API Gateway models so a clean deploy is CLEAN ([#293](https://github.com/go-to-k/cdk-real-drift/issues/293)) ([3595f4c](https://github.com/go-to-k/cdk-real-drift/commit/3595f4c78a4239c681c0b9cd2d78c570fb37e8dc))
* **baseline:** a deleted resource no longer double-reports per-property baseline removals ([#140](https://github.com/go-to-k/cdk-real-drift/issues/140)) ([7bd7a6e](https://github.com/go-to-k/cdk-real-drift/commit/7bd7a6e747481284168b5df9197c65b9fa987324))
* **baseline:** fail safe on a malformed or newer-schema baseline file ([#192](https://github.com/go-to-k/cdk-real-drift/issues/192)) ([42d825f](https://github.com/go-to-k/cdk-real-drift/commit/42d825fc7fcfcf02cc7d29e70662b9382cc5cecf))
* **baseline:** reconcile the 'generated' tier like atDefault (recorded value reset to a generated form is drift) ([#124](https://github.com/go-to-k/cdk-real-drift/issues/124)) ([619c1c7](https://github.com/go-to-k/cdk-real-drift/commit/619c1c788b7982769c7b1accf73aea3b26266336))
* **baseline:** recorded value reset to AWS default is drift; skipped resource is not 'removed' ([#122](https://github.com/go-to-k/cdk-real-drift/issues/122)) ([fc3ffd8](https://github.com/go-to-k/cdk-real-drift/commit/fc3ffd8716fde85abdc5da8fd05b9dc3062b9b1c))
* Batch ComputeEnvironment Type FP + JobDefinition CC read-gap ([#279](https://github.com/go-to-k/cdk-real-drift/issues/279)) ([d41acce](https://github.com/go-to-k/cdk-real-drift/commit/d41acce7d10fd4b35b526f0a11fb6dee5a133f0e))
* Bedrock Guardrail nested array-ordering FP + Cognito IdP CC read-gap ([#283](https://github.com/go-to-k/cdk-real-drift/issues/283)) ([9e53ff8](https://github.com/go-to-k/cdk-real-drift/commit/9e53ff8cd0027a816385ebd4256a3d4551ed9d0e))
* byte-stable ignore-rule sort + per-attribute ELB revert selection ([#118](https://github.com/go-to-k/cdk-real-drift/issues/118)) ([76a77cb](https://github.com/go-to-k/cdk-real-drift/commit/76a77cb37af40355b1ba662b7bbe77c2b5eb841f))
* **check:** --declared-only/--pre-deploy also drop the atDefault tier (undeclared-side) ([#121](https://github.com/go-to-k/cdk-real-drift/issues/121)) ([1522b6c](https://github.com/go-to-k/cdk-real-drift/commit/1522b6c8ba78590a6459ecab4a5124c8dd7824b8))
* **check:** apply --strict coverage gate under --pre-deploy ([#208](https://github.com/go-to-k/cdk-real-drift/issues/208)) ([0085b99](https://github.com/go-to-k/cdk-real-drift/commit/0085b99571a4480a9faa66008c2bdce732ebe51b))
* **check:** drop "all" from interactive Revert/Ignore/Record menu labels ([#295](https://github.com/go-to-k/cdk-real-drift/issues/295)) ([5ef0f13](https://github.com/go-to-k/cdk-real-drift/commit/5ef0f13c407e2206cd9285e26311cbd26cf7945f))
* **check:** fold per-entry 'baseline now declared' notes into one summary line (R134) ([#110](https://github.com/go-to-k/cdk-real-drift/issues/110)) ([8d3e9a1](https://github.com/go-to-k/cdk-real-drift/commit/8d3e9a17bb78ed18bd442d3ca3f7382826f62a20))
* **check:** fold three live-confirmed set-reorder / version-track FPs (Cognito URLs, Route53 ResourceRecords, Neptune EngineVersion) ([#303](https://github.com/go-to-k/cdk-real-drift/issues/303)) ([f992b17](https://github.com/go-to-k/cdk-real-drift/commit/f992b17b579a4a2116a3cf8c0f310236c7f177af))
* **check:** fold typed<->string coercion in a whole-emitted free-form map (Glue Parameters) ([#300](https://github.com/go-to-k/cdk-real-drift/issues/300)) ([b225d4d](https://github.com/go-to-k/cdk-real-drift/commit/b225d4d79560a5378a35a4e74ed4b1ea708b27c9))
* **check:** key --pre-deploy synth templates by stack name AND region ([#185](https://github.com/go-to-k/cdk-real-drift/issues/185)) ([b7ab903](https://github.com/go-to-k/cdk-real-drift/commit/b7ab9035bc9797bb0faa2b3b1a76ebd430f5b66c))
* **check:** loudly warn that nested-stack resources are NOT checked (no silent under-coverage) ([#126](https://github.com/go-to-k/cdk-real-drift/issues/126)) ([2a6daff](https://github.com/go-to-k/cdk-real-drift/commit/2a6daff2f0c934b24463272b961206548a20c911))
* **check:** never auto-confirm an AWS write through the read-only check menu ([#220](https://github.com/go-to-k/cdk-real-drift/issues/220)) ([055e30b](https://github.com/go-to-k/cdk-real-drift/commit/055e30bc81a9a3e8264c072a2d58569ec3563351))
* **check:** per-finding keyOf includes attributeKey so a skipped ELB attribute is not reverted ([#123](https://github.com/go-to-k/cdk-real-drift/issues/123)) ([cf5a6b8](https://github.com/go-to-k/cdk-real-drift/commit/cf5a6b8c1cb82c2ad0670af78a0f82e18a5ae5c9))
* **check:** reconcile CloudFront OAI bucket-policy principals (R101) ([#72](https://github.com/go-to-k/cdk-real-drift/issues/72)) ([b886c72](https://github.com/go-to-k/cdk-real-drift/commit/b886c72277e5f6c42fff21352929d72637dd94dd))
* **check:** skip REVIEW_IN_PROGRESS/deleting stacks with a clear note; warn on mid-operation/failed states ([#128](https://github.com/go-to-k/cdk-real-drift/issues/128)) ([61d56d4](https://github.com/go-to-k/cdk-real-drift/commit/61d56d418749291f9b5c2ca2d48a48cd1137cc37))
* **classify:** align Cognito UserPool Schema by attribute identity (no whole-array false drift) ([#197](https://github.com/go-to-k/cdk-real-drift/issues/197)) ([15f944e](https://github.com/go-to-k/cdk-real-drift/commit/15f944ed76b71b4924bb4a91431023074fc60212))
* **classify:** compare resolved sub-values of a partially-unresolved property ([#175](https://github.com/go-to-k/cdk-real-drift/issues/175)) ([1c32d83](https://github.com/go-to-k/cdk-real-drift/commit/1c32d83f5d19f4e04d6640b58f39494df595ea0d))
* **classify:** fold Fargate PlatformVersion "LATEST" sentinel (declared FP) ([#290](https://github.com/go-to-k/cdk-real-drift/issues/290)) ([13ce5b7](https://github.com/go-to-k/cdk-real-drift/commit/13ce5b7ec3d721c977862ccd3a19c4d31e9a48ce))
* **classify:** reach wrapped inline-policy statements + descend past unresolved siblings ([#170](https://github.com/go-to-k/cdk-real-drift/issues/170)) ([b72df55](https://github.com/go-to-k/cdk-real-drift/commit/b72df5515b5df9065b76de9d28c972335d4a3e18))
* **classify:** sort unordered-set props in the live model so the recorded value is order-stable ([#202](https://github.com/go-to-k/cdk-real-drift/issues/202)) ([1f5e9b9](https://github.com/go-to-k/cdk-real-drift/commit/1f5e9b94fb242d7a7997b196c5606fa71b35b4fa))
* **classify:** suppress Firehose processor Parameters reorder + default-fill FP ([#340](https://github.com/go-to-k/cdk-real-drift/issues/340)) ([b62a221](https://github.com/go-to-k/cdk-real-drift/commit/b62a22142a22d24743788c1623e7a5af575462f9))
* **classify:** track undeclared ELB attribute-bag keys (fail-closed FN fix) + RDS/ECS/ELB FP-FN hunt integs ([#263](https://github.com/go-to-k/cdk-real-drift/issues/263)) ([3530553](https://github.com/go-to-k/cdk-real-drift/commit/3530553bde245d0a174de1d0929b3efa5ce8b827))
* **cli:** ignore skips un-checkable stacks; reject empty separate-token flag value ([#167](https://github.com/go-to-k/cdk-real-drift/issues/167)) ([022c779](https://github.com/go-to-k/cdk-real-drift/commit/022c779ae687cfe270a4d9829b2c9e38757225d1))
* **cognito:** IdentityPool cascade FP + AllowClassicFlow revert + CognitoEvents read-gap ([#402](https://github.com/go-to-k/cdk-real-drift/issues/402)) ([23d0747](https://github.com/go-to-k/cdk-real-drift/commit/23d074763e54fff33eca789b629c343e444e929e))
* **config:** bound ignore-rule path globs to a single segment (no cross-dot over-match) ([#184](https://github.com/go-to-k/cdk-real-drift/issues/184)) ([1d9ca96](https://github.com/go-to-k/cdk-real-drift/commit/1d9ca9669b29b56cb45f062f1635b500e0ee850a))
* **config:** bracket-aware ignore parent match + glob star-collapse (ReDoS) ([#156](https://github.com/go-to-k/cdk-real-drift/issues/156)) ([25c972d](https://github.com/go-to-k/cdk-real-drift/commit/25c972d3f075ee28bcef11ecbf2d894bad3559c6))
* **config:** clear the unrecorded flag when re-tagging a finding to ignored ([#188](https://github.com/go-to-k/cdk-real-drift/issues/188)) ([7943f98](https://github.com/go-to-k/cdk-real-drift/commit/7943f981c860f30f6827ae160dab7f6efe75ae9b))
* **config:** reject an empty ignore-rule path (a silent no-op rule) ([#193](https://github.com/go-to-k/cdk-real-drift/issues/193)) ([f3f35a0](https://github.com/go-to-k/cdk-real-drift/commit/f3f35a0b12df478574f140ecfb9c22fac69858bb))
* **desired:** prefetch ImportValue exports for YAML short-form !ImportValue ([#174](https://github.com/go-to-k/cdk-real-drift/issues/174)) ([607553b](https://github.com/go-to-k/cdk-real-drift/commit/607553b257e2135fa524e2dac9dbe787fd819d30))
* **diff,read:** suppress stringly-typed scalar-array FP (R23) + paginate MetricFilter read (FN) ([#147](https://github.com/go-to-k/cdk-real-drift/issues/147)) ([c907a1c](https://github.com/go-to-k/cdk-real-drift/commit/c907a1ca94b1d5542daf1acb24ae83781ac547ed))
* **diff:** align EC2 Instance BlockDeviceMappings by DeviceName, not whole-array ([#310](https://github.com/go-to-k/cdk-real-drift/issues/310)) ([b520297](https://github.com/go-to-k/cdk-real-drift/commit/b520297c44178ac79a8d19b6886cbde21ba708c1))
* **diff:** detect a declared scalar cleared out of band on returned-when-set paths ([#507](https://github.com/go-to-k/cdk-real-drift/issues/507)) ([#516](https://github.com/go-to-k/cdk-real-drift/issues/516)) ([9119908](https://github.com/go-to-k/cdk-real-drift/commit/911990870afacdbac2b76a3033270fedb3ef8b79))
* **diff:** detect a live-only sub-key added to a declared IAM policy statement (FN) ([#151](https://github.com/go-to-k/cdk-real-drift/issues/151)) ([40b9cd5](https://github.com/go-to-k/cdk-real-drift/commit/40b9cd5cc52875b4ffd9166d64231b3ad18e2de6))
* **diff:** detect any removed declared collection by default (close the omit-when-empty FN class) ([#416](https://github.com/go-to-k/cdk-real-drift/issues/416)) ([4ea1434](https://github.com/go-to-k/cdk-real-drift/commit/4ea1434a72ef4862e519b2ee3ac9cde7afb10e62))
* **diff:** emit a free-form map whole when a key would corrupt the finding path ([#218](https://github.com/go-to-k/cdk-real-drift/issues/218)) ([7c76cc9](https://github.com/go-to-k/cdk-real-drift/commit/7c76cc9c3132dd6b93bff1cf1a7d7ef5de2af1ae))
* **diff:** fail open when a role's sibling policy names are unresolvable (R111) ([#85](https://github.com/go-to-k/cdk-real-drift/issues/85)) ([4b64ff7](https://github.com/go-to-k/cdk-real-drift/commit/4b64ff7bf6ca18c5c8f84260d748ec3572f0d84a))
* **diff:** fold a nested declared empty value vs absent/empty live (Scheduler SqsParameters) ([#568](https://github.com/go-to-k/cdk-real-drift/issues/568)) ([48b006c](https://github.com/go-to-k/cdk-real-drift/commit/48b006c450bc0e19457f26ea545896c4707f2d8c))
* **diff:** fold apigwv2 CORS header case + AutoDeploy Stage DeploymentId (bug-hunt) ([#257](https://github.com/go-to-k/cdk-real-drift/issues/257)) ([6e99f14](https://github.com/go-to-k/cdk-real-drift/commit/6e99f14233b72378cb0a6146ecf600b0718969dd))
* **diff:** fold Glue::Job derived capacity + SG rule peer-name echo ([#571](https://github.com/go-to-k/cdk-real-drift/issues/571)) ([7e1afa7](https://github.com/go-to-k/cdk-real-drift/commit/7e1afa782160221ef422d5d9cb18377010d4c31f))
* **diff:** fold IAM User/Group sibling policies + Path and ECS Cluster sibling capacity providers + ClusterSettings default ([#572](https://github.com/go-to-k/cdk-real-drift/issues/572)) ([6a726ba](https://github.com/go-to-k/cdk-real-drift/commit/6a726bae110817dbe858bc1838415e8ebc8ebffd))
* **diff:** out-of-band ADDITIONS to identity-keyed arrays (Tags, Origins) were silently missed (R95) ([#66](https://github.com/go-to-k/cdk-real-drift/issues/66)) ([f531cc2](https://github.com/go-to-k/cdk-real-drift/commit/f531cc240646cdbd3b9f92a204352da3ca60e64e))
* **diff:** revert a disjoint-key object (one-of union) by replacing it whole ([#272](https://github.com/go-to-k/cdk-real-drift/issues/272)) ([d7594fc](https://github.com/go-to-k/cdk-real-drift/commit/d7594fcc04fbe8d2f0e7e24b9c6f8762e9f83d8b))
* **drift:** detect omitted-when-empty collection removals; allow conditional-create-only reverts ([#413](https://github.com/go-to-k/cdk-real-drift/issues/413)) ([a1b0123](https://github.com/go-to-k/cdk-real-drift/commit/a1b01237774c3ccce30ac826859914f1f9382225))
* ELBv2 ListenerRule Conditions reorder FP + AutoScaling LifecycleHook read-gap ([#285](https://github.com/go-to-k/cdk-real-drift/issues/285)) ([cc84b06](https://github.com/go-to-k/cdk-real-drift/commit/cc84b062b760b9abaf11adc2dbe8251c1d09e23d))
* eliminate clean-first-run false drift and noise (mojibake, Lambda perm, defaults) ([#382](https://github.com/go-to-k/cdk-real-drift/issues/382)) ([894b4bc](https://github.com/go-to-k/cdk-real-drift/commit/894b4bcb206ff5a26db1fe959041fdecd26500cb))
* **gather:** re-resolve consumers after pass 1.5 fills composite-id liveAttrs ([#226](https://github.com/go-to-k/cdk-real-drift/issues/226)) ([2da3764](https://github.com/go-to-k/cdk-real-drift/commit/2da3764f25727fadb3129ad4105bbc3272648522))
* **gather:** retry composite-id CC-adapter resources whose GetAtt parent resolves in pass 1.5 ([#154](https://github.com/go-to-k/cdk-real-drift/issues/154)) ([3bf6c25](https://github.com/go-to-k/cdk-real-drift/commit/3bf6c25898c8ff4b68f8a94525fd04a7cc70c253))
* **gather:** skip added-child enumeration for a parent not read live ([#171](https://github.com/go-to-k/cdk-real-drift/issues/171)) ([59e2b81](https://github.com/go-to-k/cdk-real-drift/commit/59e2b81c27135ea15028573b7152a96d90d7f7ca))
* **hunt-bugs:** make cleanup sentinel parallel-safe (per-owner files) ([#258](https://github.com/go-to-k/cdk-real-drift/issues/258)) ([1778e84](https://github.com/go-to-k/cdk-real-drift/commit/1778e843f13990e68d8c8212153a25495646f0cd))
* **hunt:** 7 FP/FN bugs across 10 real-AWS rounds (IAM/Cognito/Redshift/DocDB/TGW/AZ) + rule-outs ([#355](https://github.com/go-to-k/cdk-real-drift/issues/355)) ([4e00760](https://github.com/go-to-k/cdk-real-drift/commit/4e0076041d26ae5129056e11be1dd60047b65638))
* **ignore:** match a constructPath rule against removed-since-record findings ([#212](https://github.com/go-to-k/cdk-real-drift/issues/212)) ([a5568ee](https://github.com/go-to-k/cdk-real-drift/commit/a5568eec07908bc6764f8bce55360cd9efd5622a))
* **interactive:** show the multiselect cursor — focused row was invisible (R118) ([#92](https://github.com/go-to-k/cdk-real-drift/issues/92)) ([23c8dbe](https://github.com/go-to-k/cdk-real-drift/commit/23c8dbe3b35d94e29a5dec03fb89351191c62455))
* **lambda:** surface free-form map keys, revert nested env vars + Alias Description ([#401](https://github.com/go-to-k/cdk-real-drift/issues/401)) ([5b36b6d](https://github.com/go-to-k/cdk-real-drift/commit/5b36b6d9ba7667e56e4bd26c31e1dc6de2a7bd07))
* **noise:** align object arrays when AWS generates an identity field the template omits ([#363](https://github.com/go-to-k/cdk-real-drift/issues/363)) ([56c9819](https://github.com/go-to-k/cdk-real-drift/commit/56c981967cdb5c6bd5df457e17eee33882dffb38))
* **noise:** apply per-LB-type ELB defaults to wholly-undeclared attribute bags + fold deletion_protection default ([#472](https://github.com/go-to-k/cdk-real-drift/issues/472)) ([7e0af2b](https://github.com/go-to-k/cdk-real-drift/commit/7e0af2b8cc7de370562e7725b4d54155b7d513b6))
* **noise:** apply subset-tolerant default match to the nested atDefault compare ([#435](https://github.com/go-to-k/cdk-real-drift/issues/435)) ([f63b689](https://github.com/go-to-k/cdk-real-drift/commit/f63b689f04b14973ef3c3260c58efe56855bd287))
* **noise:** drop CC field mis-echo + alt-representation (EC2 Route VpcEndpointId, Subnet AvailabilityZoneId) ([#418](https://github.com/go-to-k/cdk-real-drift/issues/418)) ([379604b](https://github.com/go-to-k/cdk-real-drift/commit/379604bb1bfe2ac35b909e069ad412f0dec2e4f6))
* **noise:** drop self-identity echo wrappers + context-derived region defaults ([#466](https://github.com/go-to-k/cdk-real-drift/issues/466)) ([b2dfeac](https://github.com/go-to-k/cdk-real-drift/commit/b2dfeac4a1d36a646cfe02d929a9914c031403a4))
* **noise:** drop the empty policy shell a service-attached log-group policy leaves after subtraction ([#473](https://github.com/go-to-k/cdk-real-drift/issues/473)) ([80797a2](https://github.com/go-to-k/cdk-real-drift/commit/80797a29e9c2d569227aed8ef0530bc7a6412bc8))
* **noise:** eliminate real-dev-stack false positives (Route53 wildcard, policy Sid/log-delivery, reorder, read-back + defaults) ([#465](https://github.com/go-to-k/cdk-real-drift/issues/465)) ([68460f6](https://github.com/go-to-k/cdk-real-drift/commit/68460f6d28b0bba15c86bd5a33dd8b0d84089e1d))
* **noise:** fold AccessAnalyzer ArchiveRules reorder; WarmPool/CapacityProvider defaults ([#460](https://github.com/go-to-k/cdk-real-drift/issues/460)) ([52a2a57](https://github.com/go-to-k/cdk-real-drift/commit/52a2a5739ae41b2ea841cbed4693e3b335e48db4))
* **noise:** fold ALB ListenerRule nested PathPatternConfig.Values reorder ([#330](https://github.com/go-to-k/cdk-real-drift/issues/330)) ([a2f23f4](https://github.com/go-to-k/cdk-real-drift/commit/a2f23f4bac268e5c78dd24d8b6935e09e4c027e6))
* **noise:** fold AWS-sorted set reorders (ECS Links, Backup ListOfTags, ALB conditions, ASG metrics) ([#387](https://github.com/go-to-k/cdk-real-drift/issues/387)) ([a0e887a](https://github.com/go-to-k/cdk-real-drift/commit/a0e887a011904ceddf683e98c15623511491ac5a))
* **noise:** fold CFn auto-generated physical names as generated (first-run noise) ([#417](https://github.com/go-to-k/cdk-real-drift/issues/417)) ([73b98cb](https://github.com/go-to-k/cdk-real-drift/commit/73b98cb4dfef1e93db4480e02885b243d659adca))
* **noise:** fold DynamoDB LSI + GlobalTable NonKeyAttributes reorder ([#328](https://github.com/go-to-k/cdk-real-drift/issues/328)) ([37035aa](https://github.com/go-to-k/cdk-real-drift/commit/37035aa7217b418a1aea94cbee3f0dd13d86201d))
* **noise:** fold EC2 Instance Volumes subset + ElastiCache LogDeliveryConfigurations reorder ([#390](https://github.com/go-to-k/cdk-real-drift/issues/390)) ([5882935](https://github.com/go-to-k/cdk-real-drift/commit/5882935f829a0053f1d3960dfdcb6db0a32e84b7))
* **noise:** fold EC2 KeyPair public-key comment rewrite + EMR Serverless Type case FP; add 13 zero-coverage corpus types ([#457](https://github.com/go-to-k/cdk-real-drift/issues/457)) ([4c2f90e](https://github.com/go-to-k/cdk-real-drift/commit/4c2f90eec5813ec6221ffba7709b7c55eae7920b))
* **noise:** fold ECS RequiresCompatibilities + Route53 HealthCheck Regions reorder FPs ([#365](https://github.com/go-to-k/cdk-real-drift/issues/365)) ([a8d6864](https://github.com/go-to-k/cdk-real-drift/commit/a8d6864b4b5ad09a962e948d21dc14c7c1c0b569))
* **noise:** fold ECS TaskDefinition PortMappings reorder as not drift ([#318](https://github.com/go-to-k/cdk-real-drift/issues/318)) ([e7bdbe2](https://github.com/go-to-k/cdk-real-drift/commit/e7bdbe27157fe05587a5374273cf7b14c9b0c4a1))
* **noise:** fold ECS VolumesFrom + DynamoDB GSI NonKeyAttributes reorder ([#322](https://github.com/go-to-k/cdk-real-drift/issues/322)) ([f5f3234](https://github.com/go-to-k/cdk-real-drift/commit/f5f3234db35fbeb38d52e1efaa53adf6939309dd))
* **noise:** fold EFS AccessPoint ClientToken as generated, not potential drift ([#455](https://github.com/go-to-k/cdk-real-drift/issues/455)) ([2597350](https://github.com/go-to-k/cdk-real-drift/commit/2597350032d25eac30e317dce4ed20aee53186e9))
* **noise:** fold ElastiCache Memcached EngineVersion concrete->partial track FP ([#429](https://github.com/go-to-k/cdk-real-drift/issues/429)) ([fc041bc](https://github.com/go-to-k/cdk-real-drift/commit/fc041bce69d2cb76b6f9aebdc6a96dcc07b393c7))
* **noise:** fold Lambda EventSourceMapping KafkaBootstrapServers reorder FP ([#437](https://github.com/go-to-k/cdk-real-drift/issues/437)) ([035e3cf](https://github.com/go-to-k/cdk-real-drift/commit/035e3cfb3e0ed1a7c7136d784618f4dcb9eb7790))
* **noise:** fold RDS-family EnableCloudwatchLogsExports reorder FP ([#366](https://github.com/go-to-k/cdk-real-drift/issues/366)) ([c810f53](https://github.com/go-to-k/cdk-real-drift/commit/c810f538f9c39d233325ccf8aef1b667c1d6e1f2))
* **noise:** fold ResolverRule/RecordSet FQDN trailing dot + PlacementGroup/IPAM/APS defaults; add 13 zero-coverage corpus types ([#464](https://github.com/go-to-k/cdk-real-drift/issues/464)) ([b0b9433](https://github.com/go-to-k/cdk-real-drift/commit/b0b94339335ae757da304352ecca6746ffd521eb))
* **noise:** fold three API Gateway / Chatbot first-run false positives ([#434](https://github.com/go-to-k/cdk-real-drift/issues/434)) ([f566d92](https://github.com/go-to-k/cdk-real-drift/commit/f566d921aa7813f2a39b289af3172983f45c2f34))
* **noise:** fold three first-run GlobalTable/ESM/Authorizer FPs ([#438](https://github.com/go-to-k/cdk-real-drift/issues/438)) ([5993878](https://github.com/go-to-k/cdk-real-drift/commit/59938786c48b0123a8ae56c9e75214534bd0cfed))
* **noise:** fold two more set reorders (ASG inline lifecycle hooks, Secret replica regions) ([#388](https://github.com/go-to-k/cdk-real-drift/issues/388)) ([04e1cf6](https://github.com/go-to-k/cdk-real-drift/commit/04e1cf61b1e295a68d60e3fbc11b47a104cb4958))
* **noise:** fold WAFv2 LoggingConfiguration RedactedFields reorder FP ([#433](https://github.com/go-to-k/cdk-real-drift/issues/433)) ([fd5f0ce](https://github.com/go-to-k/cdk-real-drift/commit/fd5f0ce8695030f9edf65fdc3a7d815baaf2ad6e))
* **noise:** merge duplicate ESM KNOWN_DEFAULTS key dropping retry/age fold ([#443](https://github.com/go-to-k/cdk-real-drift/issues/443)) ([74da4cc](https://github.com/go-to-k/cdk-real-drift/commit/74da4cc0d976de9bf6614f7bf8350590747b90b9))
* **noise:** RDS DBCluster EngineVersion partial-track prefix match ([#207](https://github.com/go-to-k/cdk-real-drift/issues/207)) ([228a845](https://github.com/go-to-k/cdk-real-drift/commit/228a84590cd0591a85de2afe7a8c82672cb4bbed))
* **noise:** rule out WAFv2 RuleGroup CustomKeys reorder + fold rate-window ([#440](https://github.com/go-to-k/cdk-real-drift/issues/440)) ([#442](https://github.com/go-to-k/cdk-real-drift/issues/442)) ([67bb180](https://github.com/go-to-k/cdk-real-drift/commit/67bb1805feb25f9aa034ec0eed7c3f37e26a050d))
* **noise:** truncated CFn-generated names + per-LB-type ELB defaults + S3Express/S3Tables/vended-logs folds ([#458](https://github.com/go-to-k/cdk-real-drift/issues/458)) ([0e43f98](https://github.com/go-to-k/cdk-real-drift/commit/0e43f985a70e1d8fc06816c20746d381799791a1))
* **normalize,baseline,revert:** Fn::Sub non-scalar leak FP + nested baseline double-report FP + added-delete NotFound tolerance ([#149](https://github.com/go-to-k/cdk-real-drift/issues/149)) ([fcdd461](https://github.com/go-to-k/cdk-real-drift/commit/fcdd461f4174f1f1bfa444875f7567c022a53e0b))
* **normalize,report:** Fn::Equals string-coercion (wrong Fn::If branch) + boundary-safe value truncation ([#155](https://github.com/go-to-k/cdk-real-drift/issues/155)) ([c36993c](https://github.com/go-to-k/cdk-real-drift/commit/c36993c34058d5d2d8643aea0b98fc386891b20a))
* **normalize:** canonicalize IAM policy Condition value-sets to kill false declared drift ([#113](https://github.com/go-to-k/cdk-real-drift/issues/113)) ([69fef60](https://github.com/go-to-k/cdk-real-drift/commit/69fef60cd470dbce183f5f2ef2ba791b852f072e))
* **normalize:** cc-api-strip must not strip managed-named keys inside free-form user maps (false negative) ([#129](https://github.com/go-to-k/cdk-real-drift/issues/129)) ([b1848dd](https://github.com/go-to-k/cdk-real-drift/commit/b1848ddf4bd4b0d1ba1dc4f0d23725dc805d2291))
* **normalize:** don't sort order-significant CodePipeline Stages/Actions (revert index misalignment) ([#275](https://github.com/go-to-k/cdk-real-drift/issues/275)) ([b14fb6e](https://github.com/go-to-k/cdk-real-drift/commit/b14fb6ee81c9d606a677c04931362150185fd45f))
* **normalize:** drop Aurora DBInstance properties that echo the parent DBCluster ([#521](https://github.com/go-to-k/cdk-real-drift/issues/521)) ([b0a8a5d](https://github.com/go-to-k/cdk-real-drift/commit/b0a8a5d80dbf1e3011c92bf7e8d0530aa3bb96dd))
* **normalize:** drop value-independent LayerVersion LayerName over-fold (fixes red main) ([#525](https://github.com/go-to-k/cdk-real-drift/issues/525)) ([19eadc2](https://github.com/go-to-k/cdk-real-drift/commit/19eadc28eb499ff78a5aa1b264638cb8509d0a06))
* **normalize:** fold ApiGateway Authorizer AuthType value-independently (TOKEN/REQUEST 'custom' FP) ([#526](https://github.com/go-to-k/cdk-real-drift/issues/526)) ([8800e81](https://github.com/go-to-k/cdk-real-drift/commit/8800e81dcf72eb2abd36bdea86560fe54c0002b2))
* **normalize:** fold AWS-assigned RDS values (KmsKeyId/PI-key/AZ/windows) value-independent ([#533](https://github.com/go-to-k/cdk-real-drift/issues/533)) ([c321d8c](https://github.com/go-to-k/cdk-real-drift/commit/c321d8ce3c836c869fa21f556452815b880f9864))
* **normalize:** fold CodePipeline V2 Git trigger filter set reorder (branch/path/tag globs) ([#541](https://github.com/go-to-k/cdk-real-drift/issues/541)) ([fb46117](https://github.com/go-to-k/cdk-real-drift/commit/fb4611718d4ed44522e226337f348879eb61477d))
* **normalize:** fold my-app-Web first-run FP batch (Cognito/WAF/ESM/RestApi/generated-names) ([#511](https://github.com/go-to-k/cdk-real-drift/issues/511)) ([7915197](https://github.com/go-to-k/cdk-real-drift/commit/7915197eb81f8ee55bb5f754068d70e339903de8))
* **normalize:** fold DynamoDB classic Table on-demand baseline WarmThroughput (12000/4000) ([#523](https://github.com/go-to-k/cdk-real-drift/issues/523)) ([920e937](https://github.com/go-to-k/cdk-real-drift/commit/920e937cd05c09fa512ff642cf5a99c855415d67))
* **normalize:** fold engine-derived RDS defaults (StorageType/Port/LicenseModel/groups/CA) to atDefault ([#512](https://github.com/go-to-k/cdk-real-drift/issues/512)) ([7f16127](https://github.com/go-to-k/cdk-real-drift/commit/7f16127ae3614c32be50a20a0611aff18dc18c34))
* **normalize:** fold RDS DB identifier case + Lambda ApplicationLogLevel default (Aurora FPs) ([#504](https://github.com/go-to-k/cdk-real-drift/issues/504)) ([af5d069](https://github.com/go-to-k/cdk-real-drift/commit/af5d069a23813773d10094c5bca6e3f06054f6bc))
* **normalize:** fold RDS EngineLifecycleSupport value-independent (+ regen drifted RDS corpus) ([#538](https://github.com/go-to-k/cdk-real-drift/issues/538)) ([60ea473](https://github.com/go-to-k/cdk-real-drift/commit/60ea4737927dfcc1ab947475b156ad338cf0a258))
* **normalize:** fold RDS OptionGroup OptionSettings default-fill FP + VpcLattice ServiceNetwork SharingConfig default ([#485](https://github.com/go-to-k/cdk-real-drift/issues/485)) ([d845047](https://github.com/go-to-k/cdk-real-drift/commit/d845047b28370a7f303d88ba4507e2b1199f6e7a))
* **normalize:** fold RDS parameter-group MySQL boolean tokens (ON≡1, OFF≡0) ([#514](https://github.com/go-to-k/cdk-real-drift/issues/514)) ([bed4d86](https://github.com/go-to-k/cdk-real-drift/commit/bed4d86fc31166e3a31a3b90ee1801c73fae3a9c))
* **normalize:** fold RedshiftServerless Workgroup echo-husk, DataBrew map key-case FP + 2026-07-03 first-run KNOWN_DEFAULTS ([#501](https://github.com/go-to-k/cdk-real-drift/issues/501)) ([0fa9a7e](https://github.com/go-to-k/cdk-real-drift/commit/0fa9a7e4af40beb066deff7c075ae6ee6afe7b32))
* **normalize:** fold ResolverEndpoint IpAddresses reorder FP (identity-key by SubnetId) ([#487](https://github.com/go-to-k/cdk-real-drift/issues/487)) ([47314bd](https://github.com/go-to-k/cdk-real-drift/commit/47314bd960986bdcae19d80e90a2b8edc56490ab))
* **normalize:** fold service-injected defaults inside JSON-string props (CE CostCategory Rules) ([#503](https://github.com/go-to-k/cdk-real-drift/issues/503)) ([#518](https://github.com/go-to-k/cdk-real-drift/issues/518)) ([82c9435](https://github.com/go-to-k/cdk-real-drift/commit/82c9435c2407fdd7a65c87595c664e0fbf1fefe3))
* **normalize:** fold typed<->string leaves inside JSON-string props + proactive AmazonMQ EngineVersion guard ([#551](https://github.com/go-to-k/cdk-real-drift/issues/551)) ([da0e4d3](https://github.com/go-to-k/cdk-real-drift/commit/da0e4d3563bca3cd87334b707d75b1b0020d7f7d))
* **normalize:** intrinsic resolver fails closed on non-scalar Join/Sub interpolants ([#115](https://github.com/go-to-k/cdk-real-drift/issues/115)) ([7436668](https://github.com/go-to-k/cdk-real-drift/commit/7436668313babd5ff26a8ba0d0ce61462bd583e0))
* **normalize:** keep order-significant Lambda Layers ARN list unsorted (false-negative) ([#117](https://github.com/go-to-k/cdk-real-drift/issues/117)) ([ca964b2](https://github.com/go-to-k/cdk-real-drift/commit/ca964b265ae3fdcaef8f5a69d029d13fefb36d7a))
* **normalize:** make cc-api-strip free-form protection sticky down the subtree ([#205](https://github.com/go-to-k/cdk-real-drift/issues/205)) ([5222247](https://github.com/go-to-k/cdk-real-drift/commit/52222475072b5381b24bc365db6613106eadb077))
* **normalize:** match SG sibling-rule ports across typed<->string + unresolved (Aurora ingress FP) ([#510](https://github.com/go-to-k/cdk-real-drift/issues/510)) ([5ea6628](https://github.com/go-to-k/cdk-real-drift/commit/5ea662863e711b6e35439feee0f8e31f18a261db))
* **normalize:** match the ARN's exact final component, not a path suffix ([#225](https://github.com/go-to-k/cdk-real-drift/issues/225)) ([e5c948e](https://github.com/go-to-k/cdk-real-drift/commit/e5c948e7f1b9670e74d665e62246a259a460624c))
* **normalize:** preserve policy doc-level Id/sibling keys + tighten isPolicyDoc to real statements ([#160](https://github.com/go-to-k/cdk-real-drift/issues/160)) ([e7a22d6](https://github.com/go-to-k/cdk-real-drift/commit/e7a22d6fe1d5866afafc24e821d83c369f4008cd))
* **normalize:** resolve Fn::Select index + honor Fn::FindInMap DefaultValue ([#165](https://github.com/go-to-k/cdk-real-drift/issues/165)) ([7b0140b](https://github.com/go-to-k/cdk-real-drift/commit/7b0140b910ef3ae2e988675037df3ee01ae07da9))
* **normalize:** scope Cognito ClientName generated-name fold (drop value-independent over-fold) ([#537](https://github.com/go-to-k/cdk-real-drift/issues/537)) ([1cf016f](https://github.com/go-to-k/cdk-real-drift/commit/1cf016f8a4bfbb65b5d9eb009f0c490ba6a91e1c))
* **normalize:** suppress CloudWatch Logs log-group ARN trailing :* wildcard (false declared drift on fresh deploy) ([#136](https://github.com/go-to-k/cdk-real-drift/issues/136)) ([45a3a81](https://github.com/go-to-k/cdk-real-drift/commit/45a3a81db25c43f5634c8d9fe3d4fafe84d4f28e))
* **normalize:** suppress RDS dynamic-reference + version-track fresh-deploy FPs; harvest13 slow data-plane integ (R130) ([#107](https://github.com/go-to-k/cdk-real-drift/issues/107)) ([3911434](https://github.com/go-to-k/cdk-real-drift/commit/39114349176bc29c0737f872bb038339746106d7))
* **normalize:** treat free-form user-map values as opaque in the policy/json-text canonicalizers ([#182](https://github.com/go-to-k/cdk-real-drift/issues/182)) ([17cab57](https://github.com/go-to-k/cdk-real-drift/commit/17cab572fcc1b68c89e5b7f834a6a76535579f4e))
* **normalize:** treat Name as an array identity field (no false drift on reordered [{Name,Value}]) ([#201](https://github.com/go-to-k/cdk-real-drift/issues/201)) ([fed3def](https://github.com/go-to-k/cdk-real-drift/commit/fed3def4ef990a882605630d7428007546bab926))
* **normalize:** treat PEM trailing-newline round-trip as not-drift + harvest10 (R125) ([#99](https://github.com/go-to-k/cdk-real-drift/issues/99)) ([d2d2acc](https://github.com/go-to-k/cdk-real-drift/commit/d2d2acce7793c4697b6ec474fbf85a3f33ea7f14))
* **params:** SSM ResolvedValue, NoEcho mask skip, delimited-list trim ([#206](https://github.com/go-to-k/cdk-real-drift/issues/206)) ([0f457fb](https://github.com/go-to-k/cdk-real-drift/commit/0f457fbd142424bb5b40b07686a4889214a684a9))
* **picker:** do not offer record on a modelReadFailed added finding ([#223](https://github.com/go-to-k/cdk-real-drift/issues/223)) ([b0e64b1](https://github.com/go-to-k/cdk-real-drift/commit/b0e64b1c136462777c0b0c9722fddba683e65cf1))
* read declared API Gateway REST + HTTP API authorizers (CC composite read-gap) ([#284](https://github.com/go-to-k/cdk-real-drift/issues/284)) ([1d76319](https://github.com/go-to-k/cdk-real-drift/commit/1d7631953d416b1fb3e666f57ee3e87c71b9dced))
* read declared AutoScaling ScheduledAction (CC composite read-gap) ([#288](https://github.com/go-to-k/cdk-real-drift/issues/288)) ([63082fb](https://github.com/go-to-k/cdk-real-drift/commit/63082fb3dcab06312c17ecf9e63f08dfa144cdce))
* **read,noise:** ApiGateway DocumentationPart read-gap + Cognito UserPoolResourceServer Scopes reorder FP ([#354](https://github.com/go-to-k/cdk-real-drift/issues/354)) ([2037601](https://github.com/go-to-k/cdk-real-drift/commit/20376014941e8deb8100d053298ac44861a33f43))
* **read,noise:** CodeDeploy DeploymentGroup read-gap + AutoRollback Events reorder FP ([#364](https://github.com/go-to-k/cdk-real-drift/issues/364)) ([e09d44f](https://github.com/go-to-k/cdk-real-drift/commit/e09d44fdde35b334c6f95fb26bedd503d0b07dcb))
* **read:** add CC_IDENTIFIER_ADAPTERS for SSM MaintenanceWindowTarget/Task (WindowId composite) ([#528](https://github.com/go-to-k/cdk-real-drift/issues/528)) ([#542](https://github.com/go-to-k/cdk-real-drift/issues/542)) ([0adcaf2](https://github.com/go-to-k/cdk-real-drift/commit/0adcaf212ae90877822cf3af56894ce7eb298b91))
* **read:** alias V2 GetAuthorizersCommand to avoid duplicate import ([#219](https://github.com/go-to-k/cdk-real-drift/issues/219)) ([454a93a](https://github.com/go-to-k/cdk-real-drift/commit/454a93a81ff7c34e686d7557764b212f8d3d9999))
* **read:** AnomalyDetector follow-ups — metric-math listing, CFn Range pattern, Label read-gap, AccountId echo ([#471](https://github.com/go-to-k/cdk-real-drift/issues/471)) ([dc9527e](https://github.com/go-to-k/cdk-real-drift/commit/dc9527edab5addf882843b4607a0b6d571f81457))
* **read:** Budgets override must compare CostFilters (scope) — a thin projection hid out-of-band scope drift ([#131](https://github.com/go-to-k/cdk-real-drift/issues/131)) ([005052f](https://github.com/go-to-k/cdk-real-drift/commit/005052f04df021b06da1124f3df64c98b6b1d6fd))
* **read:** CC_IDENTIFIER_ADAPTERS for ElasticBeanstalk ConfigurationTemplate + OptionSettings default-fill guard ([#499](https://github.com/go-to-k/cdk-real-drift/issues/499)) ([ab0cb20](https://github.com/go-to-k/cdk-real-drift/commit/ab0cb206be11395ccbe4c97f37d7863f31d6deea))
* **read:** classify a deleted Glue table as deleted, not skipped ([#173](https://github.com/go-to-k/cdk-real-drift/issues/173)) ([0a97d0e](https://github.com/go-to-k/cdk-real-drift/commit/0a97d0e6d073f29a98b8b1ec8f1f2640bb94525c))
* **read:** close AWS::Logs::LogStream CC read-gap via composite adapter ([#397](https://github.com/go-to-k/cdk-real-drift/issues/397)) ([5337427](https://github.com/go-to-k/cdk-real-drift/commit/53374271eaa61359f0cab45c26b75d1fe1a3340c))
* **read:** CodeBuild override projects LogsConfig/BadgeEnabled (out-of-band logging redirect was invisible) ([#135](https://github.com/go-to-k/cdk-real-drift/issues/135)) ([19ee6b3](https://github.com/go-to-k/cdk-real-drift/commit/19ee6b31eaa8a2dceb1371ee7ed499b3e0a4ecef))
* **read:** CodeBuild override projects Visibility/VpcConfig/ConcurrentBuildLimit/SourceVersion (projection FN) ([#132](https://github.com/go-to-k/cdk-real-drift/issues/132)) ([a03721c](https://github.com/go-to-k/cdk-real-drift/commit/a03721cffd04baac80205c9ec24ee8e201eefa1c))
* **read:** detect out-of-band AccessString changes on ElastiCache/MemoryDB users ([#488](https://github.com/go-to-k/cdk-real-drift/issues/488)) ([997fade](https://github.com/go-to-k/cdk-real-drift/commit/997fade1ddfd2c479e9161d2f3221d5707de20ff))
* **read:** detect out-of-band ConfigParameters/SecurityGroupIds/SubnetIds on RedshiftServerless Workgroup ([#513](https://github.com/go-to-k/cdk-real-drift/issues/513)) ([976a638](https://github.com/go-to-k/cdk-real-drift/commit/976a6385a0c52fe4ae96dd7f5c366bc02befac47))
* **read:** Glue Table override projects TargetTable (resource-link repoint was undetectable) ([#133](https://github.com/go-to-k/cdk-real-drift/issues/133)) ([b50d0af](https://github.com/go-to-k/cdk-real-drift/commit/b50d0af3489e5247b7a87a4a3acbe44a45109d57))
* **read:** identify API Gateway root by live path so an unresolved RootResourceId can't false-flag the root ([#159](https://github.com/go-to-k/cdk-real-drift/issues/159)) ([0c9ae6d](https://github.com/go-to-k/cdk-real-drift/commit/0c9ae6db33545af0bb05c977aa60a551016c9eec))
* **read:** Lambda Permission override projects PrincipalOrgID + FunctionUrlAuthType (invoke-widening was invisible) ([#138](https://github.com/go-to-k/cdk-real-drift/issues/138)) ([e0c417f](https://github.com/go-to-k/cdk-real-drift/commit/e0c417f79bbaa3f81861ccbab7b8204e047143d3))
* **read:** paginate Route53 ListResourceRecordSets (a page-2 record was a false deleted) ([#191](https://github.com/go-to-k/cdk-real-drift/issues/191)) ([07e2950](https://github.com/go-to-k/cdk-real-drift/commit/07e295075a979bc9f53272336575f79c9e5537ab))
* **read:** project Budgets PlannedBudgetLimits + thin AutoAdjustData (FN) ([#157](https://github.com/go-to-k/cdk-real-drift/issues/157)) ([6a856fc](https://github.com/go-to-k/cdk-real-drift/commit/6a856fcd42fcabf96bab75adc1c167c9b670e357))
* **read:** project CodeBuild Project.Cache (FN) + fold NO_CACHE default ([#150](https://github.com/go-to-k/cdk-real-drift/issues/150)) ([4f8e33d](https://github.com/go-to-k/cdk-real-drift/commit/4f8e33de5e0994ea6216088ff8f1b43ef4af3cf6))
* **read:** project CodeBuild security flags + complete S3-artifact shape (live-proven) ([#230](https://github.com/go-to-k/cdk-real-drift/issues/230)) ([bb82eb2](https://github.com/go-to-k/cdk-real-drift/commit/bb82eb2ca8dc1150267dca868d901634605ce2aa))
* **read:** project MetricFilter ApplyOnTransformedLogs (live-proven) ([#232](https://github.com/go-to-k/cdk-real-drift/issues/232)) ([5f686e7](https://github.com/go-to-k/cdk-real-drift/commit/5f686e775890029599cfd239e0cc73024e87a072))
* **read:** project Route53 geoproximity/CIDR routing + fix HostedZone Name trailing-dot FP (live-proven) ([#234](https://github.com/go-to-k/cdk-real-drift/issues/234)) ([82a9d18](https://github.com/go-to-k/cdk-real-drift/commit/82a9d181404be8b1f9523b0fbc9d317710ccc4de))
* **read:** read AppConfig HostedConfigurationVersion + Deployment via 3-segment composite id ([#348](https://github.com/go-to-k/cdk-real-drift/issues/348)) ([07863ac](https://github.com/go-to-k/cdk-real-drift/commit/07863acfa701008d8d5c7f4493cae93466d1e39d))
* **read:** read declared Logs SubscriptionFilter via FilterName|LogGroupName composite ([#344](https://github.com/go-to-k/cdk-real-drift/issues/344)) ([40c8895](https://github.com/go-to-k/cdk-real-drift/commit/40c88959f80b91ef60248a6defc077e294956945))
* **read:** report a deleted Route53 record / MetricFilter as deleted, not skipped ([#178](https://github.com/go-to-k/cdk-real-drift/issues/178)) ([b3d6c61](https://github.com/go-to-k/cdk-real-drift/commit/b3d6c6182826797b76d44c8291f806e0a740e7fb))
* **read:** Route53 override disambiguates routing variants by SetIdentifier (wrong-record FP) + projects routing fields ([#137](https://github.com/go-to-k/cdk-real-drift/issues/137)) ([8035d84](https://github.com/go-to-k/cdk-real-drift/commit/8035d8405b37163a7de3f403b37c644443f12d65))
* **read:** stop projecting EIP NetworkInterfaceId (false drift); project PublicIpv4Pool ([#187](https://github.com/go-to-k/cdk-real-drift/issues/187)) ([fe54d0a](https://github.com/go-to-k/cdk-real-drift/commit/fe54d0aa912e680ab67c74af83b06abbe6a4129a))
* **read:** strip trailing-slash Prefix on ECR RepositoryCreationTemplate (false-deleted FP) ([#502](https://github.com/go-to-k/cdk-real-drift/issues/502)) ([#515](https://github.com/go-to-k/cdk-real-drift/issues/515)) ([f968b4b](https://github.com/go-to-k/cdk-real-drift/commit/f968b4b76bfbb6c5e4329e314d4128863a6017de))
* **read:** warn when kms:ListAliases is denied instead of silently degrading (R115) ([#89](https://github.com/go-to-k/cdk-real-drift/issues/89)) ([6a216f2](https://github.com/go-to-k/cdk-real-drift/commit/6a216f221113d2dc10f2954cba6b8248e5af1a95))
* **record:** carry forward recorded entries for resources unread this run ([#164](https://github.com/go-to-k/cdk-real-drift/issues/164)) ([341f095](https://github.com/go-to-k/cdk-real-drift/commit/341f09500521241f2309403108dfb67f4ff4d5e2))
* **record:** disclose that folded sub-keys are ALWAYS recorded in the picker header ([#307](https://github.com/go-to-k/cdk-real-drift/issues/307)) ([b0c403e](https://github.com/go-to-k/cdk-real-drift/commit/b0c403ebc86c5ec4ce526e395f778d1ca4f11cba))
* **record:** use --verbose (not --show-all) to itemize the folded record picker ([#309](https://github.com/go-to-k/cdk-real-drift/issues/309)) ([50a4591](https://github.com/go-to-k/cdk-real-drift/commit/50a4591b81b07db5975ad1266dc57c701cfcebd9))
* **report:** --show-all must not flag first-run live-only values as drift ([#385](https://github.com/go-to-k/cdk-real-drift/issues/385)) ([2fa4a11](https://github.com/go-to-k/cdk-real-drift/commit/2fa4a114743830e4eb352d509bc17e4a92696436))
* **report:** clarify the unresolved info-line + add /hunt-bugs round ([#245](https://github.com/go-to-k/cdk-real-drift/issues/245)) ([ad253d7](https://github.com/go-to-k/cdk-real-drift/commit/ad253d7fc0c1f3c810e950e0e3c2468f8c08bcb4))
* **report:** correct the unresolved explanation — lead with resolution-unable intrinsics ([#566](https://github.com/go-to-k/cdk-real-drift/issues/566)) ([b8d9d55](https://github.com/go-to-k/cdk-real-drift/commit/b8d9d552f3d10621495e35752a89c4d147879c98))
* **report:** count only standout live-only values as potential drift ([#380](https://github.com/go-to-k/cdk-real-drift/issues/380)) ([ff1a806](https://github.com/go-to-k/cdk-real-drift/commit/ff1a8067110f805d1b580a11f8b66008f0c48409))
* **report:** label UNRECORDED 'not drift' and reconcile the shown/folded count (R112) ([#86](https://github.com/go-to-k/cdk-real-drift/issues/86)) ([ea57330](https://github.com/go-to-k/cdk-real-drift/commit/ea57330592e0ac0ff49d1d2d2ae1e1ec3a4bc565))
* **report:** pair-aware value truncation so a long desired/actual diff is never hidden as identical blobs ([#130](https://github.com/go-to-k/cdk-real-drift/issues/130)) ([cfc4b35](https://github.com/go-to-k/cdk-real-drift/commit/cfc4b3572422d4727300c9f50c3a49d08427b79d))
* **report:** per-key delta for map-valued declared drift (key-order/dotted-key legibility) ([#407](https://github.com/go-to-k/cdk-real-drift/issues/407)) ([e60bce6](https://github.com/go-to-k/cdk-real-drift/commit/e60bce60958ff5fff0bcd4bcc43e72cbc4fed006))
* **report:** put undeclared/potential value on its own actual= line ([#561](https://github.com/go-to-k/cdk-real-drift/issues/561)) ([5091e2a](https://github.com/go-to-k/cdk-real-drift/commit/5091e2a82cc30e5dd913c8668653f01584391e31))
* **report:** readable default-fg for explanatory prose + rule-framed result: ([#559](https://github.com/go-to-k/cdk-real-drift/issues/559)) ([2a44b7a](https://github.com/go-to-k/cdk-real-drift/commit/2a44b7a8ff8f44526841653b87c40ff21eb96de0))
* **report:** restore pre-R138 first-run folding + fold 3 ApiGateway noise values ([#176](https://github.com/go-to-k/cdk-real-drift/issues/176)) ([de34bed](https://github.com/go-to-k/cdk-real-drift/commit/de34bedbd8c4de7d6f6204f2dcc430ef71199079))
* **report:** word the added-resource UX as "not-recorded", not "undeclared" ([#153](https://github.com/go-to-k/cdk-real-drift/issues/153)) ([dc809f5](https://github.com/go-to-k/cdk-real-drift/commit/dc809f5282eb7e73766a95baf414df0dd6001ef4))
* **resolver:** guard against circular CloudFormation conditions ([#211](https://github.com/go-to-k/cdk-real-drift/issues/211)) ([a751c08](https://github.com/go-to-k/cdk-real-drift/commit/a751c08476a0d61d741a926ecfd1c1e4e7b5cef6))
* **revert,schema:** block nested create-only paths up front + collapse interior /properties/ pointers ([#162](https://github.com/go-to-k/cdk-real-drift/issues/162)) ([b44d6e3](https://github.com/go-to-k/cdk-real-drift/commit/b44d6e357440314d624108050a55735111563b71))
* **revert:** add SDK PutPermission writer for EventBusPolicy (CC RFC6902 patch fails) ([#394](https://github.com/go-to-k/cdk-real-drift/issues/394)) ([a0185be](https://github.com/go-to-k/cdk-real-drift/commit/a0185be8a7d65a3692c2fac7bd5d4d68a05482c6))
* **revert:** align policy-document writer ops to the canonical statement order ([#180](https://github.com/go-to-k/cdk-real-drift/issues/180)) ([2d84962](https://github.com/go-to-k/cdk-real-drift/commit/2d84962083e3a2bada4fb5e000d6171995c2c3a1))
* **revert:** align WAFv2 WebACL Rules to canonical index before applying ops ([#276](https://github.com/go-to-k/cdk-real-drift/issues/276)) ([23b3f13](https://github.com/go-to-k/cdk-real-drift/commit/23b3f13e10b6636e4f88f353772e0d2dae7ba710))
* **revert:** block a revert whose parent finding would replace a create-only descendant ([#216](https://github.com/go-to-k/cdk-real-drift/issues/216)) ([e4be175](https://github.com/go-to-k/cdk-real-drift/commit/e4be175a20dc93f90c903f4d37936e6c2c465c5a))
* **revert:** carry live value as prior on declared ops so IAM Role inline-policy revert removes rogue entries ([#120](https://github.com/go-to-k/cdk-real-drift/issues/120)) ([8cc168b](https://github.com/go-to-k/cdk-real-drift/commit/8cc168b8981e7185fbebba69123bfc3eec3d0d63))
* **revert:** CloudFront Distribution revert via UpdateDistribution SDK writer + CloudFront/S3/SFN hunt integs ([#264](https://github.com/go-to-k/cdk-real-drift/issues/264)) ([63c8b1c](https://github.com/go-to-k/cdk-real-drift/commit/63c8b1ccc1f994c4ede002fed28490817f7cd543))
* **revert:** collapse a resource's cc+sdk revert items into one plan block and one reverted line ([#298](https://github.com/go-to-k/cdk-real-drift/issues/298)) ([639d8e0](https://github.com/go-to-k/cdk-real-drift/commit/639d8e0734cdd54708a8e0cdf6a9c405382909b6))
* **revert:** do not report CLEAN when post-revert convergence is unverifiable ([#222](https://github.com/go-to-k/cdk-real-drift/issues/222)) ([92fdae3](https://github.com/go-to-k/cdk-real-drift/commit/92fdae396cf1a2e779c9336c92fad7b69471c497))
* **revert:** every revert op starts UNSELECTED in the picker (R137) ([#116](https://github.com/go-to-k/cdk-real-drift/issues/116)) ([96f5a44](https://github.com/go-to-k/cdk-real-drift/commit/96f5a4447f46723a50b84d36bd3aaec691335099))
* **revert:** Glue Job revert via UpdateJob SDK writer (CC MaxCapacity+WorkerType conflict) ([#266](https://github.com/go-to-k/cdk-real-drift/issues/266)) ([53f7e96](https://github.com/go-to-k/cdk-real-drift/commit/53f7e96e27c89a4f806d18da3978a57eade01816))
* **revert:** map-shaped tag keys revertable; surface free-form maps under array elements ([#403](https://github.com/go-to-k/cdk-real-drift/issues/403)) ([9a13f5d](https://github.com/go-to-k/cdk-real-drift/commit/9a13f5d51fd75714fff5359567c2e4f0e2f8db48))
* **revert:** nested undeclared values are not revertable (R99) ([#70](https://github.com/go-to-k/cdk-real-drift/issues/70)) ([f7bb3c7](https://github.com/go-to-k/cdk-real-drift/commit/f7bb3c7e79da9506644ce7de3291250aeab2da66))
* **revert:** never re-include a write-only prop that is also create-only ([#252](https://github.com/go-to-k/cdk-real-drift/issues/252)) ([0c4d4d8](https://github.com/go-to-k/cdk-real-drift/commit/0c4d4d8a2f132581f1dfacd380a6f62e5a554c0b))
* **revert:** OpenSearch Domain revert via UpdateDomainConfig SDK writer + Backup/MSK coverage ([#273](https://github.com/go-to-k/cdk-real-drift/issues/273)) ([3652616](https://github.com/go-to-k/cdk-real-drift/commit/365261639cca2c18740ea8ff503cee9d81a5004c))
* **revert:** pin Logs Transformer TransformerConfig order-significant so revert targets the raw live index ([#529](https://github.com/go-to-k/cdk-real-drift/issues/529)) ([#544](https://github.com/go-to-k/cdk-real-drift/issues/544)) ([8e413f2](https://github.com/go-to-k/cdk-real-drift/commit/8e413f2fb4e8ab09a4d75239a357a711d049bcc2))
* **revert:** preserve aws:* managed tags for map-shaped Tags too (no AWS reject) ([#204](https://github.com/go-to-k/cdk-real-drift/issues/204)) ([6e16eda](https://github.com/go-to-k/cdk-real-drift/commit/6e16edaedfff4ddcb807dca9d4b6af8ed5280706))
* **revert:** preserve aws:* managed tags when reverting a Tags drift (R131) ([#108](https://github.com/go-to-k/cdk-real-drift/issues/108)) ([02edfe0](https://github.com/go-to-k/cdk-real-drift/commit/02edfe08bd0f64832ab8e412d6314cf3f9be6804))
* **revert:** re-include nested write-only props so a cc revert never drops a credential ([#203](https://github.com/go-to-k/cdk-real-drift/issues/203)) ([153b554](https://github.com/go-to-k/cdk-real-drift/commit/153b554713a2dd1f66857a8568a8d7cbb85865fc))
* **revert:** reach empty-array husks inside array elements via pointer wildcards (ImageBuilder DistributionConfiguration) ([#506](https://github.com/go-to-k/cdk-real-drift/issues/506)) ([#519](https://github.com/go-to-k/cdk-real-drift/issues/519)) ([4c4b24f](https://github.com/go-to-k/cdk-real-drift/commit/4c4b24f9acc5bdfa8d70843a3b94ef73a7aa3f6a))
* **revert:** refuse IAM Role Policies revert when sibling policy names unresolved ([#209](https://github.com/go-to-k/cdk-real-drift/issues/209)) ([4cad1fd](https://github.com/go-to-k/cdk-real-drift/commit/4cad1fd4278a1d6a0e4669b5b48022b9376e12b3))
* **revert:** restore a removed-since-record value (was "no physical id") ([#282](https://github.com/go-to-k/cdk-real-drift/issues/282)) ([e573b39](https://github.com/go-to-k/cdk-real-drift/commit/e573b39a2a3d90ac9fb68d085e5fda827f9d2821))
* **revert:** retry transient mid-update errors (RSLVR-00705 & friends) with bounded backoff, then a targeted hint ([#474](https://github.com/go-to-k/cdk-real-drift/issues/474)) ([be101e1](https://github.com/go-to-k/cdk-real-drift/commit/be101e15b2b8a00869ef70157b42bd50d65dd13c))
* **revert:** revert Logs LogGroup BearerTokenAuthenticationEnabled via PutBearerTokenAuthentication ([#297](https://github.com/go-to-k/cdk-real-drift/issues/297)) ([0ed89c6](https://github.com/go-to-k/cdk-real-drift/commit/0ed89c66f2fb17c0416cd6b640094fe02b186071))
* **revert:** strip service-echoed empty arrays the service rejects on CC update (VpcLattice Rule HeaderMatches) ([#486](https://github.com/go-to-k/cdk-real-drift/issues/486)) ([fc22c12](https://github.com/go-to-k/cdk-real-drift/commit/fc22c120176f4c6566f5164751ba5c957cf91f1e))
* **revert:** WAFv2 WebACL revert via UpdateWebACL SDK writer + revert coverage for WAF/AppSync/Cognito ([#265](https://github.com/go-to-k/cdk-real-drift/issues/265)) ([7523146](https://github.com/go-to-k/cdk-real-drift/commit/7523146d962c55e4bb63dbcf677824fe323cb0f8))
* **revert:** write policy reverts to ALL attachment targets, not just the first ([#213](https://github.com/go-to-k/cdk-real-drift/issues/213)) ([e448af0](https://github.com/go-to-k/cdk-real-drift/commit/e448af0cc3840497e4e6601b2d573faace07250e))
* **revert:** write the AWS default for set-default undeclared props (IAM Role MaxSessionDuration) ([#296](https://github.com/go-to-k/cdk-real-drift/issues/296)) ([b3522c7](https://github.com/go-to-k/cdk-real-drift/commit/b3522c79abb1ad618cd9207142e1ae7d2aa33117))
* **schema:** exclude map-shaped Tags from freeFormMapPaths (consistent tag folding) ([#404](https://github.com/go-to-k/cdk-real-drift/issues/404)) ([2203782](https://github.com/go-to-k/cdk-real-drift/commit/2203782f21b1a171b78a50e776c009fc183bab5e))
* **schema:** strip NetworkManager GlobalNetwork lifecycle State/CreatedAt via SCHEMA_READONLY_SUPPLEMENTS ([#498](https://github.com/go-to-k/cdk-real-drift/issues/498)) ([d0c54c9](https://github.com/go-to-k/cdk-real-drift/commit/d0c54c9260e0d0d393246e6fffe3045bbb581410))
* **sg:** fold SecurityGroup sibling-rule reflection FP + preserve siblings on revert ([#430](https://github.com/go-to-k/cdk-real-drift/issues/430)) ([af5f58f](https://github.com/go-to-k/cdk-real-drift/commit/af5f58fd64814e1d8b3c276b3c9d2b402d759f6b))
* **synth:** discover stacks via stacksRecursively so CDK Stage-nested stacks are not silently skipped ([#125](https://github.com/go-to-k/cdk-real-drift/issues/125)) ([43b3b3b](https://github.com/go-to-k/cdk-real-drift/commit/43b3b3b60ae5c95958d721a20a8a060f6b89829c))
* Synthetics rate() expression FP + Scheduler CC-revert despite read-override (bug-hunt) ([#259](https://github.com/go-to-k/cdk-real-drift/issues/259)) ([ed66561](https://github.com/go-to-k/cdk-real-drift/commit/ed665617de0d661059357298af7768a14db3a42f))
* **yaml:** degrade a dot-less !GetAtt instead of crashing the whole parse ([#214](https://github.com/go-to-k/cdk-real-drift/issues/214)) ([ef7b222](https://github.com/go-to-k/cdk-real-drift/commit/ef7b2229760c8e417708b28f2332d3a8faa30e26))


### Features

* **accept:** clearer baseline-overwrite note + state that declared drift is NOT approved (R117) ([#91](https://github.com/go-to-k/cdk-real-drift/issues/91)) ([fd5728b](https://github.com/go-to-k/cdk-real-drift/commit/fd5728ba4f176ca76014c347c2102a50e01b964f))
* **apigw:** detect & revert Method integration knobs; surface nested undeclared; order revert deletes last ([#405](https://github.com/go-to-k/cdk-real-drift/issues/405)) ([fe64665](https://github.com/go-to-k/cdk-real-drift/commit/fe64665423d836ebbb92c1437dc06243273562ca))
* **apigw:** detect & revert out-of-band Method MethodResponses ResponseModels ([#409](https://github.com/go-to-k/cdk-real-drift/issues/409)) ([57176b2](https://github.com/go-to-k/cdk-real-drift/commit/57176b2dc28f36e39aaa601bdb790d5e28a3b287))
* **baseline:** make out-of-band `added` resources record-able (PR4, option B) ([#148](https://github.com/go-to-k/cdk-real-drift/issues/148)) ([fae6aee](https://github.com/go-to-k/cdk-real-drift/commit/fae6aee0d02f27e405f3f5871db2f995386bd852))
* **check,report:** element-level granularity for recorded identity-keyed undeclared arrays (R128) ([#103](https://github.com/go-to-k/cdk-real-drift/issues/103)) ([b78573d](https://github.com/go-to-k/cdk-real-drift/commit/b78573dcab8fca8710564c23ab8669ccec096c53))
* **check:** always show the report before accepting on a first run; drop blind bulk-accept (R110) ([#84](https://github.com/go-to-k/cdk-real-drift/issues/84)) ([450f641](https://github.com/go-to-k/cdk-real-drift/commit/450f641bd649a47166c70c327fd0e9f5a478a4d0))
* **check:** chain interactive resolve — re-show the menu after a non-AWS action (R133) ([#111](https://github.com/go-to-k/cdk-real-drift/issues/111)) ([daef959](https://github.com/go-to-k/cdk-real-drift/commit/daef959d7b8fab9d2f04d96ef02ce1d27e2c21b5))
* **check:** collapse the first-run prompt to one terse line (R106) ([#79](https://github.com/go-to-k/cdk-real-drift/issues/79)) ([0c35d78](https://github.com/go-to-k/cdk-real-drift/commit/0c35d78a2d715758332bc698652719e2c7132ec0))
* **check:** fold dogfood-observed service defaults as atDefault (R104) ([#76](https://github.com/go-to-k/cdk-real-drift/issues/76)) ([e48a9a0](https://github.com/go-to-k/cdk-real-drift/commit/e48a9a04d298bde2b3bb02fe98bdc636d75bdb7f))
* **check:** fold more dogfood-observed service defaults as atDefault (R105) ([#78](https://github.com/go-to-k/cdk-real-drift/issues/78)) ([1d7991f](https://github.com/go-to-k/cdk-real-drift/commit/1d7991f9ee29e0d9a19ff71988d0f765aae77350))
* **check:** fold nested service defaults via KNOWN_DEFAULT_PATHS (R108) ([#82](https://github.com/go-to-k/cdk-real-drift/issues/82)) ([2688ed4](https://github.com/go-to-k/cdk-real-drift/commit/2688ed481e3a55aba48ef0443d8ba6cbdc516adb))
* **check:** inline ignore + per-finding action picker (R121) ([#95](https://github.com/go-to-k/cdk-real-drift/issues/95)) ([b46c6f9](https://github.com/go-to-k/cdk-real-drift/commit/b46c6f9927858ee1bb85bfab8f38e4abcbe3bbe4))
* **check:** interactive UX polish from live dogfood (R125) ([#100](https://github.com/go-to-k/cdk-real-drift/issues/100)) ([e6eff60](https://github.com/go-to-k/cdk-real-drift/commit/e6eff60e80e0f04116d389acd4632cd11d6a3236))
* **check:** loud coverage warning on skipped resources + --strict exit on incomplete coverage ([#127](https://github.com/go-to-k/cdk-real-drift/issues/127)) ([26d21d5](https://github.com/go-to-k/cdk-real-drift/commit/26d21d5ea9d7af37992157ab30033d60f2065ab1))
* **check:** offer Record (establish baseline) even when only a declared drift exists ([#452](https://github.com/go-to-k/cdk-real-drift/issues/452)) ([c84112d](https://github.com/go-to-k/cdk-real-drift/commit/c84112ddcd5419de38fc77720f5050b790b58ea3))
* **check:** offer to establish the day-1 baseline on a clean no-baseline stack ([#186](https://github.com/go-to-k/cdk-real-drift/issues/186)) ([7b2a88a](https://github.com/go-to-k/cdk-real-drift/commit/7b2a88a590f39422563cda3f669e21cfa259737b))
* **check:** reframe the first-run prompt as baseline setup; count only standout edits (R105) ([#77](https://github.com/go-to-k/cdk-real-drift/issues/77)) ([a05989e](https://github.com/go-to-k/cdk-real-drift/commit/a05989e7fc6cd1afecac4659f0e4e73365d05cbd))
* **check:** scope interactive ignore/per-finding pickers to report-shown drift ([#301](https://github.com/go-to-k/cdk-real-drift/issues/301)) ([d0636f1](https://github.com/go-to-k/cdk-real-drift/commit/d0636f1581e2d2a14281019767196fc61c6dbcb7))
* **check:** show a spinner while reading live state so a run never looks frozen ([#477](https://github.com/go-to-k/cdk-real-drift/issues/477)) ([01a0976](https://github.com/go-to-k/cdk-real-drift/commit/01a0976c564ca25811ddd4a7f0b9989b2202fcdd))
* **check:** skip the first-run accept prompt when nothing stands out (R109) ([#83](https://github.com/go-to-k/cdk-real-drift/issues/83)) ([96e3fe7](https://github.com/go-to-k/cdk-real-drift/commit/96e3fe7c685bec5c9b292fa847fff798d5eec0d9))
* **check:** surface multi-stack progress [i/N] in report header + interactive prompt, announce total up front ([#540](https://github.com/go-to-k/cdk-real-drift/issues/540)) ([d12ba22](https://github.com/go-to-k/cdk-real-drift/commit/d12ba222ec3ea286c26f3f90c82f7b1fcfe8fd81))
* **check:** type-to-filter the per-finding action picker (R132) ([#109](https://github.com/go-to-k/cdk-real-drift/issues/109)) ([eef5c33](https://github.com/go-to-k/cdk-real-drift/commit/eef5c3319a81fb6dd2e55d154db0ef92c3c385d8))
* **cli:** implement the documented --all flag (target every stack) ([#233](https://github.com/go-to-k/cdk-real-drift/issues/233)) ([c35d4da](https://github.com/go-to-k/cdk-real-drift/commit/c35d4da1d3e60b4a521d8ae16f313f2a50ba8023))
* **corpus:** persist clusterEchoModel + bucketNotificationManaged so cluster-child cases replay ([#582](https://github.com/go-to-k/cdk-real-drift/issues/582)) ([47d606a](https://github.com/go-to-k/cdk-real-drift/commit/47d606ac028568e7f883ee1346728e0bb0ef3d3c))
* **desired:** recover GetTemplate ?-masked non-ASCII literals from local synth ([#384](https://github.com/go-to-k/cdk-real-drift/issues/384)) ([1ff6e79](https://github.com/go-to-k/cdk-real-drift/commit/1ff6e790ada59f317bfa63637ec04e95949b2bb6))
* detect nested undeclared inside identity-keyed array elements (R98) ([#69](https://github.com/go-to-k/cdk-real-drift/issues/69)) ([330677f](https://github.com/go-to-k/cdk-real-drift/commit/330677fb1cf603d8ee859fa11809ff0f8ee7ca72))
* detect nested undeclared properties (R96) ([#67](https://github.com/go-to-k/cdk-real-drift/issues/67)) ([53bfa43](https://github.com/go-to-k/cdk-real-drift/commit/53bfa4324e5387982dec107ea214a18f458e5b49))
* **detect:** added tier — out-of-band resources not in the template (API Gateway children) ([#139](https://github.com/go-to-k/cdk-real-drift/issues/139)) ([165f623](https://github.com/go-to-k/cdk-real-drift/commit/165f6239b86af1f1046aadfbbd5db8accb9468cd))
* **diff,report:** fold AWS/CDK auto-generated values as the `generated` tier (R104) ([#75](https://github.com/go-to-k/cdk-real-drift/issues/75)) ([28e4b42](https://github.com/go-to-k/cdk-real-drift/commit/28e4b42b2a1388e20fc21d30282ebf29ac1117ac))
* **diff:** descend undeclared Athena WorkGroupConfiguration leaf-by-leaf ([#565](https://github.com/go-to-k/cdk-real-drift/issues/565)) ([#567](https://github.com/go-to-k/cdk-real-drift/issues/567)) ([1c1f3c1](https://github.com/go-to-k/cdk-real-drift/commit/1c1f3c19db6282daa0a911fd13aaeb51df6bca42))
* **diff:** detect out-of-band changes in non-standard-keyed nested rule arrays (Backup, Route53Resolver) ([#411](https://github.com/go-to-k/cdk-real-drift/issues/411)) ([45ca1a7](https://github.com/go-to-k/cdk-real-drift/commit/45ca1a708940942b025d47f8efdaee4b98681235))
* **diff:** fold known-default sub-paths inside a fully-undeclared object (EKS) ([#555](https://github.com/go-to-k/cdk-real-drift/issues/555)) ([#560](https://github.com/go-to-k/cdk-real-drift/issues/560)) ([c1c1e22](https://github.com/go-to-k/cdk-real-drift/commit/c1c1e22561fec87a1df7fa67e279bc5d88dcc5b7))
* **diff:** generalize generated-name recognition beyond the per-type table (R107) ([#81](https://github.com/go-to-k/cdk-real-drift/issues/81)) ([2b72b05](https://github.com/go-to-k/cdk-real-drift/commit/2b72b0578d522518b36d19822c262c96bcbc78f9))
* **iam:** detach an unexpected ManagedPolicy attachment via --remove-unrecorded ([#289](https://github.com/go-to-k/cdk-real-drift/issues/289)) ([25226ad](https://github.com/go-to-k/cdk-real-drift/commit/25226ad20d3393b12dc4581f4ec75d4ec19360c1))
* **iam:** detect ManagedPolicy attachment detach (asymmetric subset) ([#278](https://github.com/go-to-k/cdk-real-drift/issues/278)) ([0c4f8c1](https://github.com/go-to-k/cdk-real-drift/commit/0c4f8c1c55cb94c5ed8d970b90922a8361900f08))
* **iam:** surface unexpected ManagedPolicy attachments as undeclared inventory ([#286](https://github.com/go-to-k/cdk-real-drift/issues/286)) ([1e9ec75](https://github.com/go-to-k/cdk-real-drift/commit/1e9ec75583be6ba796bb1c0db8ec47340dae33e3))
* **ignore:** accept an out-of-band added resource via .cdkrd/config.json ([#141](https://github.com/go-to-k/cdk-real-drift/issues/141)) ([fbee54a](https://github.com/go-to-k/cdk-real-drift/commit/fbee54a7d6156d30944d7f3400fea9bae87f3a69))
* **ignore:** add the ignore verb + config.json writer (R120) ([#94](https://github.com/go-to-k/cdk-real-drift/issues/94)) ([3b01ef7](https://github.com/go-to-k/cdk-real-drift/commit/3b01ef7ba6bad537e882cf60b919f19b6124bb0d))
* **interactive:** bulk-select keys in accept/revert multiselect — → all, ← none (R116) ([#90](https://github.com/go-to-k/cdk-real-drift/issues/90)) ([1da25ca](https://github.com/go-to-k/cdk-real-drift/commit/1da25ca6340326b24e7caa56d97835f7e42498f4))
* **nested:** detect+revert Secret ReplicaRegions KmsKeyId + ApiGW Stage MethodSettings ([#424](https://github.com/go-to-k/cdk-real-drift/issues/424)) ([e454a8d](https://github.com/go-to-k/cdk-real-drift/commit/e454a8db4c83f59d914333eb918d0408d2b7b113))
* **noise:** extend ELB_ATTRIBUTE_DEFAULTS with ALB idle_timeout + NLB keys ([#343](https://github.com/go-to-k/cdk-real-drift/issues/343)) ([7408f4f](https://github.com/go-to-k/cdk-real-drift/commit/7408f4f32db27caa5b02859b858f3a5a4825220e))
* **noise:** fold ~25 constant service defaults across common types (first-run-noise sweep) ([#356](https://github.com/go-to-k/cdk-real-drift/issues/356)) ([be29a9b](https://github.com/go-to-k/cdk-real-drift/commit/be29a9b13d9fa6a3f040aeb2e734c0f96bcf035d))
* **noise:** fold 3 constant EC2 Instance defaults to atDefault (data-driven from the noise sweep) ([#311](https://github.com/go-to-k/cdk-real-drift/issues/311)) ([2103b37](https://github.com/go-to-k/cdk-real-drift/commit/2103b37d844a0be09f36feb7c23d49fa2cbc67fd))
* **noise:** fold AmazonMQ Broker service defaults into KNOWN_DEFAULTS ([#361](https://github.com/go-to-k/cdk-real-drift/issues/361)) ([3a7450a](https://github.com/go-to-k/cdk-real-drift/commit/3a7450ab2d1e37d33e642f41cf495707e7f40099))
* **noise:** fold at-default ELB attribute-bag keys to atDefault (first-run noise) ([#339](https://github.com/go-to-k/cdk-real-drift/issues/339)) ([7645762](https://github.com/go-to-k/cdk-real-drift/commit/76457623707c555a79d2db65634c43b33eff0546))
* **noise:** fold AWS-assigned maintenance/backup/snapshot windows on RDS-family + cache engines ([#584](https://github.com/go-to-k/cdk-real-drift/issues/584)) ([96c0f8c](https://github.com/go-to-k/cdk-real-drift/commit/96c0f8c708c749058a23ef991fc1036c9a9b2b2a))
* **noise:** fold constant service defaults for 17 common types (first-run-noise sweep) ([#351](https://github.com/go-to-k/cdk-real-drift/issues/351)) ([7de65a6](https://github.com/go-to-k/cdk-real-drift/commit/7de65a6bf040ec4ed9a6508bfe2caad9e9f729f2))
* **noise:** fold ECS container Cpu=0 default to atDefault ([#321](https://github.com/go-to-k/cdk-real-drift/issues/321)) ([3278041](https://github.com/go-to-k/cdk-real-drift/commit/3278041524a7b02499c3ca35fe653e57b3f86d69))
* **noise:** fold every AWS-initial value on a fresh Redshift/OpenSearch deploy (zero potential drift) ([#587](https://github.com/go-to-k/cdk-real-drift/issues/587)) ([2123723](https://github.com/go-to-k/cdk-real-drift/commit/212372304d6af97fece1fe9b27fc98dc635eeec1))
* **noise:** fold managed param-group names + Redshift/OpenSearch AWS-assigned defaults ([#585](https://github.com/go-to-k/cdk-real-drift/issues/585)) ([787a606](https://github.com/go-to-k/cdk-real-drift/commit/787a6067a91048d1fbccd590cb99be743f3798ad))
* **noise:** fold VPC/MemoryDB/Config first-run defaults + 4 common-type fixtures ([#386](https://github.com/go-to-k/cdk-real-drift/issues/386)) ([8143960](https://github.com/go-to-k/cdk-real-drift/commit/81439602d4e09287dce8fba9cfbafcfef1f5eb87))
* **noise:** promote 16 constant AWS defaults to KNOWN_DEFAULTS (data-driven from the noise sweep) ([#305](https://github.com/go-to-k/cdk-real-drift/issues/305)) ([332ed87](https://github.com/go-to-k/cdk-real-drift/commit/332ed87545c92472e47361527990b8d9b9a86649))
* **noise:** record schema-default coverage + first-run-noise sweep for KNOWN_DEFAULTS ([#302](https://github.com/go-to-k/cdk-real-drift/issues/302)) ([bb6a8f0](https://github.com/go-to-k/cdk-real-drift/commit/bb6a8f031d72cb736b755a3011e53c73bca39462))
* **noise:** schema-driven fold for insertionOrder:false scalar sets ([#367](https://github.com/go-to-k/cdk-real-drift/issues/367)) ([995cdfc](https://github.com/go-to-k/cdk-real-drift/commit/995cdfc32f1df1959975066dc614887cccd20b0e))
* **read,revert:** close Glue Classifier read-gap (FN) + make it revertable ([#369](https://github.com/go-to-k/cdk-real-drift/issues/369)) ([34089e6](https://github.com/go-to-k/cdk-real-drift/commit/34089e6f1b16cbd7fbdbca914529ba02aeba5c1c))
* **read,revert:** close Glue Workflow read-gap (FN) + make it revertable ([#370](https://github.com/go-to-k/cdk-real-drift/issues/370)) ([fcedffb](https://github.com/go-to-k/cdk-real-drift/commit/fcedffbd7a285d6ae5b726737e95f12b13861445))
* **read:** add API Gateway REST authorizers to CHILD_ENUMERATORS ([#215](https://github.com/go-to-k/cdk-real-drift/issues/215)) ([d4980e0](https://github.com/go-to-k/cdk-real-drift/commit/d4980e09656b92d940532e14fa6c3cdb81bccbed))
* **read:** add API Gateway REST gateway responses to CHILD_ENUMERATORS ([#243](https://github.com/go-to-k/cdk-real-drift/issues/243)) ([024acc7](https://github.com/go-to-k/cdk-real-drift/commit/024acc784bd504eb2138e10eafc9f8899f5e8f1c))
* **read:** add API Gateway REST models + request validators to CHILD_ENUMERATORS ([#240](https://github.com/go-to-k/cdk-real-drift/issues/240)) ([52c27b5](https://github.com/go-to-k/cdk-real-drift/commit/52c27b5aba63d51fa8a6bc2a89587f3c9048bea2))
* **read:** add API Gateway V2 (HTTP/WebSocket) to CHILD_ENUMERATORS ([#152](https://github.com/go-to-k/cdk-real-drift/issues/152)) ([e31d9f6](https://github.com/go-to-k/cdk-real-drift/commit/e31d9f65b2131396259e8a490c317e3b7037f78f))
* **read:** add API Gateway V2 authorizers to CHILD_ENUMERATORS ([#217](https://github.com/go-to-k/cdk-real-drift/issues/217)) ([4867f1e](https://github.com/go-to-k/cdk-real-drift/commit/4867f1e3c8a692ea83b4801e9525487eb920bd7e))
* **read:** add API Gateway V2 stages to CHILD_ENUMERATORS ([#242](https://github.com/go-to-k/cdk-real-drift/issues/242)) ([e01927b](https://github.com/go-to-k/cdk-real-drift/commit/e01927b6831652cc574a9ee01b27ef30af154902))
* **read:** add AppConfig application environments to CHILD_ENUMERATORS ([#221](https://github.com/go-to-k/cdk-real-drift/issues/221)) ([b926427](https://github.com/go-to-k/cdk-real-drift/commit/b926427de72fd824267fc9df36a33d2294b81e2b))
* **read:** add AppConfig configuration profiles to CHILD_ENUMERATORS ([#229](https://github.com/go-to-k/cdk-real-drift/issues/229)) ([8f777ac](https://github.com/go-to-k/cdk-real-drift/commit/8f777acd48ad7dd52a90026934720d55fff26223))
* **read:** add AppSync data sources to CHILD_ENUMERATORS ([#172](https://github.com/go-to-k/cdk-real-drift/issues/172)) ([d68ecf1](https://github.com/go-to-k/cdk-real-drift/commit/d68ecf1e04ce7109580e2adcf5b615e1c6d89ad1))
* **read:** add AppSync functions to CHILD_ENUMERATORS ([#231](https://github.com/go-to-k/cdk-real-drift/issues/231)) ([49f914a](https://github.com/go-to-k/cdk-real-drift/commit/49f914a43eef81d44a730a87a1d1ab0f583492bf))
* **read:** add AppSync resolvers to CHILD_ENUMERATORS ([#190](https://github.com/go-to-k/cdk-real-drift/issues/190)) ([7d483d2](https://github.com/go-to-k/cdk-real-drift/commit/7d483d2d186679e64740059421f2564f4a761408))
* **read:** add CloudWatch Logs metric filters to CHILD_ENUMERATORS ([#177](https://github.com/go-to-k/cdk-real-drift/issues/177)) ([9edfc9b](https://github.com/go-to-k/cdk-real-drift/commit/9edfc9ba5c146ccb68e687f7ea9dac015bf0f180))
* **read:** add Cognito user pool clients to CHILD_ENUMERATORS ([#169](https://github.com/go-to-k/cdk-real-drift/issues/169)) ([9f1097c](https://github.com/go-to-k/cdk-real-drift/commit/9f1097cd8d40e41f71d1c89a7fdbd31b65b6c198))
* **read:** add Cognito user pool groups to CHILD_ENUMERATORS ([#183](https://github.com/go-to-k/cdk-real-drift/issues/183)) ([d5912a0](https://github.com/go-to-k/cdk-real-drift/commit/d5912a0be2a4cd41465b4dafcb244f168b041ea2))
* **read:** add Cognito user pool resource servers to CHILD_ENUMERATORS ([#198](https://github.com/go-to-k/cdk-real-drift/issues/198)) ([aef90f4](https://github.com/go-to-k/cdk-real-drift/commit/aef90f40ce8848b0ae0376430b5dad539f768ada))
* **read:** add EC2 route table routes to CHILD_ENUMERATORS ([#189](https://github.com/go-to-k/cdk-real-drift/issues/189)) ([d61e2c5](https://github.com/go-to-k/cdk-real-drift/commit/d61e2c5e4208444f8f5d5c4bbaa5d62839119e11))
* **read:** add EC2 VPC subnets to CHILD_ENUMERATORS ([#181](https://github.com/go-to-k/cdk-real-drift/issues/181)) ([3fbe14a](https://github.com/go-to-k/cdk-real-drift/commit/3fbe14aaa78dfdf3d6d56f4fcb78c5be2ab3975b))
* **read:** add ECS cluster services to CHILD_ENUMERATORS ([#195](https://github.com/go-to-k/cdk-real-drift/issues/195)) ([6d611c6](https://github.com/go-to-k/cdk-real-drift/commit/6d611c60ef459d6d0b151736948a596c106cb54c))
* **read:** add EFS file system mount targets to CHILD_ENUMERATORS ([#228](https://github.com/go-to-k/cdk-real-drift/issues/228)) ([9285105](https://github.com/go-to-k/cdk-real-drift/commit/928510531735a3ecf3c2374542164df31b971627))
* **read:** add ELBv2 listener rules to CHILD_ENUMERATORS ([#227](https://github.com/go-to-k/cdk-real-drift/issues/227)) ([30204d0](https://github.com/go-to-k/cdk-real-drift/commit/30204d05cd6cf5d2d0e299c56850904e78d3e29a))
* **read:** add ELBv2 listeners to CHILD_ENUMERATORS ([#179](https://github.com/go-to-k/cdk-real-drift/issues/179)) ([56bb657](https://github.com/go-to-k/cdk-real-drift/commit/56bb657e3099f5dd1894891734bfab23289d06b3))
* **read:** add EventBridge bus rules to CHILD_ENUMERATORS ([#166](https://github.com/go-to-k/cdk-real-drift/issues/166)) ([0d8f070](https://github.com/go-to-k/cdk-real-drift/commit/0d8f07092f9717fd04bc40fe7c66ac440cd4d545))
* **read:** add KMS key aliases to CHILD_ENUMERATORS ([#194](https://github.com/go-to-k/cdk-real-drift/issues/194)) ([890993b](https://github.com/go-to-k/cdk-real-drift/commit/890993bc50db1376aa9bc44fea9fe601047f330c))
* **read:** add Lambda aliases to CHILD_ENUMERATORS ([#224](https://github.com/go-to-k/cdk-real-drift/issues/224)) ([d21cc8e](https://github.com/go-to-k/cdk-real-drift/commit/d21cc8e3db265125db26c3044ccffa26c1b79a78))
* **read:** add Lambda event source mappings to CHILD_ENUMERATORS ([#161](https://github.com/go-to-k/cdk-real-drift/issues/161)) ([d6b31fd](https://github.com/go-to-k/cdk-real-drift/commit/d6b31fd8160ac6672ccc88aa313b9375f50575b4))
* **read:** add Lambda function URLs to CHILD_ENUMERATORS ([#199](https://github.com/go-to-k/cdk-real-drift/issues/199)) ([b11f7fd](https://github.com/go-to-k/cdk-real-drift/commit/b11f7fd177b41f9a618ef6967c05d3d70e97ffb8))
* **read:** add Lambda versions to CHILD_ENUMERATORS ([#241](https://github.com/go-to-k/cdk-real-drift/issues/241)) ([be1f59b](https://github.com/go-to-k/cdk-real-drift/commit/be1f59ba62e5039265eadcac3cd9f49ca274e3ac))
* **read:** add RDS DB cluster instances to CHILD_ENUMERATORS ([#239](https://github.com/go-to-k/cdk-real-drift/issues/239)) ([19b0a22](https://github.com/go-to-k/cdk-real-drift/commit/19b0a2240385f3eb0c90c385d721b71590752f23))
* **read:** add SDK_OVERRIDES reader for AWS::CodeBuild::ReportGroup ([#530](https://github.com/go-to-k/cdk-real-drift/issues/530)) ([#545](https://github.com/go-to-k/cdk-real-drift/issues/545)) ([5ec5bf3](https://github.com/go-to-k/cdk-real-drift/commit/5ec5bf3d9be5ca4508a05fa17639c22eeb398abf))
* **read:** add SDK_OVERRIDES readers for EC2 ClientVPN + DAX families ([#534](https://github.com/go-to-k/cdk-real-drift/issues/534)) ([#546](https://github.com/go-to-k/cdk-real-drift/issues/546)) ([490e777](https://github.com/go-to-k/cdk-real-drift/commit/490e7777d5328063b420747b81e780a62a3051c3))
* **read:** add SNS topic subscriptions to CHILD_ENUMERATORS ([#158](https://github.com/go-to-k/cdk-real-drift/issues/158)) ([3dad9cf](https://github.com/go-to-k/cdk-real-drift/commit/3dad9cf249941db989f5f47f8344c97cbf6548fb))
* **read:** CC identifier adapters for ApiGateway v1 + Cognito composite types (R129) ([#104](https://github.com/go-to-k/cdk-real-drift/issues/104)) ([4f94de0](https://github.com/go-to-k/cdk-real-drift/commit/4f94de06cee96d8ac651176da21ec0c79038348f))
* **read:** close Glue Connection read-gap (FN) — security-relevant ETL config ([#374](https://github.com/go-to-k/cdk-real-drift/issues/374)) ([0f201c7](https://github.com/go-to-k/cdk-real-drift/commit/0f201c70c049b35ea1ac23d86374c9134c528484))
* **read:** detect & revert ECS Service VolumeConfigurations writeOnly drift ([#412](https://github.com/go-to-k/cdk-real-drift/issues/412)) ([90859a0](https://github.com/go-to-k/cdk-real-drift/commit/90859a09c7c40cbedbdc5c442dda3f54533e3679))
* **read:** detect ECS Service ServiceConnectConfiguration writeOnly drift ([#406](https://github.com/go-to-k/cdk-real-drift/issues/406)) ([fff0e23](https://github.com/go-to-k/cdk-real-drift/commit/fff0e2332c2d53b3b958a208e0414bf144bf5c4a))
* **read:** detect out-of-band CloudWatch Logs subscription filters (added tier) ([#238](https://github.com/go-to-k/cdk-real-drift/issues/238)) ([8554e85](https://github.com/go-to-k/cdk-real-drift/commit/8554e856c3851ad9a263d840a0746b4944b93297))
* **read:** detect out-of-band ServerProperties revisions on AWS::MSK::Configuration (SDK_SUPPLEMENTS) ([#508](https://github.com/go-to-k/cdk-real-drift/issues/508)) ([#520](https://github.com/go-to-k/cdk-real-drift/issues/520)) ([d7b2bb6](https://github.com/go-to-k/cdk-real-drift/commit/d7b2bb66fdd4d6543d58b45c6672ef9af3cd307d))
* **read:** detect SSM::Parameter Tier writeOnly drift (Standard/Advanced) ([#408](https://github.com/go-to-k/cdk-real-drift/issues/408)) ([f4382d9](https://github.com/go-to-k/cdk-real-drift/commit/f4382d971a6589c7d027345545e7999871022c1a))
* **read:** detect writeOnly read-gap drift (SSM Parameter Description + ElastiCache RG maintenance/topic/version) ([#400](https://github.com/go-to-k/cdk-real-drift/issues/400)) ([eec6a05](https://github.com/go-to-k/cdk-real-drift/commit/eec6a05b1003b5933a4c95ad8dfc124bd3c180e3))
* **read:** project CodeBuild ResourceAccessRole + FileSystemLocations ([#237](https://github.com/go-to-k/cdk-real-drift/issues/237)) ([39c314d](https://github.com/go-to-k/cdk-real-drift/commit/39c314de346df586da7f9910343767643a6a7b37))
* **read:** read EC2 LaunchTemplate data via SDK override (was a readGap) ([#326](https://github.com/go-to-k/cdk-real-drift/issues/326)) ([b1f8bd0](https://github.com/go-to-k/cdk-real-drift/commit/b1f8bd0d733e1eb816e1c216441b82b011249c80))
* **read:** reconstruct AWS::Lex::Bot BotLocales via lexv2-models tree walk ([#527](https://github.com/go-to-k/cdk-real-drift/issues/527)) ([#547](https://github.com/go-to-k/cdk-real-drift/issues/547)) ([b367fe2](https://github.com/go-to-k/cdk-real-drift/commit/b367fe24e1c7a9af10c35f3c741841900af26760))
* **read:** record a content hash of an ELBv2 TrustStore CA bundle for out-of-band swap detection ([#505](https://github.com/go-to-k/cdk-real-drift/issues/505)) ([#522](https://github.com/go-to-k/cdk-real-drift/issues/522)) ([3d892ea](https://github.com/go-to-k/cdk-real-drift/commit/3d892ea59ba8aa819bb9626dddadd7e92ee12188))
* **read:** SDK_OVERRIDES for Amazon DocumentDB DBCluster + DBInstance ([#262](https://github.com/go-to-k/cdk-real-drift/issues/262)) ([22625c5](https://github.com/go-to-k/cdk-real-drift/commit/22625c51152b83693377c1d9f8f2b7d606657200))
* **read:** SDK_OVERRIDES for AppSync ApiKey (ListApiKeys) + epoch-hour Expires equivalence ([#274](https://github.com/go-to-k/cdk-real-drift/issues/274)) ([ed937be](https://github.com/go-to-k/cdk-real-drift/commit/ed937be6384752c4f326c6c686d1fd60044511fb))
* **read:** SDK_OVERRIDES for ServiceDiscovery (Cloud Map) HttpNamespace + Service ([#261](https://github.com/go-to-k/cdk-real-drift/issues/261)) ([86b9831](https://github.com/go-to-k/cdk-real-drift/commit/86b98313f1f43012c86dec6bf7fd3431b6ad9240))
* **read:** SDK_OVERRIDES reader + PutAnomalyDetector writer for AWS::CloudWatch::AnomalyDetector ([#469](https://github.com/go-to-k/cdk-real-drift/issues/469)) ([2e46c11](https://github.com/go-to-k/cdk-real-drift/commit/2e46c1132aba6b749fd84f7b8ac4e3dae5968f49))
* **read:** SDK_OVERRIDES reader + UpdateLifecyclePolicy writer for AWS::DLM::LifecyclePolicy ([#475](https://github.com/go-to-k/cdk-real-drift/issues/475)) ([d0f9e1d](https://github.com/go-to-k/cdk-real-drift/commit/d0f9e1d25580d16fc76899ba7f2ac273451219f1))
* **read:** SDK_OVERRIDES reader for AWS::EC2::NetworkAclEntry (close CC read-gap) ([#431](https://github.com/go-to-k/cdk-real-drift/issues/431)) ([2254675](https://github.com/go-to-k/cdk-real-drift/commit/22546751e4ac73e67efb1bec1feb47b60e420e33))
* **read:** SDK_OVERRIDES readers for DMS Endpoint/ReplicationSubnetGroup + MediaConvert Queue/JobTemplate ([#500](https://github.com/go-to-k/cdk-real-drift/issues/500)) ([730f210](https://github.com/go-to-k/cdk-real-drift/commit/730f21097d5b57f093d39143a91fdcddb3a3df95))
* **read:** SDK_OVERRIDES readers for the SES inbound receipt-rule family ([#439](https://github.com/go-to-k/cdk-real-drift/issues/439)) ([#445](https://github.com/go-to-k/cdk-real-drift/issues/445)) ([3f48b3b](https://github.com/go-to-k/cdk-real-drift/commit/3f48b3b50f27b9f7e06d9e42e8edbb5b246a0744))
* **record,ignore,revert:** share the check gather-phase spinner across all four verbs ([#478](https://github.com/go-to-k/cdk-real-drift/issues/478)) ([14307bf](https://github.com/go-to-k/cdk-real-drift/commit/14307bf4dff990da2100bc0ab316669e8c442db6))
* **record:** fold nested sub-keys in the record picker, mirroring the report ([#306](https://github.com/go-to-k/cdk-real-drift/issues/306)) ([3fe2832](https://github.com/go-to-k/cdk-real-drift/commit/3fe28324428cb2ef5e819c9f337d1a4a51fd88c6))
* **region:** fall back to the AWS profile's configured region for env-agnostic stacks ([#436](https://github.com/go-to-k/cdk-real-drift/issues/436)) ([9450105](https://github.com/go-to-k/cdk-real-drift/commit/9450105dec989eb6da4811ee11d188a1eb28325b))
* **report,read:** day-1 baseline init message + CacheNamespace id-echo + no-baseline hint ([#196](https://github.com/go-to-k/cdk-real-drift/issues/196)) ([6dfa0bd](https://github.com/go-to-k/cdk-real-drift/commit/6dfa0bd573b8944ab8311000f6af578e5f897e1f))
* **report:** annotate Application Signals / Lambda Insights footprint with an origin hint ([#532](https://github.com/go-to-k/cdk-real-drift/issues/532)) ([29a2a0c](https://github.com/go-to-k/cdk-real-drift/commit/29a2a0cd3785a03d04145a67c7e6d3f0cd5126bf))
* **report:** combined findings verdict + plainer generated/readGap labels (R114) ([#88](https://github.com/go-to-k/cdk-real-drift/issues/88)) ([b3c12e7](https://github.com/go-to-k/cdk-real-drift/commit/b3c12e7700419462de29edc96644b98fa802a411))
* **report:** distinct first-run "to record" state, not a misleading CLEAN ([#163](https://github.com/go-to-k/cdk-real-drift/issues/163)) ([6a17f31](https://github.com/go-to-k/cdk-real-drift/commit/6a17f31a3f81fc77b67b6f5aea801c1036725979))
* **report:** drop the redundant cdkrd from the section banners ([#576](https://github.com/go-to-k/cdk-real-drift/issues/576)) ([c5a9afd](https://github.com/go-to-k/cdk-real-drift/commit/c5a9afdb67733690b0e66adaed48996362b8c80e))
* **report:** fold coverage warning into info: footer so the drift result is line 1 (R127) ([#134](https://github.com/go-to-k/cdk-real-drift/issues/134)) ([e4bf086](https://github.com/go-to-k/cdk-real-drift/commit/e4bf0869a151c1cdbb699dcda085eee3c5da8e0b))
* **report:** legible drift report — multi-line array delta, distinct tier names, esc hints (R130) ([#106](https://github.com/go-to-k/cdk-real-drift/issues/106)) ([957f196](https://github.com/go-to-k/cdk-real-drift/commit/957f196991976f07c5c21a5faf555b040b1c313c))
* **report:** never print "0 shown" + drop the first-run [To Record] header ([#168](https://github.com/go-to-k/cdk-real-drift/issues/168)) ([a810455](https://github.com/go-to-k/cdk-real-drift/commit/a810455316ef070d8dee1200e834bdc389e08f7e))
* **report:** note potential-drift false positives + link the issue tracker ([#581](https://github.com/go-to-k/cdk-real-drift/issues/581)) ([c53e9b9](https://github.com/go-to-k/cdk-real-drift/commit/c53e9b9ec8017a7e3a1975a0e79b224d43992724))
* **report:** reframe first-run undeclared inventory as "Potential Drift" ([#378](https://github.com/go-to-k/cdk-real-drift/issues/378)) ([c8cee8c](https://github.com/go-to-k/cdk-real-drift/commit/c8cee8c433edb8af993f3aecd7d500f09705d65e))
* **report:** rename added tier to "Added Resource" and sort it after the property tiers ([#144](https://github.com/go-to-k/cdk-real-drift/issues/144)) ([31427f4](https://github.com/go-to-k/cdk-real-drift/commit/31427f4b9c9d939e82b4fab9810288d6aabc4ce4))
* **report:** show construct path within the stack + keep ignore rules consistent ([#573](https://github.com/go-to-k/cdk-real-drift/issues/573)) ([a43447a](https://github.com/go-to-k/cdk-real-drift/commit/a43447ad40c06a48e3b25d6237e0885f451ad3c0))
* **report:** strip the stack prefix in the last 3 construct-path displays ([#578](https://github.com/go-to-k/cdk-real-drift/issues/578)) ([ca26d92](https://github.com/go-to-k/cdk-real-drift/commit/ca26d92fa0c9b01df5f607bb311f8dc803184b23))
* **resolve:** resolve Fn::Base64 so EC2 UserData drift is detected ([#456](https://github.com/go-to-k/cdk-real-drift/issues/456)) ([9a9726c](https://github.com/go-to-k/cdk-real-drift/commit/9a9726cc1b726312e90b4e7b05862fdf4bb837f9))
* **revert:** --wait to converge through a transient mid-update window in one command, + per-retry progress ([#479](https://github.com/go-to-k/cdk-real-drift/issues/479)) ([4f6f26d](https://github.com/go-to-k/cdk-real-drift/commit/4f6f26d7f9df3eda72f4a1af7641eec38dc815c6))
* **revert:** add DocDB DBInstance SDK writer (close revert no-op gap) ([#359](https://github.com/go-to-k/cdk-real-drift/issues/359)) ([2e491d5](https://github.com/go-to-k/cdk-real-drift/commit/2e491d546a865b6e46b9acefc2646e7522e550cf))
* **revert:** classify stateful-DB mid-modify 'not in available state' faults as transient ([#484](https://github.com/go-to-k/cdk-real-drift/issues/484)) ([1f252d8](https://github.com/go-to-k/cdk-real-drift/commit/1f252d8dad4dac9712c8ec797f9ee493a3ef665d))
* **revert:** close 3 revert no-op gaps (Glue Table, Logs MetricFilter, Route53 RecordSet) ([#357](https://github.com/go-to-k/cdk-real-drift/issues/357)) ([9ae964a](https://github.com/go-to-k/cdk-real-drift/commit/9ae964acc454af15a37a85870b827862a84a4d7d))
* **revert:** credential-safe SDK writer for AWS::Glue::Connection ([#451](https://github.com/go-to-k/cdk-real-drift/issues/451)) ([cee33a7](https://github.com/go-to-k/cdk-real-drift/commit/cee33a7e8caa2b814de6e3a875fc0079f15f8dd7))
* **revert:** delete an out-of-band added resource via Cloud Control DeleteResource ([#142](https://github.com/go-to-k/cdk-real-drift/issues/142)) ([238d677](https://github.com/go-to-k/cdk-real-drift/commit/238d677f088b9e5e598b27d03ade3cabcc8bd6ff))
* **revert:** Lex Bot BotLocales STRUCTURAL revert (create/delete whole intents/slots/slot types) ([#564](https://github.com/go-to-k/cdk-real-drift/issues/564)) ([#570](https://github.com/go-to-k/cdk-real-drift/issues/570)) ([cc152bb](https://github.com/go-to-k/cdk-real-drift/commit/cc152bba98186c5e60ed306855917a4b30176e1a))
* **revert:** Lex Bot BotLocales update-only revert via lexv2-models write APIs ([#553](https://github.com/go-to-k/cdk-real-drift/issues/553)) ([#562](https://github.com/go-to-k/cdk-real-drift/issues/562)) ([8b7b0b5](https://github.com/go-to-k/cdk-real-drift/commit/8b7b0b581f1927c3d25750de982c4aa237235c53))
* **revert:** list standout undeclared values as opt-in REMOVE in an interactive revert (R113) ([#87](https://github.com/go-to-k/cdk-real-drift/issues/87)) ([f2c605f](https://github.com/go-to-k/cdk-real-drift/commit/f2c605f061a7f97dceef46837b3318375959c846))
* **revert:** revert array-element nested rule values via Cloud Control index-revert (Backup, Route53Resolver) ([#415](https://github.com/go-to-k/cdk-real-drift/issues/415)) ([50d9e47](https://github.com/go-to-k/cdk-real-drift/commit/50d9e47b8e1482483c204aad73d8944bf7208cb8))
* **revert:** revert declared drift inside JSON-string properties (ConfigRule InputParameters) ([#389](https://github.com/go-to-k/cdk-real-drift/issues/389)) ([443d7ad](https://github.com/go-to-k/cdk-real-drift/commit/443d7adf8e7676c9e76ca14fea2c06810fed8511))
* **revert:** revert ECS ServiceConnectConfiguration drift via UpdateService ([#410](https://github.com/go-to-k/cdk-real-drift/issues/410)) ([de1637b](https://github.com/go-to-k/cdk-real-drift/commit/de1637bdfdfc94848a81647b78611f2f7c7a076d))
* **revert:** SDK writer for AWS::SES::ReceiptRule (ses:UpdateReceiptRule) ([#450](https://github.com/go-to-k/cdk-real-drift/issues/450)) ([d6a8b1b](https://github.com/go-to-k/cdk-real-drift/commit/d6a8b1b7715d167e7a12f96b5f0df5061b222624))
* **revert:** SDK writers for CodeBuild ReportGroup / DAX / ClientVPN ([#552](https://github.com/go-to-k/cdk-real-drift/issues/552)) ([#558](https://github.com/go-to-k/cdk-real-drift/issues/558)) ([36dad5a](https://github.com/go-to-k/cdk-real-drift/commit/36dad5aba21b07b3b74b6103d7208e1758968bb5))
* **revert:** show construct path within the stack in revert/surviving/picker displays ([#574](https://github.com/go-to-k/cdk-real-drift/issues/574)) ([7c2131c](https://github.com/go-to-k/cdk-real-drift/commit/7c2131c6cc0eb62f42b023a318dc104a968be261))
* **schema,check:** fold nested schema defaults as atDefault, not undeclared (R103) ([#74](https://github.com/go-to-k/cdk-real-drift/issues/74)) ([e08568d](https://github.com/go-to-k/cdk-real-drift/commit/e08568d1475148cfc64f3a36b067d7b54a89a162))
* **schema:** extend the insertionOrder:false schema fold to OBJECT-item arrays ([#463](https://github.com/go-to-k/cdk-real-drift/issues/463)) ([5284f1f](https://github.com/go-to-k/cdk-real-drift/commit/5284f1fb77e2d3a1664f7f42e62e0f7f65f1393c))
