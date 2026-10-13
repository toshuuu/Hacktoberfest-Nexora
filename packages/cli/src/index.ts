/**
 * @git-cure/cli — main entry point and workflow coordinator
 *
 * Coordinates:
 *   - telemetry.ts: working-tree inspection and status collection
 *   - detector.ts: Git state anomaly diagnosis
 *   - snapshot.ts: safety snapshot creation and restoration
 *   - validator.ts: security allowlists and parameter verification
 *   - executor.ts: guarded Git subprocess execution
 *   - Socket.IO / Console event emission to the dashboard
 */

import * as path from 'node:path';
import type {
  RepositoryStatus,
  DiagnosticResult,
  RecoveryStep,
  SnapshotMetadata,
  ExecutionLog,
  VerificationResult,
} from '@git-cure/shared';

import {
  collectRepoStatus,
  collectDetailedRepoStatus,
  DetailedRepoStatus,
} from './telemetry';
import { detectProblems } from './detector';
import { createSnapshot } from './snapshot';
import { validateRecoveryPlan } from './validator';
import { executeStepWithDetails } from './executor';

// Re-export all submodules
export * from './telemetry';
export * from './detector';
export * from './snapshot';
export * from './validator';
export * from './executor';

/**
 * Event emitter contract mirroring the server's Socket.IO events.
 */
export interface CliEventEmitters {
  emitRepoStatus: (status: RepositoryStatus) => void;
  emitDiagnosisReady: (diagnosis: DiagnosticResult) => void;
  emitRecoveryPlanReady: (plan: RecoveryStep[]) => void;
  emitStepStatusChanged: (step: RecoveryStep) => void;
  emitSnapshotCreated: (snapshot: SnapshotMetadata) => void;
  emitLogAppended: (entry: ExecutionLog) => void;
  emitVerificationComplete: (results: VerificationResult[]) => void;
  emitSessionStarted?: (sessionId: string) => void;
  emitSessionEnded?: (sessionId: string, reason: string) => void;
}

/**
 * Default console-based event emitter for standalone CLI usage.
 */
export const defaultConsoleEmitters: CliEventEmitters = {
  emitRepoStatus(status) {
    console.log(`[status] ${status.repoName} (${status.currentBranch}) [${status.workingTreeStatus}] staged:${status.stagedCount} unstaged:${status.unstagedCount} untracked:${status.untrackedCount} conflicts:${status.conflictedCount}`);
  },
  emitDiagnosisReady(diagnosis) {
    console.log(`[diagnosis] [${diagnosis.riskLevel.toUpperCase()}] ${diagnosis.issue}`);
    console.log(`            ${diagnosis.rootCause}`);
  },
  emitRecoveryPlanReady(plan) {
    console.log(`[plan] Generated recovery plan (${plan.length} steps):`);
    plan.forEach((s, idx) => {
      console.log(`  ${idx + 1}. [${s.riskLevel}] ${s.description} ${s.command ? `(${s.command})` : ''}`);
    });
  },
  emitStepStatusChanged(step) {
    console.log(`[step] ${step.stepId} -> ${step.status}`);
  },
  emitSnapshotCreated(snapshot) {
    console.log(`[snapshot] Created ${snapshot.type} checkpoint "${snapshot.snapshotId}"`);
  },
  emitLogAppended(entry) {
    const prefix = entry.level === 'error' ? '✖' : entry.level === 'warn' ? '⚠' : '✓';
    console.log(`[log:${entry.level}] ${prefix} ${entry.message}`);
  },
  emitVerificationComplete(results) {
    console.log(`[verification] Completed ${results.length} checks:`);
    for (const r of results) {
      console.log(`  ${r.passed ? '✓' : '✖'} ${r.checkName}: ${r.explanation}`);
    }
  },
};

/**
 * Generates a structured recovery plan for a detected issue
 * adhering strictly to the shared RecoveryStep contract.
 */
