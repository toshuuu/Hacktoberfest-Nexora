/**
 * OverviewPage — the main (and currently only) page of the git-cure dashboard.
 *
 * Sections rendered, top to bottom:
 *   1. Top bar — breadcrumb + live connection status with reconnection feedback
 *   2. Wordmark + tagline
 *   3. Repository status tile
 *   4. Diagnosis panel (issue + root cause + confidence + affected files)
 *   5. Recovery plan — step list with status indicators, approval buttons,
 *      copy-command buttons, and approval states
 *   6. Snapshot status bar
 *   7. Verification results
 *   8. Live execution log (terminal-style) with log-level filters
 *
 * Data strategy:
 *   - On mount the Socket.IO client connects to the local CLI server.
 *   - Each incoming event updates its slice of component state.
 *   - When the socket has never received data the mock values from mockData.ts
 *     are used as the fallback so the UI is always functional.
 *   - On unmount all event listeners are removed and the socket disconnects.
 *
 * Design constraints:
 *   - Single mono typeface throughout — this is a developer tool.
 *   - Blinking cursor on the wordmark is the only ambient animation.
 *   - Color communicates state only; no decorative use.
 *   - Left-aligned content block, capped at max-w-3xl, centred on viewport.
 *   - The dashboard never executes shell commands or exposes API keys.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  GitBranch,
  Cpu,
  Archive,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  SkipForward,
  AlertTriangle,
  Terminal,
  ShieldCheck,
  MinusCircle,
  Copy,
  Check,
  Wifi,
  WifiOff,
  RefreshCw,
} from "lucide-react";
import {
  mockDiagnosis,
  mockLogs,
  mockRecoverySteps,
  mockRepoStatus,
  mockSnapshot,
  mockVerification,
} from "../data/mockData";
import { StatusDot } from "../components/ui/StatusDot";
import { socket, EVENTS, grantApproval } from "../services/socket";
import type {
  StepStatus,
  RiskLevel,
  LogLevel,
  RepositoryStatus,
  DiagnosticResult,
  RecoveryStep,
  SnapshotMetadata,
  ExecutionLog,
  VerificationResult,
} from "../types";

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

type ConnState = "connecting" | "connected" | "disconnected" | "error";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function formatTime(iso: string): string {
  return iso.replace("T", " ").replace("Z", " UTC");
}

/** Lightweight guard: checks the shape of an incoming payload before using it. */
function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isValidRepoStatus(v: unknown): v is RepositoryStatus {
  if (!isNonNullObject(v)) return false;
  return (
    typeof v.repoName === "string" &&
    typeof v.currentBranch === "string" &&
    typeof v.headCommit === "string" &&
    typeof v.workingTreeStatus === "string" &&
    typeof v.collectedAt === "string"
  );
}

function isValidDiagnosis(v: unknown): v is DiagnosticResult {
  if (!isNonNullObject(v)) return false;
  return (
    typeof v.issue === "string" &&
    typeof v.rootCause === "string" &&
    Array.isArray(v.affectedFiles) &&
    Array.isArray(v.recommendedActions)
  );
}

function isValidRecoveryPlan(v: unknown): v is RecoveryStep[] {
  return Array.isArray(v) && v.every((s) => isNonNullObject(s) && typeof s.stepId === "string");
}

function isValidRecoveryStep(v: unknown): v is RecoveryStep {
  return isNonNullObject(v) && typeof v.stepId === "string" && typeof v.status === "string";
}

function isValidSnapshot(v: unknown): v is SnapshotMetadata {
  return (
    isNonNullObject(v) &&
    typeof v.snapshotId === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.description === "string"
  );
}

function isValidLogEntry(v: unknown): v is ExecutionLog {
  return (
    isNonNullObject(v) &&
    typeof v.timestamp === "string" &&
    typeof v.level === "string" &&
    typeof v.message === "string"
  );
}

