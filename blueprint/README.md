# Blueprint

Where this repository is going, and the rules each package follows to get there. A package
moves from here into `packages/` when it is built; its note then records the decisions that
still hold.

## Direction

Pi Durable commits conversations, turns, tool calls and usage to storage before anything is
shown. That makes its storage a complete record of every run. The packages here build on that
record instead of instrumenting the runtime:

```
Durable runs (storage) ──pi-durable-otel──▶ traces (OTLP JSON) ──▶ any viewer (tracelens, otel-tui, …)
                                               │
                              pi-durable-evals: score new traces on an interval
                                               ▼
                           scores (+ attached to traces) ──▶ trend, alert
                                               │
                              low scorers ──▶ candidate fixtures (owner approves) ──▶ offline evals

Offline evals: pi-durable-evals runs fixed cases as durable conversations inside vitest-evals.
```

| Package | Does one thing | Status |
|---|---|---|
| [`pi-durable-evals`](evals.md) | Runs vitest-evals cases and judges as durable conversations | built (`packages/evals`) |
| [`pi-durable-otel`](otel.md) | Converts Durable storage into OpenTelemetry GenAI traces | built (`packages/otel`) |
| Trace scoring | Scores production traces on an interval | built, inside `pi-durable-evals` ([evals](evals.md#scoring-production-traces)) |

## Rules for every package

- **One job, small surface.** A package does one thing a reader can state in a sentence. If
  it needs a second sentence, it is two packages.
- **Compose through data, not imports.** Packages meet at open formats: OTLP JSON traces,
  vitest JSON reports, Durable storage. `pi-durable-evals` never imports `pi-durable-otel`;
  it reads traces, whoever wrote them.
- **Storage is the truth.** Prefer reading what Durable already committed over hooking the
  live runtime. Live hooks come later and only through Pi's own contracts
  (`@earendil-works/pi-telemetry`'s explicit `TelemetryContext`), never through globals.
- **The host owns its configuration.** Packages take what they need as arguments: an opener
  for a Durable harness, a storage path, a model reference. No environment variables, no
  ambient state, no hidden defaults that pick a provider.
- **Pi is a peer, not a dependency.** Pi packages are peer dependencies with a bounded range.
  Pi Durable is experimental and changes without notice, so every range ends below the next
  minor version and moves only after the tests pass on it.
- **Nothing a user did not ask for.** No exporter, scheduler or backend is bundled. A package
  writes a file or returns a value; the host decides where it goes.

## Upstream

Pi accepts pull requests only from approved contributors, and a built-in eval harness was
declined (earendil-works/pi#2002). These packages are third-party by design. A change that
belongs in Pi itself starts as an issue that asks a maintainer first.
