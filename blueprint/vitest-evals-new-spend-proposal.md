# Draft: distinguish attributed cost from new spend in vitest-evals

Status: draft for `getsentry/vitest-evals`, not yet filed.

## Problem

A durable/cached harness may reopen a committed run without calling a model. Its
`usage.costUsd` remains the cost attributed to producing that answer, while this invocation
spends zero. A partially resumed run can incur some new spend. Stock cost summaries currently
cannot distinguish these cases without losing attributed cost.

In vitest-evals 0.17.0, pi-durable-evals preserves attribution and reports invocation spend as
`usage.metadata.newCostUsd`. This metadata survives the JSON report and is inspectable in the
UI's **Raw → Case JSON** (unless host metadata filtering removes it), but is not used by stock
terminal headlines or UI summaries. Reporter options provide no usage selector.

## Minimal proposal

Add optional `UsageSummary.newCostUsd` alongside the unchanged `costUsd`:

- omitted means unavailable; zero means known no new spend;
- display separately labelled **attributed cost** and **new spend** for application and judge
  runs, including their totals;
- totals must not treat unavailable values as known zero; show unavailable/partial coverage
  when an included run lacks the field;
- preserve the field in JSON and UI ingestion.

Do not reinterpret `costUsd`. A cached/reopened flag alone cannot account for partial resumes.
Matching token semantics could be proposed separately; this draft requests only new spend.

## Acceptance examples

| Run | `costUsd` | `newCostUsd` | Display |
|---|---:|---:|---|
| Fresh | 0.12 | 0.12 | attributed $0.12; new spend $0.12 |
| Reopened | 0.12 | 0 | attributed $0.12; new spend $0 |
| Resumed | 0.12 | 0.03 | attributed $0.12; new spend $0.03 |
| Existing adapter | 0.12 | omitted | attributed $0.12; new spend unavailable |

Test application and nested judge aggregation, zero versus omitted, and JSON/UI round trips.

## Installed-source evidence

Inspection of 0.17.0 (not browser validation):

- `@vitest-evals/core/dist/index.d.ts`: `UsageSummary` includes attributed `costUsd` and
  arbitrary JSON-safe `metadata`.
- `vitest-evals/dist/reporter.mjs`: usage summaries and headlines use standard token fields
  and `costUsd`, not usage metadata; `dist/reporter.d.ts` has no selector hook.
- `vitest-evals/dist/harness.mjs` and `dist/index.mjs`: full run usage is preserved and attached
  to task metadata. Vitest's JSON reporter serializes that metadata.
- `@vitest-evals/core/dist/index.mjs` and `dist/node.mjs`: report ingestion retains run usage.
- `@vitest-evals/report-ui/dist/client/assets/index-CDR8ijN6.js`: usage aggregation and
  Overview use `costUsd`; Raw renders the complete case JSON, including usage metadata.
