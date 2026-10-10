# pi-durable-extensions

Small, composable extensions for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).
Read [`blueprint/README.md`](blueprint/README.md) for the direction, then
[`CODING_PRINCIPLE.md`](CODING_PRINCIPLE.md) for the rules the code holds.

## Shape

```
blueprint/        # direction and per-package contracts, built or planned
packages/
├── evals/        # pi-durable-evals: vitest-evals cases and judges as durable conversations, trace scoring
└── otel/         # pi-durable-otel: read-only Durable SQLite export to OTLP GenAI traces
scripts/
└── release.ts    # tags and publishes packages whose version is not on npm yet
```

## Gate

```bash
bun run check              # oxlint, its type-aware pass, oxfmt --check, knip, jscpd
bun run typecheck          # tsc in every package, then scripts
bun run test               # vitest; faux provider only, no real model calls
bun run release --dry-run  # builds and packs every public package
bun run fix                # applies oxlint fixes and oxfmt
```

Lefthook runs oxfmt, both oxlint passes and the typecheck on commit, and the full gate on
push. CI runs the same gate plus the release dry run.

## Constraints for agents

- One concern per commit.
- Never publish. A release is the owner running `bun run release` after bumping versions.
- Installs respect the machine's 5-day `minimumReleaseAge`. Pin a version that passes it;
  do not work around the gate.
- Machine-local notes go in a gitignored `CLAUDE.local.md`.
