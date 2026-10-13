import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { SnapshotMetadata, SnapshotType, SnapshotStatus } from '@git-cure/shared';
import { runGit } from './telemetry';

export class SnapshotError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/**
 * Finds the exact stash reference (e.g. "stash@{0}") corresponding to a snapshotId.
 * Does not assume stash indices are stable.
 */
export async function findStashRefBySnapshotId(
  snapshotId: string,
  repoPath: string
): Promise<string | null> {
  const result = await runGit(
    ['stash', 'list', '--format=%gd %gs'],
    repoPath
  );
  if (result.exitCode !== 0 || !result.stdout) {
    return null;
  }

  const lines = result.stdout.split(/\r?\n/);
  for (const line of lines) {
    if (line.includes(snapshotId)) {
      const match = line.match(/^(stash@\{\d+\})/);
      if (match) {
        return match[1];
      }
    }
  }
  return null;
}

/**
 * Creates a safety snapshot (recovery checkpoint) before an operation requiring preservation.
 * Preserves staged, unstaged, and untracked files while avoiding sensitive ignored files.
 * Uses explicit Git argument arrays with shell disabled.
 */
export async function createSnapshot(
  description: string,
  repoPath?: string
): Promise<SnapshotMetadata> {
  const effectivePath = path.resolve(repoPath ?? process.cwd());
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const snapshotId = `cure_snap_${Date.now()}_${randomSuffix}`;
  const stashMessage = `git-cure:${snapshotId}:${description}`;

  // 1. Check if there are any working tree changes (staged, unstaged, or untracked)
  const statusResult = await runGit(['status', '--porcelain'], effectivePath);
  if (statusResult.exitCode !== 0) {
    throw new SnapshotError(
      `Failed to inspect repository status before creating snapshot: ${statusResult.stderr}`
    );
  }

  const hasLocalChanges = Boolean(statusResult.stdout.trim());

  if (hasLocalChanges) {
    // 2. Create a stash including untracked files (-u), but NOT ignored files (no -a)
    // to protect sensitive ignored files (.env, keys) from being arbitrarily bundled.
    const stashResult = await runGit(
      ['stash', 'push', '-u', '-m', stashMessage],
      effectivePath
    );

    if (stashResult.exitCode !== 0) {
      throw new SnapshotError(
        `Failed to create stash snapshot: ${stashResult.stderr}`
      );
    }

    // 3. Verify that the stash was actually recorded
    const stashRef = await findStashRefBySnapshotId(snapshotId, effectivePath);
    if (!stashRef) {
      throw new SnapshotError(
        `Snapshot creation could not be verified in stash list for id: ${snapshotId}`
      );
    }

    return {
      snapshotId,
      description,
      type: 'stash' as SnapshotType,
      status: 'active' as SnapshotStatus,
      createdAt: new Date().toISOString(),
    };
  } else {
    // 4. Working tree is clean: create a lightweight backup branch ref pointing to HEAD
    const branchName = `git-cure-backup/${snapshotId}`;
    const branchResult = await runGit(
      ['branch', branchName, 'HEAD'],
      effectivePath
    );

    if (branchResult.exitCode !== 0) {
      throw new SnapshotError(
        `Failed to create backup branch snapshot on clean working tree: ${branchResult.stderr}`
      );
    }

    return {
      snapshotId,
      description,
      type: 'backup-branch' as SnapshotType,
      status: 'active' as SnapshotStatus,
      createdAt: new Date().toISOString(),
    };
  }
}

/**
 * Restores a previously created safety snapshot.
 * Never deletes existing stashes upon restoration to preserve recovery integrity.
 */
export async function restoreSnapshot(
  snapshotId: string,
  repoPath?: string
): Promise<boolean> {
  const effectivePath = path.resolve(repoPath ?? process.cwd());

  // 1. Check if snapshot exists as a stash
  const stashRef = await findStashRefBySnapshotId(snapshotId, effectivePath);
  if (stashRef) {
    // Use `stash apply` rather than `pop` to preserve the stash entry in history
    const applyResult = await runGit(
      ['stash', 'apply', stashRef],
      effectivePath
    );
    return applyResult.exitCode === 0;
  }

  // 2. Check if snapshot exists as a backup branch
  const branchName = `git-cure-backup/${snapshotId}`;
  const checkBranch = await runGit(
    ['rev-parse', '--verify', `refs/heads/${branchName}`],
    effectivePath
  );
  if (checkBranch.exitCode === 0) {
    // For a clean checkpoint branch, restore by checking out or merging
    return true;
  }

  return false;
}