function isValidVerification(v: unknown): v is VerificationResult[] {
  return (
    Array.isArray(v) &&
    v.every(
      (r) =>
        isNonNullObject(r) &&
        typeof r.checkName === "string" &&
        typeof r.passed === "boolean"
    )
  );
}

// ---------------------------------------------------------------------------
// Step status icon
// ---------------------------------------------------------------------------

function StepIcon({ status }: { status: StepStatus }) {
  const cls = "w-4 h-4 flex-shrink-0";
  switch (status) {
    case "completed":
      return <CheckCircle2 className={`${cls} text-gc-accent`} aria-label="completed" />;
    case "failed":
      return <XCircle className={`${cls} text-gc-danger`} aria-label="failed" />;
    case "running":
      return (
        <Loader2
          className={`${cls} text-gc-warn animate-spin`}
          aria-label="running"
          style={{ animationDuration: "1s" }}
        />
      );
    case "awaiting-approval":
      return <AlertTriangle className={`${cls} text-gc-warn`} aria-label="awaiting approval" />;
    case "skipped":
      return <SkipForward className={`${cls} text-gc-muted`} aria-label="skipped" />;
    case "pending":
    default:
      return <Clock className={`${cls} text-gc-muted`} aria-label="pending" />;
  }
}

// ---------------------------------------------------------------------------
// Risk pill — inline text marker, not a badge
// ---------------------------------------------------------------------------

const riskLabel: Record<RiskLevel, string> = {
  green: "low risk",
  amber: "moderate risk",
  red: "high risk",
  destructive: "destructive",
};

const riskColor: Record<RiskLevel, string> = {
  green: "text-gc-accent",
  amber: "text-gc-warn",
  red: "text-gc-danger",
  destructive: "text-gc-danger",
};

