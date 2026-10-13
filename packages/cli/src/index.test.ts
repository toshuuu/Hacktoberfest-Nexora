import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type {
  RepositoryStatus,
  DiagnosticResult,
  RecoveryStep,
  SnapshotMetadata,
  ExecutionLog,
  VerificationResult,
} from '@git-cure/shared';
import { runCure, CliEventEmitters } from './index';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `git-cure-index-test-${prefix}-`));
}

function runGit(repoDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors on Windows locks
  }
}

test('runCure succeeds on a clean git repository', async () => {
  const tempDir = createTempDir('clean');
  try {
    runGit(tempDir, ['init']);
    runGit(tempDir, ['config', 'user.name', 'Test Runner']);
    runGit(tempDir, ['config', 'user.email', 'test@example.com']);

    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'clean\n', 'utf8');
    runGit(tempDir, ['add', 'file.txt']);
    runGit(tempDir, ['commit', '-m', 'clean commit']);

    const emittedEvents: string[] = [];
    const mockEmitters: CliEventEmitters = {
      emitRepoStatus: () => emittedEvents.push('repoStatus'),
      emitDiagnosisReady: () => emittedEvents.push('diagnosis'),
      emitRecoveryPlanReady: () => emittedEvents.push('plan'),
      emitStepStatusChanged: () => emittedEvents.push('stepStatus'),
      emitSnapshotCreated: () => emittedEvents.push('snapshot'),
      emitLogAppended: () => emittedEvents.push('log'),
      emitVerificationComplete: () => emittedEvents.push('verification'),
    };

    const result = await runCure({ repoPath: tempDir, emitters: mockEmitters });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.diagnosis, null);
    assert.ok(emittedEvents.includes('repoStatus'));
    assert.ok(emittedEvents.includes('verification'));
  } finally {
    cleanupDir(tempDir);
  }
});

test('runCure pauses at awaiting-approval when autoApprove is false', async () => {
  const tempDir = createTempDir('approval-pause');
  try {
    runGit(tempDir, ['init']);
    runGit(tempDir, ['config', 'user.name', 'Test Runner']);
    runGit(tempDir, ['config', 'user.email', 'test@example.com']);

    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content\n', 'utf8');
    runGit(tempDir, ['add', 'file.txt']);
    runGit(tempDir, ['commit', '-m', 'initial']);

    // Detach HEAD
    const headSha = runGit(tempDir, ['rev-parse', 'HEAD']).trim();
    runGit(tempDir, ['checkout', '--detach', headSha]);

    let stepStatusState: string | undefined;
    const mockEmitters: CliEventEmitters = {
      emitRepoStatus: () => {},
      emitDiagnosisReady: () => {},
      emitRecoveryPlanReady: () => {},
      emitStepStatusChanged: (step) => {
        stepStatusState = step.status;
      },
      emitSnapshotCreated: () => {},
      emitLogAppended: () => {},
      emitVerificationComplete: () => {},
    };

    const result = await runCure({
      repoPath: tempDir,
      autoApprove: false,
      emitters: mockEmitters,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.diagnosis);
    assert.strictEqual(result.diagnosis!.issue, 'Detached HEAD state');
    assert.strictEqual(stepStatusState, 'awaiting-approval');

    // Confirm that HEAD is STILL detached (no branch was created without approval)
    const currentBranch = runGit(tempDir, ['branch', '--show-current']).trim();
    assert.strictEqual(currentBranch, '');
  } finally {
    cleanupDir(tempDir);
  }
});

test('runCure executes approved recovery for detached HEAD', async () => {
  const tempDir = createTempDir('detached-recover');
  try {
    runGit(tempDir, ['init']);
    runGit(tempDir, ['config', 'user.name', 'Test Runner']);
    runGit(tempDir, ['config', 'user.email', 'test@example.com']);

    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content\n', 'utf8');
    runGit(tempDir, ['add', 'file.txt']);
    runGit(tempDir, ['commit', '-m', 'initial']);

    const headSha = runGit(tempDir, ['rev-parse', 'HEAD']).trim();
    runGit(tempDir, ['checkout', '--detach', headSha]);

    let snapshotCreated = false;
    let completedSteps = 0;
    const mockEmitters: CliEventEmitters = {
      emitRepoStatus: () => {},
      emitDiagnosisReady: () => {},
      emitRecoveryPlanReady: () => {},
      emitStepStatusChanged: (step) => {
        if (step.status === 'completed') completedSteps++;
      },
      emitSnapshotCreated: () => {
        snapshotCreated = true;
      },
      emitLogAppended: () => {},
      emitVerificationComplete: () => {},
    };

    const result = await runCure({
      repoPath: tempDir,
      autoApprove: true,
      emitters: mockEmitters,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(snapshotCreated, true);
    assert.ok(completedSteps > 0);

    // Confirm that HEAD is now on a recovery branch!
    const currentBranch = runGit(tempDir, ['branch', '--show-current']).trim();
    assert.ok(currentBranch.startsWith('recovery-'));
  } finally {
    cleanupDir(tempDir);
  }
});
