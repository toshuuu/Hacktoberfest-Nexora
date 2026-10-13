import type { RepositoryStatus, DiagnosticResult, RecoveryStep } from '@git-cure/shared';

const RISK_ORDER: Record<string, number> = {
  green: 1,
  amber: 2,
  red: 3,
  destructive: 4,
};

/**
 * Sorts recovery steps from safest to riskiest.
 */
export function sortStepsByRisk(steps: RecoveryStep[]): RecoveryStep[] {
  return [...steps].sort((a, b) => {
    const riskA = RISK_ORDER[String(a.riskLevel).toLowerCase()] || 2;
    const riskB = RISK_ORDER[String(b.riskLevel).toLowerCase()] || 2;
    return riskA - riskB;
  });
}

/**
 * Fallback rule-based diagnosis when Gemma API fails or is offline.
 */
export function fallbackDiagnosis(repoStatus: RepositoryStatus): DiagnosticResult {
  // Case 1: Merge conflicts detected
  if (repoStatus.conflictedCount > 0) {
    return {
      issue: 'Merge conflicts detected',
      rootCause: 'Git attempted to merge changes but found conflicting modifications in the same lines of code.',
      riskLevel: 'amber',
      confidence: 0.95,
      affectedFiles: [],
      recommendedActions: [
        'Review conflicted files',
        'Resolve conflicts manually',
        'Stage resolved files',
        'Complete merge',
      ],
    };
  }

  // Case 2: Sensitive files / secrets detected
  if (repoStatus.detectedSecrets && repoStatus.detectedSecrets.length > 0) {
    const secretFile = repoStatus.detectedSecrets[0];
    return {
      issue: 'Sensitive credentials or secret keys detected in repository',
      rootCause: `File "${secretFile}" matches patterns for private secrets and is present in the repository.`,
      riskLevel: 'red',
      confidence: 0.98,
      affectedFiles: repoStatus.detectedSecrets,
      recommendedActions: [
        `Untrack ${secretFile} from git`,
        `Add ${secretFile} to .gitignore`,
        'Amend commit to remove sensitive data',
      ],
    };
  }

  // Case 3: Detached HEAD state
  if (repoStatus.currentBranch === 'HEAD' || repoStatus.currentBranch.includes('detached')) {
    return {
      issue: 'Detached HEAD state',
      rootCause: 'You are not currently on any branch. This can happen after checking out a commit directly.',
      riskLevel: 'amber',
      confidence: 1.0,
      affectedFiles: [],
      recommendedActions: [
        'Create a new branch to save work',
        'Or checkout an existing branch',
      ],
    };
  }

  // Case 4: Dirty working tree with uncommitted modifications
  if (repoStatus.stagedCount > 0 || repoStatus.unstagedCount > 0) {
    return {
      issue: 'Uncommitted working tree changes',
      rootCause: 'You have local modifications that are not yet committed or stashed.',
      riskLevel: 'green',
      confidence: 0.9,
      affectedFiles: [],
      recommendedActions: [
        'Stage modified files with git add',
        'Commit changes with git commit',
        'Or stash changes with git stash',
      ],
    };
  }

  // Default clean / healthy repository
  return {
    issue: 'Repository state clean',
    rootCause: 'No active anomalies or conflicts detected in the working tree.',
    riskLevel: 'green',
    confidence: 0.85,
    affectedFiles: [],
    recommendedActions: ['Working tree is clean. Ready to push or pull changes.'],
  };
}

/**
 * Fallback rule-based recovery plan when Gemma API fails or is offline.
 */
