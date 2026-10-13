import type {
  RepositoryStatus,
  DiagnosticResult,
  RiskLevel,
} from '@git-cure/shared';
import type { DetailedRepoStatus } from './telemetry';

/**
 * Detects all problems present in the repository, ordered by risk and priority.
 * This is a pure diagnostic function that NEVER executes recovery commands.
 */
export function detectAllProblems(
  status: RepositoryStatus,
  detailed?: DetailedRepoStatus
): DiagnosticResult[] {
  const problems: DiagnosticResult[] = [];

  // 1. Merge Conflicts (High Priority)
  if (status.conflictedCount > 0) {
    const affected = detailed?.conflictedFiles ?? [];
    problems.push({
      issue: 'Merge conflict detected',
      rootCause:
        'Git attempted to merge changes but encountered conflicting modifications in the same lines or files that cannot be resolved automatically.',
      riskLevel: 'amber' as RiskLevel,
      confidence: 0.95,
      affectedFiles: affected,
      recommendedActions: [
        'Review conflicted files and conflict markers (<<<<<<<, =======, >>>>>>>)',
        'Resolve conflicts manually or using a visual merge tool',
        'Stage resolved files with git add <file>',
        'Complete the merge with git commit',
      ],
    });
  }

  // 2. Unfinished Merge or Rebase in progress
  if (
    status.workingTreeStatus === 'rebasing' ||
    status.workingTreeStatus === 'merging' ||
    detailed?.isRebasing ||
    detailed?.isMerging
  ) {
    const isRebase =
      status.workingTreeStatus === 'rebasing' || detailed?.isRebasing;
    problems.push({
      issue: isRebase
        ? 'Unfinished rebase in progress'
        : 'Unfinished merge in progress',
      rootCause: isRebase
        ? 'A Git rebase operation was interrupted or paused due to conflicts or user request and has not been completed or aborted.'
        : 'A Git merge operation was initiated and has unresolved files or has not been finalized with a commit.',
      riskLevel: 'amber' as RiskLevel,
      confidence: 0.9,
      affectedFiles: detailed?.conflictedFiles ?? [],
      recommendedActions: isRebase
        ? [
            'Resolve any outstanding conflict markers in affected files',
            'Stage resolved files using git add <file>',
            'Continue rebase using git rebase --continue',
            'Or abort the rebase cleanly using git rebase --abort',
          ]
        : [
            'Resolve any conflicting files',
            'Stage resolved files using git add <file>',
            'Complete the merge using git commit',
            'Or abort the merge cleanly using git merge --abort',
          ],
    });
  }

  // 3. Suspicious Credential Filenames in working tree
  if (detailed && detailed.suspiciousFiles.length > 0) {
    problems.push({
      issue: 'Suspicious credential filenames detected in working tree',
      rootCause:
        'Filenames matching sensitive credentials or secret configurations were found in the working tree. Committing these may leak API keys or private keys.',
      riskLevel: 'red' as RiskLevel,
      confidence: 0.9,
      affectedFiles: detailed.suspiciousFiles,
      recommendedActions: [
        'Verify that sensitive credential files are not staged for commit',
        'Add sensitive files (.env, keys, credentials) to .gitignore',
        'Use git rm --cached <file> if any secret was accidentally staged',
      ],
    });
  }

  // 4. Detached HEAD State
  if (status.isDetachedHead || status.currentBranch === 'HEAD') {
    const shortSha = status.headCommit ? status.headCommit.slice(0, 8) : 'unknown';
    problems.push({
      issue: 'Detached HEAD state',
      rootCause: `You are currently detached at commit ${shortSha}. Any new commits made in this state will not belong to any branch ref and risk being orphaned when switching branches.`,
      riskLevel: 'amber' as RiskLevel,
      confidence: 1.0,
      affectedFiles: [],
      recommendedActions: [
        'Create a new branch to save your current work (git checkout -b <branch-name>)',
        'Or switch back to an existing branch (git checkout <branch-name>)',
      ],
    });
  }

  // 5. Dirty Working Tree
  if (
    status.workingTreeStatus === 'dirty' ||
    status.stagedCount > 0 ||
    status.unstagedCount > 0 ||
    status.untrackedCount > 0
  ) {
    const allModified = [
      ...(detailed?.stagedFiles ?? []),
      ...(detailed?.unstagedFiles ?? []),
      ...(detailed?.untrackedFiles ?? []),
    ];
    problems.push({
      issue: 'Dirty working tree',
      rootCause: `Working tree contains uncommitted changes: ${status.stagedCount} staged, ${status.unstagedCount} unstaged, and ${status.untrackedCount} untracked files.`,
      riskLevel: 'green' as RiskLevel,
      confidence: 0.85,
      affectedFiles: allModified,
      recommendedActions: [
        'Review changes using git status or git diff',
        'Stage desired files using git add <file>',
        'Commit changes using git commit -m "<message>"',
        'Or stash modifications safely before performing branch operations',
      ],
    });
  }

  return problems;
}

/**
 * Returns the primary diagnostic issue detected in the repository,
 * or null if the repository state is clean.
 */
export function detectProblems(
  status: RepositoryStatus,
  detailed?: DetailedRepoStatus
): DiagnosticResult | null {
  const problems = detectAllProblems(status, detailed);
  return problems.length > 0 ? problems[0] : null;
}
