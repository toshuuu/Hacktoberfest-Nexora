# 🧠 @git-cure/gemma — Gemma Integration Service

Gemma-powered Git diagnostics and autonomous recovery plan generation service for **git-cure**.

---

## 📂 Architecture & Directory Structure

```
services/gemma/
├── src/
│   ├── index.ts          # Main API exports (diagnoseWithGemma, generateRecoveryPlan)
│   ├── client.ts         # GoogleGenerativeAI client & Gemma model loader
│   ├── prompts.ts        # Structured prompt templates for diagnostics & recovery
│   ├── parser.ts         # Defensive JSON parsers with markdown stripping
│   ├── planner.ts        # Heuristic fallback doctors & risk sorters
│   └── validator.ts      # Git command safety whitelist & schema validation
├── .env.example          # Environment variable template
├── .env                  # Local secret configuration (git-ignored)
├── package.json          # Service package definition
├── tsconfig.json         # TypeScript compiler configuration
├── test.ts               # Test suite for Gemma connectivity and parsing
└── README.md             # This documentation
```

---

## ⚙️ Environment Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Configure your Google AI Studio API key and desired Gemma model:
   ```env
   GEMMA_API_KEY=your_actual_api_key_here
   GEMMA_MODEL=gemma-2-9b-it
   ```

> **Security Note:** Never commit your `.env` file or real API keys. `.env` is ignored by `.gitignore`.

---

## 🚀 Available Exports & APIs

### `diagnoseWithGemma(repoStatus: RepositoryStatus): Promise<DiagnosticResult>`
Analyzes repository telemetry (branch, staged/unstaged/conflicted files, detected secrets) and returns a structured diagnosis with risk level, root cause, and recommendations. If the API is unreachable, it seamlessly switches to rule-based offline diagnosis.

### `generateRecoveryPlan(repoStatus: RepositoryStatus, diagnosis: DiagnosticResult): Promise<RecoveryStep[]>`
Generates a 3-7 step recovery plan ordered from safest to riskiest, complete with:
- `stepId`
- `description`
- `command`
- `commandExplanation`
- `riskLevel` (`green`, `amber`, `red`, `destructive`)
- `requiresApproval`
- `expectedOutcome`
- `rollback` action and guarantees

### Validation & Parsing Utilities
- `parseDiagnosisResponse(raw: string): DiagnosticResult`
- `parseRecoveryPlanResponse(raw: string): RecoveryStep[]`
- `validateDiagnosis(diag: DiagnosticResult): ValidationReport`
- `validateRecoveryPlan(plan: RecoveryStep[]): ValidationReport`
- `isSafeGitCommand(cmd: string | null): boolean`

---

## 🧪 Testing

Run the test suite:
```bash
# From services/gemma directory
npx ts-node test.ts

# Or from workspace root
npm run test --workspace=@git-cure/gemma
```

To typecheck:
```bash
npm run typecheck --workspace=@git-cure/gemma
```
