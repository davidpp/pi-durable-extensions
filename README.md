# pi-durable-extensions

Small, composable extensions for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).
They build on what Durable already commits to storage. Each package does one thing, and
packages meet through open formats (OTLP traces, vitest JSON), not imports.

| Package | What it does |
|---|---|
| [`pi-durable-evals`](packages/evals) | Durable eval cases, judges and interval scoring of OTLP traces |
| [`pi-durable-otel`](packages/otel) | Read-only Durable SQLite export to OTLP GenAI traces |

Planned work and the rules each package follows: [`blueprint/`](blueprint/README.md).

## Develop

```bash
bun install
bun run check && bun run typecheck && bun run test
```

## Release

Bump `version` in the package's `package.json`, commit, then:

```bash
bun run release --dry-run   # build and pack every public package
bun run release             # tag HEAD and publish each version that is not on npm yet
git push origin <name@version>
```

A real release needs a clean tree and checks every package's npm and tag state before it
tags or publishes anything. Any registry answer other than the exact version or a 404 stops
it. The `name@version` tag is created before publishing, so push tags only after every
publish succeeded. A rerun from the same HEAD reuses the tag and skips published versions.
If the fix needs a new commit, delete the unpushed tag of the unpublished version
(`git tag -d name@version`) and rerun. If a published version has no local tag, release
stops: fetch or recreate that tag on the commit that produced the published artifact.

## License

MIT
