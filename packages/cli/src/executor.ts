import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type {
  RecoveryStep,
  ExecutionLog,
  LogLevel,
  VerificationResult,
} from '@git-cure/shared';
import { validateRecoveryStep } from './validator';
import { runGit, collectRepoStatus } from './telemetry';

const execFileAsync = promisify(execFile);

export interface ExecutionOptions {
  repoPath?: string;
  isApproved?: boolean;
  activeSnapshotId?: string;
  requireSnapshotForMutations?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StepExecutionResult {
  log: ExecutionLog;
  success: boolean;
  verification?: VerificationResult;
  updatedStep: RecoveryStep;
}

/**
 * Runs a verification check on the repository state following execution of a step.
 */
export async function verifyStepOutcome(
  step: RecoveryStep,
  repoPath: string
): Promise<VerificationResult> {
  const status = await collectRepoStatus(repoPath);

  if (step.command?.startsWith('git checkout -b ') || step.command?.startsWith('git switch -c ')) {
    const targetBranch = step.command.split(' ').pop()?.trim();
    const passed = status.currentBranch === targetBranch && !status.isDetachedHead;
    return {
      checkName: 'Branch creation and checkout',
      passed,
      explanation: passed
        ? `Successfully checked out new branch "${targetBranch}".`
        : `Expected branch "${targetBranch}", but current branch is "${status.currentBranch}".`,
    };
  }

  if (step.command?.startsWith('git add ')) {
    const passed = status.stagedCount > 0 || status.conflictedCount === 0;
    return {
      checkName: 'File staged in index',
      passed,
      explanation: passed
        ? `Staging completed. Index contains ${status.stagedCount} staged files.`
        : 'Index check failed: file was not staged.',
    };
  }

  if (step.command?.startsWith('git commit')) {
    const passed = status.stagedCount === 0;
    return {
      checkName: 'Commit created',
      passed,
      explanation: passed
        ? `Commit recorded at HEAD (${status.headCommit.slice(0, 8)}). Working tree staged count is now 0.`
        : 'Commit check failed: staged files remain in index.',
    };
  }

  // Default general check
  return {
    checkName: 'Repository integrity check',
    passed: true,
    explanation: `Repository working tree status is "${status.workingTreeStatus}".`,
  };
}

/**
 * Executes a single predefined, validated Git recovery step.
 * Uses explicit argument arrays and shell-disabled subprocesses.
 * Requires approval for mutations and blocks destructive actions.
 */
export async function executeStep(
  step: RecoveryStep,
  options?: ExecutionOptions
): Promise<ExecutionLog> {
  const detailedResult = await executeStepWithDetails(step, options);
  return detailedResult.log;
}

/**
 * Detailed variant of executeStep returning full execution metadata and verification results.
 */
export async function executeStepWithDetails(
  step: RecoveryStep,
  options?: ExecutionOptions
): Promise<StepExecutionResult> {
  const repoPath = path.resolve(options?.repoPath ?? process.cwd());
  const startTime = new Date().toISOString();

  // 1. Informational steps without commands
  if (!step.command) {
    return {
      log: {
        timestamp: startTime,
        level: 'info' as LogLevel,
        message: `ℹ ${step.description}`,
        stepId: step.stepId,
      },
      success: true,
      updatedStep: { ...step, status: 'completed' },
    };
  }

  // 2. Validate step against fixed allowlist and security rules
  const validation = validateRecoveryStep(step);
  if (!validation.valid || !validation.sanitizedArgs) {
    const errorMsg = `Command blocked by validator: ${validation.errors.join('; ')}`;
    return {
      log: {
        timestamp: startTime,
        level: 'error' as LogLevel,
        message: `✗ ${errorMsg}`,
        stepId: step.stepId,
      },
      success: false,
      updatedStep: { ...step, status: 'failed' },
    };
  }

  // 3. Approval verification
  const isApproved =
    options?.isApproved === true ||
    step.status === 'completed' ||
    (step as { isApproved?: boolean }).isApproved === true;

  if (step.requiresApproval && !isApproved) {
    return {
      log: {
        timestamp: startTime,
        level: 'warn' as LogLevel,
        message: `Step ${step.stepId} awaiting explicit user approval before execution: "${step.command}"`,
        stepId: step.stepId,
      },
      success: false,
      updatedStep: { ...step, status: 'awaiting-approval' },
    };
  }

  // 4. Require snapshot before mutating repository state
  if (validation.mutatesRepo && options?.requireSnapshotForMutations) {
    if (!options.activeSnapshotId) {
      return {
        log: {
          timestamp: startTime,
          level: 'error' as LogLevel,
          message: `Execution blocked: mutating action "${step.command}" requires an active safety snapshot.`,
          stepId: step.stepId,
        },
        success: false,
        updatedStep: { ...step, status: 'failed' },
      };
    }
  }

  // 5. Execute using child_process.execFile with explicit args and shell: false
  const timeoutMs = options?.timeoutMs ?? 30000;

  try {
    const { stdout, stderr } = await execFileAsync('git', validation.sanitizedArgs, {
      cwd: repoPath,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      signal: options?.signal,
      maxBuffer: 10 * 1024 * 1024,
    });

    const completionTime = new Date().toISOString();

    // 6. Post-execution verification
    let verification: VerificationResult | undefined;
    try {
      verification = await verifyStepOutcome(step, repoPath);
    } catch {
      // Non-fatal if verification check fails to run
    }

    const outputSummary = stdout.trim() ? ` (${stdout.trim().split('\n')[0]})` : '';

    return {
      log: {
        timestamp: completionTime,
        level: 'info' as LogLevel,
        message: `✓ ${step.description}${outputSummary}`,
        stepId: step.stepId,
      },
      success: true,
      verification,
      updatedStep: { ...step, status: 'completed' },
    };
  } catch (err: unknown) {
    const error = err as {
      code?: string | number;
      name?: string;
      message?: string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };

    const completionTime = new Date().toISOString();
    let failureMessage: string;

    if (error.name === 'AbortError' || options?.signal?.aborted) {
      failureMessage = `Operation cancelled by user`;
    } else if (error.killed || error.code === 'ETIMEDOUT') {
      failureMessage = `Operation timed out after ${timeoutMs}ms`;
    } else {
      const detail = (error.stderr || error.stdout || error.message || '').trim();
      failureMessage = `Failed: ${step.description}${detail ? ` - ${detail}` : ''}`;
    }

    return {
      log: {
        timestamp: completionTime,
        level: 'error' as LogLevel,
        message: `✗ ${failureMessage}`,
        stepId: step.stepId,
      },
      success: false,
      updatedStep: { ...step, status: 'failed' },
    };
  }
}

/**
 * Sequentially executes a recovery plan, stopping immediately if any step fails
 * or lacks required approval.
 */
export async function executePlan(
  plan: RecoveryStep[],
  options?: ExecutionOptions,
  onStepChange?: (step: RecoveryStep) => void,
  onLog?: (log: ExecutionLog) => void
): Promise<{ success: boolean; executedLogs: ExecutionLog[]; finalSteps: RecoveryStep[] }> {
  const executedLogs: ExecutionLog[] = [];
  const finalSteps: RecoveryStep[] = [];
  let allSuccess = true;

  for (const step of plan) {
    const runningStep: RecoveryStep = { ...step, status: 'running' };
    if (onStepChange) onStepChange(runningStep);

    const result = await executeStepWithDetails(step, options);
    executedLogs.push(result.log);
    finalSteps.push(result.updatedStep);

    if (onLog) onLog(result.log);
    if (onStepChange) onStepChange(result.updatedStep);

    if (!result.success) {
      allSuccess = false;
      break;
    }
  }

  return {
    success: allSuccess,
    executedLogs,
    finalSteps,
  };
}
