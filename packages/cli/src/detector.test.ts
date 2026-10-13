import { test } from 'node:test';
import * as assert from 'node:assert';
import type { RepositoryStatus } from '@git-cure/shared';
import { detectProblems, detectAllProblems } from './detector';
import type { DetailedRepoStatus } from './telemetry';

function createMockStatus(overrides?: Partial<RepositoryStatus>): RepositoryStatus {
  return {
    repoPath: '/tmp/mock-repo',
    repoName: 'mock-repo',
    currentBranch: 'main',
    headCommit: 'abcdef1234567890abcdef1234567890abcdef12',
    isDetachedHead: false,
    workingTreeStatus: 'clean',
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('detectProblems returns null for clean repository', () => {
  const status = createMockStatus();
  const diagnosis = detectProblems(status);
  assert.strictEqual(diagnosis, null);
});

test('detectProblems detects merge conflicts', () => {
  const status = createMockStatus({
    workingTreeStatus: 'conflicted',
    conflictedCount: 2,
  });
  const detailed: DetailedRepoStatus = {
    ...status,
    conflictedFiles: ['conflict1.txt', 'conflict2.txt'],
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    suspiciousFiles: [],
    isMerging: true,
    isRebasing: false,
    isCherryPicking: false,
    isReverting: false,
  };

  const diagnosis = detectProblems(status, detailed);
  assert.ok(diagnosis);
  assert.strictEqual(diagnosis!.issue, 'Merge conflict detected');
  assert.strictEqual(diagnosis!.riskLevel, 'amber');
  assert.deepStrictEqual(diagnosis!.affectedFiles, ['conflict1.txt', 'conflict2.txt']);
  assert.ok(diagnosis!.recommendedActions.length > 0);
});

test('detectProblems detects detached HEAD', () => {
  const status = createMockStatus({
    currentBranch: 'HEAD',
    isDetachedHead: true,
  });
  const diagnosis = detectProblems(status);
  assert.ok(diagnosis);
  assert.strictEqual(diagnosis!.issue, 'Detached HEAD state');
  assert.strictEqual(diagnosis!.riskLevel, 'amber');
  assert.strictEqual(diagnosis!.confidence, 1.0);
});

test('detectProblems detects unfinished rebase', () => {
  const status = createMockStatus({
    workingTreeStatus: 'rebasing',
  });
  const detailed: DetailedRepoStatus = {
    ...status,
    conflictedFiles: [],
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    suspiciousFiles: [],
    isMerging: false,
    isRebasing: true,
    isCherryPicking: false,
    isReverting: false,
  };

  const diagnosis = detectProblems(status, detailed);
  assert.ok(diagnosis);
  assert.strictEqual(diagnosis!.issue, 'Unfinished rebase in progress');
  assert.ok(diagnosis!.recommendedActions.some((a) => a.includes('--continue')));
});

test('detectProblems detects suspicious credential filenames', () => {
  const status = createMockStatus({
    workingTreeStatus: 'dirty',
    untrackedCount: 1,
  });
  const detailed: DetailedRepoStatus = {
    ...status,
    conflictedFiles: [],
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: ['.env'],
    suspiciousFiles: ['.env'],
    isMerging: false,
    isRebasing: false,
    isCherryPicking: false,
    isReverting: false,
  };

  const problems = detectAllProblems(status, detailed);
  assert.ok(problems.length >= 2);
  const secretProblem = problems.find((p) => p.riskLevel === 'red');
  assert.ok(secretProblem);
  assert.ok(secretProblem!.affectedFiles.includes('.env'));
});

test('detectProblems detects dirty working tree', () => {
  const status = createMockStatus({
    workingTreeStatus: 'dirty',
    unstagedCount: 3,
  });
  const diagnosis = detectProblems(status);
  assert.ok(diagnosis);
  assert.strictEqual(diagnosis!.issue, 'Dirty working tree');
  assert.strictEqual(diagnosis!.riskLevel, 'green');
});
