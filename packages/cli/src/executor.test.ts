import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RecoveryStep } from '@git-cure/shared';
import { executeStep, executeStepWithDetails, executePlan } from './executor';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `git-cure-exec-test-${prefix}-`));
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

test('executeStep executes valid read-only command and captures logs', async () => {
  const tempDir = createTempDir('read');
  try {
    runGit(tempDir, ['init']);
    const step: RecoveryStep = {
      stepId: 'check-status',
      description: 'Check git status',
      command: 'git status',
      commandExplanation: 'Check repository status',
      riskLevel: 'green',
      status: 'pending',
      requiresApproval: false,
    };

    const log = await executeStep(step, { repoPath: tempDir });
    assert.strictEqual(log.level, 'info');
    assert.ok(log.message.includes('Check git status'));
    assert.strictEqual(log.stepId, 'check-status');
  } finally {
    cleanupDir(tempDir);
  }
});

test('executeStep blocks mutating step when approval is missing', async () => {
  const tempDir = createTempDir('approval');
  try {
    runGit(tempDir, ['init']);
    const step: RecoveryStep = {
      stepId: 'mutate-branch',
      description: 'Create new branch',
      command: 'git checkout -b recovery-branch',
      commandExplanation: 'Create and checkout recovery branch',
      riskLevel: 'amber',
      status: 'pending',
      requiresApproval: true,
    };

    const result = await executeStepWithDetails(step, {
      repoPath: tempDir,
      isApproved: false,
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.log.level, 'warn');
    assert.strictEqual(result.updatedStep.status, 'awaiting-approval');
  } finally {
    cleanupDir(tempDir);
  }
});

test('executeStep executes approved mutating step and verifies state', async () => {
  const tempDir = createTempDir('mutating');
  try {
    runGit(tempDir, ['init']);
    runGit(tempDir, ['config', 'user.name', 'Test Runner']);
    runGit(tempDir, ['config', 'user.email', 'test@example.com']);

    // Commit a file so branch creation works
    fs.writeFileSync(path.join(tempDir, 'init.txt'), 'init\n', 'utf8');
    runGit(tempDir, ['add', 'init.txt']);
    runGit(tempDir, ['commit', '-m', 'init']);

    const step: RecoveryStep = {
      stepId: 'create-branch',
      description: 'Create and switch to recovery branch',
      command: 'git checkout -b save-work',
      commandExplanation: 'Create new branch',
      riskLevel: 'amber',
      status: 'pending',
      requiresApproval: true,
    };

    const result = await executeStepWithDetails(step, {
      repoPath: tempDir,
      isApproved: true,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.log.level, 'info');
    assert.strictEqual(result.updatedStep.status, 'completed');
    assert.ok(result.verification);
    assert.strictEqual(result.verification!.passed, true);
  } finally {
    cleanupDir(tempDir);
  }
});

test('executeStep blocks mutating step when required snapshot is missing', async () => {
  const tempDir = createTempDir('snap-missing');
  try {
    runGit(tempDir, ['init']);
    const step: RecoveryStep = {
      stepId: 'stage-files',
      description: 'Stage file',
      command: 'git add file.txt',
      commandExplanation: 'Stage file for commit',
      riskLevel: 'amber',
      status: 'pending',
      requiresApproval: true,
    };

    const result = await executeStepWithDetails(step, {
      repoPath: tempDir,
      isApproved: true,
      requireSnapshotForMutations: true,
      activeSnapshotId: undefined, // No active snapshot!
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.log.level, 'error');
    assert.ok(result.log.message.includes('requires an active safety snapshot'));
  } finally {
    cleanupDir(tempDir);
  }
});

test('executePlan stops immediately on step failure', async () => {
  const tempDir = createTempDir('plan-stop');
  try {
    runGit(tempDir, ['init']);
    const plan: RecoveryStep[] = [
      {
        stepId: 'step-1',
        description: 'Read status',
        command: 'git status',
        commandExplanation: 'Check status',
        riskLevel: 'green',
        status: 'pending',
        requiresApproval: false,
      },
      {
        stepId: 'step-2',
        description: 'Destructive command blocked',
        command: 'git reset --hard',
        commandExplanation: 'Blocked destructive command',
        riskLevel: 'destructive',
        status: 'pending',
        requiresApproval: true,
      },
      {
        stepId: 'step-3',
        description: 'Never reached',
        command: 'git status',
        commandExplanation: 'Should never run',
        riskLevel: 'green',
        status: 'pending',
        requiresApproval: false,
      },
    ];

    const planResult = await executePlan(plan, { repoPath: tempDir });
    assert.strictEqual(planResult.success, false);
    // Should have stopped after step-2 failed
    assert.strictEqual(planResult.finalSteps.length, 2);
    assert.strictEqual(planResult.finalSteps[0].status, 'completed');
    assert.strictEqual(planResult.finalSteps[1].status, 'failed');
  } finally {
    cleanupDir(tempDir);
  }
});
