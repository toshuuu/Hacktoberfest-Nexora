import type { RepositoryStatus } from '@git-cure/shared';

/**
 * Builds structured diagnostic prompt for Gemma.
 */
export function buildDiagnosisPrompt(repoStatus: RepositoryStatus): string {
  const extraContext: string[] = [];
  if (repoStatus.diffSummary) {
    extraContext.push(`- Diff Summary: ${repoStatus.diffSummary}`);
  }
  if (repoStatus.detectedSecrets && repoStatus.detectedSecrets.length > 0) {
    extraContext.push(`- Detected Secrets/Sensitive Files: ${repoStatus.detectedSecrets.join(', ')}`);
  }
  if (repoStatus.headCommit) {
    extraContext.push(`- HEAD Commit: ${repoStatus.headCommit}`);
  }

  const extraContextStr = extraContext.length > 0 ? `\n${extraContext.join('\n')}` : '';

  return `You are a Git diagnostics expert. Analyze this repository state and provide a structured diagnosis.

Repository Status:
- Branch: ${repoStatus.currentBranch}
- Working Tree: ${repoStatus.workingTreeStatus}
- Staged files: ${repoStatus.stagedCount}
- Unstaged files: ${repoStatus.unstagedCount}
- Untracked files: ${repoStatus.untrackedCount}
- Conflicted files: ${repoStatus.conflictedCount}${extraContextStr}

Respond in JSON format:
{
  "issue": "brief problem statement",
  "rootCause": "detailed explanation of why this happened",
  "riskLevel": "green|amber|red|destructive",
  "confidence": 0.0-1.0,
  "affectedFiles": ["file1", "file2"],
  "recommendedActions": ["action1", "action2"]
}

Focus on:
1. What specific Git problem exists
2. How the user likely got into this state
3. Risk level of potential recovery actions
4. Clear next steps

Respond ONLY with valid JSON, no additional text.`;
}

/**
 * Builds structured recovery plan prompt for Gemma.
 */
export function buildRecoveryPlanPrompt(
  repoStatus: RepositoryStatus,
  diagnosis: any
): string {
  return `You are a Git recovery expert. Generate a step-by-step recovery plan.

Current Problem:
${diagnosis.issue}

Root Cause:
${diagnosis.rootCause}

Repository State:
- Branch: ${repoStatus.currentBranch}
- Conflicted files: ${repoStatus.conflictedCount}
- Dirty working tree: ${repoStatus.stagedCount + repoStatus.unstagedCount > 0}

Generate 3-7 recovery steps as JSON array:
[
  {
    "stepId": "step-1",
    "description": "Clear description of what this step does",
    "command": "git command to execute",
    "commandExplanation": "Why we're running this command",
    "riskLevel": "green|amber|red|destructive",
    "requiresApproval": true|false,
    "expectedOutcome": "What should happen after this step",
    "rollback": {
      "canGuaranteeRestoration": true|false,
      "warningMessage": "what might be lost"
    }
  }
]

Guidelines:
- Start with low-risk information gathering commands
- Create snapshots before destructive operations
- Require approval for anything that modifies history
- Explain technical commands in plain language
- Order steps from safest to riskiest

Respond ONLY with valid JSON array, no additional text.`;
}
