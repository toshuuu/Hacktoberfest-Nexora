import { 
  diagnoseWithGemma, 
  generateRecoveryPlan,
  parseDiagnosisResponse,
  parseRecoveryPlanResponse,
  validateDiagnosis,
  validateRecoveryPlan 
} from './src/index';
import type { RepositoryStatus } from '@git-cure/shared';

const mockStatus: RepositoryStatus = {
  repoName: 'test-repo',
  currentBranch: 'main',
  headCommit: 'abc123',
  workingTreeStatus: 'conflicted',
  stagedCount: 0,
  unstagedCount: 3,
  untrackedCount: 0,
  conflictedCount: 2,
  collectedAt: new Date().toISOString(),
};

async function test() {
  console.log('=== 1. Testing Parser & Validator with Mock Data ===');
  const mockDiagnosisJson = `{
    "issue": "Merge conflict detected in src/app.ts",
    "rootCause": "Concurrent branch edits conflicted during git merge",
    "riskLevel": "amber",
    "confidence": 0.95,
    "affectedFiles": ["src/app.ts"],
    "recommendedActions": ["Resolve conflict markers", "git add src/app.ts", "git commit"]
  }`;

  const parsedDiag = parseDiagnosisResponse(mockDiagnosisJson);
  console.log('✓ Parsed Diagnosis:', parsedDiag);
  const diagValidation = validateDiagnosis(parsedDiag);
  console.log('✓ Diagnosis Validation:', diagValidation);

  const mockPlanJson = `[
    {
      "stepId": "step-1",
      "description": "Show conflict markers",
      "command": "git diff",
      "commandExplanation": "View differences causing the conflict",
      "riskLevel": "green",
      "requiresApproval": false,
      "expectedOutcome": "Conflict markers displayed",
      "rollback": { "canGuaranteeRestoration": true, "warningMessage": "" }
    },
    {
      "stepId": "step-2",
      "description": "Abort merge if unresolved",
      "command": "git merge --abort",
      "commandExplanation": "Cancel the merge operation",
      "riskLevel": "amber",
      "requiresApproval": true,
      "expectedOutcome": "Merge aborted",
      "rollback": { "canGuaranteeRestoration": false, "warningMessage": "Resolution discarded" }
    }
  ]`;

  const parsedPlan = parseRecoveryPlanResponse(mockPlanJson);
  console.log('✓ Parsed Recovery Plan (length):', parsedPlan.length);
  const planValidation = validateRecoveryPlan(parsedPlan);
  console.log('✓ Plan Validation:', planValidation);

  console.log('\n=== 2. Testing End-to-End diagnoseWithGemma & generateRecoveryPlan ===');
  const diagnosis = await diagnoseWithGemma(mockStatus);
  console.log('Final Diagnosis:', diagnosis);

  const plan = await generateRecoveryPlan(mockStatus, diagnosis);
  console.log('Final Recovery Plan:', plan);
  console.log('\n✅ All tests completed successfully!');
}

test().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
