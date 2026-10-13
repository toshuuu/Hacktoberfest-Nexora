# Contributing to git-cure

We are a four-person hackathon team. Keep things simple and predictable.

---

## Branch naming

| Prefix  | Use for                                 | Example                              |
|---------|-----------------------------------------|--------------------------------------|
| `feat/` | New feature or capability               | `feat/repo-telemetry`                |
| `fix/`  | Bug fix                                 | `fix/conflict-detection-edge-case`   |
| `docs/` | Documentation only                      | `docs/api-contract-update`           |

Branch names are lowercase, hyphen-separated, with no spaces or special characters.

---

## Starting work

```bash
git checkout main
git pull origin main
git checkout -b feat/your-feature-name
```

Always pull the latest `main` before branching.

---

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(cli): collect working-tree status via git status --porcelain
fix(dashboard): resolve statusDot colour mismatch for red risk level
docs(architecture): clarify dashboard read-only constraint
chore(deps): update react to 18.3.1
```

Format: `type(scope): imperative, lowercase, present tense, ≤72 chars`

Scopes: `cli`, `gemma`, `dashboard`, `shared`, `docs`, `deps`

---

## Pull requests

1. Open a PR from your feature branch to `main`.
2. Title follows the same Conventional Commit format as above.
3. Description explains what changed and why, not how — the diff shows the how.
4. Link any related issues or integration dependencies.
5. All teammates review PRs that touch `packages/shared` — changing shared types affects every module.

---

## TypeScript conventions

- Prefer `interface` for objects with methods or that will be extended; `type` for unions, intersections, and aliased primitives.
- No `any`. Use `unknown` and narrow explicitly when the type is genuinely unknown.
- Function parameters that could be confused by order should use an options object.
- Export types from `packages/shared/src/types.ts`; import them from `@git-cure/shared` in all other packages.

---

## Changing shared contracts

Shared types in `packages/shared/src/types.ts` are the integration boundary between all three modules.

Before changing them:
1. Open a discussion in the team chat or a draft PR.
2. Confirm that all affected modules can be updated in the same PR.
3. Update the mock data in `apps/dashboard/src/data/mockData.ts` to match.
4. Update `docs/API_CONTRACT.md`.

A breaking change to shared types that lands without warning will block your teammates.

---

## Environment setup

```bash
# Copy the env template — never commit .env
cp .env.example .env
```

Fill in values only for the module you are working on.
