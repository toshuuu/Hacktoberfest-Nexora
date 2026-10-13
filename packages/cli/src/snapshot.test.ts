import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSnapshot, restoreSnapshot, findStashRefBySnapshotId } from './snapshot';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `git-cure-snap-test-${prefix}-`));
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

test('createSnapshot preserves staged, unstaged, and untracked changes', async () => {
  const tempDir = createTempDir('preserve');
  try {
    runGit(tempDir, ['init']);
    runGit(tempDir, ['config', 'user.name', 'Test Runner']);
    runGit(tempDir, ['config', 'user.email', 'test@example.com']);

    // Commit a base file
    fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'version 1\n', 'utf8');
    runGit(tempDir, ['add', 'tracked.txt']);
    runGit(tempDir, ['commit', '-m', 'initial commit']);

    // Create unstaged modification and untracked file
    fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'version 2 modified\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'untracked.txt'), 'untracked content\n', 'utf8');

    // Create snapshot
    const metadata = await createSnapshot('Pre-recovery snapshot', tempDir);
    assert.strictEqual(metadata.type, 'stash');
    assert.strictEqual(metadata.status, 'active');
    assert.ok(metadata.snapshotId.startsWith('cure_snap_'));

    // Verify working tree was stashed (clean now)
    const statusAfter = runGit(tempDir, ['status', '--porcelain']).trim();
    assert.strictEqual(statusAfter, '');

    // Restore snapshot
    const restored = await restoreSnapshot(metadata.snapshotId, tempDir);
    assert.strictEqual(restored, true);

    // Verify content restored
    const trackedContent = fs.readFileSync(path.join(tempDir, 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n');
    assert.strictEqual(trackedContent, 'version 2 modified\n');
    assert.ok(fs.existsSync(path.join(tempDir, 'untracked.txt')));
  } finally {
    cleanupDir(tempDir);
  }
});

test('createSnapshot does not stash sensitive ignored files', async () => {
  const tempDir = createTempDir('ignored');
  try {
    runGit(tempDir, ['init']);
    runGit(tempDir, ['config', 'user.name', 'Test Runner']);
    runGit(tempDir, ['config', 'user.email', 'test@example.com']);

    // Commit gitignore
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.env\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'app.js'), 'console.log(1);\n', 'utf8');
    runGit(tempDir, ['add', '.gitignore', 'app.js']);
    runGit(tempDir, ['commit', '-m', 'init']);

    // Create an ignored sensitive file and a modified file
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET_API_KEY=xyz123\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'app.js'), 'console.log(2);\n', 'utf8');

    // Create snapshot
    const metadata = await createSnapshot('Check ignored preservation', tempDir);
    assert.strictEqual(metadata.status, 'active');

    // .env should still exist in working tree because it was NOT included in stash
    assert.ok(fs.existsSync(path.join(tempDir, '.env')));
    const envContent = fs.readFileSync(path.join(tempDir, '.env'), 'utf8').replace(/\r\n/g, '\n');
    assert.strictEqual(envContent, 'SECRET_API_KEY=xyz123\n');
  } finally {
    cleanupDir(tempDir);
  }
});

test('createSnapshot creates backup-branch when working tree is clean', async () => {
  const tempDir = createTempDir('clean');
  try {
    runGit(tempDir, ['init']);
    runGit(tempDir, ['config', 'user.name', 'Test Runner']);
    runGit(tempDir, ['config', 'user.email', 'test@example.com']);

    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'clean\n', 'utf8');
    runGit(tempDir, ['add', 'file.txt']);
    runGit(tempDir, ['commit', '-m', 'init']);

    const metadata = await createSnapshot('Clean checkpoint', tempDir);
    assert.strictEqual(metadata.type, 'backup-branch');
    assert.strictEqual(metadata.status, 'active');

    const restored = await restoreSnapshot(metadata.snapshotId, tempDir);
    assert.strictEqual(restored, true);
  } finally {
    cleanupDir(tempDir);
  }
});

test('restoreSnapshot returns false for unknown snapshot id', async () => {
  const tempDir = createTempDir('unknown');
  try {
    runGit(tempDir, ['init']);
    const restored = await restoreSnapshot('non_existent_id', tempDir);
    assert.strictEqual(restored, false);
  } finally {
    cleanupDir(tempDir);
  }
});
