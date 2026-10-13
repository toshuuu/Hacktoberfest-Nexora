import type { DiagnosticResult, RecoveryStep, RiskLevel } from '@git-cure/shared';

const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'checkout',
  'switch',
  'branch',
  'add',
  'rm',
  'reset',
  'restore',
  'stash',
  'commit',
  'rebase',
  'merge',
  'cherry-pick',
  'clean',
  'reflog',
  'rev-parse',
  'show',
  'tag',
  'fetch',
  'pull',
]);

const DANGEROUS_PATTERNS = [
  /;\s*(?:rm|del|rmdir|format|curl|wget|powershell|bash|sh|cmd|invoke-expression|iex)\b/i,
  /\|\s*(?:bash|sh|cmd|powershell|iex)\b/i,
  /`.*`/,
  /\$\(.*(?:\bsh\b|\bbash\b|\brm\b).*\)/i,
  />\s*\/dev\/(?:null|zero|random|sda)/i,
  /\brm\s+-rf\s+(?:\/|~|\.\.|\*)/i,
];

/**
 * Checks whether a shell command belongs to Git's safe operational subset.
 */
export function isSafeGitCommand(command: string | null): boolean {
  if (!command) return true;

  const trimmed = command.trim();

  // Allow safe echo / append commands (e.g. echo "secret.key" >> .gitignore)
  if (/^echo\s+["'][^"']+["']\s*>>\s*\.gitignore$/.test(trimmed)) {
    return true;
  }

  // Must begin with git
  if (!trimmed.startsWith('git ') && trimmed !== 'git') {
    return false;
  }

  // Check against dangerous pattern injections
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return false;
    }
  }

  // Extract subcommand
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return false;
  const subcommand = parts[1].toLowerCase();

  return ALLOWED_GIT_SUBCOMMANDS.has(subcommand);
}

export interface ValidationReport {
  isValid: boolean;
  errors: string[];
}

/**
 * Validates a DiagnosticResult produced by AI or fallback.
 */
export function validateDiagnosis(diagnosis: DiagnosticResult): ValidationReport {
  const errors: string[] = [];

  if (!diagnosis.issue || typeof diagnosis.issue !== 'string' || diagnosis.issue.trim().length === 0) {
    errors.push('Diagnosis issue statement is missing or empty');
  }

  if (!diagnosis.rootCause || typeof diagnosis.rootCause !== 'string' || diagnosis.rootCause.trim().length === 0) {
    errors.push('Diagnosis root cause is missing or empty');
  }

  const validRiskLevels: RiskLevel[] = ['green', 'amber', 'red', 'destructive'];
  if (!validRiskLevels.includes(diagnosis.riskLevel)) {
    errors.push(`Invalid risk level: "${diagnosis.riskLevel}". Expected green, amber, red, or destructive.`);
  }

  if (typeof diagnosis.confidence !== 'number' || diagnosis.confidence < 0 || diagnosis.confidence > 1) {
    errors.push(`Confidence must be a number between 0.0 and 1.0 (received ${diagnosis.confidence})`);
  }

  if (!Array.isArray(diagnosis.affectedFiles)) {
    errors.push('affectedFiles must be an array of strings');
  }

  if (!Array.isArray(diagnosis.recommendedActions)) {
    errors.push('recommendedActions must be an array of strings');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validates a generated RecoveryPlan array.
 */
export function validateRecoveryPlan(plan: RecoveryStep[]): ValidationReport {
  const errors: string[] = [];

  if (!Array.isArray(plan)) {
    return { isValid: false, errors: ['Recovery plan is not an array'] };
  }

  if (plan.length === 0) {
    return { isValid: true, errors: [] };
  }

  plan.forEach((step, idx) => {
    const stepLabel = step.stepId || `step-${idx + 1}`;

    if (!step.description || typeof step.description !== 'string') {
      errors.push(`${stepLabel}: missing description`);
    }

    if (step.command && !isSafeGitCommand(step.command)) {
      errors.push(`${stepLabel}: command "${step.command}" is not in the safe Git command subset`);
    }

    const validRiskLevels = ['green', 'amber', 'red', 'destructive'];
    if (!validRiskLevels.includes(String(step.riskLevel).toLowerCase())) {
      errors.push(`${stepLabel}: invalid risk level "${step.riskLevel}"`);
    }

    if ((step.riskLevel === 'red' || step.riskLevel === 'destructive') && !step.requiresApproval) {
      errors.push(`${stepLabel}: high-risk steps (${step.riskLevel}) must require approval`);
    }

    if (!step.rollback || typeof step.rollback.canGuaranteeRestoration !== 'boolean') {
      errors.push(`${stepLabel}: missing rollback configuration`);
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
  };
}
