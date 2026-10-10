# Coding Principles — pi-durable-extensions

The rules this repository holds itself to. Each one is true of the code today. A change that
breaks one either fixes the code or changes this file in the same commit. Package-level
direction lives in [`blueprint/`](blueprint/README.md).

## Research, then build

1. Understand: restate the task and name assumptions.
2. Read the package, its blueprint note and the Pi surface it touches. Pi ships its
   type declarations; read them rather than guess the API.
3. Look for prior art in Pi, its packages and the community before adding anything.
4. Raise unknowns and decisions before writing code.

## Non-negotiables

- **TypeScript strict.** No `any`, no non-null `!`, no `@ts-ignore` or `@ts-expect-error`.
  A cast needs a one-line reason beside it.
- **Errors follow the boundary they cross.** Pi Durable and vitest-evals expect thrown errors,
  so adapters throw at those boundaries. APIs this repository owns return Result-style values
  for expected failures.
- **Explicit dependencies.** Packages read no environment variables and hold no global state.
  The host passes what is needed: an opener, a path, a model reference.
- **Pi as peer.** Pi packages are peer dependencies with a range ending below the next minor
  version. Development pins exact versions.
- **Co-located tests.** A test sits beside its code as `*.test.ts`. Tests use Pi's faux
  provider; the gate never calls a real model.
- **Public entry is `src/index.ts`.** Each package exports only from there. Knip treats it as
  the API, so an unused internal export fails the gate.

## Working posture

YAGNI · KISS · DRY · obvious correctness over cleverness · every abstraction must earn its
place · readable diffs · fail fast.

- **Verify before done:** `bun run check`, `bun run typecheck` and `bun run test` pass. A
  package change also passes `bun run release --dry-run`.
- **Prove the entry point:** a package claim is checked through what consumers import, the
  packed tarball, not only the source tests.
- **Errors are DX:** say what failed, with which input, and what to do next, in one line.

## Invariants at construction

If a comment or doc states a property, ask why the code does not enforce it. If it cannot,
say so beside the claim. A claim about behavior deserves a test that fails when the claim
stops being true.
