# pi-durable-otel

Converts **quiescent, checkpointed Pi Durable 1.0.2 SQLite** into OTLP/JSON GenAI traces.
Node >=24.21.0. No model calls, task execution, runtime hooks, exporter or network access.

```ts
import { exportTrace } from "pi-durable-otel";

const result = await exportTrace("session.sqlite", {
  storageId: "episode-run-42", // host-owned, stable across moves; unique per storage
  includeContent: false,
  // conversation: 1,         // optional root ID, includes its full subtree
});
if (!result.ok) {
  console.error(result.error.code, result.error.message);
} else {
  // result.value.traces: one OTLP ExportTraceServiceRequest JSON envelope per root
  // result.value.diagnostics: content-free coverage limitations
}
```

```sh
pi-durable-otel session.sqlite                  # OTLP JSON on stdout
pi-durable-otel one.sqlite two.sqlite --out traces
pi-durable-otel session.sqlite --storage-id episode-run-42 --content
```

`--out` writes one `<traceId>.json` per trace, with mode `0600`, creating directories with
mode `0700`. If any target file already exists, nothing is written. Diagnostics go to stderr, not into OTLP
JSON. Without `--out`, all roots share one OTLP envelope on stdout. Empty storage produces
no traces; untimed records produce coverage diagnostics. `--storage-id` requires one input; otherwise each
input's **resolved path** is its namespace. Moving a CLI input changes identity unless you
supply the same `--storage-id`.

## Read-only means immutable

The reader opens SQLite with `mode=ro&immutable=1` and `readOnly: true`, bypassing Durable's
write-capable openers, migrations and WAL checkpoint-on-close. Node 22.13 treats
URI filenames as literal paths, so Node 24.21.0 is the minimum; older runtimes get
`unsupported_runtime`. It reads schema v1 tables in one read transaction and rejects a
nonempty `-wal` file before and after the read. Immutable SQLite ignores the WAL, so stop
writers and checkpoint through your host first; this package never checkpoints and does not
guard against concurrent writers.
JSONL is not implemented in v0. Malformed records, broken ancestry and unsupported schemas
return Result errors without echoing stored content.

## Meaning of the spans

- Conversations: `invoke_agent` INTERNAL spans. Ownership determines parentage; an ownerless
  history fork uses its fork ancestor. Entries are read once, never replayed into forks.
- Responses: `chat <model>` CLIENT spans under the appending task or conversation.
- Calls: `execute_tool <name>` INTERNAL spans, using the matching `pi.tool` task identity
  when available. They are siblings of chat spans under the generation task, not children
  of a model request that already finished. Owned child conversations hang under their tool.
- Other tasks: `pi.durable.task <kind>` INTERNAL spans, preserving task ownership.

IDs hash the storage namespace and Durable record/message/call identities. Re-exporting with
identical namespace and options is deterministic. Stable IDs **do not guarantee viewer or
backend deduplication**.

**Times are observations, not execution latency.** Durable records message timestamps but
not request/task start and finish times. A chat is a zero-duration point at its persisted
message timestamp (`pi.durable.time_basis=message_observation`). Tool/task/conversation spans
enclose their associated/descendant message observations (`message_observation_envelope`).
Untimed records are omitted with diagnostics; descendants use their nearest emitted ancestor.
Nested tool-call records have durations without absolute times and are omitted with a count
in diagnostics. These traces cannot establish real model latency or complete untimed-task
coverage. Omitted untimed responses also lose their usage from the trace, so totals can fall short of
the stored receipt. Opt-in content events use package-owned `pi.durable.*` names, not the
GenAI content-event conventions.

**Compaction usage is unavailable per span.** Pi 1.0.2 records summarizer usage in the
conversation ledger but does not persist the summarizer's assistant response: a successful
summary is only a timestamped user message. Failed/retried attempts can also contribute spend
without any summary entry. Every detected `pi.compaction` task therefore produces a
`compaction_usage_unavailable` diagnostic, even when its task span is untimed or omitted.
This conservatively also warns for no-op or hook-only compactions that made no model call;
it signals potentially incomplete token/cost totals, not a known missing amount. The exporter
never invents a summarizer chat span or allocates ledger aggregates to one.

GenAI input tokens include Pi's input + cache-read + cache-write. Output already includes
reasoning; reasoning is a breakdown, not added again. Only response and tool-result spans
carry usage, never container aggregates:

| Attribute | Stored value |
|---|---|
| `gen_ai.usage.input_tokens` | input + cacheRead + cacheWrite |
| `gen_ai.usage.output_tokens` | output |
| `gen_ai.usage.cache_read.input_tokens` | cacheRead |
| `gen_ai.usage.cache_write.input_tokens` | cacheWrite |
| `gen_ai.usage.reasoning.output_tokens` | reasoning, only when stored |
| `pi.durable.usage.input_tokens` | raw Pi input (receipt reconciliation) |
| `pi.durable.usage.total_tokens` | stored totalTokens |
| `pi.durable.usage.cache_write_1h_tokens` | cacheWrite1h, only when stored |
| `pi.durable.cost.usd` | stored cost.total, estimated USD, not invoice cost |

Nothing is repriced or inferred. The GenAI conventions are still in development; the mapping
follows a pinned revision rather than the latest draft.

## Privacy

By default there are no content events: no prompts, instructions, responses, tool arguments,
results, raw error prose or arbitrary stored metadata. IDs, tool/task/model/provider names,
stop reasons and numeric usage are still present. `includeContent: true` / `--content` adds
persisted input/output/call/result content in events; this can include secrets, images and
reasoning. Nothing is uploaded. The host owns trace storage, retention and viewer choice.
