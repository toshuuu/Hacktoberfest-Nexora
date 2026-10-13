/**
 * Socket.IO client for the git-cure dashboard.
 *
 * Architecture notes:
 *   - This module connects to the local @git-cure/server process (services/server).
 *   - All ten named events mirror the EVENTS constants in services/server/src/index.ts.
 *   - The dashboard is read-only: it only LISTENS to the eight server→client events
 *     and only SENDS the one approval event (approval:granted).
 *   - No git commands are issued from this file. No API keys are sent or logged.
 *   - The connection URL is read from the VITE_API_BASE_URL env var so it can
 *     be configured without touching source code.
 *
 * Usage:
 *   import { socket, EVENTS } from "@/services/socket";
 *   socket.on(EVENTS.LOG_APPENDED, (entry) => { ... });
 *   socket.emit(EVENTS.APPROVAL_GRANTED, { stepId, approvedAt });
 */

import { io, Socket } from "socket.io-client";
import type {
  RepositoryStatus,
  DiagnosticResult,
  RecoveryStep,
  SnapshotMetadata,
  ExecutionLog,
  VerificationResult,
} from "@git-cure/shared";

// ---------------------------------------------------------------------------
// Event name constants — must stay in sync with services/server/src/index.ts
// ---------------------------------------------------------------------------

export const EVENTS = {
  // Server → client
  REPO_STATUS_UPDATED: "repo:status:updated",
  DIAGNOSIS_READY: "diagnosis:ready",
  RECOVERY_PLAN_READY: "recovery:plan:ready",
  STEP_STATUS_CHANGED: "recovery:step:changed",
  SNAPSHOT_CREATED: "snapshot:created",
  LOG_APPENDED: "log:appended",
  VERIFICATION_COMPLETE: "verification:complete",
  SESSION_STARTED: "session:started",
  SESSION_ENDED: "session:ended",
  // Client → server
  APPROVAL_GRANTED: "approval:granted",
} as const;

// ---------------------------------------------------------------------------
// Typed socket
// "ServerToClient" and "ClientToServer" match the types in the server module.
// ---------------------------------------------------------------------------

type ServerToClientEvents = {
  "repo:status:updated": (p: RepositoryStatus) => void;
  "diagnosis:ready": (p: DiagnosticResult) => void;
  "recovery:plan:ready": (p: RecoveryStep[]) => void;
  "recovery:step:changed": (p: RecoveryStep) => void;
  "snapshot:created": (p: SnapshotMetadata) => void;
  "log:appended": (p: ExecutionLog) => void;
  "verification:complete": (p: VerificationResult[]) => void;
  "session:started": (p: { sessionId: string; startedAt: string }) => void;
  "session:ended": (p: { sessionId: string; endedAt: string; reason: string }) => void;
};

type ClientToServerEvents = {
  "approval:granted": (p: { stepId: string; approvedAt: string }) => void;
};

// ---------------------------------------------------------------------------
// Singleton socket instance
// autoConnect: false — caller decides when to connect, avoiding spurious
// connection attempts during unit tests or when the server isn't running.
// ---------------------------------------------------------------------------

const SOCKET_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:7432";

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SOCKET_URL, {
  autoConnect: false,
  reconnectionDelay: 2000,
  reconnectionAttempts: 10,
});

// ---------------------------------------------------------------------------
// Convenience: grant approval for a step
// The dashboard calls this; the server forwards to the CLI engine.
// ---------------------------------------------------------------------------

export function grantApproval(stepId: string): void {
  socket.emit(EVENTS.APPROVAL_GRANTED, {
    stepId,
    approvedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Connection lifecycle logging (dev only)
// Listeners are intentionally minimal here — OverviewPage owns state updates
// via its own on/off pairs registered in useEffect, so there is no duplication.
// ---------------------------------------------------------------------------

socket.on("connect", () => {
  console.info("[socket] connected  id=", socket.id);
});

socket.on("disconnect", (reason: string) => {
  console.warn("[socket] disconnected  reason=", reason);
});

socket.on("connect_error", (err: Error) => {
  // Expected when the CLI server is not running; surfaced as a UI indicator.
  console.warn("[socket] connect_error", err.message);
});
