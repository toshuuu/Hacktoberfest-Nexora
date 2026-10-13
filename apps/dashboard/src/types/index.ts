/**
 * Re-export shared types for convenience inside the dashboard package.
 * Import from here rather than @git-cure/shared directly in component files,
 * so the path alias only needs updating in one place on integration.
 */
export type {
  DiagnosticResult,
  ExecutionLog,
  LogLevel,
  RecoveryStep,
  RepositoryStatus,
  RiskLevel,
  SnapshotMetadata,
  StepStatus,
  VerificationResult,
} from "@git-cure/shared";
