import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryStatus } from '@git-cure/shared';

const execFileAsync = promisify(execFile);

/**
 * Result of executing a Git command via execFile with shell disabled.
 */
export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Represents a parsed line from `git status --porcelain`.
 */
export interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
  isConflicted: boolean;
  isStaged: boolean;
  isUnstaged: boolean;
  isUntracked: boolean;
  isIgnored: boolean;
}

/**
 * Extended repository telemetry including auxiliary metadata
 * useful for problem detection without needing extra Git calls.
 */
export interface DetailedRepoStatus extends RepositoryStatus {
  upstream?: string;
  isMerging: boolean;
  isRebasing: boolean;
  isCherryPicking: boolean;
  isReverting: boolean;
  conflictedFiles: string[];
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  suspiciousFiles: string[];
}

/**
 * Suspicious file patterns that might contain credentials or secrets.
 * We inspect FILENAMES only, never file contents.
 */
const SUSPICIOUS_FILENAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|pkcs12|pfx|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials\.json$/i,
  /^client_secret.*\.json$/i,
  /^service_account.*\.json$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^secrets?\.(json|ya?ml)$/i,
];

/**
 * Safely executes a Git command with explicit argument array and shell disabled.
 */
export async function runGit(
  args: string[],
  cwd: string
): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout,
      stderr: stderr.trim(),
      exitCode: 0,
    };
  } catch (err: unknown) {
    const error = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    return {
      stdout: error.stdout ?? '',
      stderr: (error.stderr ?? error.message ?? '').trim(),
      exitCode: typeof error.code === 'number' ? error.code : 1,
    };
  }
}

/**
 * Parses a single line of `git status --porcelain` (v1 format).
 */
export function parsePorcelainLine(line: string): PorcelainEntry | null {
  if (!line || line.length < 3) {
    return null;
  }

  const x = line[0];
  const y = line[1];
  let rawPath = line.slice(3).trim();

  // Handle renames (e.g. "R  old -> new")
  if (rawPath.includes(' -> ')) {
    const parts = rawPath.split(' -> ');
    rawPath = parts[parts.length - 1].trim();
  }

  // Strip enclosing quotes if present (for paths with spaces/escaped chars)
  if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
    rawPath = rawPath.slice(1, -1);
  }

  // Untracked files
  if (x === '?' && y === '?') {
    return {
      x,
      y,
      path: rawPath,
      isConflicted: false,
      isStaged: false,
      isUnstaged: false,
      isUntracked: true,
      isIgnored: false,
    };
  }

  // Ignored files
  if (x === '!' && y === '!') {
    return {
      x,
      y,
      path: rawPath,
      isConflicted: false,
      isStaged: false,
      isUnstaged: false,
      isUntracked: false,
      isIgnored: true,
    };
  }

  // Conflict state patterns in porcelain v1:
  // DD, AU, UD, UA, DU, AA, UU or any unmerged marker
  const isConflict =
    x === 'U' ||
    y === 'U' ||
    (x === 'A' && y === 'A') ||
    (x === 'D' && y === 'D');

  if (isConflict) {
    return {
      x,
      y,
      path: rawPath,
      isConflicted: true,
      isStaged: false,
      isUnstaged: false,
      isUntracked: false,
      isIgnored: false,
    };
  }

  const isStaged = x !== ' ' && x !== '?';
  const isUnstaged = y !== ' ' && y !== '?';

  return {
    x,
    y,
    path: rawPath,
    isConflicted: false,
    isStaged,
    isUnstaged,
    isUntracked: false,
    isIgnored: false,
  };
}

/**
 * Parses the complete output of `git status --porcelain`.
 */
