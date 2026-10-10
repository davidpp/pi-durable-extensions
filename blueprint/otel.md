# pi-durable-otel

Converts Pi Durable storage into OpenTelemetry GenAI traces.

## Why

Pi's tracing extensions (`pi-otel`, `@desek/pi-opentelemetry`, the Langfuse, Braintrust and
LangSmith plugins) all hook the coding agent's extension events. None reads Pi Durable.
`@earendil-works/pi-telemetry` defines a span contract but ships no exporter, and Durable
does not use it yet. Community PRs for an OTLP exporter (pi#10009) and for emitting
`pi.ai.request` spans (pi#10085) were auto-closed by contributor policy, not on merit.

## Contract

- **Input:** quiescent, checkpointed Durable SQLite schema v1 (Pi 1.0.2), opened immutable
  and read-only. No model calls or task execution. JSONL remains later work.
- **Output:** one OTLP/JSON trace per root conversation, written to a file or returned as a
  value. Pushing to an OTLP endpoint is the host's choice, outside this package.
- **Spans** use a pinned OpenTelemetry GenAI mapping:
  - conversation → `invoke_agent`
  - each model response → `chat`, with `gen_ai.request.model`, `gen_ai.usage.*` and cost
  - each tool call → `execute_tool`; nested and child-task conversations → child spans
- **Identity is stable:** trace and span IDs derive from a host-owned storage namespace and
  Durable conversation, entry, task and call identities. Re-exporting yields the same IDs;
  viewer/backend deduplication is not guaranteed.
- **Content is opt-in:** prompts and responses can be sensitive, so message content goes into
  span events only when the caller asks for it.

## Surface (built in `packages/otel`)

```ts
exportTrace(sqlitePath, { storageId, conversation?, includeContent? })
// Promise<ExportResult>: { ok: true, value: { traces: OtlpTrace[], diagnostics: ExportDiagnostic[] } }
//                   or { ok: false, error: { code, message } }
// CLI
pi-durable-otel <storage-path…> [--out DIR] [--content] [--storage-id ID]
```

One OTLP/JSON envelope per ownership/fork root; `conversation` selects an existing root's
complete subtree. CLI stdout merges envelopes; diagnostics go to stderr. `--out` creates
private, exclusively written `<traceId>.json` files, never overwriting existing files.
CLI identity defaults to each input's resolved path. `--storage-id` applies to one input;
reuse it after relocation. The library requires an explicit namespace, unique per storage.

## Viewers that fit

These are small and local: tracelens (drop a file into a browser page), otel-desktop-viewer and
otel-tui (single binaries that receive OTLP), otelite (a single binary for LLM work, with GenAI
attribute support).

## Later, only if needed

Live spans through a `TelemetryContext` adapter passed into the model call, for hosts that
already wrap `models.streamSimple`. An upstream issue asking whether Durable should accept a
`telemetryContext` comes before any code.

## Held v0 decisions

- **Immutable reads.** `node:sqlite` opens the file with URI `mode=ro&immutable=1` and
  `readOnly: true`, inside one read transaction, after checking schema v1. Durable's own
  openers migrate and checkpoint on close, and plain `readOnly` can create WAL/SHM sidecars.
  A nonempty WAL before or after the read is an error: stop writers and checkpoint first. This
  needs a quiescent database; it does not protect against concurrent writers. Node 22.13 does
  not honor SQLite URI filenames; 24.21.0 is the lowest version tested, and older runtimes get
  an `unsupported_runtime` error.
- **Parentage.** Conversations follow task ownership; ownerless forks follow the conversation
  they forked from. Chat spans follow `byTaskId`. A `pi.tool` task's `{ assistant, callId }`
  ties a call and its child conversations to one tool span; other tasks keep their own
  INTERNAL spans. Each entry is exported once, never replayed into forks.
- **Timestamps are observations.** Durable stores message timestamps, not execution intervals.
  Chats are zero-duration points; tool, task and conversation spans enclose the messages they
  contain, tagged `pi.durable.time_basis`. Untimed spans and nested tool calls (which have no
  absolute time) are omitted with diagnostics, so their usage is missing from the trace too.
- **Usage.** GenAI input tokens are `input + cacheRead + cacheWrite`; reasoning is already in
  output. Only chat and tool-result spans carry usage. `pi.durable.usage.*` keeps Pi's raw
  counters and `pi.durable.cost.usd` the stored estimate. Nothing is repriced or inferred.
- **Compaction.** Pi 1.0.2 charges compaction to the usage ledger without storing the
  summarizer's response, and failed attempts leave no entry. Every `pi.compaction` task in the
  export emits `compaction_usage_unavailable`, including no-op tasks: usage *may* be
  incomplete. No summarizer span or cost is invented.
- **Content is off by default**, including raw errors and stored metadata. Opt-in content goes
  into package-owned `pi.durable.*` events; IDs and tool, task and model names stay visible.
- **Conventions.** The GenAI mapping follows semantic-conventions revision
  `cc07f722069974139dab497d80d145144b19daca`, not the latest draft. `chat` is CLIENT; tools
  and agents are INTERNAL, and tools stay under their owning task rather than the finished
  chat span. Cost and content attributes are package-owned.

## Verified

The packed 0.1.0 tarball's import, types and CLI were run on Node 24.21.0 against a real
Durable session: three spans, token and cost attributes matching the stored receipt,
byte-identical re-exports, and an unchanged database. otel-desktop-viewer 0.5.0 accepted the
OTLP and rendered the conversation → task → chat tree. Tool, child-task and compaction traces
are covered by tests, not yet by a viewer check.