export function generateRecoveryPlan(
  diagnosis: DiagnosticResult,
  repoStatus: RepositoryStatus
): RecoveryStep[] {
  const steps: RecoveryStep[] = [];

  if (diagnosis.issue.includes('Merge conflict')) {
    steps.push({
      stepId: 'conflict-inspect',
      description: 'Inspect conflicted and unmerged files',
      command: 'git status --porcelain',
      commandExplanation: 'Review all files with unresolved conflict markers.',
      riskLevel: 'green',
      status: 'pending',
      requiresApproval: false,
    });

    if (diagnosis.affectedFiles.length > 0) {
      for (const file of diagnosis.affectedFiles) {
        steps.push({
          stepId: `conflict-stage-${file.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          description: `Stage resolved file "${file}"`,
          command: `git add ${file}`,
          commandExplanation: `Mark "${file}" as conflict-resolved in Git index.`,
          riskLevel: 'amber',
          status: 'awaiting-approval',
          requiresApproval: true,
          rollback: {
            description: `Unstage ${file}`,
            command: `git reset HEAD ${file}`,
            canGuaranteeRestoration: true,
          },
        });
      }
    }

    steps.push({
      stepId: 'conflict-commit-merge',
      description: 'Commit the resolved merge',
      command: 'git commit -m "fix(merge): resolve conflicts"',
      commandExplanation: 'Finalize the merge commit in the current branch history.',
      riskLevel: 'amber',
      status: 'awaiting-approval',
      requiresApproval: true,
      rollback: {
        description: 'Undo merge commit safely',
        canGuaranteeRestoration: false,
        warningMessage: 'Rolling back a committed merge requires reset; use safety snapshot to restore exact index state.',
      },
    });
  } else if (diagnosis.issue.includes('Detached HEAD')) {
    const recoveryBranchName = `recovery-${Date.now().toString(36)}`;
    steps.push({
      stepId: 'detached-create-branch',
      description: `Create and checkout new branch "${recoveryBranchName}" to save work`,
      command: `git checkout -b ${recoveryBranchName}`,
      commandExplanation: `Binds the detached HEAD commit to branch "${recoveryBranchName}" so work is preserved.`,
      riskLevel: 'amber',
      status: 'awaiting-approval',
      requiresApproval: true,
      rollback: {
        description: 'Switch back to detached commit',
        command: `git checkout ${repoStatus.headCommit ? repoStatus.headCommit.slice(0, 8) : 'HEAD'}`,
        canGuaranteeRestoration: true,
      },
    });
  } else if (diagnosis.issue.includes('rebase in progress')) {
    steps.push({
      stepId: 'rebase-abort',
      description: 'Abort paused rebase and restore pre-rebase branch state',
      command: 'git rebase --abort',
      commandExplanation: 'Cleanly aborts the current rebase attempt without losing repository commits.',
      riskLevel: 'amber',
      status: 'awaiting-approval',
      requiresApproval: true,
      rollback: {
        description: 'Cannot resume aborted rebase; rebase must be restarted manually.',
        canGuaranteeRestoration: false,
        warningMessage: 'Aborting a rebase discards in-progress conflict resolutions for that rebase.',
      },
    });
  } else if (diagnosis.issue.includes('merge in progress')) {
    steps.push({
      stepId: 'merge-abort',
      description: 'Abort in-progress merge and return to pre-merge HEAD',
      command: 'git merge --abort',
      commandExplanation: 'Safely restores working tree and HEAD to pre-merge state.',
      riskLevel: 'amber',
      status: 'awaiting-approval',
      requiresApproval: true,
      rollback: {
        description: 'Cannot undo merge abort automatically.',
        canGuaranteeRestoration: false,
        warningMessage: 'Aborting merge discards current merge state.',
      },
    });
  } else if (diagnosis.issue.includes('Dirty working tree')) {
    steps.push({
      stepId: 'dirty-stash',
      description: 'Safely stash working tree modifications including untracked files',
      command: 'git stash push -u -m "git-cure-auto-stash"',
      commandExplanation: 'Saves dirty changes to a stash so working tree becomes clean.',
      riskLevel: 'amber',
      status: 'awaiting-approval',
      requiresApproval: true,
      rollback: {
        description: 'Restore stashed modifications',
        command: 'git stash apply',
        canGuaranteeRestoration: false,
        warningMessage: 'Applying stash may produce merge conflicts if working tree changed.',
      },
    });
  }

  return steps;
}

export interface RunCureOptions {
  repoPath?: string;
  autoApprove?: boolean;
  dryRun?: boolean;
  emitters?: CliEventEmitters;
}

export interface RunCureResult {
  repoStatus: RepositoryStatus;
  diagnosis: DiagnosticResult | null;
  plan: RecoveryStep[];
  snapshot?: SnapshotMetadata;
  logs: ExecutionLog[];
  verifications: VerificationResult[];
  success: boolean;
}

/**
 * Primary coordinated recovery workflow:
 * 1. Collect repository telemetry
 * 2. Emit repository status
 * 3. Detect Git problems
 * 4. Generate recovery plan
 * 5. Validate the plan
 * 6. Create required recovery checkpoints
 * 7. Request explicit approval
 * 8. Execute approved steps
 * 9. Emit execution logs and state changes
 * 10. Verify final repository state
 */
export async function runCure(options?: RunCureOptions): Promise<RunCureResult> {
  const repoPath = path.resolve(options?.repoPath ?? process.cwd());
  const emitters = options?.emitters ?? defaultConsoleEmitters;
  const logs: ExecutionLog[] = [];
  const verifications: VerificationResult[] = [];

  function logAndEmit(level: 'info' | 'warn' | 'error' | 'debug', message: string, stepId?: string) {
    const entry: ExecutionLog = {
      timestamp: new Date().toISOString(),
      level,
      message,
      stepId,
    };
    logs.push(entry);
    emitters.emitLogAppended(entry);
  }

  // 1. Collect repository telemetry
  const detailedStatus = await collectDetailedRepoStatus(repoPath);
  const repoStatus: RepositoryStatus = {
    repoPath: detailedStatus.repoPath,
    repoName: detailedStatus.repoName,
    currentBranch: detailedStatus.currentBranch,
    headCommit: detailedStatus.headCommit,
    isDetachedHead: detailedStatus.isDetachedHead,
    workingTreeStatus: detailedStatus.workingTreeStatus,
    stagedCount: detailedStatus.stagedCount,
    unstagedCount: detailedStatus.unstagedCount,
    untrackedCount: detailedStatus.untrackedCount,
    conflictedCount: detailedStatus.conflictedCount,
    collectedAt: detailedStatus.collectedAt,
  };

  // 2. Emit repository status
  emitters.emitRepoStatus(repoStatus);

  // 3. Detect Git problems
  const diagnosis = detectProblems(repoStatus, detailedStatus);
  if (!diagnosis) {
    logAndEmit('info', 'Repository is clean and healthy. No Git problems detected.');
    const check: VerificationResult = {
      checkName: 'Clean state verification',
      passed: true,
      explanation: 'Repository working tree is clean and on a valid branch.',
    };
    verifications.push(check);
    emitters.emitVerificationComplete(verifications);
    return {
      repoStatus,
      diagnosis: null,
      plan: [],
      logs,
      verifications,
      success: true,
    };
  }

  emitters.emitDiagnosisReady(diagnosis);

  // 4. Generate recovery plan
  const plan = generateRecoveryPlan(diagnosis, repoStatus);
  emitters.emitRecoveryPlanReady(plan);

  if (plan.length === 0) {
    logAndEmit('warn', 'No automated recovery steps could be determined for this diagnosis.');
    return {
      repoStatus,
      diagnosis,
      plan,
      logs,
      verifications,
      success: false,
    };
  }

  // 5. Validate the plan
  const validation = validateRecoveryPlan(plan);
  if (!validation.valid) {
    logAndEmit('error', `Recovery plan validation failed: ${validation.errors.join('; ')}`);
    return {
      repoStatus,
      diagnosis,
      plan,
      logs,
      verifications,
      success: false,
    };
  }

  if (options?.dryRun) {
    logAndEmit('info', 'Dry run mode: plan validated successfully; skipping execution.');
    return {
      repoStatus,
      diagnosis,
      plan,
      logs,
      verifications,
      success: true,
    };
  }

  // 6. Create required recovery checkpoint (safety snapshot)
  const hasMutatingSteps = plan.some((s) => s.command && s.requiresApproval);
  let snapshot: SnapshotMetadata | undefined;

  if (hasMutatingSteps) {
    try {
      snapshot = await createSnapshot('Pre-recovery safety checkpoint', repoPath);
      emitters.emitSnapshotCreated(snapshot);
      logAndEmit('info', `Created safety snapshot: ${snapshot.snapshotId}`);

      // Attach snapshotId to steps with rollback
      for (const step of plan) {
        if (step.rollback) {
          step.rollback.snapshotId = snapshot.snapshotId;
        }
      }
    } catch (err: unknown) {
      const errorMsg = (err as Error).message || String(err);
      logAndEmit('error', `Safety snapshot creation failed: ${errorMsg}. Halting recovery.`);
      return {
        repoStatus,
        diagnosis,
        plan,
        logs,
        verifications,
        success: false,
      };
    }
  }

  // 7. Request approval & 8. Execute approved steps & 9. Emit execution logs
  let planSucceeded = true;
  for (const step of plan) {
    if (step.requiresApproval && !options?.autoApprove) {
      logAndEmit('warn', `Step ${step.stepId} requires explicit approval. Auto-approval disabled.`, step.stepId);
      emitters.emitStepStatusChanged({ ...step, status: 'awaiting-approval' });
      planSucceeded = false;
      break;
    }

    emitters.emitStepStatusChanged({ ...step, status: 'running' });

    const stepResult = await executeStepWithDetails(step, {
      repoPath,
      isApproved: true,
      activeSnapshotId: snapshot?.snapshotId,
      requireSnapshotForMutations: true,
    });

    logs.push(stepResult.log);
    emitters.emitLogAppended(stepResult.log);
    emitters.emitStepStatusChanged(stepResult.updatedStep);

    if (stepResult.verification) {
      verifications.push(stepResult.verification);
    }

    if (!stepResult.success) {
      planSucceeded = false;
      logAndEmit('error', `Step ${step.stepId} failed execution. Stopping recovery sequence.`, step.stepId);
      break;
    }
  }

  // 10. Verify the final repository state
  const finalStatus = await collectRepoStatus(repoPath);
  const finalCheck: VerificationResult = {
    checkName: 'Final repository state verification',
    passed: planSucceeded,
    explanation: `Post-recovery working tree status: "${finalStatus.workingTreeStatus}", conflicts: ${finalStatus.conflictedCount}.`,
  };
  verifications.push(finalCheck);
  emitters.emitVerificationComplete(verifications);

  return {
    repoStatus,
    diagnosis,
    plan,
    snapshot,
    logs,
    verifications,
    success: planSucceeded,
  };
}

// Backward-compatibility aliases for earlier phase signatures
export async function collectRepositoryStatus(repoPath?: string): Promise<RepositoryStatus> {
  return collectRepoStatus(repoPath);
}

export async function runDiagnostics(repoPath: string): Promise<void> {
  const result = await runCure({ repoPath, dryRun: true });
  if (result.diagnosis) {
    console.log(`Diagnosed issue: ${result.diagnosis.issue}`);
  } else {
    console.log('No issues detected.');
  }
}

// Entry point for future CLI binary / direct execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isAutoApprove = args.includes('--approve') || args.includes('-y');
  const pathArgIdx = args.findIndex((a) => a === '--path' || a === '-p');
  const repoPath = pathArgIdx !== -1 && args[pathArgIdx + 1] ? args[pathArgIdx + 1] : process.cwd();

  console.log('git-cure CLI — analyzing repository...');
  runCure({
    repoPath,
    dryRun: isDryRun,
    autoApprove: isAutoApprove,
  }).then((res) => {
    if (res.success) {
      console.log('✓ git-cure execution completed successfully.');
      process.exit(0);
    } else {
      console.error('✖ git-cure finished with warnings or halted steps.');
      process.exit(1);
    }
  }).catch((err) => {
    console.error('Fatal CLI error:', err);
    process.exit(1);
  });
}
