import type { RecoveryStep, RiskLevel } from '@git-cure/shared';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitizedArgs?: string[];
  isDestructive: boolean;
  mutatesRepo: boolean;
}

/**
 * Forbidden shell characters and operators that indicate
 * shell chaining, redirection, or command substitution.
 */
const SHELL_OPERATOR_PATTERN = /[;&|><`$\n\r]/;

/**
 * Allowlist of approved Git subcommands and their permitted options.
 */
interface SubcommandRule {
  allowedFlags: Set<string>;
  allowsPositional: boolean;
  mutatesRepo: boolean;
  isDestructive: boolean;
}

const APPROVED_SUBCOMMAND_RULES: Record<string, SubcommandRule> = {
  status: {
    allowedFlags: new Set(['--porcelain', '-s', '--short', '-b', '--branch']),
    allowsPositional: false,
    mutatesRepo: false,
    isDestructive: false,
  },
  diff: {
    allowedFlags: new Set(['--name-only', '--stat', '--cached', '--staged', '--diff-filter=U']),
    allowsPositional: true,
    mutatesRepo: false,
    isDestructive: false,
  },
  add: {
    allowedFlags: new Set(['--', '-v', '--verbose']),
    allowsPositional: true,
    mutatesRepo: true,
    isDestructive: false,
  },
  commit: {
    allowedFlags: new Set(['-m', '--message', '--allow-empty', '--no-verify']),
    allowsPositional: false,
    mutatesRepo: true,
    isDestructive: false,
  },
  checkout: {
    allowedFlags: new Set(['-b']),
    allowsPositional: true,
    mutatesRepo: true,
    isDestructive: false,
  },
  switch: {
    allowedFlags: new Set(['-c', '--create']),
    allowsPositional: true,
    mutatesRepo: true,
    isDestructive: false,
  },
  branch: {
    allowedFlags: new Set(['-a', '--all', '--list', '-v', '--show-current']),
    allowsPositional: true,
    mutatesRepo: false, // listing or creating branch
    isDestructive: false,
  },
  stash: {
    allowedFlags: new Set(['push', 'apply', 'list', 'show', '-u', '--include-untracked', '-m', '--message']),
    allowsPositional: true,
    mutatesRepo: true,
    isDestructive: false,
  },
  rebase: {
    allowedFlags: new Set(['--continue', '--abort']),
    allowsPositional: false,
    mutatesRepo: true,
    isDestructive: false,
  },
  merge: {
    allowedFlags: new Set(['--abort', '--continue', '-m', '--message']),
    allowsPositional: true,
    mutatesRepo: true,
    isDestructive: false,
  },
  restore: {
    allowedFlags: new Set(['--staged']),
    allowsPositional: true,
    mutatesRepo: true,
    isDestructive: false,
  },
  reset: {
    // Only safe unstaging reset is allowed: git reset HEAD <file> or git reset <file>
    allowedFlags: new Set(['HEAD', '--']),
    allowsPositional: true,
    mutatesRepo: true,
    isDestructive: false,
  },
};

/**
 * Determines whether a Git command and arguments represent a destructive operation
 * that must be blocked by default in MVP.
 */
export function isDestructiveCommand(subcommand: string, gitArgs: string[]): boolean {
  if (subcommand === 'clean') return true;
  if (subcommand === 'push') return true; // git push is blocked
  if (subcommand === 'reset' && gitArgs.includes('--hard')) return true;
  if (subcommand === 'branch' && (gitArgs.includes('-D') || gitArgs.includes('-d') || gitArgs.includes('--delete'))) return true;
  if (subcommand === 'stash' && (gitArgs.includes('drop') || gitArgs.includes('clear'))) return true;
  if (gitArgs.includes('--force') || gitArgs.includes('-f') || gitArgs.includes('--prune')) return true;
  return false;
}

/**
 * Safely parses a command string into tokenized arguments without invoking a shell.
 * Rejects shell operators, quotes with unbalanced boundaries, or command substitutions.
 */
export function tokenizeCommand(command: string): string[] | null {
  if (SHELL_OPERATOR_PATTERN.test(command)) {
    return null;
  }

  // Tokenize while respecting single and double quotes
  const tokens: string[] = [];
  let current = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === ' ' && !inDoubleQuote && !inSingleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (inDoubleQuote || inSingleQuote) {
    // Unbalanced quotes
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Validates an individual recovery step against safety rules, allowlists,
 * and approval requirements.
 */
export function validateRecoveryStep(step: RecoveryStep): ValidationResult {
  const errors: string[] = [];

  // Informational steps without commands are always safe
  if (!step.command) {
    return {
      valid: true,
      errors: [],
      isDestructive: false,
      mutatesRepo: false,
    };
  }

  // Check 1: Block destructive risk level by default in MVP
  if (step.riskLevel === 'destructive') {
    errors.push('Destructive risk level steps are blocked by default in this MVP.');
  }

  // Check 2: Tokenize command without shell evaluation
  const tokens = tokenizeCommand(step.command);
  if (!tokens || tokens.length === 0) {
    errors.push(
      `Command contains forbidden shell operators, command substitutions, or invalid quotes: "${step.command}"`
    );
    return {
      valid: false,
      errors,
      isDestructive: true,
      mutatesRepo: true,
    };
  }

  // Check 3: Executable MUST be 'git'
  const executable = tokens[0].toLowerCase();
  if (executable !== 'git') {
    errors.push(`Arbitrary executable blocked: "${tokens[0]}". Only "git" commands are permitted.`);
  }

  const gitArgs = tokens.slice(1);
  if (gitArgs.length === 0) {
    errors.push('Empty git command');
    return {
      valid: false,
      errors,
      isDestructive: false,
      mutatesRepo: false,
    };
  }

  const subcommand = gitArgs[0].toLowerCase();

  // Check 4: Check destructive operations
  const isDestructive = isDestructiveCommand(subcommand, gitArgs);
  if (isDestructive) {
    errors.push(`Destructive git operation or flag blocked in MVP: "${step.command}"`);
  }

  // Check 5: Verify subcommand is in allowlist
  const rule = APPROVED_SUBCOMMAND_RULES[subcommand];
  if (!rule) {
    errors.push(`Git subcommand "${subcommand}" is not in the approved recovery allowlist.`);
  }

  let mutatesRepo = rule ? rule.mutatesRepo : true;

  // Validate flags for approved subcommand
  if (rule) {
    for (let i = 1; i < gitArgs.length; i++) {
      const arg = gitArgs[i];
      if (arg.startsWith('-')) {
        // Flag
        if (!rule.allowedFlags.has(arg)) {
          errors.push(`Flag "${arg}" is not permitted for "git ${subcommand}".`);
        }
        // If flag takes an argument (like -m "msg"), skip next token
        if ((arg === '-m' || arg === '--message') && i + 1 < gitArgs.length) {
          i++;
        }
      } else {
        // Positional argument
        if (!rule.allowsPositional && !rule.allowedFlags.has(arg)) {
          errors.push(`Unexpected argument "${arg}" for "git ${subcommand}".`);
        }
      }
    }
  }

  // Check 6: Enforce explicit approval for repository-changing actions
  if (mutatesRepo && !step.requiresApproval) {
    errors.push(
      `Step "${step.stepId}" mutates repository state but does not have requiresApproval set to true.`
    );
  }

  // Check 7: Red risk level must require approval
  if (step.riskLevel === 'red' && !step.requiresApproval) {
    errors.push(`Step "${step.stepId}" has red risk level and must require explicit approval.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedArgs: errors.length === 0 ? gitArgs : undefined,
    isDestructive,
    mutatesRepo,
  };
}

/**
 * Validates an entire recovery plan before execution begins.
 */
export function validateRecoveryPlan(plan: RecoveryStep[]): {
  valid: boolean;
  stepResults: Map<string, ValidationResult>;
  errors: string[];
} {
  const stepResults = new Map<string, ValidationResult>();
  const errors: string[] = [];

  for (const step of plan) {
    const result = validateRecoveryStep(step);
    stepResults.set(step.stepId, result);
    if (!result.valid) {
      errors.push(`Step ${step.stepId} failed validation: ${result.errors.join('; ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    stepResults,
    errors,
  };
}
