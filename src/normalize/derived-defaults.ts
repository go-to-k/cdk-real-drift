// Shared tier-2 DERIVED default derivations (#1709). classify builds derived defaults
// into its LOCAL knownDef/knownDefPaths (they never enter the exported static tables),
// so before this module the revert planner had NO value source for them: the RSDP
// branch read only the static KNOWN_DEFAULTS (wrong value for a derived path — the RDS
// replica BackupRetentionPeriod bug) and the nested explicit-add branch read only the
// static KNOWN_DEFAULT_PATHS (miss — bare `remove`, a silent no-op on Route53
// HealthCheck Port and the ELBv2 TargetGroup health-check pair, all live-proven
// 2026-08-02). Both classify and revert/plan derive through THESE functions so the two
// sides can never disagree again; any future derived default gets revert convergence by
// deriving here and wiring the path into derivedRevertDefaultFor (revert/plan.ts).

// Route53 HealthCheck: a check that omits HealthCheckConfig.Port reads back the
// type-derived default — 80 for the HTTP pair, 443 for the HTTPS pair (TCP requires an
// explicit Port, so no arm exists there). #1703, live freepack-hunt 2026-08-01.
export function route53HealthCheckDerivedPort(hcType: unknown): number | undefined {
  return hcType === 'HTTP' || hcType === 'HTTP_STR_MATCH'
    ? 80
    : hcType === 'HTTPS' || hcType === 'HTTPS_STR_MATCH'
      ? 443
      : undefined;
}

// ELBv2 TargetGroup: the health-check protocol default FOLLOWS the group protocol —
// GENEVE (GWLB) and the NLB family (TCP/TLS/UDP/TCP_UDP, unless the target is an alb,
// which keeps its own HTTP-family defaults) default to TCP; an HTTPS group defaults to
// HTTPS. The remaining protocols use the static HTTP KNOWN_DEFAULTS pin. #1626/#1696.
export function elbTargetGroupDerivedHealthCheckProtocol(
  protocol: unknown,
  targetType: unknown
): string | undefined {
  if (protocol === 'GENEVE') return 'TCP';
  if (protocol === 'HTTPS') return 'HTTPS';
  if (
    (protocol === 'TCP' || protocol === 'TLS' || protocol === 'UDP' || protocol === 'TCP_UDP') &&
    targetType !== 'alb'
  ) {
    return 'TCP';
  }
  return undefined;
}

// ELBv2 TargetGroup: a GENEVE group's health check defaults to the FIXED port 80 (not
// traffic-port — #1696); every other protocol uses the static traffic-port pin.
export function elbTargetGroupDerivedHealthCheckPort(protocol: unknown): string | undefined {
  return protocol === 'GENEVE' ? '80' : undefined;
}

// RDS DBInstance: a read replica (SourceDBInstanceIdentifier declared) defaults
// BackupRetentionPeriod to 0, unlike the source's 1 (#1704). The static KNOWN_DEFAULTS
// entry stays 1 for non-replicas. SourceDBInstanceIdentifier is WRITE-ONLY, so callers
// must source it from a pre-strip snapshot (classify: rdsReplicaSourceId; revert/plan:
// the gather desired model, which keeps write-only values for the re-include pass).
export function rdsReplicaDerivedBackupRetention(
  sourceDbInstanceIdentifier: unknown
): number | undefined {
  return sourceDbInstanceIdentifier !== undefined ? 0 : undefined;
}
