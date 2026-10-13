# git-cure

**Terminal-native Git diagnostics and recovery powered by Gemma.**

git-cure inspects your local repository, identifies problematic Git states, uses Google's Gemma model to explain root causes, generates a step-by-step recovery plan, and executes approved commands with safety snapshots — entirely from the terminal.

---

## Problem

Git's output is precise but not always actionable. When something goes wrong — a botched rebase, a merge conflict in a critical file, a detached HEAD after a failed cherry-pick — developers spend time decoding error messages and searching Stack Overflow for the right incantation.

git-cure gives you a plain-language diagnosis and a concrete recovery path without leaving your terminal.

---

## Architecture (planned)

```
Local repository
       │
       ▼
  CLI engine          ← git operations via child_process, state detection
       │
       ▼
 Gemma module         ← structured prompts, schema-validated diagnosis output
       │
       ▼
Recovery planner      ← step sequencing, risk classification, approval gates
       │
       ▼
  Guarded executor    ← snapshot → run → verify
       │
       ▼
   Dashboard          ← read-only presentation layer, live during hackathon demo
```

The dashboard **never** executes shell commands. It displays what the CLI engine reports.

---

## Phase 1 scope (current)

- Monorepo scaffold with npm workspaces
- React + Vite + TypeScript + Tailwind frontend shell
- Shared TypeScript data contracts (`packages/shared`)
- Placeholder CLI entry point (`packages/cli`)
- Placeholder Gemma entry point (`services/gemma`)
- Mock data and service interface stubs
- Documentation

The CLI integration and Gemma API calls are **not yet implemented**.

---

## Tech stack

| Layer       | Technology                          |
|-------------|-------------------------------------|
| Frontend    | React 18, Vite 5, TypeScript 5, Tailwind CSS 3 |
| CLI engine  | Node.js, TypeScript, child_process  |
| AI          | Google Gemma (Phase 3)              |
| Package mgr | npm workspaces                      |

---

## Prerequisites

- Node.js 20 or later
- npm 10 or later

---

## Installation

```bash
git clone https://github.com/toshuuu/Hacktoberfest-Nexora
cd git-cure
npm install
```


---

## Development commands

| Command               | What it does                              |
|-----------------------|-------------------------------------------|
| `npm run dev`         | Start the dashboard on http://localhost:5173 |
| `npm run build`       | Production build (dashboard)              |
| `npm run typecheck`   | Type-check all workspaces                 |

Per-workspace:

```bash
npm run dev --workspace=@git-cure/dashboard
npm run typecheck --workspace=@git-cure/shared
npm run typecheck --workspace=@git-cure/cli
npm run typecheck --workspace=@git-cure/gemma
```

---

## Repository structure

```
git-cure/
├── apps/dashboard/        # React dashboard (Teammate 1)
│   ├── src/
│   │   ├── components/ui/ # Shared UI primitives
│   │   ├── data/          # Mock data (replaced by live API in Phase 2)
│   │   ├── pages/         # Page-level components
│   │   ├── services/      # API service layer (stubs)
│   │   └── types/         # Re-exports from @git-cure/shared
│   └── ...
│
├── packages/
│   ├── shared/            # TypeScript data contracts (read by all)
│   └── cli/               # CLI engine (Teammate 2)
│
├── services/gemma/        # Gemma AI module (Teammate 3)
│
└── docs/                  # Architecture, API contract, team workflow
```

---

## Team

| Teammate | Module            | Owns                         |
|----------|-------------------|------------------------------|
| 1        | Dashboard         | `apps/dashboard/`            |
| 2        | CLI engine        | `packages/cli/`              |
| 3        | Gemma engine      | `services/gemma/`            |

See `docs/TEAM_WORKFLOW.md` for branch strategy and integration points.

---

## Upcoming phases

**Phase 2 — CLI engine**
Repository telemetry, state detection, safety snapshots, guarded execution.

**Phase 3 — Gemma integration**
Structured prompts, schema-validated diagnosis, risk classification, recovery recipes.

**Phase 4 — Dashboard integration**
Wire the dashboard to the live CLI API. Replace all mock data.

---

## Current limitations

- No real Git operations are performed.
- Gemma API is not connected.
- The dashboard displays static mock data only.
- The local API server does not yet exist.

---

## Push to GitHub (first time)

```bash
git init
git add .
git commit -m "chore: initialize git-cure project foundation"
git branch -M main
git remote add origin <YOUR_GITHUB_REPOSITORY_URL>
git push -u origin main
```

> Replace `(https://github.com/toshuuu/Hacktoberfest-Nexora)` with the actual URL of your newly created GitHub repository. Do not commit until the repository exists on GitHub.
=======