export function fallbackRecoveryPlan(
  diagnosis: DiagnosticResult,
  repoStatus?: RepositoryStatus
): RecoveryStep[] {
  const issueLower = diagnosis.issue.toLowerCase();

  // Merge Conflict Recipe
  if (issueLower.includes('conflict')) {
    return [
      {
        stepId: 'step-1',
        description: 'List conflicted files',
        command: 'git diff --name-only --diff-filter=U',
        commandExplanation: 'Show which files have conflicts that need manual resolution',
        riskLevel: 'green',
        status: 'pending',
        requiresApproval: false,
        expectedOutcome: 'See list of files needing manual resolution',
        rollback: {
          canGuaranteeRestoration: true,
          warningMessage: '',
        },
      },
      {
        stepId: 'step-2',
        description: 'Inspect conflict diff markers',
        command: 'git diff',
        commandExplanation: 'Inspect conflicting code sections between branches',
        riskLevel: 'green',
        status: 'pending',
        requiresApproval: false,
        expectedOutcome: 'Inspect conflict markers (<<<<<<<, =======, >>>>>>>)',
        rollback: {
          canGuaranteeRestoration: true,
          warningMessage: '',
        },
      },
      {
        stepId: 'step-3',
        description: 'Abort merge if recovery cannot be completed',
        command: 'git merge --abort',
        commandExplanation: 'Aborts the merge and returns repository to pre-merge state',
        riskLevel: 'amber',
        status: 'pending',
        requiresApproval: true,
        expectedOutcome: 'Merge is cancelled cleanly with no conflict state left',
        rollback: {
          canGuaranteeRestoration: false,
          warningMessage: 'Aborting merge discards current in-progress conflict resolution',
        },
      },
    ];
  }

  // Detached HEAD Recipe
  if (issueLower.includes('detached')) {
    return [
      {
        stepId: 'step-1',
        description: 'Check current commit status',
        command: 'git status',
        commandExplanation: 'Verify which commit HEAD is currently detached at',
        riskLevel: 'green',
        status: 'pending',
        requiresApproval: false,
        expectedOutcome: 'Confirmed commit hash and current detached state',
        rollback: {
          canGuaranteeRestoration: true,
          warningMessage: '',
        },
      },
      {
        stepId: 'step-2',
        description: 'Create rescue branch to preserve work',
        command: 'git switch -c recovery-branch',
        commandExplanation: 'Creates and switches to a new branch preserving all detached commits',
        riskLevel: 'green',
        status: 'pending',
        requiresApproval: false,
        expectedOutcome: 'Commits are safely pinned to a named branch',
        rollback: {
          canGuaranteeRestoration: true,
          warningMessage: '',
          command: 'git switch -',
        },
      },
    ];
  }

  // Sensitive File / Secret Recipe
  if (issueLower.includes('secret') || issueLower.includes('credential')) {
    const file = diagnosis.affectedFiles[0] || '.env';
    return [
      {
        stepId: 'step-1',
        description: `Stop tracking sensitive file (${file})`,
        command: `git rm --cached ${file}`,
        commandExplanation: `Untracks ${file} from Git history without deleting it from your local disk`,
        riskLevel: 'amber',
        status: 'pending',
        requiresApproval: false,
        expectedOutcome: `${file} is removed from git staging and will not be pushed`,
        rollback: {
          canGuaranteeRestoration: true,
          warningMessage: '',
          command: `git add ${file}`,
        },
      },
      {
        stepId: 'step-2',
        description: `Append ${file} to .gitignore`,
        command: `echo "${file}" >> .gitignore`,
        commandExplanation: `Prevents future accidental commits of ${file}`,
        riskLevel: 'green',
        status: 'pending',
        requiresApproval: false,
        expectedOutcome: `${file} safely ignored in .gitignore`,
        rollback: {
          canGuaranteeRestoration: true,
          warningMessage: '',
        },
      },
      {
        stepId: 'step-3',
        description: 'Stage updated .gitignore',
        command: 'git add .gitignore',
        commandExplanation: 'Stages the ignore rule for the repository',
        riskLevel: 'green',
        status: 'pending',
        requiresApproval: false,
        expectedOutcome: '.gitignore is staged',
        rollback: {
          canGuaranteeRestoration: true,
          warningMessage: '',
        },
      },
    ];
  }

  // Dirty Working Tree Recipe
  if (repoStatus && (repoStatus.stagedCount > 0 || repoStatus.unstagedCount > 0)) {
    return [
      {
        stepId: 'step-1',
        description: 'View uncommitted changes',
        command: 'git status -s',
        commandExplanation: 'Quickly review all modified, untracked, and staged files',
        riskLevel: 'green',
        status: 'pending',
        requiresApproval: false,
        expectedOutcome: 'Summary of working tree modifications',
        rollback: {
          canGuaranteeRestoration: true,
          warningMessage: '',
        },
      },
      {
        stepId: 'step-2',
        description: 'Stash changes into safe temporary storage',
        command: 'git stash save "git-cure-auto-stash"',
        commandExplanation: 'Safely stores all uncommitted changes without losing any work',
        riskLevel: 'green',
        status: 'pending',
        requiresApproval: false,
        expectedOutcome: 'Working tree is cleanly restored; changes can be re-applied with git stash pop',
        rollback: {
          canGuaranteeRestoration: true,
          warningMessage: '',
          command: 'git stash pop',
        },
      },
    ];
  }

  return [];
}
