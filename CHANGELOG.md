## [0.12.31](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.30...v0.12.31) (2026-07-10)


### Bug Fixes

* **diff:** dot-key empty {} double-report + GA HealthCheckPort string FromPort ([#1275](https://github.com/go-to-k/cdk-real-drift/issues/1275), [#1268](https://github.com/go-to-k/cdk-real-drift/issues/1268)) ([#1379](https://github.com/go-to-k/cdk-real-drift/issues/1379)) ([7546a9a](https://github.com/go-to-k/cdk-real-drift/commit/7546a9ae15977d5405ac7ac1394cf980a6502239))
* **read:** Lambda child matchers accept the partial-ARN FunctionName form ([#1281](https://github.com/go-to-k/cdk-real-drift/issues/1281)) ([#1380](https://github.com/go-to-k/cdk-real-drift/issues/1380)) ([fc38d4f](https://github.com/go-to-k/cdk-real-drift/commit/fc38d4f8195119a85f4c3b67d6aaa706e82f56c3))

## [0.12.30](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.29...v0.12.30) (2026-07-10)


### Bug Fixes

* **desired:** --pre-deploy unpreviewable-param warning also scans Conditions ([#1296](https://github.com/go-to-k/cdk-real-drift/issues/1296)) ([#1376](https://github.com/go-to-k/cdk-real-drift/issues/1376)) ([7bd9552](https://github.com/go-to-k/cdk-real-drift/commit/7bd9552fce8369c90fab378766a24b271a14e7bb))
* **read:** project Tags in DLM/ServiceDiscovery/ElastiCache-PG/DAX/Glue-Workflow/MediaConvert readers ([#1362](https://github.com/go-to-k/cdk-real-drift/issues/1362)) ([#1378](https://github.com/go-to-k/cdk-real-drift/issues/1378)) ([600c94b](https://github.com/go-to-k/cdk-real-drift/commit/600c94b3db5c3c485f89ae886b229fd2c80db706))
* **synth:** fail loudly when an --app command exits 0 without writing a fresh cloud assembly ([#1323](https://github.com/go-to-k/cdk-real-drift/issues/1323)) ([#1377](https://github.com/go-to-k/cdk-real-drift/issues/1377)) ([883476e](https://github.com/go-to-k/cdk-real-drift/commit/883476e01de2083e754fe417385b24251ebf9a3c))

## [0.12.29](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.28...v0.12.29) (2026-07-10)


### Bug Fixes

* **record:** ignored declared/added findings no longer demote snapshot completeness — gate the [#1078](https://github.com/go-to-k/cdk-real-drift/issues/1078) guard on ignoredFrom ([#1277](https://github.com/go-to-k/cdk-real-drift/issues/1277)) ([#1375](https://github.com/go-to-k/cdk-real-drift/issues/1375)) ([387c265](https://github.com/go-to-k/cdk-real-drift/commit/387c2652e2d9c8afe955d02d4ef6d6bbf4e8ce3c))

## [0.12.28](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.27...v0.12.28) (2026-07-10)


### Bug Fixes

* **ignore:** ignore verb passes constructPathByLogical so removed-since-record findings match constructPath-form rules ([#1285](https://github.com/go-to-k/cdk-real-drift/issues/1285)) ([#1373](https://github.com/go-to-k/cdk-real-drift/issues/1373)) ([73083bb](https://github.com/go-to-k/cdk-real-drift/commit/73083bbe6eb64f645bc1d011e22eecfb4783b7ee))
* **normalize:** add missing registry tag property names to TAG_PROPERTY_NAMES + map-shaped names to FREE_FORM_MAP_PARENTS ([#1300](https://github.com/go-to-k/cdk-real-drift/issues/1300)) ([#1374](https://github.com/go-to-k/cdk-real-drift/issues/1374)) ([49f7dd3](https://github.com/go-to-k/cdk-real-drift/commit/49f7dd3f33862a121033726a064528e2eab4e487))

## [0.12.27](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.26...v0.12.27) (2026-07-10)


### Bug Fixes

* **read:** gateway VPC endpoint prefix-list routes no longer false-added ([#1276](https://github.com/go-to-k/cdk-real-drift/issues/1276)) ([#1359](https://github.com/go-to-k/cdk-real-drift/issues/1359)) ([cf5423d](https://github.com/go-to-k/cdk-real-drift/commit/cf5423dabd34bae56683b08fa176e17ec934ba0a))

## [0.12.26](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.25...v0.12.26) (2026-07-10)


### Bug Fixes

* **read:** credential resolution honors [#1066](https://github.com/go-to-k/cdk-real-drift/issues/1066) request timeouts ([#1319](https://github.com/go-to-k/cdk-real-drift/issues/1319)) ([#1363](https://github.com/go-to-k/cdk-real-drift/issues/1363)) ([86e5682](https://github.com/go-to-k/cdk-real-drift/commit/86e568219338ee680671e3109022e708cd367e3e))

## [0.12.25](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.24...v0.12.25) (2026-07-10)


### Bug Fixes

* **diff:** fold EventBusPolicy Statement Sid == declared StatementId ([#1314](https://github.com/go-to-k/cdk-real-drift/issues/1314)) ([#1364](https://github.com/go-to-k/cdk-real-drift/issues/1364)) ([ab2116f](https://github.com/go-to-k/cdk-real-drift/commit/ab2116f8614ced1fc60b2ab14f8fe63debf22d14))

## [0.12.24](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.23...v0.12.24) (2026-07-10)


### Bug Fixes

* **noise:** fold S3 AccelerateConfiguration Suspended off-state ([#1288](https://github.com/go-to-k/cdk-real-drift/issues/1288)) ([#1358](https://github.com/go-to-k/cdk-real-drift/issues/1358)) ([f95dbb3](https://github.com/go-to-k/cdk-real-drift/commit/f95dbb370c8a9b27b6c1c157fa1116f8a51560a2))

## [0.12.23](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.22...v0.12.23) (2026-07-10)


### Bug Fixes

* **commands:** add the account axis to named/glob stack dedup + pre-deploy synth key ([#1320](https://github.com/go-to-k/cdk-real-drift/issues/1320)) ([#1372](https://github.com/go-to-k/cdk-real-drift/issues/1372)) ([a85c7b4](https://github.com/go-to-k/cdk-real-drift/commit/a85c7b4142a73c2cceb772593c2ca0a708bd6478))
* **read:** DMS/SageMaker-EndpointConfig/DocDB readers project Tags ([#1287](https://github.com/go-to-k/cdk-real-drift/issues/1287)) ([#1371](https://github.com/go-to-k/cdk-real-drift/issues/1371)) ([80a26a6](https://github.com/go-to-k/cdk-real-drift/commit/80a26a618923006ff976522cb2db3d11596bb3b9))
* **report:** escape bidi/zero-width Unicode in live drift VALUES, not just keys ([#1307](https://github.com/go-to-k/cdk-real-drift/issues/1307)) ([#1370](https://github.com/go-to-k/cdk-real-drift/issues/1370)) ([ba6a6e1](https://github.com/go-to-k/cdk-real-drift/commit/ba6a6e1a712f95757bd0f17c6bae0d30322fcac1))

## [0.12.22](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.21...v0.12.22) (2026-07-10)


### Bug Fixes

* **config:** addIgnoreRules dedupes against the same snapshot it writes from ([#1290](https://github.com/go-to-k/cdk-real-drift/issues/1290)) ([#1368](https://github.com/go-to-k/cdk-real-drift/issues/1368)) ([4eab792](https://github.com/go-to-k/cdk-real-drift/commit/4eab792d40484601b6055424c69f98bac3c950d2))

## [0.12.21](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.20...v0.12.21) (2026-07-10)


### Bug Fixes

* **baseline:** fold an adopted out-of-band added resource instead of phantom-deleting it ([#1365](https://github.com/go-to-k/cdk-real-drift/issues/1365)) ([87ab27d](https://github.com/go-to-k/cdk-real-drift/commit/87ab27da94d03e662a0432447033c7a39d068f6f))
* **report:** prefix-aware redaction masks secret VALUES in container-level findings ([#1297](https://github.com/go-to-k/cdk-real-drift/issues/1297)) ([#1369](https://github.com/go-to-k/cdk-real-drift/issues/1369)) ([8977778](https://github.com/go-to-k/cdk-real-drift/commit/8977778ed4a394e2730e48d15576fa955cc76596))

## [0.12.20](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.19...v0.12.20) (2026-07-10)


### Bug Fixes

* **read:** detect out-of-band Glue job ETL script swaps via a recorded ScriptSha256 signal ([#1346](https://github.com/go-to-k/cdk-real-drift/issues/1346)) ([#1357](https://github.com/go-to-k/cdk-real-drift/issues/1357)) ([925cbc2](https://github.com/go-to-k/cdk-real-drift/commit/925cbc2a04af414215a15bee19142ad8d631c7a9))

## [0.12.19](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.18...v0.12.19) (2026-07-10)


### Bug Fixes

* **report:** sha256 distinguisher for masked values + redacted json marker ([#1308](https://github.com/go-to-k/cdk-real-drift/issues/1308)) ([#1351](https://github.com/go-to-k/cdk-real-drift/issues/1351)) ([b72b1f1](https://github.com/go-to-k/cdk-real-drift/commit/b72b1f1354fcc8084cf67e5a6beb67cd575d8c18))

## [0.12.18](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.17...v0.12.18) (2026-07-10)


### Bug Fixes

* **config:** decode UTF-16/BOM ignore.yaml ([#1291](https://github.com/go-to-k/cdk-real-drift/issues/1291)) ([#1352](https://github.com/go-to-k/cdk-real-drift/issues/1352)) ([d2d203f](https://github.com/go-to-k/cdk-real-drift/commit/d2d203fb2362ed8be8e42eb0b9b49c74640cc791))
* **schema:** pointerToDotted tolerates a no-leading-slash properties/ pointer ([#1311](https://github.com/go-to-k/cdk-real-drift/issues/1311)) ([#1353](https://github.com/go-to-k/cdk-real-drift/issues/1353)) ([65227cc](https://github.com/go-to-k/cdk-real-drift/commit/65227cc7672998fd8a0eb88dbdd42842426d5a46))

## [0.12.17](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.16...v0.12.17) (2026-07-10)


### Bug Fixes

* **read:** project MetricFilter FieldSelectionCriteria + EmitSystemFieldDimensions ([#1332](https://github.com/go-to-k/cdk-real-drift/issues/1332)) ([#1347](https://github.com/go-to-k/cdk-real-drift/issues/1347)) ([65de3a7](https://github.com/go-to-k/cdk-real-drift/commit/65de3a7434dc61b180bc24bf6c9aaf143c03caa9))

## [0.12.16](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.15...v0.12.16) (2026-07-10)


### Bug Fixes

* **revert:** refuse to write GetTemplate-masked declared values back to AWS ([#1354](https://github.com/go-to-k/cdk-real-drift/issues/1354)) ([134e96c](https://github.com/go-to-k/cdk-real-drift/commit/134e96ce49ab83778752b8048ae655e2abd77b6f))

## [0.12.15](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.14...v0.12.15) (2026-07-10)


### Bug Fixes

* **report:** break GetTemplate-masked readGaps out of "not returned by AWS" ([#1345](https://github.com/go-to-k/cdk-real-drift/issues/1345)) ([da66ce9](https://github.com/go-to-k/cdk-real-drift/commit/da66ce9edef50efd46b9e4428e97e9aef6061e19))

## [0.12.14](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.13...v0.12.14) (2026-07-10)


### Bug Fixes

* **noise:** subtract CFn stack-level tags propagated onto resources ([#683](https://github.com/go-to-k/cdk-real-drift/issues/683)) ([#1344](https://github.com/go-to-k/cdk-real-drift/issues/1344)) ([6fbf70c](https://github.com/go-to-k/cdk-real-drift/commit/6fbf70c36453d79c077b4a783c12f80432881972))

## [0.12.13](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.12...v0.12.13) (2026-07-10)


### Bug Fixes

* **diff:** funnel every declared-drift push through a central GetTemplate-mask guard ([#1341](https://github.com/go-to-k/cdk-real-drift/issues/1341)) ([3d31136](https://github.com/go-to-k/cdk-real-drift/commit/3d311365f11f3f1bc24eaf8a4a1fa21f18534d24))


### Reverts

* back out [#683](https://github.com/go-to-k/cdk-real-drift/issues/683) stack-tag subtraction (trips tsgolint budget → red main CI) ([#1339](https://github.com/go-to-k/cdk-real-drift/issues/1339)) ([ecdc872](https://github.com/go-to-k/cdk-real-drift/commit/ecdc872e87a75f0d19c20da5b1e3745b22884d11))

## [0.12.12](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.11...v0.12.12) (2026-07-10)


### Bug Fixes

* **noise:** subtract CFn stack-level tags propagated onto resources ([#683](https://github.com/go-to-k/cdk-real-drift/issues/683)) ([#1338](https://github.com/go-to-k/cdk-real-drift/issues/1338)) ([8138356](https://github.com/go-to-k/cdk-real-drift/commit/81383567446c535e56a8dade0aa2848c07ad6dd7))

## [0.12.11](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.10...v0.12.11) (2026-07-10)


### Bug Fixes

* **diff:** demote non-ASCII-masked JSON_STRING_PROPS values to readGap, not declared drift ([#1337](https://github.com/go-to-k/cdk-real-drift/issues/1337)) ([354b670](https://github.com/go-to-k/cdk-real-drift/commit/354b670ddc9cbd9a8ad2ac98e8f79fef3e14354c))

## [0.12.10](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.9...v0.12.10) (2026-07-10)


### Bug Fixes

* **read:** detect out-of-band Lambda function code swaps via a recorded CodeSha256 signal ([#646](https://github.com/go-to-k/cdk-real-drift/issues/646)) ([#1260](https://github.com/go-to-k/cdk-real-drift/issues/1260)) ([b0a963a](https://github.com/go-to-k/cdk-real-drift/commit/b0a963a4767fdd9eb46f1581780a650141513b15))

## [0.12.9](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.8...v0.12.9) (2026-07-10)


### Bug Fixes

* **report:** hash secret-bearing values in the baseline, not plaintext ([#798](https://github.com/go-to-k/cdk-real-drift/issues/798)) ([#1259](https://github.com/go-to-k/cdk-real-drift/issues/1259)) ([34db21a](https://github.com/go-to-k/cdk-real-drift/commit/34db21a62a57deb71cf687e3c06042c31a99a83d))

## [0.12.8](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.7...v0.12.8) (2026-07-10)


### Bug Fixes

* **diff:** pin SSMContacts/Scheduler/AppSync order-significant arrays so an OOB reorder surfaces ([#880](https://github.com/go-to-k/cdk-real-drift/issues/880)) ([#1258](https://github.com/go-to-k/cdk-real-drift/issues/1258)) ([b253a2c](https://github.com/go-to-k/cdk-real-drift/commit/b253a2c75168cfdf5f8859a1b6ed6cf3d37f06ab))
* **read:** fold RDS cluster implicit members by name signature so a rogue OOB instance surfaces ([#985](https://github.com/go-to-k/cdk-real-drift/issues/985)) ([#1257](https://github.com/go-to-k/cdk-real-drift/issues/1257)) ([19be820](https://github.com/go-to-k/cdk-real-drift/commit/19be8206461911bfa7fb084b11fb12761772475a))

## [0.12.7](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.6...v0.12.7) (2026-07-10)


### Bug Fixes

* **noise:** fold LakeFormation PrincipalPermissions undeclared Catalog=<account> ([#930](https://github.com/go-to-k/cdk-real-drift/issues/930)) ([#1254](https://github.com/go-to-k/cdk-real-drift/issues/1254)) ([ad88c0c](https://github.com/go-to-k/cdk-real-drift/commit/ad88c0cc7365a659b2bee4567aaa832d068b9dc1))

## [0.12.6](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.5...v0.12.6) (2026-07-10)


### Bug Fixes

* **diff:** gate TargetGroup Targets on a dynamic-registrar sibling instead of value-independent ([#891](https://github.com/go-to-k/cdk-real-drift/issues/891)) ([#1253](https://github.com/go-to-k/cdk-real-drift/issues/1253)) ([8bdc1c5](https://github.com/go-to-k/cdk-real-drift/commit/8bdc1c5746cde7430e74a69bcc9e2e4c08c51d3e))

## [0.12.5](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.4...v0.12.5) (2026-07-10)


### Bug Fixes

* **diff:** fold Neptune default-SG list via the [#889](https://github.com/go-to-k/cdk-real-drift/issues/889) derived gate + Cognito UserPoolUser sub ([#976](https://github.com/go-to-k/cdk-real-drift/issues/976), [#844](https://github.com/go-to-k/cdk-real-drift/issues/844)) ([#1252](https://github.com/go-to-k/cdk-real-drift/issues/1252)) ([4b32072](https://github.com/go-to-k/cdk-real-drift/commit/4b3207285e2cc2bd9b672b6f8969e4199269e5dd))

## [0.12.4](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.3...v0.12.4) (2026-07-10)


### Bug Fixes

* **normalize:** strip managed-timestamp name variants ALWAYS_STRIPPED misses ([#915](https://github.com/go-to-k/cdk-real-drift/issues/915)) ([#1251](https://github.com/go-to-k/cdk-real-drift/issues/1251)) ([8ed0435](https://github.com/go-to-k/cdk-real-drift/commit/8ed0435f84253475c2caf8a998a042a494607823))

## [0.12.3](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.2...v0.12.3) (2026-07-10)


### Bug Fixes

* **diff:** stop false potential drift on declared dot-key maps and legacy S3 transition default ([#1249](https://github.com/go-to-k/cdk-real-drift/issues/1249)) ([c86ad6e](https://github.com/go-to-k/cdk-real-drift/commit/c86ad6e1a9869e4a18ccc1cbdc3a2ff0640aaf03))

## [0.12.2](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.1...v0.12.2) (2026-07-10)


### Bug Fixes

* **diff:** demote non-ASCII-masked SFN DefinitionString to readGap, not declared drift ([#1247](https://github.com/go-to-k/cdk-real-drift/issues/1247)) ([44b554e](https://github.com/go-to-k/cdk-real-drift/commit/44b554e88d6c83bba5946da47117ea366ca26245))

## [0.12.1](https://github.com/go-to-k/cdk-real-drift/compare/v0.12.0...v0.12.1) (2026-07-10)


### Bug Fixes

* **read:** match alias/version-bound Lambda EventSourceMappings on unqualified function identity ([#803](https://github.com/go-to-k/cdk-real-drift/issues/803)) ([#1248](https://github.com/go-to-k/cdk-real-drift/issues/1248)) ([797d3e0](https://github.com/go-to-k/cdk-real-drift/commit/797d3e036f4b2df284bd1fad411c2bb1cfa2e797))

# [0.12.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.11.2...v0.12.0) (2026-07-10)


### Bug Fixes

* **diff:** derive the VPC default SG to gate ENI GroupSet / ALB SecurityGroups instead of value-independent folding ([#889](https://github.com/go-to-k/cdk-real-drift/issues/889)) ([#1244](https://github.com/go-to-k/cdk-real-drift/issues/1244)) ([6ad1140](https://github.com/go-to-k/cdk-real-drift/commit/6ad1140dafcaaf6bd100e45e364260f5b6b0a67c))
* **diff:** gate EIP NetworkInterfaceId on a declared sibling association instead of value-independent ([#892](https://github.com/go-to-k/cdk-real-drift/issues/892)) ([#1246](https://github.com/go-to-k/cdk-real-drift/issues/1246)) ([9dd226a](https://github.com/go-to-k/cdk-real-drift/commit/9dd226a123fc1da320892342b3b911504d17a618))


### Features

* **read:** add AWS::LakeFormation::Resource SDK_OVERRIDES reader for the CC read gap ([#930](https://github.com/go-to-k/cdk-real-drift/issues/930)) ([#1245](https://github.com/go-to-k/cdk-real-drift/issues/1245)) ([2dd840c](https://github.com/go-to-k/cdk-real-drift/commit/2dd840c2fd96ce03a301d3a0e44d0c3dbe13cb29))


### Reverts

* back out the [#805](https://github.com/go-to-k/cdk-real-drift/issues/805) op.prior stale-index guard (shape-fragile, deterministic false-abort) ([#1243](https://github.com/go-to-k/cdk-real-drift/issues/1243)) ([e58704d](https://github.com/go-to-k/cdk-real-drift/commit/e58704d3f6b7a692f77bfd94d512acd332e5731e))

## [0.11.2](https://github.com/go-to-k/cdk-real-drift/compare/v0.11.1...v0.11.2) (2026-07-10)


### Bug Fixes

* **diff:** derive GlobalAccelerator EndpointGroup HealthCheckPort from its listener ([#975](https://github.com/go-to-k/cdk-real-drift/issues/975)) ([#1242](https://github.com/go-to-k/cdk-real-drift/issues/1242)) ([d961916](https://github.com/go-to-k/cdk-real-drift/commit/d961916fad219861eca6facf0da82784f488a98a))

## [0.11.1](https://github.com/go-to-k/cdk-real-drift/compare/v0.11.0...v0.11.1) (2026-07-10)


### Bug Fixes

* **read:** skip OpenSearch service-created UserPoolClient in the Cognito enumerator ([#897](https://github.com/go-to-k/cdk-real-drift/issues/897)) ([#1240](https://github.com/go-to-k/cdk-real-drift/issues/1240)) ([6b4d4d1](https://github.com/go-to-k/cdk-real-drift/commit/6b4d4d155921d2e8a0dc4afbff7b3f5344e0b96f))
* **revert:** whole-array revert for value changes inside canonicalize-sorted tag lists ([#750](https://github.com/go-to-k/cdk-real-drift/issues/750)) ([#1241](https://github.com/go-to-k/cdk-real-drift/issues/1241)) ([0746701](https://github.com/go-to-k/cdk-real-drift/commit/07467010f28cffe19342f58bc184e578cc3e01b2))

# [0.11.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.10.3...v0.11.0) (2026-07-10)


### Bug Fixes

* **desired:** resolve crossRegionReferences reader GetAtt via SSM /cdk/exports prefetch ([#741](https://github.com/go-to-k/cdk-real-drift/issues/741)) ([#1236](https://github.com/go-to-k/cdk-real-drift/issues/1236)) ([e7f8a7a](https://github.com/go-to-k/cdk-real-drift/commit/e7f8a7a6a32b014c7d8d8926fac7b5fc7bf3dea3))
* **diff:** subtract sibling standalone LifecycleHooks from an ASG's live list ([#700](https://github.com/go-to-k/cdk-real-drift/issues/700)) ([#1228](https://github.com/go-to-k/cdk-real-drift/issues/1228)) ([2f0e23b](https://github.com/go-to-k/cdk-real-drift/commit/2f0e23b7a5df35c2e46aee3a6b066c7297707fa0))
* **noise:** fold nested-stack AWS::CloudFormation::Stack undeclared props ([#723](https://github.com/go-to-k/cdk-real-drift/issues/723)) ([#1237](https://github.com/go-to-k/cdk-real-drift/issues/1237)) ([a506f8d](https://github.com/go-to-k/cdk-real-drift/commit/a506f8ddfc2c37e738ec4ec64fb541f0b0ff19e3))
* **read:** enumerate Cognito UserPool IdPs + skip auto-created federated groups ([#1043](https://github.com/go-to-k/cdk-real-drift/issues/1043), [#961](https://github.com/go-to-k/cdk-real-drift/issues/961)) ([#1232](https://github.com/go-to-k/cdk-real-drift/issues/1232)) ([47d4452](https://github.com/go-to-k/cdk-real-drift/commit/47d4452820ddc4070c51a82680b360ca68d82915))


### Features

* **read:** add SDK_OVERRIDES readers for DMS ReplicationInstance + ReplicationTask ([#856](https://github.com/go-to-k/cdk-real-drift/issues/856)) ([#1230](https://github.com/go-to-k/cdk-real-drift/issues/1230)) ([a191e8d](https://github.com/go-to-k/cdk-real-drift/commit/a191e8d0a27cdc8c394da3190846a65d9fb45b38))

## [0.10.3](https://github.com/go-to-k/cdk-real-drift/compare/v0.10.2...v0.10.3) (2026-07-10)


### Bug Fixes

* **normalize:** tolerate IPv6-CIDR representation variants (RFC 5952 canonicalization) ([#981](https://github.com/go-to-k/cdk-real-drift/issues/981)) ([#1239](https://github.com/go-to-k/cdk-real-drift/issues/1239)) ([add0634](https://github.com/go-to-k/cdk-real-drift/commit/add06344a46e19fff41f0c25d299605bc4ce27ce))

## [0.10.2](https://github.com/go-to-k/cdk-real-drift/compare/v0.10.1...v0.10.2) (2026-07-10)


### Bug Fixes

* **diff:** gate GuardDuty Detector Features per-name Status instead of value-independent ([#1092](https://github.com/go-to-k/cdk-real-drift/issues/1092)) ([#1235](https://github.com/go-to-k/cdk-real-drift/issues/1235)) ([2428c2c](https://github.com/go-to-k/cdk-real-drift/commit/2428c2ccc475ba16427c722de64f5a605d90103b))

## [0.10.1](https://github.com/go-to-k/cdk-real-drift/compare/v0.10.0...v0.10.1) (2026-07-10)


### Bug Fixes

* **report:** mask secret-bearing values in text + --json output ([#798](https://github.com/go-to-k/cdk-real-drift/issues/798)) ([#1234](https://github.com/go-to-k/cdk-real-drift/issues/1234)) ([0940a8d](https://github.com/go-to-k/cdk-real-drift/commit/0940a8d7bd4604101ff547127fb3ceb6ac46171e))

# [0.10.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.14...v0.10.0) (2026-07-10)


### Features

* **revert:** add --force to override the [#786](https://github.com/go-to-k/cdk-real-drift/issues/786) mid-operation stack-stability refusal ([#1175](https://github.com/go-to-k/cdk-real-drift/issues/1175)) ([#1233](https://github.com/go-to-k/cdk-real-drift/issues/1233)) ([1a69536](https://github.com/go-to-k/cdk-real-drift/commit/1a69536bcee3dda3c5223a5a3925db2aa5aaf1ae))

## [0.9.14](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.13...v0.9.14) (2026-07-10)


### Bug Fixes

* **diff:** gate EB SecurityGroups/InstanceType options instead of value-independent folding ([#893](https://github.com/go-to-k/cdk-real-drift/issues/893)) ([#1229](https://github.com/go-to-k/cdk-real-drift/issues/1229)) ([d4cbc36](https://github.com/go-to-k/cdk-real-drift/commit/d4cbc365fc0ede488adc3f825943f544e41d9c78))
* **read:** probe each segment of a composite CC identifier in the sibling-stack check ([#800](https://github.com/go-to-k/cdk-real-drift/issues/800)) ([#1231](https://github.com/go-to-k/cdk-real-drift/issues/1231)) ([220bede](https://github.com/go-to-k/cdk-real-drift/commit/220bede7b0232212651da55a3a4b3768df166788))

## [0.9.13](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.12...v0.9.13) (2026-07-10)


### Bug Fixes

* **diff:** fold EKS AccessEntry.Username via a derived gate, not value-independent ([#890](https://github.com/go-to-k/cdk-real-drift/issues/890)) ([#1227](https://github.com/go-to-k/cdk-real-drift/issues/1227)) ([a601be2](https://github.com/go-to-k/cdk-real-drift/commit/a601be244ad4adf044409b66a508a02d70173018))

## [0.9.12](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.11...v0.9.12) (2026-07-10)


### Bug Fixes

* **normalize+revert:** handle map-shaped tag properties under service-specific names ([#862](https://github.com/go-to-k/cdk-real-drift/issues/862)) ([#1226](https://github.com/go-to-k/cdk-real-drift/issues/1226)) ([82b003d](https://github.com/go-to-k/cdk-real-drift/commit/82b003d4792ec66b3289574418e080e35a68520e))
* **revert:** verify op.prior against the fresh model before a whole-document SDK write ([#805](https://github.com/go-to-k/cdk-real-drift/issues/805)) ([#1225](https://github.com/go-to-k/cdk-real-drift/issues/1225)) ([a1c8f06](https://github.com/go-to-k/cdk-real-drift/commit/a1c8f06f2c881656a176f75870655881cc5b38e4))

## [0.9.11](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.10...v0.9.11) (2026-07-10)


### Bug Fixes

* **revert:** stream each resource's revert outcome as it completes ([#952](https://github.com/go-to-k/cdk-real-drift/issues/952)) ([#1224](https://github.com/go-to-k/cdk-real-drift/issues/1224)) ([be1b1f6](https://github.com/go-to-k/cdk-real-drift/commit/be1b1f62618c91e82403e1ddc3bef94d2d4d6c63))

## [0.9.10](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.9...v0.9.10) (2026-07-10)


### Bug Fixes

* **diff:** fold 5 derived-echo first-run FPs computable from declared inputs ([#975](https://github.com/go-to-k/cdk-real-drift/issues/975)) ([#1223](https://github.com/go-to-k/cdk-real-drift/issues/1223)) ([3edf287](https://github.com/go-to-k/cdk-real-drift/commit/3edf287e67ff58f8a9e79e8e23472a8696f92d1d))

## [0.9.9](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.8...v0.9.9) (2026-07-10)


### Bug Fixes

* **read:** enumerate VPC RouteTable + NetworkAcl children ([#1045](https://github.com/go-to-k/cdk-real-drift/issues/1045) follow-up) ([#1222](https://github.com/go-to-k/cdk-real-drift/issues/1222)) ([88d7852](https://github.com/go-to-k/cdk-real-drift/commit/88d78522257c7f3018f13964509ccb12ce2a4d20))

## [0.9.8](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.7...v0.9.8) (2026-07-10)


### Bug Fixes

* **desired:** loudly surface --pre-deploy params with no resolvable value ([#1215](https://github.com/go-to-k/cdk-real-drift/issues/1215)) ([#1221](https://github.com/go-to-k/cdk-real-drift/issues/1221)) ([d794ffd](https://github.com/go-to-k/cdk-real-drift/commit/d794ffdde4e3feda587ca3b73ca5dd8dac322cf6))

## [0.9.7](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.6...v0.9.7) (2026-07-10)


### Bug Fixes

* **added:** fail safe when the sibling-stack check cannot verify a cross-account/region child ([#959](https://github.com/go-to-k/cdk-real-drift/issues/959)) ([#1220](https://github.com/go-to-k/cdk-real-drift/issues/1220)) ([f846e6f](https://github.com/go-to-k/cdk-real-drift/commit/f846e6f7643900353ba3acbf676590f2046f58d2))
* **noise:** fold AWS-assigned placement/key/version defaults surfacing as first-run undeclared FPs ([#976](https://github.com/go-to-k/cdk-real-drift/issues/976)) ([#1216](https://github.com/go-to-k/cdk-real-drift/issues/1216)) ([f6fa5c1](https://github.com/go-to-k/cdk-real-drift/commit/f6fa5c10afc2222c78223170e5e6d1f2b19c521c))
* **read:** suppress spec-materialized children of Body-defined / quick-create ApiGatewayV2 HTTP APIs ([#960](https://github.com/go-to-k/cdk-real-drift/issues/960)) ([#1218](https://github.com/go-to-k/cdk-real-drift/issues/1218)) ([b9041bd](https://github.com/go-to-k/cdk-real-drift/commit/b9041bdd134dc8628ab25f479daa1c9b428bc67a))
* **sweep:** honor aws:cloudformation:stack-name in the generic tag net so a peer's live resource is never flagged an orphan ([#1217](https://github.com/go-to-k/cdk-real-drift/issues/1217)) ([6d9b9c8](https://github.com/go-to-k/cdk-real-drift/commit/6d9b9c84dc5d4aad7f02b23ad16dc95f41954259))

## [0.9.6](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.5...v0.9.6) (2026-07-10)


### Bug Fixes

* **noise:** tolerate AWS::Cognito::UserPool.EnabledMfas reorder ([#1093](https://github.com/go-to-k/cdk-real-drift/issues/1093)) ([#1212](https://github.com/go-to-k/cdk-real-drift/issues/1212)) ([65a86ec](https://github.com/go-to-k/cdk-real-drift/commit/65a86ecaca719c538b4296a44e11f673839ce004))
* **read:** use the CFn physical-id form for the Events::Rule sibling-stack check ([#895](https://github.com/go-to-k/cdk-real-drift/issues/895)) ([#1213](https://github.com/go-to-k/cdk-real-drift/issues/1213)) ([7361a12](https://github.com/go-to-k/cdk-real-drift/commit/7361a123e7ad82e8f0b854c4706e8ce647776234))
* **revert:** per-finding revert of a subset must not write unselected/skipped findings back to AWS ([#756](https://github.com/go-to-k/cdk-real-drift/issues/756)) ([#1214](https://github.com/go-to-k/cdk-real-drift/issues/1214)) ([4233d19](https://github.com/go-to-k/cdk-real-drift/commit/4233d198f4416e9134c88f5bc8c5ef9fcc2a2211))

## [0.9.5](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.4...v0.9.5) (2026-07-10)


### Bug Fixes

* **diff:** reconcile StepFunctions writeOnly Definition / DefinitionSubstitutions with live DefinitionString ([#712](https://github.com/go-to-k/cdk-real-drift/issues/712)) ([#1209](https://github.com/go-to-k/cdk-real-drift/issues/1209)) ([f83362e](https://github.com/go-to-k/cdk-real-drift/commit/f83362e6962636d24ab61b7ced3895199468a30c))
* **noise:** fold EC2 Instance create-only CpuOptions + SubnetId first-run undeclared FPs ([#640](https://github.com/go-to-k/cdk-real-drift/issues/640)) ([#1211](https://github.com/go-to-k/cdk-real-drift/issues/1211)) ([e66ca06](https://github.com/go-to-k/cdk-real-drift/commit/e66ca06c154bde22cf39ba77a56c4d5136657c44))
* **record:** keep the ignore->record->un-ignore lifecycle correct — no false 'appeared since record' ([#1078](https://github.com/go-to-k/cdk-real-drift/issues/1078)) ([#1210](https://github.com/go-to-k/cdk-real-drift/issues/1210)) ([32219af](https://github.com/go-to-k/cdk-real-drift/commit/32219af9de2dacd242649e0af3c7e9987cb7c9e1))

## [0.9.4](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.3...v0.9.4) (2026-07-10)


### Bug Fixes

* **check:** do not offer the inline Record/Revert menu under --declared-only / --undeclared-only ([#779](https://github.com/go-to-k/cdk-real-drift/issues/779)) ([#1208](https://github.com/go-to-k/cdk-real-drift/issues/1208)) ([589ecd7](https://github.com/go-to-k/cdk-real-drift/commit/589ecd7d8ce32a388160240712c3ac0df12e6032))
* **noise:** fold AWS-assigned identifiers / generated names surfacing as first-run undeclared FPs ([#844](https://github.com/go-to-k/cdk-real-drift/issues/844)) ([#1206](https://github.com/go-to-k/cdk-real-drift/issues/1206)) ([49f36f4](https://github.com/go-to-k/cdk-real-drift/commit/49f36f4754a7d5c28fdd77aa5a11c95e0964d65c))
* **revert:** make [#641](https://github.com/go-to-k/cdk-real-drift/issues/641) null-husk strip ops non-selectable coupled plumbing ([#967](https://github.com/go-to-k/cdk-real-drift/issues/967)) ([#1207](https://github.com/go-to-k/cdk-real-drift/issues/1207)) ([1c63bea](https://github.com/go-to-k/cdk-real-drift/commit/1c63bea23ef8ebb3570b73c55301fdc3011c253a))

## [0.9.3](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.2...v0.9.3) (2026-07-10)


### Bug Fixes

* **baseline:** re-apply the full live-value strip pipeline to the stored baseline value at compare time ([#766](https://github.com/go-to-k/cdk-real-drift/issues/766)) ([#1205](https://github.com/go-to-k/cdk-real-drift/issues/1205)) ([43d4d6f](https://github.com/go-to-k/cdk-real-drift/commit/43d4d6f89523ef5acea96f94e8b84f8f106a737c))
* **revert:** show tag-preserve / write-only-reinclude / empty-strip ops in the plan before confirm ([#760](https://github.com/go-to-k/cdk-real-drift/issues/760)) ([#1204](https://github.com/go-to-k/cdk-real-drift/issues/1204)) ([d7b1790](https://github.com/go-to-k/cdk-real-drift/commit/d7b1790a9a5ad12892a847c233073fd2d0f5dfc6))

## [0.9.2](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.1...v0.9.2) (2026-07-10)


### Bug Fixes

* **check:** emit the no-baseline note under --json + carry a baseline-presence flag ([#1095](https://github.com/go-to-k/cdk-real-drift/issues/1095)) ([#1203](https://github.com/go-to-k/cdk-real-drift/issues/1203)) ([aed9261](https://github.com/go-to-k/cdk-real-drift/commit/aed9261918d5e9593369530aa883cfffc9b51489))

## [0.9.1](https://github.com/go-to-k/cdk-real-drift/compare/v0.9.0...v0.9.1) (2026-07-10)


### Bug Fixes

* **read:** enumerate VPCEndpoint children of a declared VPC ([#1045](https://github.com/go-to-k/cdk-real-drift/issues/1045)) ([#1193](https://github.com/go-to-k/cdk-real-drift/issues/1193)) ([aab732a](https://github.com/go-to-k/cdk-real-drift/commit/aab732a454c118ba63e653b73b31b7f155574dfd))

# [0.9.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.8.0...v0.9.0) (2026-07-10)


### Bug Fixes

* **noise:** fold undeclared Neptune DBCluster EngineVersion value-independent ([#1186](https://github.com/go-to-k/cdk-real-drift/issues/1186)) ([#1192](https://github.com/go-to-k/cdk-real-drift/issues/1192)) ([142c579](https://github.com/go-to-k/cdk-real-drift/commit/142c5791396c4adf9fcb2519dde85b7c073b88c1))


### Features

* **read:** fold RDS OptionGroup default-fill via the live option catalog ([#978](https://github.com/go-to-k/cdk-real-drift/issues/978) follow-up) ([#1200](https://github.com/go-to-k/cdk-real-drift/issues/1200)) ([27acc1a](https://github.com/go-to-k/cdk-real-drift/commit/27acc1a812cf9ddecbc05598b66a6d91db878dbb))

# [0.8.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.7.6...v0.8.0) (2026-07-10)


### Bug Fixes

* **check:** a Custom::* skip is informational, not a --strict failure ([#724](https://github.com/go-to-k/cdk-real-drift/issues/724)) ([#1202](https://github.com/go-to-k/cdk-real-drift/issues/1202)) ([df49a25](https://github.com/go-to-k/cdk-real-drift/commit/df49a2572057d24563f034519d749e94777692e9))


### Features

* **read:** add SDK read override for SageMaker::EndpointConfig ([#857](https://github.com/go-to-k/cdk-real-drift/issues/857), SageMaker half) ([#1201](https://github.com/go-to-k/cdk-real-drift/issues/1201)) ([4641769](https://github.com/go-to-k/cdk-real-drift/commit/4641769bf36c331b4b423187623f2c18834302e0))

## [0.7.6](https://github.com/go-to-k/cdk-real-drift/compare/v0.7.5...v0.7.6) (2026-07-10)


### Bug Fixes

* **diff:** subtract sibling IAM attachments from Role.ManagedPolicyArns / User.Groups reflections ([#698](https://github.com/go-to-k/cdk-real-drift/issues/698)) ([#1198](https://github.com/go-to-k/cdk-real-drift/issues/1198)) ([a82bb53](https://github.com/go-to-k/cdk-real-drift/commit/a82bb53301c9c9ca89e095ce11edfa80a0fe2cb5))
* **revert:** extend the silent-no-op detector to add-shaped set-default writes ([#763](https://github.com/go-to-k/cdk-real-drift/issues/763)) ([#1199](https://github.com/go-to-k/cdk-real-drift/issues/1199)) ([aba5589](https://github.com/go-to-k/cdk-real-drift/commit/aba5589c6aba344366040bc224f81d2a9bc5203f))

## [0.7.5](https://github.com/go-to-k/cdk-real-drift/compare/v0.7.4...v0.7.5) (2026-07-10)


### Bug Fixes

* **diff:** subtract sibling EventBusPolicy statements from a bus's reflected Policy ([#699](https://github.com/go-to-k/cdk-real-drift/issues/699)) ([#1196](https://github.com/go-to-k/cdk-real-drift/issues/1196)) ([b6adb06](https://github.com/go-to-k/cdk-real-drift/commit/b6adb062d8f5bbc812774ac66de93f8b21aac01f))
* **revert:** coerce a string-typed declared scalar to the live value's type on the revert patch ([#725](https://github.com/go-to-k/cdk-real-drift/issues/725)) ([#1197](https://github.com/go-to-k/cdk-real-drift/issues/1197)) ([f5865e9](https://github.com/go-to-k/cdk-real-drift/commit/f5865e9b12eb136f9af3ecb28b4f866ca0792839))
* **synth:** carry env.account through discovery so multi-account stacks are not silently skipped or wrong-account compared ([#740](https://github.com/go-to-k/cdk-real-drift/issues/740)) ([#1195](https://github.com/go-to-k/cdk-real-drift/issues/1195)) ([75e538c](https://github.com/go-to-k/cdk-real-drift/commit/75e538c2a658edf5f7a9bc6ff81b9e5dd6d8f227))

## [0.7.4](https://github.com/go-to-k/cdk-real-drift/compare/v0.7.3...v0.7.4) (2026-07-10)


### Bug Fixes

* **desired:** under --pre-deploy, local param Default wins over the deployed value so a changed Default is not masked ([#728](https://github.com/go-to-k/cdk-real-drift/issues/728)) ([#1194](https://github.com/go-to-k/cdk-real-drift/issues/1194)) ([1e43017](https://github.com/go-to-k/cdk-real-drift/commit/1e430177d53284820c6bf43316f5e6ce4510ae57))

## [0.7.3](https://github.com/go-to-k/cdk-real-drift/compare/v0.7.2...v0.7.3) (2026-07-10)


### Bug Fixes

* **revert:** --wait delete-batch deadline computed once per run, not re-armed per pass ([#969](https://github.com/go-to-k/cdk-real-drift/issues/969)) ([#1191](https://github.com/go-to-k/cdk-real-drift/issues/1191)) ([14a59ac](https://github.com/go-to-k/cdk-real-drift/commit/14a59aca9f3c0414ca97407c8e20ae7090a0e71e))

## [0.7.2](https://github.com/go-to-k/cdk-real-drift/compare/v0.7.1...v0.7.2) (2026-07-10)


### Bug Fixes

* **normalize:** stop stripAwsTagsDeep from stripping declared aws:* tag-FILTER elements ([#864](https://github.com/go-to-k/cdk-real-drift/issues/864)) ([#1188](https://github.com/go-to-k/cdk-real-drift/issues/1188)) ([f042a7d](https://github.com/go-to-k/cdk-real-drift/commit/f042a7d8177e0ae2abdeb65ce244ae02d46f4bda))
* **revert:** converge the six remaining Cognito UserPool folded defaults via REVERT_SET_DEFAULT_PATHS ([#702](https://github.com/go-to-k/cdk-real-drift/issues/702)) ([#1187](https://github.com/go-to-k/cdk-real-drift/issues/1187)) ([49d6ffd](https://github.com/go-to-k/cdk-real-drift/commit/49d6ffdba5553910a5b87189bcf8ecd525378bdc))
* **revert:** whole-type SDK writers report unconsumed ops as not-reverted instead of a silent false success ([#804](https://github.com/go-to-k/cdk-real-drift/issues/804)) ([#1189](https://github.com/go-to-k/cdk-real-drift/issues/1189)) ([786d0fb](https://github.com/go-to-k/cdk-real-drift/commit/786d0fb7404a4cdcba183985bf8f5dac60e20b23))

## [0.7.1](https://github.com/go-to-k/cdk-real-drift/compare/v0.7.0...v0.7.1) (2026-07-10)


### Bug Fixes

* **check:** do not open the interactive resolve menu under --yes ([#1054](https://github.com/go-to-k/cdk-real-drift/issues/1054)) ([#1185](https://github.com/go-to-k/cdk-real-drift/issues/1185)) ([1fa42c3](https://github.com/go-to-k/cdk-real-drift/commit/1fa42c32d8049c40be776119f5e29291a42bce49))
* **noise:** fold RDS OptionGroup default-fill OptionSettings to atDefault ([#978](https://github.com/go-to-k/cdk-real-drift/issues/978)) ([#1184](https://github.com/go-to-k/cdk-real-drift/issues/1184)) ([51c8264](https://github.com/go-to-k/cdk-real-drift/commit/51c82641558f38bcacba4e48b2c0ee8acdba8606))

# [0.7.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.6.2...v0.7.0) (2026-07-10)


### Features

* **read:** add SDK read override for Glue::SecurityConfiguration ([#857](https://github.com/go-to-k/cdk-real-drift/issues/857), Glue half) ([#1183](https://github.com/go-to-k/cdk-real-drift/issues/1183)) ([e78c504](https://github.com/go-to-k/cdk-real-drift/commit/e78c5041cd8515465f46bb7bb6587d574d3ab918))

## [0.6.2](https://github.com/go-to-k/cdk-real-drift/compare/v0.6.1...v0.6.2) (2026-07-10)


### Bug Fixes

* **diff:** gate DynamoDB/OpenSearch managed-key fold so an out-of-band CMK swap surfaces ([#704](https://github.com/go-to-k/cdk-real-drift/issues/704)) ([#1180](https://github.com/go-to-k/cdk-real-drift/issues/1180)) ([2b156cf](https://github.com/go-to-k/cdk-real-drift/commit/2b156cf393838507c2cdb747bf19775d913fa351))
* **revert:** gate deletion of a recorded (endorsed) added resource behind --remove-unrecorded ([#764](https://github.com/go-to-k/cdk-real-drift/issues/764)) ([#1181](https://github.com/go-to-k/cdk-real-drift/issues/1181)) ([4ce09e3](https://github.com/go-to-k/cdk-real-drift/commit/4ce09e34114c3a0314493725934b2156f9df842e))

## [0.6.1](https://github.com/go-to-k/cdk-real-drift/compare/v0.6.0...v0.6.1) (2026-07-10)


### Bug Fixes

* **read:** counted readGap for all failed-supplement exempted props, not just scalars ([#849](https://github.com/go-to-k/cdk-real-drift/issues/849)) ([#1182](https://github.com/go-to-k/cdk-real-drift/issues/1182)) ([d94173f](https://github.com/go-to-k/cdk-real-drift/commit/d94173f85d6865bff588c5da7f10224c41634be3))
* **read:** route-table enumerator catches IPv6 + prefix-list routes ([#1081](https://github.com/go-to-k/cdk-real-drift/issues/1081)) ([#1178](https://github.com/go-to-k/cdk-real-drift/issues/1178)) ([8c1aaad](https://github.com/go-to-k/cdk-real-drift/commit/8c1aaade0b692d511911e36f41da0fcceed0b1ab))

# [0.6.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.5.4...v0.6.0) (2026-07-10)


### Features

* **report:** show recorded → live for a changed undeclared value ([#758](https://github.com/go-to-k/cdk-real-drift/issues/758) follow-up) ([#1179](https://github.com/go-to-k/cdk-real-drift/issues/1179)) ([09f73b7](https://github.com/go-to-k/cdk-real-drift/commit/09f73b73e41f279ce2fee9f43292826ca33506ba))

## [0.5.4](https://github.com/go-to-k/cdk-real-drift/compare/v0.5.3...v0.5.4) (2026-07-10)


### Bug Fixes

* **desired:** honor --pre-deploy contract (type-change REPLACE, stack-state gate, SSM-typed new param) ([#882](https://github.com/go-to-k/cdk-real-drift/issues/882)) ([#1157](https://github.com/go-to-k/cdk-real-drift/issues/1157)) ([87be069](https://github.com/go-to-k/cdk-real-drift/commit/87be069ef0635cea93424b820df6fe4e718e028a))
* **diff:** skip execute-api Policy expansion when declared Policy is UNRESOLVED ([#839](https://github.com/go-to-k/cdk-real-drift/issues/839)) ([#1156](https://github.com/go-to-k/cdk-real-drift/issues/1156)) ([e6e4647](https://github.com/go-to-k/cdk-real-drift/commit/e6e464769e14f3c24dfe04a461c4aade8cedf301))
* **noise:** canonicalize WAFv2 FieldToMatch.SingleHeader key+value case ([#876](https://github.com/go-to-k/cdk-real-drift/issues/876)) ([#1161](https://github.com/go-to-k/cdk-real-drift/issues/1161)) ([a61a031](https://github.com/go-to-k/cdk-real-drift/commit/a61a0311819e91ca0018e2bee0145b2992d378c1))
* **read:** surface a counted readGap for scalar exempted props on supplement-read failure ([#849](https://github.com/go-to-k/cdk-real-drift/issues/849)) ([#1162](https://github.com/go-to-k/cdk-real-drift/issues/1162)) ([749cdcb](https://github.com/go-to-k/cdk-real-drift/commit/749cdcb0456c34baf590d4350a4a67dc46a21797))
* **revert:** assert RFC6902 test precondition against the RAW live model ([#853](https://github.com/go-to-k/cdk-real-drift/issues/853)) ([#1155](https://github.com/go-to-k/cdk-real-drift/issues/1155)) ([f6fa536](https://github.com/go-to-k/cdk-real-drift/commit/f6fa5362fad6aa2f8afb853f6598d6be44ad36d4))
* **revert:** dependency-violation deletes fail fast to the pass loop, not the retry budget ([#969](https://github.com/go-to-k/cdk-real-drift/issues/969)) ([#1164](https://github.com/go-to-k/cdk-real-drift/issues/1164)) ([a16e135](https://github.com/go-to-k/cdk-real-drift/commit/a16e1355286ca05c36588b158a922ba4c732dd13))
* **revert:** poll ProgressEvent to completion in writeCloudControlIndexNested ([#1065](https://github.com/go-to-k/cdk-real-drift/issues/1065)) ([#1163](https://github.com/go-to-k/cdk-real-drift/issues/1163)) ([6e45cb9](https://github.com/go-to-k/cdk-real-drift/commit/6e45cb9e65e75fae70455bc1c175da032599eecf))
* **synth:** align raw-SDK client credential precedence with toolkit-lib ([#954](https://github.com/go-to-k/cdk-real-drift/issues/954)) ([#1160](https://github.com/go-to-k/cdk-real-drift/issues/1160)) ([06bac1e](https://github.com/go-to-k/cdk-real-drift/commit/06bac1ed645143147f1b95dd3bcf8525b0c825ef))

## [0.5.3](https://github.com/go-to-k/cdk-real-drift/compare/v0.5.2...v0.5.3) (2026-07-10)


### Bug Fixes

* **baseline:** recorded added-resource lifecycle — surface OOB deletion + carry-forward under throttled parent ([#791](https://github.com/go-to-k/cdk-real-drift/issues/791)) ([#1177](https://github.com/go-to-k/cdk-real-drift/issues/1177)) ([9990932](https://github.com/go-to-k/cdk-real-drift/commit/9990932f56010fe0436811fb87cf1d394944ed09))

## [0.5.2](https://github.com/go-to-k/cdk-real-drift/compare/v0.5.1...v0.5.2) (2026-07-10)


### Bug Fixes

* **check:** perFinding state bugs — cancelled revert mis-reported + record ran with stale config ([#761](https://github.com/go-to-k/cdk-real-drift/issues/761)) ([#1176](https://github.com/go-to-k/cdk-real-drift/issues/1176)) ([dc76b4d](https://github.com/go-to-k/cdk-real-drift/commit/dc76b4d66c889620f4b63fd5700fc715840ec01e))

## [0.5.1](https://github.com/go-to-k/cdk-real-drift/compare/v0.5.0...v0.5.1) (2026-07-10)


### Bug Fixes

* **report:** defend --json output against a nested UNRESOLVED symbol ([#1059](https://github.com/go-to-k/cdk-real-drift/issues/1059) --json residue) ([#1141](https://github.com/go-to-k/cdk-real-drift/issues/1141)) ([7eb8f41](https://github.com/go-to-k/cdk-real-drift/commit/7eb8f4105bb51eca68faaf41a590fc6f529dc452))

# [0.5.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.44...v0.5.0) (2026-07-10)


### Bug Fixes

* **read:** CodeBuild deleted-project -> deleted tier + ACM tag-read degrade ([#1083](https://github.com/go-to-k/cdk-real-drift/issues/1083), [#1086](https://github.com/go-to-k/cdk-real-drift/issues/1086)) ([#1139](https://github.com/go-to-k/cdk-real-drift/issues/1139)) ([b261d44](https://github.com/go-to-k/cdk-real-drift/commit/b261d441dc6fe982b5d5937e6357cb9d511ed287))


### Features

* **read:** Route53 HostedZone RecordSet child enumerator (added-tier) ([#1042](https://github.com/go-to-k/cdk-real-drift/issues/1042)) ([#1147](https://github.com/go-to-k/cdk-real-drift/issues/1147)) ([eaa1b47](https://github.com/go-to-k/cdk-real-drift/commit/eaa1b47eecd6534f28bb67f1ccfee01aa5e294d6))

## [0.4.44](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.43...v0.4.44) (2026-07-10)


### Bug Fixes

* **record:** stop silently pruning/blessing recorded drift on re-record ([#790](https://github.com/go-to-k/cdk-real-drift/issues/790), [#758](https://github.com/go-to-k/cdk-real-drift/issues/758)) ([#1174](https://github.com/go-to-k/cdk-real-drift/issues/1174)) ([e8214a4](https://github.com/go-to-k/cdk-real-drift/commit/e8214a4f2aff064d580b16c1273f0c81045af59c))

## [0.4.43](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.42...v0.4.43) (2026-07-10)


### Bug Fixes

* **synth:** hoist the profile-region backfill ahead of the discovery synth so both --pre-deploy synths share one region env ([#957](https://github.com/go-to-k/cdk-real-drift/issues/957)) ([#1173](https://github.com/go-to-k/cdk-real-drift/issues/1173)) ([a1682e8](https://github.com/go-to-k/cdk-real-drift/commit/a1682e882c035f26673c4dff90646b7dfed645ce))

## [0.4.42](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.41...v0.4.42) (2026-07-10)


### Bug Fixes

* **normalize:** fold an EMBEDDED {{resolve:...}} dynamic reference to UNRESOLVED, not only a whole-string token ([#722](https://github.com/go-to-k/cdk-real-drift/issues/722)) ([#1172](https://github.com/go-to-k/cdk-real-drift/issues/1172)) ([dbcb780](https://github.com/go-to-k/cdk-real-drift/commit/dbcb780b80514350012c5ab6498f50e8a5f551cf))

## [0.4.41](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.40...v0.4.41) (2026-07-10)


### Bug Fixes

* **gather:** degrade schema-unavailable resources to skipped, not an unstripped diff ([#858](https://github.com/go-to-k/cdk-real-drift/issues/858)) ([#1171](https://github.com/go-to-k/cdk-real-drift/issues/1171)) ([aa970bd](https://github.com/go-to-k/cdk-real-drift/commit/aa970bdaa003aecbab7b094a567f83acd4fbb684))

## [0.4.40](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.39...v0.4.40) (2026-07-10)


### Bug Fixes

* **revert:** gate revert on a mid-operation stack + surface stackStatusWarning in record/ignore/revert ([#786](https://github.com/go-to-k/cdk-real-drift/issues/786)) ([#1170](https://github.com/go-to-k/cdk-real-drift/issues/1170)) ([a7cddb7](https://github.com/go-to-k/cdk-real-drift/commit/a7cddb7555070f53edbc6fa5fea23fbf6c8cd794))

## [0.4.39](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.38...v0.4.39) (2026-07-10)


### Bug Fixes

* **baseline:** make baselineValueMatches reflexive for identity-less object arrays ([#767](https://github.com/go-to-k/cdk-real-drift/issues/767)) ([#1169](https://github.com/go-to-k/cdk-real-drift/issues/1169)) ([7e5ecbe](https://github.com/go-to-k/cdk-real-drift/commit/7e5ecbe8caedc665803aea96703594b51709673f))
* **config:** write ignore.yaml atomically (tmp+rename) + re-read-merge the addIgnoreRules race ([#759](https://github.com/go-to-k/cdk-real-drift/issues/759)) ([#1166](https://github.com/go-to-k/cdk-real-drift/issues/1166)) ([09e3d02](https://github.com/go-to-k/cdk-real-drift/commit/09e3d022f652dea345d75861ccb7489c72cf3979))
* **gather:** don't re-cache a failed DescribeType's EMPTY schema in the per-run map ([#1067](https://github.com/go-to-k/cdk-real-drift/issues/1067)) ([#1167](https://github.com/go-to-k/cdk-real-drift/issues/1167)) ([ddb5ce1](https://github.com/go-to-k/cdk-real-drift/commit/ddb5ce15bfef17a19a8b65e798055f28b6ef3df1))
* **normalize:** content-gate the AWSLogDelivery policy-statement subtraction ([#715](https://github.com/go-to-k/cdk-real-drift/issues/715)) ([#1168](https://github.com/go-to-k/cdk-real-drift/issues/1168)) ([8cfcf1b](https://github.com/go-to-k/cdk-real-drift/commit/8cfcf1b789303202ccfc7586fd7021c667ef5732))

## [0.4.38](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.37...v0.4.38) (2026-07-10)


### Bug Fixes

* **read:** re-fold declared CognitoEvents to a readGap when GetCognitoEvents fails ([#1085](https://github.com/go-to-k/cdk-real-drift/issues/1085)) ([#1165](https://github.com/go-to-k/cdk-real-drift/issues/1165)) ([f20b430](https://github.com/go-to-k/cdk-real-drift/commit/f20b43000c5b52d2a36b2a79d56233a399512779))

## [0.4.37](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.36...v0.4.37) (2026-07-10)


### Bug Fixes

* **baseline:** fold a promoted-to-code NESTED recorded path, not just top-level ([#1079](https://github.com/go-to-k/cdk-real-drift/issues/1079)) ([#1158](https://github.com/go-to-k/cdk-real-drift/issues/1158)) ([184c23e](https://github.com/go-to-k/cdk-real-drift/commit/184c23e1fdae162cd8e1131a83590c0e799d0e9f))
* **revert:** carry dry-run plan counts + refused reason in the --json element ([#1096](https://github.com/go-to-k/cdk-real-drift/issues/1096)) ([#1159](https://github.com/go-to-k/cdk-real-drift/issues/1159)) ([d9ee497](https://github.com/go-to-k/cdk-real-drift/commit/d9ee49753d90045fc151e541f54171c59ecb9e7e))

## [0.4.36](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.35...v0.4.36) (2026-07-10)


### Bug Fixes

* **noise:** fold default SLR / AWS-managed KMS ARNs via CONTEXT_ARN_DEFAULTS ([#846](https://github.com/go-to-k/cdk-real-drift/issues/846)) ([#1153](https://github.com/go-to-k/cdk-real-drift/issues/1153)) ([42bd8f7](https://github.com/go-to-k/cdk-real-drift/commit/42bd8f702133772e4f78c169719e32cac8f4cd87))

## [0.4.35](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.34...v0.4.35) (2026-07-10)


### Bug Fixes

* **noise:** fold 3 clean-deploy first-run FPs — Athena Status, VPCPeering PeerOwnerId, Neptune subnet-group echo ([#980](https://github.com/go-to-k/cdk-real-drift/issues/980)) ([#1154](https://github.com/go-to-k/cdk-real-drift/issues/1154)) ([921b188](https://github.com/go-to-k/cdk-real-drift/commit/921b1884d9d7c1394028c2bb76205fb07fa7e693))

## [0.4.34](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.33...v0.4.34) (2026-07-10)


### Bug Fixes

* **revert:** bar cc-kind revert on a handler-less CFn-legacy type ([#1091](https://github.com/go-to-k/cdk-real-drift/issues/1091)) ([#1152](https://github.com/go-to-k/cdk-real-drift/issues/1152)) ([29cb662](https://github.com/go-to-k/cdk-real-drift/commit/29cb662dbe9014b12d1679c569dc90a821246ec4))

## [0.4.33](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.32...v0.4.33) (2026-07-10)


### Bug Fixes

* **config:** ignore rule for a '/'-bearing CC identifier no longer swallows a '/'-extended sibling ([#1061](https://github.com/go-to-k/cdk-real-drift/issues/1061)) ([#1151](https://github.com/go-to-k/cdk-real-drift/issues/1151)) ([e899188](https://github.com/go-to-k/cdk-real-drift/commit/e899188ad1d01840d42bda8b3db6caa5d73f4a2f))

## [0.4.32](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.31...v0.4.32) (2026-07-10)


### Bug Fixes

* **check:** match hasBaselineForStack on the sanitized stack-name component ([#1077](https://github.com/go-to-k/cdk-real-drift/issues/1077) follow-up) ([#1149](https://github.com/go-to-k/cdk-real-drift/issues/1149)) ([c547881](https://github.com/go-to-k/cdk-real-drift/commit/c547881551af18ad75c78679f9d014ae17df1683))

## [0.4.31](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.30...v0.4.31) (2026-07-10)


### Bug Fixes

* **baseline:** sanitize Windows reserved DOS device stack names in baseline path ([#1077](https://github.com/go-to-k/cdk-real-drift/issues/1077)) ([#1145](https://github.com/go-to-k/cdk-real-drift/issues/1145)) ([a53188b](https://github.com/go-to-k/cdk-real-drift/commit/a53188b5174ff890e9a1cf896f391693d9c4b193))
* **normalize:** re-check intrinsic-resolved strings for dynamic references (Ref/FindInMap/Select/ImportValue) ([#1073](https://github.com/go-to-k/cdk-real-drift/issues/1073)) ([#1146](https://github.com/go-to-k/cdk-real-drift/issues/1146)) ([8ee0f77](https://github.com/go-to-k/cdk-real-drift/commit/8ee0f77df16486fc143ded1d2fb93c3e9e1eb746))
* **report:** render unrecorded added live model + defend nested UNRESOLVED symbol in value rendering ([#1057](https://github.com/go-to-k/cdk-real-drift/issues/1057), [#1059](https://github.com/go-to-k/cdk-real-drift/issues/1059)) ([#1142](https://github.com/go-to-k/cdk-real-drift/issues/1142)) ([9358538](https://github.com/go-to-k/cdk-real-drift/commit/93585388287e0446464a862ed065243a29141eb6))
* **revert:** default the AWS-write confirm to No ([#1055](https://github.com/go-to-k/cdk-real-drift/issues/1055)) ([#1143](https://github.com/go-to-k/cdk-real-drift/issues/1143)) ([50923fb](https://github.com/go-to-k/cdk-real-drift/commit/50923fb5b977b43ee533021b32ce9b17d566c5c7))

## [0.4.30](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.29...v0.4.30) (2026-07-10)


### Bug Fixes

* **check:** pin the current account in the deleted-out-of-band baseline probe ([#1046](https://github.com/go-to-k/cdk-real-drift/issues/1046)) ([#1140](https://github.com/go-to-k/cdk-real-drift/issues/1140)) ([a79bacb](https://github.com/go-to-k/cdk-real-drift/commit/a79bacbd3b7113589e72979de0a91c342797eb28))

## [0.4.29](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.28...v0.4.29) (2026-07-10)


### Bug Fixes

* **baseline:** surface JSON.parse position + conflict/recovery hint on a corrupt baseline ([#1138](https://github.com/go-to-k/cdk-real-drift/issues/1138)) ([84d3172](https://github.com/go-to-k/cdk-real-drift/commit/84d317298b81991e03fa9a18701177c5f6e08c60))

## [0.4.28](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.27...v0.4.28) (2026-07-10)


### Bug Fixes

* **baseline:** reject unknown top-level + per-entry keys at load, require entry value ([#1048](https://github.com/go-to-k/cdk-real-drift/issues/1048)) ([#1136](https://github.com/go-to-k/cdk-real-drift/issues/1136)) ([92b0f69](https://github.com/go-to-k/cdk-real-drift/commit/92b0f694651843f51a90d97da349adc01714d3b6))
* **revert:** writeDaxParameterGroup throws on an un-expressible remove op instead of false success ([#1124](https://github.com/go-to-k/cdk-real-drift/issues/1124)) ([039f319](https://github.com/go-to-k/cdk-real-drift/commit/039f319894e3e9383cf016065e97c8aba29793b9))

## [0.4.27](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.26...v0.4.27) (2026-07-10)


### Bug Fixes

* **read:** fail safe on an UNRESOLVED child-identity prop in three enumerators ([#1089](https://github.com/go-to-k/cdk-real-drift/issues/1089)) ([#1135](https://github.com/go-to-k/cdk-real-drift/issues/1135)) ([b2803d2](https://github.com/go-to-k/cdk-real-drift/commit/b2803d20efe2a92058112b3cc7bf24e5104e01a6))
* **revert:** pair REVERT_SET_DEFAULT_PATHS entries with grown KNOWN_DEFAULTS folds so omit-ignored props converge ([#1128](https://github.com/go-to-k/cdk-real-drift/issues/1128)) ([cff3011](https://github.com/go-to-k/cdk-real-drift/commit/cff301111246440656a8953e38ff98ddd732b181))

## [0.4.26](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.25...v0.4.26) (2026-07-10)


### Bug Fixes

* **revert:** thread region/account into CC identifier adapter so custom-bus Events::Rule revert converges ([#1122](https://github.com/go-to-k/cdk-real-drift/issues/1122)) ([bf319fa](https://github.com/go-to-k/cdk-real-drift/commit/bf319fa0bd9b61a479cd3af9d9b365ebf472d811))

## [0.4.25](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.24...v0.4.25) (2026-07-10)


### Bug Fixes

* **desired:** parse a duplicate-map-key YAML template last-wins instead of throwing ([#1074](https://github.com/go-to-k/cdk-real-drift/issues/1074)) ([#1133](https://github.com/go-to-k/cdk-real-drift/issues/1133)) ([1c95041](https://github.com/go-to-k/cdk-real-drift/commit/1c95041a6f3f2e51371ccb3274f05bee1d1d59ba))

## [0.4.24](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.23...v0.4.24) (2026-07-10)


### Bug Fixes

* **read:** derive Events::Rule CC-identifier ARN partition via partitionForRegion ([#1062](https://github.com/go-to-k/cdk-real-drift/issues/1062)) ([#1131](https://github.com/go-to-k/cdk-real-drift/issues/1131)) ([1f8e8d6](https://github.com/go-to-k/cdk-real-drift/commit/1f8e8d6733359371ca4d3b9bc958e0d11413996e))
* **revert:** retry a Cloud Control status-poll failure without re-sending the mutation ([#1064](https://github.com/go-to-k/cdk-real-drift/issues/1064)) ([#1132](https://github.com/go-to-k/cdk-real-drift/issues/1132)) ([a3c62d8](https://github.com/go-to-k/cdk-real-drift/commit/a3c62d89c79f5c13f6eb40004f0a898f382005d5))

## [0.4.23](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.22...v0.4.23) (2026-07-10)


### Bug Fixes

* **config:** surface YAML parse diagnostics instead of a bare 'not valid YAML' ([#1123](https://github.com/go-to-k/cdk-real-drift/issues/1123)) ([0460b4c](https://github.com/go-to-k/cdk-real-drift/commit/0460b4c113b1834e795cd8caff3fcba1914bfc08))
* **desired:** restrict YAML 1.1 int/float tags so octal/hex/sexagesimal/float-special scalars stay strings ([#1125](https://github.com/go-to-k/cdk-real-drift/issues/1125)) ([c5378e0](https://github.com/go-to-k/cdk-real-drift/commit/c5378e0cd3239bee7b74dbd8184feafbca4aad3e))

## [0.4.22](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.21...v0.4.22) (2026-07-10)


### Bug Fixes

* **baseline:** reject duplicate recorded identity keys at load ([#1047](https://github.com/go-to-k/cdk-real-drift/issues/1047)) ([#1117](https://github.com/go-to-k/cdk-real-drift/issues/1117)) ([d146f2b](https://github.com/go-to-k/cdk-real-drift/commit/d146f2b67d20556a44ca3b6f1b35e59ae1527dd2))
* **check:** guard top-level --json stringify against non-serializable finding values ([#1060](https://github.com/go-to-k/cdk-real-drift/issues/1060)) ([#1129](https://github.com/go-to-k/cdk-real-drift/issues/1129)) ([b88a085](https://github.com/go-to-k/cdk-real-drift/commit/b88a08549451a3637f3f10e8a1aebb4d34e3c970))
* **noise:** fold Chatbot GuardrailPolicies per-partition via array-valued CONTEXT_ARN_DEFAULTS ([#1120](https://github.com/go-to-k/cdk-real-drift/issues/1120)) ([e68a6a8](https://github.com/go-to-k/cdk-real-drift/commit/e68a6a83a74d2d9fc8d24791607ae2a0811ff73c))
* **read:** readLambdaPermission throws ResourceGoneError on exact-Sid miss ([#1084](https://github.com/go-to-k/cdk-real-drift/issues/1084)) ([#1119](https://github.com/go-to-k/cdk-real-drift/issues/1119)) ([e15d162](https://github.com/go-to-k/cdk-real-drift/commit/e15d162cc8730c1b0a30ddc2eb5bada6c1f2b970))
* **read:** route enumerator fails safe on UNRESOLVED DestinationCidrBlock ([#1082](https://github.com/go-to-k/cdk-real-drift/issues/1082)) ([#1118](https://github.com/go-to-k/cdk-real-drift/issues/1118)) ([34113d7](https://github.com/go-to-k/cdk-real-drift/commit/34113d7ccb95865cbe960c2032556dd9cf31177e))
* **report:** escape Unicode bidi/zero-width controls in sanitizeForTerminal ([#1058](https://github.com/go-to-k/cdk-real-drift/issues/1058)) ([#1116](https://github.com/go-to-k/cdk-real-drift/issues/1116)) ([0a0cc74](https://github.com/go-to-k/cdk-real-drift/commit/0a0cc746f89d7cbcc6ef3dc73c4a76197b52d104))
* **schema:** resolve $ref and descend oneOf/anyOf/allOf when collecting schema defaults ([#1068](https://github.com/go-to-k/cdk-real-drift/issues/1068), [#1069](https://github.com/go-to-k/cdk-real-drift/issues/1069)) ([#1126](https://github.com/go-to-k/cdk-real-drift/issues/1126)) ([2d3b6e1](https://github.com/go-to-k/cdk-real-drift/commit/2d3b6e1a1228576e09bb9eb6008af762498a7385))

## [0.4.21](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.20...v0.4.21) (2026-07-10)


### Bug Fixes

* **cli:** emit [] under --json on unknown-command exit path ([#1063](https://github.com/go-to-k/cdk-real-drift/issues/1063)) ([#1115](https://github.com/go-to-k/cdk-real-drift/issues/1115)) ([4ca58e8](https://github.com/go-to-k/cdk-real-drift/commit/4ca58e8e01350c1e94428dea3dc47fb6da88b221))
* **normalize:** stringify numeric/boolean Fn::FindInMap key arguments so numeric-keyed maps resolve ([#1121](https://github.com/go-to-k/cdk-real-drift/issues/1121)) ([ba2437b](https://github.com/go-to-k/cdk-real-drift/commit/ba2437ba96171e4a852bd71a2edea24492127ea5))
* **revert)+fix(noise:** ClientVpnEndpoint revert-op isolation (F2) + TagSpecifications readGap (F3) ([#1102](https://github.com/go-to-k/cdk-real-drift/issues/1102)) ([#1114](https://github.com/go-to-k/cdk-real-drift/issues/1114)) ([9119e49](https://github.com/go-to-k/cdk-real-drift/commit/9119e4990bf202c8c7f30b91661b9346c10c316a))

## [0.4.20](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.19...v0.4.20) (2026-07-10)


### Bug Fixes

* **noise:** fold ClientVpnEndpoint SessionTimeoutHours=24 + TransportProtocol=udp first-run defaults ([#1102](https://github.com/go-to-k/cdk-real-drift/issues/1102)) ([#1113](https://github.com/go-to-k/cdk-real-drift/issues/1113)) ([616cdf0](https://github.com/go-to-k/cdk-real-drift/commit/616cdf0e78de79b9b362b68402ad408a106240f9))
* **tooling:** sweep-orphans skips already-deleted tagged resources (RGT index lag) ([#1112](https://github.com/go-to-k/cdk-real-drift/issues/1112)) ([21e9793](https://github.com/go-to-k/cdk-real-drift/commit/21e979336ba1e309d416497a726a8476f85c6281))

## [0.4.19](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.18...v0.4.19) (2026-07-10)


### Bug Fixes

* **read:** enumerate REST API Stages so an out-of-band create-stage is not invisible ([#1044](https://github.com/go-to-k/cdk-real-drift/issues/1044)) ([#1111](https://github.com/go-to-k/cdk-real-drift/issues/1111)) ([e45c8c4](https://github.com/go-to-k/cdk-real-drift/commit/e45c8c4c22231e5b441c131fde81b997975ad20d))

## [0.4.18](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.17...v0.4.18) (2026-07-10)


### Bug Fixes

* **report:** activate --pre-deploy pending-creation footer (follow-up [#883](https://github.com/go-to-k/cdk-real-drift/issues/883)) ([#1110](https://github.com/go-to-k/cdk-real-drift/issues/1110)) ([55c7d7e](https://github.com/go-to-k/cdk-real-drift/commit/55c7d7e56d58e331e6cac31507e94eaf2dd707d8))

## [0.4.17](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.16...v0.4.17) (2026-07-10)


### Bug Fixes

* **synth:** decode cdk.json BOM/UTF-16 and surface a parse error instead of the misleading 'no CDK app' ([#1076](https://github.com/go-to-k/cdk-real-drift/issues/1076)) ([#1108](https://github.com/go-to-k/cdk-real-drift/issues/1108)) ([a5bf71f](https://github.com/go-to-k/cdk-real-drift/commit/a5bf71f515db7c1175cf39731dedc3e94538a15b))

## [0.4.16](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.15...v0.4.16) (2026-07-10)


### Bug Fixes

* **schema:** honor registry propertyTransform (JSONata) to close declared-echo FP class ([#881](https://github.com/go-to-k/cdk-real-drift/issues/881)) ([#1107](https://github.com/go-to-k/cdk-real-drift/issues/1107)) ([8e62961](https://github.com/go-to-k/cdk-real-drift/commit/8e62961d418175f2f99d20f0a6cd8a9c071e6bc3))

## [0.4.15](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.14...v0.4.15) (2026-07-10)


### Bug Fixes

* **read:** connection + request timeouts on every AWS client — no more forever-hang ([#1066](https://github.com/go-to-k/cdk-real-drift/issues/1066)) ([#1106](https://github.com/go-to-k/cdk-real-drift/issues/1106)) ([b61493b](https://github.com/go-to-k/cdk-real-drift/commit/b61493bc5521d32750fb1d37fb55a420fc7c8630))

## [0.4.14](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.13...v0.4.14) (2026-07-10)


### Bug Fixes

* **normalize:** nested unordered-array sort missing from the live normalizer ([#808](https://github.com/go-to-k/cdk-real-drift/issues/808)) ([#1103](https://github.com/go-to-k/cdk-real-drift/issues/1103)) ([30ebc85](https://github.com/go-to-k/cdk-real-drift/commit/30ebc852c7a92862fec5d244fe7567da06bc363f))
* **read:** API Gateway custom-domain mappings silently skipped ([#855](https://github.com/go-to-k/cdk-real-drift/issues/855)) ([#1101](https://github.com/go-to-k/cdk-real-drift/issues/1101)) ([4b0fde4](https://github.com/go-to-k/cdk-real-drift/commit/4b0fde4dd0f8887b40bc088e9c66f231fe8bbfe9))
* **read:** project Tags in readCodeBuildProject so a declared-tags Project is not a false drift ([#1056](https://github.com/go-to-k/cdk-real-drift/issues/1056)) ([#1105](https://github.com/go-to-k/cdk-real-drift/issues/1105)) ([4b88635](https://github.com/go-to-k/cdk-real-drift/commit/4b886353480dbeea2bb1531185b959a4421a7be2))
* **synth:** sibling context-lookup failure aborts named-stack check ([#905](https://github.com/go-to-k/cdk-real-drift/issues/905)) ([#1104](https://github.com/go-to-k/cdk-real-drift/issues/1104)) ([9390603](https://github.com/go-to-k/cdk-real-drift/commit/93906039e18545c8074fea82e4d4c80230d691e6))

## [0.4.13](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.12...v0.4.13) (2026-07-10)


### Bug Fixes

* ACM Certificate folds ([#1090](https://github.com/go-to-k/cdk-real-drift/issues/1090)) + [#845](https://github.com/go-to-k/cdk-real-drift/issues/845) sibling-shape folds ([#1094](https://github.com/go-to-k/cdk-real-drift/issues/1094)) ([#1099](https://github.com/go-to-k/cdk-real-drift/issues/1099)) ([152f117](https://github.com/go-to-k/cdk-real-drift/commit/152f1173e774fe541a029c27314c261fece6abc5))
* **check:** whole-stack skips escape --strict exit aggregation ([#948](https://github.com/go-to-k/cdk-real-drift/issues/948)) ([#1022](https://github.com/go-to-k/cdk-real-drift/issues/1022)) ([7de287f](https://github.com/go-to-k/cdk-real-drift/commit/7de287ff42d8535586ce4e7a7ba46de4043c3078))
* **cli:** route swallowed signals/rejections to real exit codes (SIGTERM 143, unhandled error 2) ([#951](https://github.com/go-to-k/cdk-real-drift/issues/951)) ([#1100](https://github.com/go-to-k/cdk-real-drift/issues/1100)) ([fc7627d](https://github.com/go-to-k/cdk-real-drift/commit/fc7627da510747e7b064c4a3a94050698c86a45f))
* **commands:** region in per-finding decision prompts ([#1097](https://github.com/go-to-k/cdk-real-drift/issues/1097)) ([#1098](https://github.com/go-to-k/cdk-real-drift/issues/1098)) ([189dfa0](https://github.com/go-to-k/cdk-real-drift/commit/189dfa0ef15c9a4d3c589b493b4f76c0d5a65dcb))
* **normalize:** {Condition: name} in property position is literal data ([#783](https://github.com/go-to-k/cdk-real-drift/issues/783)) ([#1026](https://github.com/go-to-k/cdk-real-drift/issues/1026)) ([efb7a5a](https://github.com/go-to-k/cdk-real-drift/commit/efb7a5a7f5e1494492bef8f2379e1e610178cd61))
* **read:** Aurora AAS read-replicas falsely 'added' ([#801](https://github.com/go-to-k/cdk-real-drift/issues/801)) ([#1030](https://github.com/go-to-k/cdk-real-drift/issues/1030)) ([3d28e20](https://github.com/go-to-k/cdk-real-drift/commit/3d28e2012589a9153f07647af03526beb4545fb2))
* **report:** --pre-deploy pending-creation footer + deploy-will-delete surface ([#883](https://github.com/go-to-k/cdk-real-drift/issues/883)) ([#1032](https://github.com/go-to-k/cdk-real-drift/issues/1032)) ([f079227](https://github.com/go-to-k/cdk-real-drift/commit/f079227ede982a126fc887dff8dde2c18f8b1010))
* **synth:** surface silent context lookups + cdk.context.json write ([#906](https://github.com/go-to-k/cdk-real-drift/issues/906)) ([#1037](https://github.com/go-to-k/cdk-real-drift/issues/1037)) ([0af729c](https://github.com/go-to-k/cdk-real-drift/commit/0af729c8940cebb7bc77d89b64d62577ae8e0e09))

## [0.4.12](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.11...v0.4.12) (2026-07-10)


### Bug Fixes

* **baseline:** baselineValueMatches reflexivity for free-form JSON/policy string values ([#807](https://github.com/go-to-k/cdk-real-drift/issues/807)) ([#1020](https://github.com/go-to-k/cdk-real-drift/issues/1020)) ([ae427fd](https://github.com/go-to-k/cdk-real-drift/commit/ae427fd43382764c57b9848c12eec8fe5f83d54f))

## [0.4.11](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.10...v0.4.11) (2026-07-09)


### Bug Fixes

* **noise:** fold EKS first-run defaults (ServiceIpv4Cidr / Version / AddonVersion) ([#979](https://github.com/go-to-k/cdk-real-drift/issues/979)) ([#1041](https://github.com/go-to-k/cdk-real-drift/issues/1041)) ([1687677](https://github.com/go-to-k/cdk-real-drift/commit/1687677b44514878b0e1e0a76550fc5f999e69ec))

## [0.4.10](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.9...v0.4.10) (2026-07-09)


### Bug Fixes

* **noise:** fold Valkey ReplicationGroup first-run defaults ([#818](https://github.com/go-to-k/cdk-real-drift/issues/818)) ([#1040](https://github.com/go-to-k/cdk-real-drift/issues/1040)) ([30a01fc](https://github.com/go-to-k/cdk-real-drift/commit/30a01fc4542b305e965c9fe3109adc228cc33b39))

## [0.4.9](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.8...v0.4.9) (2026-07-09)


### Bug Fixes

* **diff:** surface out-of-band IAM Condition operators — gate emitNested's aws:* map drop ([#863](https://github.com/go-to-k/cdk-real-drift/issues/863)) ([#1039](https://github.com/go-to-k/cdk-real-drift/issues/1039)) ([e061f41](https://github.com/go-to-k/cdk-real-drift/commit/e061f41b94e6e137137fcd8fb64aa849a3732413))

## [0.4.8](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.7...v0.4.8) (2026-07-09)


### Bug Fixes

* **cli:** honor AWS_DEFAULT_PROFILE so SDK clients match the synth identity ([#953](https://github.com/go-to-k/cdk-real-drift/issues/953)) ([#1038](https://github.com/go-to-k/cdk-real-drift/issues/1038)) ([1f62745](https://github.com/go-to-k/cdk-real-drift/commit/1f627456a1f5031c8c7f4434864e421aac4b0404))

## [0.4.7](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.6...v0.4.7) (2026-07-09)


### Bug Fixes

* **revert:** ApiGatewayV2 Stage revert can clear AccessLogSettings/StageVariables ([#806](https://github.com/go-to-k/cdk-real-drift/issues/806)) ([#1031](https://github.com/go-to-k/cdk-real-drift/issues/1031)) ([1505fb3](https://github.com/go-to-k/cdk-real-drift/commit/1505fb3c191608d1c2664232d5b02004abd24cff))

## [0.4.6](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.5...v0.4.6) (2026-07-09)


### Bug Fixes

* **commands:** mirror the AWS-CLI/cdk region fallbacks in resolveProfileRegion ([#955](https://github.com/go-to-k/cdk-real-drift/issues/955)) ([#1036](https://github.com/go-to-k/cdk-real-drift/issues/1036)) ([cda55dc](https://github.com/go-to-k/cdk-real-drift/commit/cda55dc0ce89b647bec91d95102fb3bf52b3090f))

## [0.4.5](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.4...v0.4.5) (2026-07-09)


### Bug Fixes

* **noise:** fold RedshiftServerless ([#958](https://github.com/go-to-k/cdk-real-drift/issues/958)) + MSK::Cluster ([#977](https://github.com/go-to-k/cdk-real-drift/issues/977)) first-run defaults ([#1035](https://github.com/go-to-k/cdk-real-drift/issues/1035)) ([8e18834](https://github.com/go-to-k/cdk-real-drift/commit/8e18834820341923a2abc25aeb812cd83c098bb1))

## [0.4.4](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.3...v0.4.4) (2026-07-09)


### Bug Fixes

* **diff:** fold derivable tier-3 policy residue ([#894](https://github.com/go-to-k/cdk-real-drift/issues/894)) ([#1034](https://github.com/go-to-k/cdk-real-drift/issues/1034)) ([4c2db62](https://github.com/go-to-k/cdk-real-drift/commit/4c2db62a1bc0cc67ea99512a163026ed3b5038a8))

## [0.4.3](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.2...v0.4.3) (2026-07-09)


### Bug Fixes

* **cli:** gate interactivity on both stdin AND stdout being a TTY ([#869](https://github.com/go-to-k/cdk-real-drift/issues/869)) ([#1033](https://github.com/go-to-k/cdk-real-drift/issues/1033)) ([ea69785](https://github.com/go-to-k/cdk-real-drift/commit/ea6978503cf98ace25ccee22bf768756545a97c3))

## [0.4.2](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.1...v0.4.2) (2026-07-09)


### Bug Fixes

* **cli:** interrupt during the gather spinner exits 130, never 0 ([#950](https://github.com/go-to-k/cdk-real-drift/issues/950)) ([#1029](https://github.com/go-to-k/cdk-real-drift/issues/1029)) ([180ab88](https://github.com/go-to-k/cdk-real-drift/commit/180ab88c24582479f699a8e4c22842e87c5cf2b1))

## [0.4.1](https://github.com/go-to-k/cdk-real-drift/compare/v0.4.0...v0.4.1) (2026-07-09)


### Bug Fixes

* **revert:** writer-routed KNOWN_DEFAULTS now converge on revert ([#912](https://github.com/go-to-k/cdk-real-drift/issues/912)) ([#1019](https://github.com/go-to-k/cdk-real-drift/issues/1019)) ([cf781ae](https://github.com/go-to-k/cdk-real-drift/commit/cf781ae2ce7c4d4a47699fffc5d3234544b4fc91))

# [0.4.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.14...v0.4.0) (2026-07-09)


### Features

* **read:** SDK read override for ACM Certificate ([#974](https://github.com/go-to-k/cdk-real-drift/issues/974)) ([#1024](https://github.com/go-to-k/cdk-real-drift/issues/1024)) ([cdd4910](https://github.com/go-to-k/cdk-real-drift/commit/cdd4910b2a5652447b7b714368b3683ffe02f90e))

## [0.3.14](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.13...v0.3.14) (2026-07-09)


### Bug Fixes

* **diff:** fold derived first-run echoes (CodeBuild/Secrets/NLB/MQ/Firehose) ([#845](https://github.com/go-to-k/cdk-real-drift/issues/845)) ([#1027](https://github.com/go-to-k/cdk-real-drift/issues/1027)) ([c845192](https://github.com/go-to-k/cdk-real-drift/commit/c845192757aff578c0fac16792b2e89c20bae4ab))

## [0.3.13](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.12...v0.3.13) (2026-07-09)


### Bug Fixes

* **noise:** fold GuardDuty Detector first-run defaults ([#879](https://github.com/go-to-k/cdk-real-drift/issues/879)) + Cognito UserPoolClient sorted attribute lists ([#875](https://github.com/go-to-k/cdk-real-drift/issues/875)) ([#1021](https://github.com/go-to-k/cdk-real-drift/issues/1021)) ([309ecf6](https://github.com/go-to-k/cdk-real-drift/commit/309ecf6f54a37e12ba88d77283567b39fd4b42d4))

## [0.3.12](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.11...v0.3.12) (2026-07-09)


### Bug Fixes

* **commands:** region in per-stack decision prompts ([#947](https://github.com/go-to-k/cdk-real-drift/issues/947)) ([#1023](https://github.com/go-to-k/cdk-real-drift/issues/1023)) ([f254242](https://github.com/go-to-k/cdk-real-drift/commit/f25424297e2c67d4e7bb829284dfb57235a12700))

## [0.3.11](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.10...v0.3.11) (2026-07-09)


### Bug Fixes

* **check:** schema-v1 baseline warning vanished under --json ([#944](https://github.com/go-to-k/cdk-real-drift/issues/944)) ([#1018](https://github.com/go-to-k/cdk-real-drift/issues/1018)) ([f59d6c9](https://github.com/go-to-k/cdk-real-drift/commit/f59d6c9bf1765df0e687b0aa4c103e7d462aa316))
* **read:** supplementLexBot no longer swallows lexv2 failures ([#964](https://github.com/go-to-k/cdk-real-drift/issues/964)) ([#1017](https://github.com/go-to-k/cdk-real-drift/issues/1017)) ([540eac1](https://github.com/go-to-k/cdk-real-drift/commit/540eac17927893d0c8c0ae35c5f762d115275ea6))
* **read:** transient kms:ListAliases warns transient, does not poison the region dedupe ([#963](https://github.com/go-to-k/cdk-real-drift/issues/963)) ([#1014](https://github.com/go-to-k/cdk-real-drift/issues/1014)) ([3e68b3e](https://github.com/go-to-k/cdk-real-drift/commit/3e68b3e930a801680e12159284bead6fda6b8deb))
* **read:** UNRESOLVED parent-ref fail-safe across child enumerators ([#962](https://github.com/go-to-k/cdk-real-drift/issues/962)) ([#1016](https://github.com/go-to-k/cdk-real-drift/issues/1016)) ([525426b](https://github.com/go-to-k/cdk-real-drift/commit/525426bd340957bee12651d1aa76e7bea083db54))
* **revert:** nullHuskRemovalOps positional array-remove index shift deletes wrong element ([#968](https://github.com/go-to-k/cdk-real-drift/issues/968)) ([#1015](https://github.com/go-to-k/cdk-real-drift/issues/1015)) ([c6babbb](https://github.com/go-to-k/cdk-real-drift/commit/c6babbb4cdcd72a212aa83df0a9d3aa7a6c97e19))

## [0.3.11](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.10...v0.3.11) (2026-07-09)


### Bug Fixes

* **read:** transient kms:ListAliases warns transient, does not poison the region dedupe ([#963](https://github.com/go-to-k/cdk-real-drift/issues/963)) ([#1014](https://github.com/go-to-k/cdk-real-drift/issues/1014)) ([3e68b3e](https://github.com/go-to-k/cdk-real-drift/commit/3e68b3e930a801680e12159284bead6fda6b8deb))
* **read:** UNRESOLVED parent-ref fail-safe across child enumerators ([#962](https://github.com/go-to-k/cdk-real-drift/issues/962)) ([#1016](https://github.com/go-to-k/cdk-real-drift/issues/1016)) ([525426b](https://github.com/go-to-k/cdk-real-drift/commit/525426bd340957bee12651d1aa76e7bea083db54))
* **revert:** nullHuskRemovalOps positional array-remove index shift deletes wrong element ([#968](https://github.com/go-to-k/cdk-real-drift/issues/968)) ([#1015](https://github.com/go-to-k/cdk-real-drift/issues/1015)) ([c6babbb](https://github.com/go-to-k/cdk-real-drift/commit/c6babbb4cdcd72a212aa83df0a9d3aa7a6c97e19))

## [0.3.10](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.9...v0.3.10) (2026-07-09)


### Bug Fixes

* **check:** make hasBaselineForStack region-aware ([#942](https://github.com/go-to-k/cdk-real-drift/issues/942)) ([#1006](https://github.com/go-to-k/cdk-real-drift/issues/1006)) ([f0616c1](https://github.com/go-to-k/cdk-real-drift/commit/f0616c196b261b2edba7611d589881f65ad01864))
* **config:** an added-tier ignore rule must not subtree-walk over a sibling resource ([#990](https://github.com/go-to-k/cdk-real-drift/issues/990)) ([#1007](https://github.com/go-to-k/cdk-real-drift/issues/1007)) ([b4ba0d3](https://github.com/go-to-k/cdk-real-drift/commit/b4ba0d3ccd0cfe20fdfb072e34d7e8cd429f0ca3))
* **noise:** fold CFn-generated SecurityGroup GroupName as generated ([#888](https://github.com/go-to-k/cdk-real-drift/issues/888)) ([#1010](https://github.com/go-to-k/cdk-real-drift/issues/1010)) ([988000b](https://github.com/go-to-k/cdk-real-drift/commit/988000bead07259e856fe2ec72b3641b24fbd714))

## [0.3.9](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.8...v0.3.9) (2026-07-09)


### Bug Fixes

* **read:** Events::Rule on a custom event bus is silently skipped ([#973](https://github.com/go-to-k/cdk-real-drift/issues/973)) ([#1003](https://github.com/go-to-k/cdk-real-drift/issues/1003)) ([93be820](https://github.com/go-to-k/cdk-real-drift/commit/93be8201ee9948877a16c1648b648b014e50a5fe))
* **read:** out-of-band deleted IAM AccessKey / AppSync ApiKey reach the deleted tier ([#965](https://github.com/go-to-k/cdk-real-drift/issues/965)) ([#1001](https://github.com/go-to-k/cdk-real-drift/issues/1001)) ([8d95a26](https://github.com/go-to-k/cdk-real-drift/commit/8d95a26395e17a78ad141e64ef5bf70e1cea2cc4))
* **revert:** DocDB + ClientVpn selective writers drop remove ops ([#984](https://github.com/go-to-k/cdk-real-drift/issues/984)) ([#1002](https://github.com/go-to-k/cdk-real-drift/issues/1002)) ([02b2886](https://github.com/go-to-k/cdk-real-drift/commit/02b2886aef69213aa192ad868e1118c01b8f79cf))

## [0.3.8](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.7...v0.3.8) (2026-07-09)


### Bug Fixes

* **record,ignore:** commit-nudge footer under a partial multi-stack failure ([#949](https://github.com/go-to-k/cdk-real-drift/issues/949)) ([#1009](https://github.com/go-to-k/cdk-real-drift/issues/1009)) ([09232d0](https://github.com/go-to-k/cdk-real-drift/commit/09232d0c29654df7e64be1765fd609d0e015ec48))
* **synth:** warn on ignored -c/--context for an assembly-dir --app ([#956](https://github.com/go-to-k/cdk-real-drift/issues/956)) ([#1008](https://github.com/go-to-k/cdk-real-drift/issues/1008)) ([a9a8c01](https://github.com/go-to-k/cdk-real-drift/commit/a9a8c01d0dc950c141355d7ec342e119fea720d6))

## [0.3.7](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.6...v0.3.7) (2026-07-09)


### Bug Fixes

* **check:** case-insensitive hasBaselineForStack (deleted-detector FN) ([#986](https://github.com/go-to-k/cdk-real-drift/issues/986)) ([#1005](https://github.com/go-to-k/cdk-real-drift/issues/1005)) ([67d8fa3](https://github.com/go-to-k/cdk-real-drift/commit/67d8fa383b87c61136c399379c42f4536d0f2a09))

## [0.3.6](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.5...v0.3.6) (2026-07-09)


### Bug Fixes

* **ci:** build before test so the json-empty dist-spawn test finds dist/cli.js ([#1004](https://github.com/go-to-k/cdk-real-drift/issues/1004)) ([57ec1c8](https://github.com/go-to-k/cdk-real-drift/commit/57ec1c8ca0d73d2ae9b820109937848f948b9483))

## [0.3.5](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.4...v0.3.5) (2026-07-09)


### Bug Fixes

* **cli:** close empty-JSON-on-error holes across all 4 verbs ([#943](https://github.com/go-to-k/cdk-real-drift/issues/943), [#988](https://github.com/go-to-k/cdk-real-drift/issues/988), [#989](https://github.com/go-to-k/cdk-real-drift/issues/989)) ([#1000](https://github.com/go-to-k/cdk-real-drift/issues/1000)) ([d8a8f51](https://github.com/go-to-k/cdk-real-drift/commit/d8a8f519e43efa081345253687f28c16058773d7))

## [0.3.4](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.3...v0.3.4) (2026-07-09)


### Bug Fixes

* **diff:** derive partition from shared partitionForRegion in classify.ts ([#945](https://github.com/go-to-k/cdk-real-drift/issues/945)) ([#999](https://github.com/go-to-k/cdk-real-drift/issues/999)) ([14417dd](https://github.com/go-to-k/cdk-real-drift/commit/14417dd8d3a96ca573b1af46eb9a107a66ab0463))

## [0.3.3](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.2...v0.3.3) (2026-07-09)


### Bug Fixes

* **config:** re-validate rules in addIgnoreRules before writing ([#991](https://github.com/go-to-k/cdk-real-drift/issues/991)) ([#997](https://github.com/go-to-k/cdk-real-drift/issues/997)) ([c1a1801](https://github.com/go-to-k/cdk-real-drift/commit/c1a1801ec32610cf107b99b34ddcca74a812233a))
* **read:** ClientVPN endpoint-not-found → deleted tier ([#966](https://github.com/go-to-k/cdk-real-drift/issues/966)) ([#994](https://github.com/go-to-k/cdk-real-drift/issues/994)) ([f06a560](https://github.com/go-to-k/cdk-real-drift/commit/f06a560c4cc789f421355f09e69e6c1902a81e62))
* **synth:** recursive nested-assembly missing-context aggregation ([#987](https://github.com/go-to-k/cdk-real-drift/issues/987)) ([#998](https://github.com/go-to-k/cdk-real-drift/issues/998)) ([d4a9cf7](https://github.com/go-to-k/cdk-real-drift/commit/d4a9cf7c08d7faa3ac1f3230110ac37cd3f37b6b))

## [0.3.2](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.1...v0.3.2) (2026-07-09)


### Bug Fixes

* **noise:** move ScheduledAction EndTime fold from tier-3 to tier-1 constant ([#946](https://github.com/go-to-k/cdk-real-drift/issues/946)) ([#996](https://github.com/go-to-k/cdk-real-drift/issues/996)) ([84156b2](https://github.com/go-to-k/cdk-real-drift/commit/84156b2bcecd4769ab287d06c8775691befbf6b1))

## [0.3.1](https://github.com/go-to-k/cdk-real-drift/compare/v0.3.0...v0.3.1) (2026-07-09)


### Bug Fixes

* **config:** ignore-rule '/'-subtree coverage (parent rule + added ARN ids) ([#903](https://github.com/go-to-k/cdk-real-drift/issues/903)) ([#993](https://github.com/go-to-k/cdk-real-drift/issues/993)) ([4ca9040](https://github.com/go-to-k/cdk-real-drift/commit/4ca90408417c49ba3ff3770894bd6bc25a4df54a))

# [0.3.0](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.79...v0.3.0) (2026-07-09)


### Features

* **report:** implement the --json output contract for record/ignore/revert ([#868](https://github.com/go-to-k/cdk-real-drift/issues/868)) ([#983](https://github.com/go-to-k/cdk-real-drift/issues/983)) ([f20b210](https://github.com/go-to-k/cdk-real-drift/commit/f20b21079b5bc67c10c7d258605a7f6c65ee3c31))

## [0.2.79](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.78...v0.2.79) (2026-07-09)


### Bug Fixes

* **cli:** flush stdout before process.exit so piped output is not truncated at 64KiB ([#866](https://github.com/go-to-k/cdk-real-drift/issues/866)) ([#982](https://github.com/go-to-k/cdk-real-drift/issues/982)) ([224e32b](https://github.com/go-to-k/cdk-real-drift/commit/224e32b142f133a6aec33693ae0cef9292935dcc))

## [0.2.78](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.77...v0.2.78) (2026-07-09)


### Bug Fixes

* **diff:** unmask declared-false/live-true drift for truthy-boolean KNOWN_DEFAULTS pins ([#929](https://github.com/go-to-k/cdk-real-drift/issues/929)) ([#934](https://github.com/go-to-k/cdk-real-drift/issues/934)) ([0a41d9f](https://github.com/go-to-k/cdk-real-drift/commit/0a41d9fb2a511aac590e068403defd4eb8f1e95e))
* **noise:** fold Lambda Function URL Cors AllowHeaders/ExposeHeaders case-insensitively ([#874](https://github.com/go-to-k/cdk-real-drift/issues/874)) ([#933](https://github.com/go-to-k/cdk-real-drift/issues/933)) ([b77b18b](https://github.com/go-to-k/cdk-real-drift/commit/b77b18bc3ccd064086331eb7d53831225589dcaf))
* **revert:** bar Cloud Control update revert for types with no update handler ([#908](https://github.com/go-to-k/cdk-real-drift/issues/908)) ([#937](https://github.com/go-to-k/cdk-real-drift/issues/937)) ([768a0cb](https://github.com/go-to-k/cdk-real-drift/commit/768a0cba6656e3733f01b1945dd6b6d50ae60cf3))

## [0.2.77](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.76...v0.2.77) (2026-07-09)


### Bug Fixes

* **baseline:** complete identity guards (stackName/region/record-account/schemaVersion) ([#870](https://github.com/go-to-k/cdk-real-drift/issues/870)) ([#940](https://github.com/go-to-k/cdk-real-drift/issues/940)) ([de96d4a](https://github.com/go-to-k/cdk-real-drift/commit/de96d4aea36972918f19b6d48830534e5b68df3d))
* **noise:** fold first-run FP defaults — SG IpProtocol, S3 AccessPoint, ImageBuilder ([#877](https://github.com/go-to-k/cdk-real-drift/issues/877), [#919](https://github.com/go-to-k/cdk-real-drift/issues/919), [#911](https://github.com/go-to-k/cdk-real-drift/issues/911)) ([#939](https://github.com/go-to-k/cdk-real-drift/issues/939)) ([c334b48](https://github.com/go-to-k/cdk-real-drift/commit/c334b4818ecdec413ed4076f48b14f10ecad4304))
* **synth:** surface missing-context dummy lookup values (--pre-deploy) ([#907](https://github.com/go-to-k/cdk-real-drift/issues/907)) ([#938](https://github.com/go-to-k/cdk-real-drift/issues/938)) ([0940535](https://github.com/go-to-k/cdk-real-drift/commit/0940535742fe7e77b6c7dabf3cacc53d880fb3d4))

## [0.2.76](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.75...v0.2.76) (2026-07-09)


### Bug Fixes

* **read:** fold RDS Multi-AZ DB cluster implicit member instances, not 'added' ([#896](https://github.com/go-to-k/cdk-real-drift/issues/896)) ([#935](https://github.com/go-to-k/cdk-real-drift/issues/935)) ([2f6cf54](https://github.com/go-to-k/cdk-real-drift/commit/2f6cf540ad194064c7ae0253682a45f72aa00e7c))

## [0.2.75](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.74...v0.2.75) (2026-07-09)


### Bug Fixes

* **read:** ApplicationAutoScaling ScalingPolicy flat-form declaration read-gap ([#836](https://github.com/go-to-k/cdk-real-drift/issues/836)) ([#932](https://github.com/go-to-k/cdk-real-drift/issues/932)) ([14514c1](https://github.com/go-to-k/cdk-real-drift/commit/14514c17fe6414f480f2d6d8cc50e536a6d7c9fa))

## [0.2.74](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.73...v0.2.74) (2026-07-09)


### Bug Fixes

* **desired:** explicit !!timestamp no longer resolves to a JS Date ([#909](https://github.com/go-to-k/cdk-real-drift/issues/909)) ([#936](https://github.com/go-to-k/cdk-real-drift/issues/936)) ([9b5446b](https://github.com/go-to-k/cdk-real-drift/commit/9b5446b263cc775fb0c2b7ca40bf946a75e8b80e))

## [0.2.73](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.72...v0.2.73) (2026-07-09)


### Bug Fixes

* **read:** ApiGatewayV2 Model/Deployment/IntegrationResponse composite CC ids ([#872](https://github.com/go-to-k/cdk-real-drift/issues/872)) ([#927](https://github.com/go-to-k/cdk-real-drift/issues/927)) ([f48c4b9](https://github.com/go-to-k/cdk-real-drift/commit/f48c4b91852d9a447e2666fa25b94f0a500e0866))
* **revert:** selective-update writers converge remove ops or bar honestly, not silently drop ([#913](https://github.com/go-to-k/cdk-real-drift/issues/913)) ([#928](https://github.com/go-to-k/cdk-real-drift/issues/928)) ([32e8bb2](https://github.com/go-to-k/cdk-real-drift/commit/32e8bb2bbb1d0a680ecb9732528c67aab1b98fbc))

## [0.2.72](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.71...v0.2.72) (2026-07-09)


### Bug Fixes

* **normalize:** harden Fn::Cidr — UNRESOLVED-arg crash + non-aligned ipBlock mis-resolution ([#926](https://github.com/go-to-k/cdk-real-drift/issues/926)) ([eb6c93a](https://github.com/go-to-k/cdk-real-drift/commit/eb6c93a14befeae2cd0a4abfc814a196fce447d0))

## [0.2.71](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.70...v0.2.71) (2026-07-09)


### Bug Fixes

* **noise:** fold first-run FP defaults for ServerCertificate Path, ApiGwV2 Route AuthType, ApplicationInsights CWEMonitorEnabled, LakeFormation Tag CatalogId ([#925](https://github.com/go-to-k/cdk-real-drift/issues/925)) ([87559a5](https://github.com/go-to-k/cdk-real-drift/commit/87559a5516684443cf89be31582cc12cbd7a6661))

## [0.2.70](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.69...v0.2.70) (2026-07-09)


### Bug Fixes

* **read:** GuardDuty::Filter composite CC identifier [DetectorId, Name] ([#878](https://github.com/go-to-k/cdk-real-drift/issues/878)) ([#924](https://github.com/go-to-k/cdk-real-drift/issues/924)) ([0e5e124](https://github.com/go-to-k/cdk-real-drift/commit/0e5e124ff98940765c6d1a5c4e4db507129cbc70))

## [0.2.69](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.68...v0.2.69) (2026-07-09)


### Bug Fixes

* **cleanup:** back sweep protection with authoritative stack membership + sentinel (age guard backstop) ([#900](https://github.com/go-to-k/cdk-real-drift/issues/900) follow-up) ([#922](https://github.com/go-to-k/cdk-real-drift/issues/922)) ([efd556a](https://github.com/go-to-k/cdk-real-drift/commit/efd556a1cc626091323c731c79aec2e92ebca664))

## [0.2.68](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.67...v0.2.68) (2026-07-09)


### Bug Fixes

* **check:** --json signals deleted-stack drift, keeps warnings on stderr, never empties stdout on error ([#871](https://github.com/go-to-k/cdk-real-drift/issues/871)) ([#921](https://github.com/go-to-k/cdk-real-drift/issues/921)) ([1e241ad](https://github.com/go-to-k/cdk-real-drift/commit/1e241adc300b8ca840e30de80c0ba1d3e5128067))
* **config:** escape literal */? when the ignore verb writes a finding path ([#917](https://github.com/go-to-k/cdk-real-drift/issues/917)) ([e06f52f](https://github.com/go-to-k/cdk-real-drift/commit/e06f52f220fda5f102ef494875c7a53308a20e3c))
* **noise:** fold AutoScaling ScheduledAction StartTime/EndTime first-run FPs ([#918](https://github.com/go-to-k/cdk-real-drift/issues/918)) ([f1f054c](https://github.com/go-to-k/cdk-real-drift/commit/f1f054cebdd9b743af9af616329cab42fa5ddc92))
* **synth:** pin QuietIoHost off CI-stdout so check --json stays pure JSON in CI ([#867](https://github.com/go-to-k/cdk-real-drift/issues/867)) ([#920](https://github.com/go-to-k/cdk-real-drift/issues/920)) ([aad5048](https://github.com/go-to-k/cdk-real-drift/commit/aad5048774887140ed7b2915ee461aeb87f2f156))

## [0.2.67](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.66...v0.2.67) (2026-07-09)


### Bug Fixes

* **revert:** derive EventBusPolicy ARN partition from region (GovCloud/China) ([#916](https://github.com/go-to-k/cdk-real-drift/issues/916)) ([b11b281](https://github.com/go-to-k/cdk-real-drift/commit/b11b281fd19b6ddff9e1e1a335557641ee7a4522))

## [0.2.66](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.65...v0.2.66) (2026-07-09)


### Bug Fixes

* **check:** emit '[]' for --json on a zero-stack app ([#885](https://github.com/go-to-k/cdk-real-drift/issues/885)) ([#898](https://github.com/go-to-k/cdk-real-drift/issues/898)) ([8157bdc](https://github.com/go-to-k/cdk-real-drift/commit/8157bdc971fafe25e291ec8fff6723fe57a2dcfa))
* **commands:** exact-name stack selection targets every same-named region instance ([#884](https://github.com/go-to-k/cdk-real-drift/issues/884)) ([#899](https://github.com/go-to-k/cdk-real-drift/issues/899)) ([ec90b0f](https://github.com/go-to-k/cdk-real-drift/commit/ec90b0fceef4f2ac586ec9dab009425b64d7e71f))

## [0.2.65](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.64...v0.2.65) (2026-07-09)


### Bug Fixes

* **config:** reject all-wildcard ignore paths and bound path globs at '/' ([#861](https://github.com/go-to-k/cdk-real-drift/issues/861)) ([25ec0ff](https://github.com/go-to-k/cdk-real-drift/commit/25ec0ff74f54a1c2a217164205a62159527ba66a))
* **desired:** restrict YAML 1.1 schema — no implicit Date, no single-letter Y/N booleans ([#860](https://github.com/go-to-k/cdk-real-drift/issues/860)) ([750c9fc](https://github.com/go-to-k/cdk-real-drift/commit/750c9fcf1ade8ce99056d1d5e73fa6fe05b103cf))
* **normalize:** harden intrinsic resolver (Fn::Sub/Fn::Join guards, Fn::GetAtt long-form string, Fn::Cidr) ([#859](https://github.com/go-to-k/cdk-real-drift/issues/859)) ([671397e](https://github.com/go-to-k/cdk-real-drift/commit/671397eb0fed909fd70a7dcf50a4a0d2cf85a6ef))

## [0.2.64](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.63...v0.2.64) (2026-07-09)


### Bug Fixes

* **revert:** paginate Lex structural-revert list calls (slot types / intents / slots) ([#753](https://github.com/go-to-k/cdk-real-drift/issues/753)) ([#838](https://github.com/go-to-k/cdk-real-drift/issues/838)) ([15415f1](https://github.com/go-to-k/cdk-real-drift/commit/15415f15756b26d768ccc965e223e037325086f3))

## [0.2.63](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.62...v0.2.63) (2026-07-09)


### Bug Fixes

* **read:** suppress added-tier findings for Body-defined (SpecRestApi) RestApis ([#714](https://github.com/go-to-k/cdk-real-drift/issues/714)) ([#827](https://github.com/go-to-k/cdk-real-drift/issues/827)) ([f3151c6](https://github.com/go-to-k/cdk-real-drift/commit/f3151c659ebcbc5d60e948c890b65989788cafdd))

## [0.2.62](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.61...v0.2.62) (2026-07-09)


### Bug Fixes

* **desired:** resolve Fn::GetAtt Nested.Outputs.X against the CC Outputs array ([#782](https://github.com/go-to-k/cdk-real-drift/issues/782)) ([#824](https://github.com/go-to-k/cdk-real-drift/issues/824)) ([6e05aa2](https://github.com/go-to-k/cdk-real-drift/commit/6e05aa2123a263b4b4328f9203dc9b2985c44070))
* **diff:** emit whole map for undeclared path-unsafe keys, mirroring the declared side ([#747](https://github.com/go-to-k/cdk-real-drift/issues/747)) ([#828](https://github.com/go-to-k/cdk-real-drift/issues/828)) ([ec145ba](https://github.com/go-to-k/cdk-real-drift/commit/ec145bae3dda921303b51cfa4d075ac82bda68b1))
* **ignore:** key added-tier ignore rules on the unique logicalId, not the label ([#802](https://github.com/go-to-k/cdk-real-drift/issues/802)) ([#826](https://github.com/go-to-k/cdk-real-drift/issues/826)) ([1e15d78](https://github.com/go-to-k/cdk-real-drift/commit/1e15d78017dad7d082894287cf5da90194e7c94d))
* **schema:** warn + do not cache an empty schema on DescribeType failure ([#751](https://github.com/go-to-k/cdk-real-drift/issues/751)) ([#825](https://github.com/go-to-k/cdk-real-drift/issues/825)) ([f6fe61e](https://github.com/go-to-k/cdk-real-drift/commit/f6fe61ed34240c90982464aba3ac4a6779bb58a3))

## [0.2.61](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.60...v0.2.61) (2026-07-09)


### Bug Fixes

* **noise:** fold RDS DBCluster BackupRetentionPeriod=1 + DBProxy IdleClientTimeout=1800 ([#717](https://github.com/go-to-k/cdk-real-drift/issues/717)) ([#837](https://github.com/go-to-k/cdk-real-drift/issues/837)) ([892829d](https://github.com/go-to-k/cdk-real-drift/commit/892829dbde762e20c0cae6ee0904bd1e083e72d4))

## [0.2.60](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.59...v0.2.60) (2026-07-09)


### Bug Fixes

* **baseline:** block snapshot-completeness for readGap resources ([#795](https://github.com/go-to-k/cdk-real-drift/issues/795)) ([#830](https://github.com/go-to-k/cdk-real-drift/issues/830)) ([9888206](https://github.com/go-to-k/cdk-real-drift/commit/9888206b2ba7775d1ab9afc62f984cd428f8cb64))
* **desired:** parse deployed YAML templates with the YAML 1.1 schema ([#785](https://github.com/go-to-k/cdk-real-drift/issues/785)) ([#831](https://github.com/go-to-k/cdk-real-drift/issues/831)) ([8a7ca13](https://github.com/go-to-k/cdk-real-drift/commit/8a7ca138610334a9bda5c6e56d2514d5c5bb4880))
* **read:** degrade a failed SDK supplement read to a loud readGap, not false declared drift ([#752](https://github.com/go-to-k/cdk-real-drift/issues/752)) ([#833](https://github.com/go-to-k/cdk-real-drift/issues/833)) ([3332be4](https://github.com/go-to-k/cdk-real-drift/commit/3332be4ee2208cd8eaaa17bc441d73234f43a36e))
* **revert:** dependency-aware bounded retry for delete-kind revert items ([#765](https://github.com/go-to-k/cdk-real-drift/issues/765)) ([#840](https://github.com/go-to-k/cdk-real-drift/issues/840)) ([095c598](https://github.com/go-to-k/cdk-real-drift/commit/095c598591a6c444358512da1702204266924c42))

## [0.2.59](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.58...v0.2.59) (2026-07-08)


### Bug Fixes

* **report:** sanitize live keys/ids/notes against control-char injection ([#829](https://github.com/go-to-k/cdk-real-drift/issues/829)) ([#848](https://github.com/go-to-k/cdk-real-drift/issues/848)) ([4c1aef3](https://github.com/go-to-k/cdk-real-drift/commit/4c1aef3730cedc16555b8d5c852b4642b672e0d3))

## [0.2.58](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.57...v0.2.58) (2026-07-08)


### Bug Fixes

* **check:** --pre-deploy --strict no longer false-fails on a locally-added resource ([#727](https://github.com/go-to-k/cdk-real-drift/issues/727)) ([#843](https://github.com/go-to-k/cdk-real-drift/issues/843)) ([563ed6d](https://github.com/go-to-k/cdk-real-drift/commit/563ed6df53d7dcce973daa8f969ea02e47f9a2b5))

## [0.2.57](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.56...v0.2.57) (2026-07-08)


### Bug Fixes

* **baseline:** recordedPhysicalIds cover zero-entry complete resources ([#674](https://github.com/go-to-k/cdk-real-drift/issues/674) void) ([#792](https://github.com/go-to-k/cdk-real-drift/issues/792)) ([#834](https://github.com/go-to-k/cdk-real-drift/issues/834)) ([ce3d446](https://github.com/go-to-k/cdk-real-drift/commit/ce3d44629450f895376b7d7ee6a24fbb628940c5))
* **check:** deleted stack + committed baseline = drift, not skipped ([#781](https://github.com/go-to-k/cdk-real-drift/issues/781)) ([#823](https://github.com/go-to-k/cdk-real-drift/issues/823)) ([cf2e814](https://github.com/go-to-k/cdk-real-drift/commit/cf2e814d694a536908af5c4ec13a10f482076434))
* **revert:** RFC6902 test preconditions guard CC index patches against stale-index writes ([#762](https://github.com/go-to-k/cdk-real-drift/issues/762)) ([#832](https://github.com/go-to-k/cdk-real-drift/issues/832)) ([714c022](https://github.com/go-to-k/cdk-real-drift/commit/714c022f810df4f31211cbfb0e39fdf88a874ed0))

## [0.2.56](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.55...v0.2.56) (2026-07-08)


### Bug Fixes

* **cli:** reject verb-inapplicable flags (record --dry-run et al) ([#780](https://github.com/go-to-k/cdk-real-drift/issues/780)) ([#822](https://github.com/go-to-k/cdk-real-drift/issues/822)) ([2f8c7ca](https://github.com/go-to-k/cdk-real-drift/commit/2f8c7ca122ec808b33d09b8906f3a112394ce050))

## [0.2.55](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.54...v0.2.55) (2026-07-08)


### Bug Fixes

* **record:** suppress commit footer when nothing was written ([#799](https://github.com/go-to-k/cdk-real-drift/issues/799)) ([#820](https://github.com/go-to-k/cdk-real-drift/issues/820)) ([fc6aac7](https://github.com/go-to-k/cdk-real-drift/commit/fc6aac7c3cae20030bca776329587b7271a049af))

## [0.2.54](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.53...v0.2.54) (2026-07-08)


### Bug Fixes

* **baseline:** validate baseline elements + guard reused-logicalId type mismatch ([#794](https://github.com/go-to-k/cdk-real-drift/issues/794), [#793](https://github.com/go-to-k/cdk-real-drift/issues/793)) ([#819](https://github.com/go-to-k/cdk-real-drift/issues/819)) ([6899829](https://github.com/go-to-k/cdk-real-drift/commit/68998290680d2b1505f78c35e3f545f9a28abc7f))

## [0.2.53](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.52...v0.2.53) (2026-07-08)


### Bug Fixes

* **config:** bracket-aware path glob + reject empty scope; doc glob semantics ([#777](https://github.com/go-to-k/cdk-real-drift/issues/777)) ([#817](https://github.com/go-to-k/cdk-real-drift/issues/817)) ([bb43bdf](https://github.com/go-to-k/cdk-real-drift/commit/bb43bdfb1fd8d4600fd0546416932a055ed58b75))

## [0.2.52](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.51...v0.2.52) (2026-07-08)


### Bug Fixes

* **check:** ROLLBACK_COMPLETE is not-checkable, not ok ([#787](https://github.com/go-to-k/cdk-real-drift/issues/787)) ([#816](https://github.com/go-to-k/cdk-real-drift/issues/816)) ([36e6509](https://github.com/go-to-k/cdk-real-drift/commit/36e65097f9aa30092ba1a33aa6c34a14aee47b34))

## [0.2.51](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.50...v0.2.51) (2026-07-08)


### Bug Fixes

* **baseline:** surface out-of-band removal of NESTED recorded values ([#749](https://github.com/go-to-k/cdk-real-drift/issues/749)) ([#809](https://github.com/go-to-k/cdk-real-drift/issues/809)) ([64c3bb3](https://github.com/go-to-k/cdk-real-drift/commit/64c3bb32f6079de0b9b08c539835654c1c3d2b44))
* **ignore:** stamp stack/account/region scope onto written ignore rules ([#757](https://github.com/go-to-k/cdk-real-drift/issues/757)) ([#810](https://github.com/go-to-k/cdk-real-drift/issues/810)) ([399b39e](https://github.com/go-to-k/cdk-real-drift/commit/399b39ef030b9046ff772c5c2db654fd8a8634ea))
* **report:** emit multi-stack --json as one valid JSON array; document the full contract ([#755](https://github.com/go-to-k/cdk-real-drift/issues/755)) ([#811](https://github.com/go-to-k/cdk-real-drift/issues/811)) ([618944c](https://github.com/go-to-k/cdk-real-drift/commit/618944c822dc6a43a286e817b72d82cfde1288ba))

## [0.2.50](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.49...v0.2.50) (2026-07-08)


### Bug Fixes

* **commands:** error on a glob stack arg that matches no stacks ([#778](https://github.com/go-to-k/cdk-real-drift/issues/778)) ([#815](https://github.com/go-to-k/cdk-real-drift/issues/815)) ([5e1fb04](https://github.com/go-to-k/cdk-real-drift/commit/5e1fb047054f6353873454ae31a8db66ac10b465))
* **desired:** key ImportValue exports cache by account+region, degrade on ListExports failure ([#784](https://github.com/go-to-k/cdk-real-drift/issues/784)) ([#814](https://github.com/go-to-k/cdk-real-drift/issues/814)) ([f41c7f2](https://github.com/go-to-k/cdk-real-drift/commit/f41c7f27b11bfc7f492089caf74c330e08d46c54))
* **read:** do not cache transient kms:ListAliases failures ([#789](https://github.com/go-to-k/cdk-real-drift/issues/789)) ([#813](https://github.com/go-to-k/cdk-real-drift/issues/813)) ([d278db5](https://github.com/go-to-k/cdk-real-drift/commit/d278db5b6e67cdd885cadee60a696cf8b8301c61))
* **schema:** key DescribeType schema cache by region ([#788](https://github.com/go-to-k/cdk-real-drift/issues/788)) ([#812](https://github.com/go-to-k/cdk-real-drift/issues/812)) ([6a8c103](https://github.com/go-to-k/cdk-real-drift/commit/6a8c1032b1d58350e09dcd2d9ebec0e2ef85be7d))

## [0.2.49](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.48...v0.2.49) (2026-07-08)


### Bug Fixes

* **diff:** numeric-string tolerance for matchesKnownDefault + unordered scalar sets ([#731](https://github.com/go-to-k/cdk-real-drift/issues/731)) ([#797](https://github.com/go-to-k/cdk-real-drift/issues/797)) ([d1bbc6d](https://github.com/go-to-k/cdk-real-drift/commit/d1bbc6d91fb698a39cdf3380f549dcb6f79c9693))

## [0.2.48](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.47...v0.2.48) (2026-07-08)


### Bug Fixes

* **read:** paginate unpaginated SDK override list readers ([#729](https://github.com/go-to-k/cdk-real-drift/issues/729)) ([#774](https://github.com/go-to-k/cdk-real-drift/issues/774)) ([3fc7ff3](https://github.com/go-to-k/cdk-real-drift/commit/3fc7ff3efdc58bdc323501e0fbd43e2ea5e3ff16))

## [0.2.47](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.46...v0.2.47) (2026-07-08)


### Bug Fixes

* **desired:** parameter-resolution batch — NoEcho default / SSM list param / NotificationARNs ([#744](https://github.com/go-to-k/cdk-real-drift/issues/744), [#745](https://github.com/go-to-k/cdk-real-drift/issues/745), [#746](https://github.com/go-to-k/cdk-real-drift/issues/746)) ([#773](https://github.com/go-to-k/cdk-real-drift/issues/773)) ([18726dd](https://github.com/go-to-k/cdk-real-drift/commit/18726dd02793ca68dd0718ca0f7260a6f53fb386))
* **read:** recognize service-specific not-found codes so deleted resources aren't downgraded to skipped ([#743](https://github.com/go-to-k/cdk-real-drift/issues/743)) ([#772](https://github.com/go-to-k/cdk-real-drift/issues/772)) ([5219620](https://github.com/go-to-k/cdk-real-drift/commit/52196208e10e23fdaf15206ba407e53afb4dacdd))

## [0.2.46](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.45...v0.2.46) (2026-07-08)


### Bug Fixes

* **read:** isManagedBySiblingStack fails CLOSED on an errored check — no DeleteResource from a throttle ([#754](https://github.com/go-to-k/cdk-real-drift/issues/754)) ([#771](https://github.com/go-to-k/cdk-real-drift/issues/771)) ([12b1cd4](https://github.com/go-to-k/cdk-real-drift/commit/12b1cd41c9a656885e5e6e64ded7d7e8bdd8e819))
* **revert:** toPointer splits dots only at bracket depth 0 — dotted identity in a bracket segment ([#748](https://github.com/go-to-k/cdk-real-drift/issues/748)) ([#770](https://github.com/go-to-k/cdk-real-drift/issues/770)) ([1fb6243](https://github.com/go-to-k/cdk-real-drift/commit/1fb6243af9f5085b4f098c3fbcf98d9e77aa0ee4))
* **synth:** honor GovCloud/ISO region pins — widen CONCRETE_REGION for multi-part infixes ([#742](https://github.com/go-to-k/cdk-real-drift/issues/742)) ([#768](https://github.com/go-to-k/cdk-real-drift/issues/768)) ([95f17f3](https://github.com/go-to-k/cdk-real-drift/commit/95f17f3416a3e07231a9585c508b40e4cbe00b8f))

## [0.2.45](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.44...v0.2.45) (2026-07-08)


### Bug Fixes

* **desired:** derive AWS::Partition / AWS::URLSuffix from the region ([#730](https://github.com/go-to-k/cdk-real-drift/issues/730)) ([#739](https://github.com/go-to-k/cdk-real-drift/issues/739)) ([6738626](https://github.com/go-to-k/cdk-real-drift/commit/673862639b3d77aeb5b88547739e4212a50993cd))

## [0.2.44](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.43...v0.2.44) (2026-07-08)


### Bug Fixes

* **read:** paginate isManagedBySiblingStack via ListStackResources (DescribeStackResources 100-cap, [#726](https://github.com/go-to-k/cdk-real-drift/issues/726)) ([#737](https://github.com/go-to-k/cdk-real-drift/issues/737)) ([edbf105](https://github.com/go-to-k/cdk-real-drift/commit/edbf105240ce5ebb651723cd84f9106b0f823339))
* **read:** read AWS::IAM::AccessKey Status via SDK override — detect out-of-band deactivation ([#716](https://github.com/go-to-k/cdk-real-drift/issues/716)) ([#738](https://github.com/go-to-k/cdk-real-drift/issues/738)) ([b0bda96](https://github.com/go-to-k/cdk-real-drift/commit/b0bda9655d66dd3e87706deec02f867fdabd8041))

## [0.2.43](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.42...v0.2.43) (2026-07-08)


### Bug Fixes

* **desired:** collect IAM standalone inline-policy siblings (RolePolicy/UserPolicy/GroupPolicy) ([#697](https://github.com/go-to-k/cdk-real-drift/issues/697)) ([#735](https://github.com/go-to-k/cdk-real-drift/issues/735)) ([5ccc4c2](https://github.com/go-to-k/cdk-real-drift/commit/5ccc4c2e3dc6b5b856c1b8b694fda10b54f5f616))
* **normalize:** YAML-string Content structural compare — SSM Document DocumentFormat: YAML ([#713](https://github.com/go-to-k/cdk-real-drift/issues/713)) ([#736](https://github.com/go-to-k/cdk-real-drift/issues/736)) ([5a2116d](https://github.com/go-to-k/cdk-real-drift/commit/5a2116d941146bda6e39de232e2423adad297274))

## [0.2.42](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.41...v0.2.42) (2026-07-08)


### Bug Fixes

* **diff:** EC2 derived first-run folds — CreditSpecification/gp2 Iops/ENI SecondaryIpCount ([#640](https://github.com/go-to-k/cdk-real-drift/issues/640)) ([#734](https://github.com/go-to-k/cdk-real-drift/issues/734)) ([ea3e879](https://github.com/go-to-k/cdk-real-drift/commit/ea3e87980a23df6407bf866bbda2a2ca54a4d253))
* **noise:** six-type first-run undeclared-default constant folds ([#711](https://github.com/go-to-k/cdk-real-drift/issues/711)) ([#733](https://github.com/go-to-k/cdk-real-drift/issues/733)) ([5693f20](https://github.com/go-to-k/cdk-real-drift/commit/5693f20d39a59ec46cdb72fc517017320b5dad9b))

## [0.2.41](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.40...v0.2.41) (2026-07-08)


### Bug Fixes

* **noise:** detect Classic ELB SSL-policy downgrade — Policies per-element equality gate ([#705](https://github.com/go-to-k/cdk-real-drift/issues/705)) ([#732](https://github.com/go-to-k/cdk-real-drift/issues/732)) ([279d66d](https://github.com/go-to-k/cdk-real-drift/commit/279d66d66c0f7924b58d3702e81aeac1336fc118))

## [0.2.40](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.39...v0.2.40) (2026-07-08)


### Bug Fixes

* **desired:** drop condition-false resources from the desired set ([#689](https://github.com/go-to-k/cdk-real-drift/issues/689)) ([#720](https://github.com/go-to-k/cdk-real-drift/issues/720)) ([1f1b9ff](https://github.com/go-to-k/cdk-real-drift/commit/1f1b9ff3b761725cd6e2d4fffb5ef559583cd7d0))

## [0.2.39](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.38...v0.2.39) (2026-07-08)


### Bug Fixes

* **diff:** fold API Gateway execute-api:/* resource-policy shorthand against the echoed ARN ([#676](https://github.com/go-to-k/cdk-real-drift/issues/676)) ([#721](https://github.com/go-to-k/cdk-real-drift/issues/721)) ([1e9e9a0](https://github.com/go-to-k/cdk-real-drift/commit/1e9e9a0d8a170b841f103af07f84403df398b6b8))

## [0.2.38](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.37...v0.2.38) (2026-07-08)


### Bug Fixes

* **noise:** EC2 Instance/Volume/ENI first-run undeclared folds ([#640](https://github.com/go-to-k/cdk-real-drift/issues/640)) ([#719](https://github.com/go-to-k/cdk-real-drift/issues/719)) ([013729d](https://github.com/go-to-k/cdk-real-drift/commit/013729d0530e90604ee50ced094735ce677e8a51))

## [0.2.37](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.36...v0.2.37) (2026-07-08)


### Bug Fixes

* **diff:** detect out-of-band Lambda log re-pointing — LoggingConfig.LogGroup derived gate ([#703](https://github.com/go-to-k/cdk-real-drift/issues/703)) ([#709](https://github.com/go-to-k/cdk-real-drift/issues/709)) ([c734fdb](https://github.com/go-to-k/cdk-real-drift/commit/c734fdbac8e8be91ce76df1287f4de4830d9eecf))
* **revert:** converge Cognito UserPool Policies revert — write the KNOWN_DEFAULTS default ([#702](https://github.com/go-to-k/cdk-real-drift/issues/702)) ([#710](https://github.com/go-to-k/cdk-real-drift/issues/710)) ([75528d3](https://github.com/go-to-k/cdk-real-drift/commit/75528d3878b37e454910a3babda7f14b47a09d5d))

## [0.2.36](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.35...v0.2.36) (2026-07-08)


### Bug Fixes

* **noise:** minimal-config first-run batch — ALB/Events/EIP/Cognito/ESM/KMS ([#701](https://github.com/go-to-k/cdk-real-drift/issues/701)) ([#708](https://github.com/go-to-k/cdk-real-drift/issues/708)) ([9e38044](https://github.com/go-to-k/cdk-real-drift/commit/9e38044f0c15533330a11b84c29742d96a5a09ba))

## [0.2.35](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.34...v0.2.35) (2026-07-08)


### Bug Fixes

* **noise:** first-run fold gaps on 13+ covered types ([#653](https://github.com/go-to-k/cdk-real-drift/issues/653) corpus-mining batch) ([#706](https://github.com/go-to-k/cdk-real-drift/issues/706)) ([541d7df](https://github.com/go-to-k/cdk-real-drift/commit/541d7df48bccac09436c27940faa2eb33f2bfc7a))
* **revert:** strip bare-null array husks from a CC revert patch ([#641](https://github.com/go-to-k/cdk-real-drift/issues/641) symptom 2) ([#696](https://github.com/go-to-k/cdk-real-drift/issues/696)) ([11daa22](https://github.com/go-to-k/cdk-real-drift/commit/11daa221ab1bc09d0a843b8603a29c890a72ac64))

## [0.2.34](https://github.com/go-to-k/cdk-real-drift/compare/v0.2.33...v0.2.34) (2026-07-08)


### Bug Fixes

* **noise:** first-run fold gaps on ApiGateway/Cognito/Batch/ECR/SSM/CloudFront ([#642](https://github.com/go-to-k/cdk-real-drift/issues/642), [#643](https://github.com/go-to-k/cdk-real-drift/issues/643), [#668](https://github.com/go-to-k/cdk-real-drift/issues/668), [#678](https://github.com/go-to-k/cdk-real-drift/issues/678)) ([#694](https://github.com/go-to-k/cdk-real-drift/issues/694)) ([125addf](https://github.com/go-to-k/cdk-real-drift/commit/125addfda9dd7e5854b18df8ec3fc521ebd3b2bc))

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