export function parsePorcelainOutput(output: string): PorcelainEntry[] {
  if (!output) {
    return [];
  }
  const lines = output.split(/\r?\n/);
  const entries: PorcelainEntry[] = [];
  for (const line of lines) {
    const entry = parsePorcelainLine(line);
    if (entry && !entry.isIgnored) {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Checks whether a given filename matches suspicious secret file patterns.
 */
export function isSuspiciousFilename(filePath: string): boolean {
  const base = path.basename(filePath);
  return SUSPICIOUS_FILENAME_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * Collects comprehensive repository telemetry without modifying repository state
 * or reading secret file contents.
 */
export async function collectDetailedRepoStatus(
  targetPath?: string
): Promise<DetailedRepoStatus> {
  const effectivePath = path.resolve(targetPath ?? process.cwd());

  // 1. Verify that target directory is inside a Git repository
  const verifyGit = await runGit(['rev-parse', '--is-inside-work-tree'], effectivePath);
  if (verifyGit.exitCode !== 0 || verifyGit.stdout.trim() !== 'true') {
    throw new Error(`Not a git repository: ${effectivePath}`);
  }

  // 2. Discover repository root
  const rootResult = await runGit(['rev-parse', '--show-toplevel'], effectivePath);
  const repoPath = rootResult.exitCode === 0 && rootResult.stdout.trim()
    ? path.resolve(rootResult.stdout.trim())
    : effectivePath;
  const repoName = path.basename(repoPath);

  // 3. Discover .git directory location (handles submodules / worktrees)
  const gitDirResult = await runGit(['rev-parse', '--git-dir'], repoPath);
  const gitDir = gitDirResult.exitCode === 0 && gitDirResult.stdout.trim()
    ? path.resolve(repoPath, gitDirResult.stdout.trim())
    : path.join(repoPath, '.git');

  // 4. Branch and detached HEAD inspection
  const showCurrent = await runGit(['branch', '--show-current'], repoPath);
  let currentBranch = showCurrent.stdout.trim();
  let isDetachedHead = false;

  if (!currentBranch) {
    // If show-current is empty, check if we're in detached HEAD or on an unborn branch
    const abbrevRef = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    const abbrevStr = abbrevRef.stdout.trim();
    if (abbrevRef.exitCode === 0) {
      if (abbrevStr === 'HEAD') {
        isDetachedHead = true;
        currentBranch = 'HEAD';
      } else {
        currentBranch = abbrevStr;
      }
    } else {
      // Unborn branch with no commits yet
      currentBranch = 'main';
    }
  }

  // 5. HEAD commit SHA (may fail on an empty repository without commits)
  const headResult = await runGit(['rev-parse', 'HEAD'], repoPath);
  const headCommit = headResult.exitCode === 0 ? headResult.stdout.trim() : '';

  // If there are commits and symbolic-ref fails, it is definitely detached HEAD
  if (headCommit) {
    const symRef = await runGit(['symbolic-ref', '-q', 'HEAD'], repoPath);
    if (symRef.exitCode !== 0) {
      isDetachedHead = true;
    }
  }

  // 6. Upstream tracking branch (safe fallback if missing)
  const upstreamResult = await runGit(['rev-parse', '--abbrev-ref', '@{u}'], repoPath);
  const upstream = upstreamResult.exitCode === 0 && upstreamResult.stdout.trim()
    ? upstreamResult.stdout.trim()
    : undefined;

  // 7. Check for in-progress operations
  const isMerging = fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
  const isRebasing =
    fs.existsSync(path.join(gitDir, 'rebase-merge')) ||
    fs.existsSync(path.join(gitDir, 'rebase-apply'));
  const isCherryPicking = fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'));
  const isReverting = fs.existsSync(path.join(gitDir, 'REVERT_HEAD'));

  // 8. Working tree status via git status --porcelain
  const statusResult = await runGit(['status', '--porcelain'], repoPath);
  const entries = parsePorcelainOutput(statusResult.stdout);

  const conflictedEntries = entries.filter((e) => e.isConflicted);
  const stagedEntries = entries.filter((e) => e.isStaged);
  const unstagedEntries = entries.filter((e) => e.isUnstaged);
  const untrackedEntries = entries.filter((e) => e.isUntracked);

  const conflictedFiles = conflictedEntries.map((e) => e.path);
  const stagedFiles = stagedEntries.map((e) => e.path);
  const unstagedFiles = unstagedEntries.map((e) => e.path);
  const untrackedFiles = untrackedEntries.map((e) => e.path);

  // Identify suspicious filenames without inspecting file contents
  const allAffectedFiles = entries.map((e) => e.path);
  const suspiciousFiles = allAffectedFiles.filter(isSuspiciousFilename);

  // 9. Determine overall working tree state
  let workingTreeStatus = 'clean';
  if (conflictedEntries.length > 0) {
    workingTreeStatus = 'conflicted';
  } else if (isMerging) {
    workingTreeStatus = 'merging';
  } else if (isRebasing) {
    workingTreeStatus = 'rebasing';
  } else if (isCherryPicking) {
    workingTreeStatus = 'cherry-picking';
  } else if (isReverting) {
    workingTreeStatus = 'reverting';
  } else if (
    stagedEntries.length > 0 ||
    unstagedEntries.length > 0 ||
    untrackedEntries.length > 0
  ) {
    workingTreeStatus = 'dirty';
  }

  const collectedAt = new Date().toISOString();

  return {
    repoPath,
    repoName,
    currentBranch,
    headCommit,
    isDetachedHead,
    workingTreeStatus,
    stagedCount: stagedEntries.length,
    unstagedCount: unstagedEntries.length,
    untrackedCount: untrackedEntries.length,
    conflictedCount: conflictedEntries.length,
    collectedAt,
    upstream,
    isMerging,
    isRebasing,
    isCherryPicking,
    isReverting,
    conflictedFiles,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    suspiciousFiles,
  };
}

/**
 * Collects repository status adhering strictly to the shared RepositoryStatus contract.
 */
export async function collectRepoStatus(
  targetPath?: string
): Promise<RepositoryStatus> {
  const detailed = await collectDetailedRepoStatus(targetPath);
  return {
    repoPath: detailed.repoPath,
    repoName: detailed.repoName,
    currentBranch: detailed.currentBranch,
    headCommit: detailed.headCommit,
    isDetachedHead: detailed.isDetachedHead,
    workingTreeStatus: detailed.workingTreeStatus,
    stagedCount: detailed.stagedCount,
    unstagedCount: detailed.unstagedCount,
    untrackedCount: detailed.untrackedCount,
    conflictedCount: detailed.conflictedCount,
    collectedAt: detailed.collectedAt,
  };
}
