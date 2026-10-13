import { gemmaModel } from './client';
import { buildDiagnosisPrompt, buildRecoveryPlanPrompt } from './prompts';
import { parseDiagnosisResponse, parseRecoveryPlanResponse } from './parser';
import { fallbackDiagnosis, fallbackRecoveryPlan, sortStepsByRisk } from './planner';
import { validateDiagnosis, validateRecoveryPlan } from './validator';
import type { RepositoryStatus, DiagnosticResult, RecoveryStep } from '@git-cure/shared';

/**
 * Analyze repository status and generate diagnosis using Gemma.
 */
export async function diagnoseWithGemma(
  repoStatus: RepositoryStatus
): Promise<DiagnosticResult> {
  console.log('🤖 Asking Gemma for diagnosis...');

  const prompt = buildDiagnosisPrompt(repoStatus);

  try {
    const result = await gemmaModel.generateContent(prompt);
    const response = typeof result.response?.text === 'function' 
      ? result.response.text() 
      : String(result);

    console.log('✓ Gemma responded');

    const diagnosis = parseDiagnosisResponse(response);
    const validation = validateDiagnosis(diagnosis);
    if (!validation.isValid) {
      console.warn('⚠️ Diagnosis validation warnings:', validation.errors);
    }
    return diagnosis;
  } catch (error) {
    console.error('Gemma diagnosis failed:', error);

    // Fallback to rule-based diagnosis
    return fallbackDiagnosis(repoStatus);
  }
}

/**
 * Generate recovery plan using Gemma.
 */
export async function generateRecoveryPlan(
  repoStatus: RepositoryStatus,
  diagnosis: DiagnosticResult
): Promise<RecoveryStep[]> {
  console.log('🤖 Asking Gemma for recovery plan...');

  const prompt = buildRecoveryPlanPrompt(repoStatus, diagnosis);

  try {
    const result = await gemmaModel.generateContent(prompt);
    const response = typeof result.response?.text === 'function' 
      ? result.response.text() 
      : String(result);

    console.log('✓ Gemma responded with recovery plan');

    const plan = parseRecoveryPlanResponse(response);
    if (!plan || plan.length === 0) {
      console.warn('AI generated empty plan, falling back to rule-based recipe.');
      return fallbackRecoveryPlan(diagnosis, repoStatus);
    }

    const validation = validateRecoveryPlan(plan);
    if (!validation.isValid) {
      console.warn('⚠️ Recovery plan validation warnings:', validation.errors);
    }

    return sortStepsByRisk(plan);
  } catch (error) {
    console.error('Gemma recovery plan failed:', error);

    // Fallback to rule-based plan
    return fallbackRecoveryPlan(diagnosis, repoStatus);
  }
}

// Re-export helper and parser functions for testing and consumers
export {
  parseDiagnosisResponse,
  parseRecoveryPlanResponse,
  fallbackDiagnosis,
  fallbackRecoveryPlan,
  validateDiagnosis,
  validateRecoveryPlan,
  buildDiagnosisPrompt,
  buildRecoveryPlanPrompt,
  sortStepsByRisk,
};