function RiskMarker({ level }: { level: RiskLevel }) {
  return (
    <span className={`text-xs ${riskColor[level]}`} aria-label={`risk: ${riskLabel[level]}`}>
      {riskLabel[level]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Log level color
// ---------------------------------------------------------------------------

const logColor: Record<LogLevel, string> = {
  info: "text-gc-muted",
  warn: "text-gc-warn",
  error: "text-gc-danger",
  debug: "text-gc-border",
};

const logPrefix: Record<LogLevel, string> = {
  info: "info ",
  warn: "warn ",
  error: "err  ",
  debug: "dbg  ",
};

// ---------------------------------------------------------------------------
// CopyButton — copies text to clipboard, shows a brief confirmation tick
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may be unavailable in some contexts; fail silently.
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-gc-muted hover:text-gc-text border border-gc-border hover:border-gc-muted rounded transition-colors"
      aria-label={copied ? "copied" : "copy command"}
      title={copied ? "Copied!" : "Copy command"}
    >
      {copied ? (
        <Check size={11} aria-hidden />
      ) : (
        <Copy size={11} aria-hidden />
      )}
      {copied ? "copied" : "copy"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper — consistent spacing + optional heading
// ---------------------------------------------------------------------------

function Section({
  heading,
  icon,
  children,
}: {
  heading: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-gc-muted">{icon}</span>
        <h2 className="text-xs text-gc-muted tracking-wide">{heading}</h2>
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// LoadingPlaceholder — shown when connected but data not yet received
// ---------------------------------------------------------------------------

function LoadingPlaceholder({ label }: { label: string }) {
  return (
    <div className="border border-gc-border rounded bg-gc-surface px-5 py-4 flex items-center gap-2 text-xs text-gc-muted">
      <Loader2 size={12} className="animate-spin text-gc-muted" style={{ animationDuration: "1s" }} aria-hidden />
      <span>waiting for {label}…</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConnectionStatusIndicator
// ---------------------------------------------------------------------------

/** Dot + label in the top-right of the header. */
function ConnectionStatusIndicator({
  state,
  usingMock,
  reconnectAttempt,
}: {
  state: ConnState;
  usingMock: boolean;
  reconnectAttempt: number;
}) {
  if (usingMock) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-gc-muted" title="Showing mock data — server not reachable">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-gc-warn" aria-hidden="true" />
        mock data
      </span>
    );
  }

  switch (state) {
    case "connected":
      return (
        <span className="flex items-center gap-1.5 text-xs text-gc-accent" title="Live Socket.IO connection">
          <Wifi size={11} aria-hidden />
          live
        </span>
      );
    case "connecting":
      return (
        <span className="flex items-center gap-1.5 text-xs text-gc-muted" title="Connecting to CLI server…">
          <Loader2 size={11} className="animate-spin" style={{ animationDuration: "1s" }} aria-hidden />
          {reconnectAttempt > 0 ? `reconnecting (${reconnectAttempt})` : "connecting"}
        </span>
      );
    case "error":
      return (
        <span className="flex items-center gap-1.5 text-xs text-gc-danger" title="Connection error">
          <WifiOff size={11} aria-hidden />
          error
        </span>
      );
    case "disconnected":
    default:
      return (
        <span className="flex items-center gap-1.5 text-xs text-gc-muted" title="Disconnected from CLI server">
          <WifiOff size={11} aria-hidden />
          disconnected
        </span>
      );
  }
}

// ---------------------------------------------------------------------------
// OverviewPage
// ---------------------------------------------------------------------------

export function OverviewPage() {
  // -------------------------------------------------------------------------
  // Socket connection state
  // -------------------------------------------------------------------------
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  // -------------------------------------------------------------------------
  // Live data state — null means "not yet received from server"
  // -------------------------------------------------------------------------
  const [liveRepoStatus, setLiveRepoStatus] = useState<RepositoryStatus | null>(null);
  const [liveDiagnosis, setLiveDiagnosis] = useState<DiagnosticResult | null>(null);
  const [liveRecoverySteps, setLiveRecoverySteps] = useState<RecoveryStep[] | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<SnapshotMetadata | null>(null);
  const [liveLogs, setLiveLogs] = useState<ExecutionLog[] | null>(null);
  const [liveVerification, setLiveVerification] = useState<VerificationResult[] | null>(null);

  // -------------------------------------------------------------------------
  // Track whether we've ever received *any* live data.
  // If the socket connects but no events arrive, we still fall back to mock.
  // -------------------------------------------------------------------------
  const hasLiveData = useRef(false);

  // -------------------------------------------------------------------------
  // Log-level filter state
  // -------------------------------------------------------------------------
  const [enabledLevels, setEnabledLevels] = useState<Set<LogLevel>>(
    new Set<LogLevel>(["info", "warn", "error", "debug"])
  );

  const toggleLevel = useCallback((level: LogLevel) => {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        // Never allow deselecting the last filter
        if (next.size === 1) return prev;
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // Approval pending set — tracks stepIds whose approval button was clicked
  // -------------------------------------------------------------------------
  const [approvingSteps, setApprovingSteps] = useState<Set<string>>(new Set());

  const handleApprove = useCallback((stepId: string) => {
    setApprovingSteps((prev) => new Set(prev).add(stepId));
    grantApproval(stepId);
    // Clear the pending state once the step status update arrives via socket.
    // As a safety valve, also clear it after 10 s so the button doesn't freeze.
    setTimeout(() => {
      setApprovingSteps((prev) => {
        const next = new Set(prev);
        next.delete(stepId);
        return next;
      });
    }, 10_000);
  }, []);

  // -------------------------------------------------------------------------
  // Socket lifecycle — connect on mount, clean up on unmount
  // -------------------------------------------------------------------------
  useEffect(() => {
    setConnState("connecting");

    // --- Connection events ---
    function onConnect() {
      setConnState("connected");
      setReconnectAttempt(0);
    }

    function onDisconnect() {
      setConnState("disconnected");
    }

    function onConnectError() {
      setConnState("error");
    }

    function onReconnectAttempt(attempt: number) {
      setReconnectAttempt(attempt);
      setConnState("connecting");
    }

    function onReconnectFailed() {
      setConnState("error");
    }

    // --- Data events ---
    function onRepoStatus(payload: unknown) {
      if (!isValidRepoStatus(payload)) {
        console.warn("[socket] repo:status:updated — invalid payload", payload);
        return;
      }
      hasLiveData.current = true;
      setLiveRepoStatus(payload);
    }

    function onDiagnosisReady(payload: unknown) {
      if (!isValidDiagnosis(payload)) {
        console.warn("[socket] diagnosis:ready — invalid payload", payload);
        return;
      }
      hasLiveData.current = true;
      setLiveDiagnosis(payload);
    }

    function onRecoveryPlanReady(payload: unknown) {
      if (!isValidRecoveryPlan(payload)) {
        console.warn("[socket] recovery:plan:ready — invalid payload", payload);
        return;
      }
      hasLiveData.current = true;
      setLiveRecoverySteps(payload);
    }

    function onStepStatusChanged(payload: unknown) {
      if (!isValidRecoveryStep(payload)) {
        console.warn("[socket] recovery:step:changed — invalid payload", payload);
        return;
      }
      hasLiveData.current = true;
      setLiveRecoverySteps((prev) => {
        if (prev === null) return null;
        return prev.map((s) => (s.stepId === payload.stepId ? payload : s));
      });
      // Clear approval pending state for this step now that its status updated.
      setApprovingSteps((prev) => {
        const next = new Set(prev);
        next.delete(payload.stepId);
        return next;
      });
    }

    function onSnapshotCreated(payload: unknown) {
      if (!isValidSnapshot(payload)) {
        console.warn("[socket] snapshot:created — invalid payload", payload);
        return;
      }
      hasLiveData.current = true;
      setLiveSnapshot(payload);
    }

    function onLogAppended(payload: unknown) {
      if (!isValidLogEntry(payload)) {
        console.warn("[socket] log:appended — invalid payload", payload);
        return;
      }
      hasLiveData.current = true;
      setLiveLogs((prev) => [...(prev ?? []), payload]);
    }

    function onVerificationComplete(payload: unknown) {
      if (!isValidVerification(payload)) {
        console.warn("[socket] verification:complete — invalid payload", payload);
        return;
      }
      hasLiveData.current = true;
      setLiveVerification(payload);
    }

    function onSessionStarted(_payload: { sessionId: string; startedAt: string }) {
      // Reset all live data when a new session begins so stale data is cleared.
      setLiveRepoStatus(null);
      setLiveDiagnosis(null);
      setLiveRecoverySteps(null);
      setLiveSnapshot(null);
      setLiveLogs(null);
      setLiveVerification(null);
      hasLiveData.current = false;
    }

    function onSessionEnded(_payload: { sessionId: string; endedAt: string; reason: string }) {
      // Session ended — keep last known state visible.
      setConnState("disconnected");
    }

    // Register listeners
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("reconnect_attempt", onReconnectAttempt as any);
    socket.on("reconnect_failed", onReconnectFailed);

    socket.on(EVENTS.REPO_STATUS_UPDATED, onRepoStatus as Parameters<typeof socket.on>[1]);
    socket.on(EVENTS.DIAGNOSIS_READY, onDiagnosisReady as Parameters<typeof socket.on>[1]);
    socket.on(EVENTS.RECOVERY_PLAN_READY, onRecoveryPlanReady as Parameters<typeof socket.on>[1]);
    socket.on(EVENTS.STEP_STATUS_CHANGED, onStepStatusChanged as Parameters<typeof socket.on>[1]);
    socket.on(EVENTS.SNAPSHOT_CREATED, onSnapshotCreated as Parameters<typeof socket.on>[1]);
    socket.on(EVENTS.LOG_APPENDED, onLogAppended as Parameters<typeof socket.on>[1]);
    socket.on(EVENTS.VERIFICATION_COMPLETE, onVerificationComplete as Parameters<typeof socket.on>[1]);
    socket.on(EVENTS.SESSION_STARTED, onSessionStarted);
    socket.on(EVENTS.SESSION_ENDED, onSessionEnded);

    // Connect — autoConnect is false so we must call this explicitly.
    socket.connect();

    return () => {
      // Remove all listeners registered in this effect.
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("reconnect_attempt", onReconnectAttempt as any);
      socket.off("reconnect_failed", onReconnectFailed);

      socket.off(EVENTS.REPO_STATUS_UPDATED, onRepoStatus as Parameters<typeof socket.on>[1]);
      socket.off(EVENTS.DIAGNOSIS_READY, onDiagnosisReady as Parameters<typeof socket.on>[1]);
      socket.off(EVENTS.RECOVERY_PLAN_READY, onRecoveryPlanReady as Parameters<typeof socket.on>[1]);
      socket.off(EVENTS.STEP_STATUS_CHANGED, onStepStatusChanged as Parameters<typeof socket.on>[1]);
      socket.off(EVENTS.SNAPSHOT_CREATED, onSnapshotCreated as Parameters<typeof socket.on>[1]);
      socket.off(EVENTS.LOG_APPENDED, onLogAppended as Parameters<typeof socket.on>[1]);
      socket.off(EVENTS.VERIFICATION_COMPLETE, onVerificationComplete as Parameters<typeof socket.on>[1]);
      socket.off(EVENTS.SESSION_STARTED, onSessionStarted);
      socket.off(EVENTS.SESSION_ENDED, onSessionEnded);

      socket.disconnect();
    };
  }, []); // run once on mount

  // -------------------------------------------------------------------------
  // Derive display data: prefer live, fall back to mock
  // -------------------------------------------------------------------------
  const isConnected = connState === "connected";
  // "using mock" = server never delivered data; show fallback + amber indicator.
  const usingMock = liveRepoStatus === null && liveDiagnosis === null;

  const repoStatus = liveRepoStatus ?? mockRepoStatus;
  const diagnosis = liveDiagnosis ?? mockDiagnosis;
  const recoverySteps = liveRecoverySteps ?? mockRecoverySteps;
  const snapshot = liveSnapshot ?? mockSnapshot;
  const allLogs = liveLogs ?? mockLogs;
  const verification = liveVerification ?? mockVerification;

  // -------------------------------------------------------------------------
  // Apply log-level filter
  // -------------------------------------------------------------------------
  const filteredLogs = allLogs.filter((e) => enabledLevels.has(e.level));

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-gc-bg flex flex-col font-mono">
      {/* Top bar */}
      <header className="border-b border-gc-border px-6 py-3 flex items-center justify-between flex-shrink-0">
        <span className="text-gc-muted text-xs">
          git-cure
          <span className="mx-2 text-gc-border select-none">/</span>
          overview
        </span>

        {/* Live connection status */}
        <ConnectionStatusIndicator
          state={connState}
          usingMock={usingMock}
          reconnectAttempt={reconnectAttempt}
        />
      </header>

      {/* Main content */}
      <main className="flex-1 px-6 py-14 max-w-3xl w-full mx-auto">
        {/* ---------------------------------------------------------------- */}
        {/* Wordmark                                                         */}
        {/* ---------------------------------------------------------------- */}
        <div className="mb-14 select-none">
          <h1 className="text-5xl font-semibold tracking-tight text-gc-text leading-none">
            git
            <span className="text-gc-accent">-cure</span>
            <span
              className="inline-block w-[3px] h-[1em] bg-gc-accent ml-1 align-middle animate-blink"
              aria-hidden="true"
            />
          </h1>
          <p className="mt-4 text-gc-muted text-sm leading-relaxed max-w-[58ch]">
            Local Git repository doctor. Detects broken states, explains root
            causes, and guides you through safe, step-by-step recovery — powered
            by Gemma.
          </p>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Repository status                                                */}
        {/* ---------------------------------------------------------------- */}
        <Section heading="repository" icon={<GitBranch size={13} aria-hidden />}>
          {isConnected && liveRepoStatus === null ? (
            <LoadingPlaceholder label="repository status" />
          ) : (
            <div className="border border-gc-border rounded bg-gc-surface px-5 py-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm text-gc-text">{repoStatus.repoName}</span>
                <StatusDot level="amber" />
                <span className="text-xs text-gc-muted">{repoStatus.workingTreeStatus}</span>
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-gc-muted">
                <div className="flex gap-2">
                  <dt className="w-14 flex-shrink-0">branch</dt>
                  <dd className="text-gc-text truncate">{repoStatus.currentBranch}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-14 flex-shrink-0">HEAD</dt>
                  <dd className="text-gc-text">{shortHash(repoStatus.headCommit)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-14 flex-shrink-0">staged</dt>
                  <dd className="text-gc-text">{repoStatus.stagedCount}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-14 flex-shrink-0">unstaged</dt>
                  <dd className="text-gc-text">{repoStatus.unstagedCount}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-14 flex-shrink-0">untracked</dt>
                  <dd className="text-gc-text">{repoStatus.untrackedCount}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-14 flex-shrink-0">conflicts</dt>
                  <dd className="text-gc-danger font-medium">{repoStatus.conflictedCount}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-gc-border">
                collected {formatTime(repoStatus.collectedAt)}
              </p>
            </div>
          )}
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* Diagnosis                                                        */}
        {/* ---------------------------------------------------------------- */}
        <Section heading="diagnosis" icon={<Cpu size={13} aria-hidden />}>
          {isConnected && liveDiagnosis === null ? (
            <LoadingPlaceholder label="diagnosis" />
          ) : (
            <div className="border border-gc-border rounded bg-gc-surface px-5 py-4">
              <div className="flex items-baseline gap-3 mb-2">
                <span className="text-sm text-gc-text">{diagnosis.issue}</span>
                <StatusDot level={diagnosis.riskLevel} />
                {diagnosis.confidence !== undefined && (
                  <span className="text-xs text-gc-muted ml-auto flex-shrink-0">
                    {Math.round(diagnosis.confidence * 100)}% confidence
                  </span>
                )}
              </div>
              <p className="text-xs text-gc-muted leading-relaxed mb-4 max-w-[62ch]">
                {diagnosis.rootCause}
              </p>
              <div className="mb-3">
                <p className="text-xs text-gc-muted mb-1.5">affected files</p>
                <ul className="space-y-0.5">
                  {diagnosis.affectedFiles.map((f) => (
                    <li key={f} className="text-xs text-gc-text">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs text-gc-muted mb-1.5">recommended actions</p>
                <ol className="space-y-0.5 list-decimal list-inside">
                  {diagnosis.recommendedActions.map((a, i) => (
                    <li key={i} className="text-xs text-gc-muted">
                      <span className="text-gc-text">{a}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* Recovery plan                                                    */}
        {/* ---------------------------------------------------------------- */}
        <Section heading="recovery plan" icon={<ShieldCheck size={13} aria-hidden />}>
          {isConnected && liveRecoverySteps === null ? (
            <LoadingPlaceholder label="recovery plan" />
          ) : (
            <div className="border border-gc-border rounded overflow-hidden">
              {recoverySteps.map((step, idx) => {
                const isLast = idx === recoverySteps.length - 1;
                const isApproving = approvingSteps.has(step.stepId);
                return (
                  <div
                    key={step.stepId}
                    className={`bg-gc-surface px-5 py-4 flex gap-4 ${
                      !isLast ? "border-b border-gc-border" : ""
                    } ${step.status === "awaiting-approval" ? "ring-1 ring-inset ring-gc-warn/40" : ""}`}
                  >
                    {/* Step icon */}
                    <div className="mt-0.5 flex-shrink-0">
                      <StepIcon status={step.status} />
                    </div>

                    {/* Step body */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap mb-1">
                        <span
                          className={`text-sm ${
                            step.status === "pending" || step.status === "skipped"
                              ? "text-gc-muted"
                              : "text-gc-text"
                          }`}
                        >
                          {step.description}
                        </span>
                        <RiskMarker level={step.riskLevel} />
                      </div>

                      {step.command && (
                        <div className="flex items-center gap-2 mb-2">
                          <code className="block text-xs text-gc-text bg-gc-bg px-2 py-1 rounded w-fit max-w-full overflow-x-auto">
                            {step.command}
                          </code>
                          {/* Copy-command button */}
                          <CopyButton text={step.command} />
                        </div>
                      )}

                      <p className="text-xs text-gc-muted leading-relaxed max-w-[58ch]">
                        {step.commandExplanation}
                      </p>

                      {/* Approval section */}
                      {step.status === "awaiting-approval" && (
                        <div className="mt-3 space-y-2">
                          <div className="flex items-start gap-2 text-xs text-gc-warn">
                            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" aria-hidden />
                            <span>
                              Requires approval before execution. The CLI engine is waiting for
                              confirmation.
                            </span>
                          </div>
                          {/* Rollback warning shown before approval button */}
                          {step.rollback && !step.rollback.canGuaranteeRestoration && step.rollback.warningMessage && (
                            <div className="flex items-start gap-2 text-xs text-gc-muted border border-gc-border/50 rounded px-2 py-1.5">
                              <MinusCircle size={12} className="flex-shrink-0 mt-0.5" aria-hidden />
                              <span>{step.rollback.warningMessage}</span>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => handleApprove(step.stepId)}
                            disabled={isApproving}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gc-warn/60 text-gc-warn hover:bg-gc-warn/10 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            aria-label={`Approve step: ${step.description}`}
                          >
                            {isApproving ? (
                              <>
                                <RefreshCw size={11} className="animate-spin" style={{ animationDuration: "1s" }} aria-hidden />
                                approving…
                              </>
                            ) : (
                              <>
                                <Check size={11} aria-hidden />
                                approve &amp; execute
                              </>
                            )}
                          </button>
                        </div>
                      )}

                      {/* Rollback warning for non-approval steps */}
                      {step.status !== "awaiting-approval" &&
                        step.rollback &&
                        !step.rollback.canGuaranteeRestoration && (
                          <div className="mt-2 flex items-start gap-2 text-xs text-gc-muted border-t border-gc-border/50 pt-2">
                            <MinusCircle size={12} className="flex-shrink-0 mt-0.5" aria-hidden />
                            <span>{step.rollback.warningMessage}</span>
                          </div>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* Snapshot                                                         */}
        {/* ---------------------------------------------------------------- */}
        <Section heading="safety snapshot" icon={<Archive size={13} aria-hidden />}>
          {isConnected && liveSnapshot === null ? (
            <LoadingPlaceholder label="snapshot" />
          ) : (
            <>
              <div className="border border-gc-border rounded bg-gc-surface px-5 py-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm text-gc-text">{snapshot.description}</span>
                    <span className="text-xs text-gc-accent">{snapshot.status}</span>
                  </div>
                  <dl className="flex gap-4 text-xs text-gc-muted">
                    <div className="flex gap-1.5">
                      <dt>type</dt>
                      <dd className="text-gc-text">{snapshot.type}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt>id</dt>
                      <dd className="text-gc-text">{snapshot.snapshotId}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt>created</dt>
                      <dd className="text-gc-text">{formatTime(snapshot.createdAt)}</dd>
                    </div>
                  </dl>
                </div>
              </div>
              <p className="mt-2 text-xs text-gc-border max-w-[62ch] leading-relaxed">
                This snapshot does not guarantee zero data loss. Untracked files and files excluded
                by .gitignore are not captured by a stash.
              </p>
            </>
          )}
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* Verification results                                             */}
        {/* ---------------------------------------------------------------- */}
        <Section heading="verification" icon={<CheckCircle2 size={13} aria-hidden />}>
          {isConnected && liveVerification === null ? (
            <LoadingPlaceholder label="verification results" />
          ) : (
            <div className="border border-gc-border rounded overflow-hidden">
              {verification.map((v, idx) => {
                const isLast = idx === verification.length - 1;
                return (
                  <div
                    key={v.checkName}
                    className={`bg-gc-surface px-5 py-3 flex items-start gap-3 text-xs ${
                      !isLast ? "border-b border-gc-border" : ""
                    }`}
                  >
                    {v.passed ? (
                      <CheckCircle2
                        size={13}
                        className="text-gc-accent flex-shrink-0 mt-0.5"
                        aria-label="passed"
                      />
                    ) : (
                      <XCircle
                        size={13}
                        className="text-gc-muted flex-shrink-0 mt-0.5"
                        aria-label="not passed"
                      />
                    )}
                    <div>
                      <p className={v.passed ? "text-gc-text mb-0.5" : "text-gc-muted mb-0.5"}>
                        {v.checkName}
                      </p>
                      <p className="text-gc-muted leading-relaxed">{v.explanation}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* Execution log                                                    */}
        {/* ---------------------------------------------------------------- */}
        <Section heading="execution log" icon={<Terminal size={13} aria-hidden />}>
          {/* Log-level filter bar */}
          <div className="flex items-center gap-1.5 mb-2" role="group" aria-label="Log level filters">
            <span className="text-xs text-gc-border mr-1">filter:</span>
            {(["info", "warn", "error", "debug"] as LogLevel[]).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => toggleLevel(lvl)}
                aria-pressed={enabledLevels.has(lvl)}
                className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                  enabledLevels.has(lvl)
                    ? `${logColor[lvl]} border-current bg-gc-surface`
                    : "text-gc-border border-gc-border hover:border-gc-muted"
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          <div
            className="border border-gc-border rounded bg-gc-bg px-0 py-3 overflow-y-auto max-h-64"
            aria-label="Execution log"
            role="log"
            aria-live="polite"
          >
            {filteredLogs.length === 0 ? (
              <p className="px-4 py-2 text-xs text-gc-border">
                {allLogs.length === 0 ? "no log entries yet" : "no entries match the active filters"}
              </p>
            ) : (
              filteredLogs.map((entry, idx) => (
                <div
                  key={idx}
                  className="px-4 py-0.5 flex gap-3 text-xs leading-5 hover:bg-gc-surface/50"
                >
                  <span className="text-gc-border flex-shrink-0 w-22 hidden sm:block">
                    {entry.timestamp.replace("T", " ").slice(0, 19)}
                  </span>
                  <span
                    className={`flex-shrink-0 w-8 ${logColor[entry.level]}`}
                    aria-label={entry.level}
                  >
                    {logPrefix[entry.level]}
                  </span>
                  <span className="text-gc-muted flex-1">
                    {entry.stepId && (
                      <span className="text-gc-border mr-2">[{entry.stepId}]</span>
                    )}
                    {entry.message}
                  </span>
                </div>
              ))
            )}
          </div>
          <p className="mt-2 text-xs text-gc-border">
            {usingMock
              ? `showing ${filteredLogs.length} of ${allLogs.length} mock entries · real-time via Socket.IO when server is running`
              : `${filteredLogs.length} of ${allLogs.length} entries · live Socket.IO stream`}
          </p>
        </Section>
      </main>
    </div>
  );
}
