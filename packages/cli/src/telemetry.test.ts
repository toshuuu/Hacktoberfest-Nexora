import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  collectRepoStatus,
  collectDetailedRepoStatus,
  parsePorcelainLine,
  isSuspiciousFilename,
} from './telemetry';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `git-cure-test-${prefix}-`));
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

test('parsePorcelainLine correctly classifies Git status markers', () => {
  // Modified staged
  const staged = parsePorcelainLine('M  file.txt');
  assert.ok(staged);
  assert.strictEqual(staged!.isStaged, true);
  assert.strictEqual(staged!.isUnstaged, false);
  assert.strictEqual(staged!.isConflicted, false);
  assert.strictEqual(staged!.path, 'file.txt');

  // Modified unstaged
  const unstaged = parsePorcelainLine(' M file2.txt');
  assert.ok(unstaged);
  assert.strictEqual(unstaged!.isStaged, false);
  assert.strictEqual(unstaged!.isUnstaged, true);
  assert.strictEqual(unstaged!.isConflicted, false);

  // Untracked
  const untracked = parsePorcelainLine('?? new.txt');
  assert.ok(untracked);
  assert.strictEqual(untracked!.isUntracked, true);
  assert.strictEqual(untracked!.isStaged, false);

  // Conflicts
  const conflictUU = parsePorcelainLine('UU conflicted.txt');
  assert.ok(conflictUU);
  assert.strictEqual(conflictUU!.isConflicted, true);

  const conflictAA = parsePorcelainLine('AA both_added.txt');
  assert.ok(conflictAA);
  assert.strictEqual(conflictAA!.isConflicted, true);

  // Renamed
  const renamed = parsePorcelainLine('R  old.txt -> new.txt');
  assert.ok(renamed);
  assert.strictEqual(renamed!.isStaged, true);
  assert.strictEqual(renamed!.path, 'new.txt');
});

test('isSuspiciousFilename catches credential-like names', () => {
  assert.strictEqual(isSuspiciousFilename('.env'), true);
  assert.strictEqual(isSuspiciousFilename('.env.local'), true);
  assert.strictEqual(isSuspiciousFilename('id_rsa'), true);
  assert.strictEqual(isSuspiciousFilename('server.key'), true);
  assert.strictEqual(isSuspiciousFilename('cert.pem'), true);
  assert.strictEqual(isSuspiciousFilename('credentials.json'), true);
  assert.strictEqual(isSuspiciousFilename('normal-file.ts'), false);
  assert.strictEqual(isSuspiciousFilename('README.md'), false);
});

test('telemetry in a fresh disposable git repo', async () => {
  const tempDir = createTempDir('telemetry');
  try {
    runGit(tempDir, ['init']);
    runGit(tempDir, ['config', 'user.name', 'Test Runner']);
    runGit(tempDir, ['config', 'user.email', 'test@example.com']);

    // Initial empty repo check
    const emptyStatus = await collectRepoStatus(tempDir);
    assert.strictEqual(emptyStatus.workingTreeStatus, 'clean');
    assert.strictEqual(emptyStatus.headCommit, '');
    assert.strictEqual(emptyStatus.stagedCount, 0);
    assert.strictEqual(emptyStatus.untrackedCount, 0);

    // Create and commit a file
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'hello world\n', 'utf8');
    runGit(tempDir, ['add', 'file.txt']);
    runGit(tempDir, ['commit', '-m', 'initial commit']);

    const cleanStatus = await collectRepoStatus(tempDir);
    assert.strictEqual(cleanStatus.workingTreeStatus, 'clean');
    assert.ok(cleanStatus.headCommit.length > 0);
    assert.strictEqual(cleanStatus.isDetachedHead, false);

    // Create untracked, staged, unstaged files
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'modified content\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'staged.txt'), 'staged\n', 'utf8');
    runGit(tempDir, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(tempDir, 'untracked.txt'), 'untracked\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET=123\n', 'utf8');

    const dirtyDetailed = await collectDetailedRepoStatus(tempDir);
    assert.strictEqual(dirtyDetailed.workingTreeStatus, 'dirty');
    assert.strictEqual(dirtyDetailed.stagedCount, 1);
    assert.strictEqual(dirtyDetailed.unstagedCount, 1);
    assert.strictEqual(dirtyDetailed.untrackedCount, 2); // untracked.txt and .env
    assert.ok(dirtyDetailed.suspiciousFiles.includes('.env'));

    // Check detached HEAD state
    runGit(tempDir, ['checkout', '--detach', cleanStatus.headCommit]);
    const detachedStatus = await collectRepoStatus(tempDir);
    assert.strictEqual(detachedStatus.isDetachedHead, true);
  } finally {
    cleanupDir(tempDir);
  }
});

test('telemetry rejects non-git directory', async () => {
  const tempDir = createTempDir('non-git');
  try {
    await assert.rejects(async () => {
      await collectRepoStatus(tempDir);
    }, /Not a git repository/);
  } finally {
    cleanupDir(tempDir);
  }
});
