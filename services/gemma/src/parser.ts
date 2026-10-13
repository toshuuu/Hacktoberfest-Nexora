import type { DiagnosticResult, RecoveryStep, RiskLevel } from '@git-cure/shared';

/**
 * Parses raw text response from Gemma into a structured DiagnosticResult.
 */
export function parseDiagnosisResponse(response: string): DiagnosticResult {
  try {
    // Clean potential markdown blocks
    let cleaned = response.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    // Extract JSON from response (Gemma might wrap it in markdown)
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!parsed.issue || !parsed.rootCause || !parsed.riskLevel) {
      throw new Error('Missing required fields in diagnosis');
    }

    // Normalize and validate risk level
    const normalizedRisk = typeof parsed.riskLevel === 'string' ? parsed.riskLevel.toLowerCase() : 'amber';
    const validRiskLevels: RiskLevel[] = ['green', 'amber', 'red', 'destructive'];
    const riskLevel: RiskLevel = validRiskLevels.includes(normalizedRisk as RiskLevel)
      ? (normalizedRisk as RiskLevel)
      : 'amber';

    const confidence = typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0.8;

    return {
      issue: String(parsed.issue),
      rootCause: String(parsed.rootCause),
      riskLevel,
      confidence,
      affectedFiles: Array.isArray(parsed.affectedFiles) ? parsed.affectedFiles.map(String) : [],
      recommendedActions: Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions.map(String) : [],
    };
  } catch (error) {
    console.error('Failed to parse diagnosis:', error);

    // Fallback diagnosis
    return {
      issue: 'Failed to parse AI diagnosis',
      rootCause: 'AI response was malformed or incomplete',
      riskLevel: 'amber',
      confidence: 0.5,
      affectedFiles: [],
      recommendedActions: ['Retry analysis', 'Check repository manually'],
    };
  }
}

/**
 * Parses raw text response from Gemma into a list of RecoveryStep items.
 */
export function parseRecoveryPlanResponse(response: string): RecoveryStep[] {
  try {
    // Clean potential markdown blocks
    let cleaned = response.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    // Extract JSON array from response
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(parsed)) {
      throw new Error('Response is not an array');
    }

    const validRiskLevels: RiskLevel[] = ['green', 'amber', 'red', 'destructive'];

    return parsed.map((step, index) => {
      const rawRisk = typeof step.riskLevel === 'string' ? step.riskLevel.toLowerCase() : 'amber';
      const riskLevel = validRiskLevels.includes(rawRisk as RiskLevel) ? rawRisk : 'amber';
      const isDangerous = riskLevel === 'red' || riskLevel === 'destructive';

      return {
        stepId: step.stepId || `step-${index + 1}`,
        description: step.description || 'Unknown step',
        command: step.command || null,
        commandExplanation: step.commandExplanation || '',
        riskLevel,
        status: 'pending',
        requiresApproval: step.requiresApproval !== undefined ? Boolean(step.requiresApproval) : isDangerous,
        rollback: {
          description: step.rollback?.description || (step.command ? `Rollback for ${step.command}` : 'No rollback action needed'),
          canGuaranteeRestoration: step.rollback?.canGuaranteeRestoration ?? false,
          warningMessage: step.rollback?.warningMessage || (isDangerous ? 'Rollback may not restore all state' : ''),
          ...(step.rollback?.command ? { command: step.rollback.command } : {}),
        },
      };
    });
  } catch (error) {
    console.error('Failed to parse recovery plan:', error);
    return [];
  }
}
