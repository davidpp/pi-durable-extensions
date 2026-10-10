# pi-durable-evals

Runs vitest-evals cases and judges as Pi Durable conversations, and scores production traces.

## Decisions that hold

- **vitest-evals, not a new runner.** Pi's own `packages/evals` uses Sentry's vitest-evals.
  It brings judges, a JSON report, `vitest-evals serve` and a GitHub action.
  `@vitest-evals/harness-pi-ai` still targets the pre-1.0 `@mariozechner/pi-*` packages.
- **One case is one durable conversation in its own storage.** The case directory is
  content-addressed by harness name, agent, prompt and key. An unchanged case reopens its
  committed answer without a model call, an interrupted one resumes, and a changed one runs
  fresh. Durable's request ID makes the resubmission idempotent.
- **Judges are durable too.** `piDurableJudgeHarness` serves `ctx.runJudge(...)`, so judge
  calls get the same resume and reopen behavior.
- **Samples are a key.** vitest-evals has no repetitions, so the caller puts a sample index in
  the case key. The judge harness takes a sample `key` as well, so identical outputs from
  different samples get independent grading, and `DurableJudgeInput.key` separates requests
  within a sample. Judges without either key keep their original storage identity.
- **Pairwise judges both orders.** `piDurablePairwiseJudge` takes the baseline as a required
  assertion parameter and asks candidate/baseline, then baseline/candidate. Only an agreed
  preference is a win (`1`) or loss (`0`); ties and disagreements score `0.5`. Invalid
  verdicts throw instead of becoming ties.
- **Importable outside Vitest.** The package imports vitest-evals subpaths only, so the
  scoring CLI runs under plain Node.

Why sampling matters: one judge, run three times on byte-identical inputs, scored 0.71, 0.43
and 0.57. A rerun of the same three cases reopened them in 359 ms with no spend.

## Known gaps

- On a reopened case, vitest-evals 0.17.0's terminal headline and UI cost summaries show the
  stored cost of producing it (`usage.costUsd`). New spend is in `usage.metadata.newCostUsd`
  and new tokens in `usage.metadata.newTotalTokens`; both survive the JSON report and show
  under **Raw → Case JSON**. A resumed case may still spend, so a cached flag is not enough.
  An [upstream proposal](vitest-evals-new-spend-proposal.md) is drafted, not filed.

## Scoring production traces

`scoreTraces(options)` and `pi-durable-evals score --config judges.mjs --since checkpoint.json
--interval ID --out DIR [trace.json…]`. The host owns the schedule, file discovery, Durable
opener, model registry, rubric and threshold; the config is a host JS module. The package
reads OTLP JSON and never imports `pi-durable-otel`.

- **The checkpoint is a snapshot ledger, not a timestamp filter.** Every supplied file is
  scanned, and an unseen or changed snapshot is scored even if its events are old. A seen key
  covers the snapshot hash, judge name, JSON-visible agent configuration, model and rendered
  prompt. A missing checkpoint starts a new ledger; a malformed one fails instead of resetting.
  The ledger is never pruned.
- **Generic OTLP JSON.** Batched envelopes split by trace ID; unknown fields and protobuf
  defaults are kept. Duplicate spans, cyclic parents and two different snapshots of one trace
  fail before any judge call, as does a numeric `intValue` beyond 2^53 (encode int64 as a
  string). Inputs are never modified. Annotated copies get `pi.evals.<judge>.*` attributes on
  their root spans; feeding a copy back in counts as a new snapshot.
- **Reference-free judges.** A prompt grades a snapshot against its own artifacts. A verdict
  is JSON with a score in `[0,1]` and an optional rationale, and must come from the configured
  model. Functions cannot be hashed, so function-valued agent configuration needs a host
  `configKey`, changed whenever opener, registry or closure behavior changes.
- **Mandatory frozen anchors.** Each new interval ID judges the anchors again with fresh calls,
  even with no new production traces; reusing an interval ID is a retry. The checkpoint
  freezes anchor hashes, so changing anchors needs a new checkpoint. Anchors may not overlap
  production traces. An anchor shift says the judge or the pipeline moved; it does not say which.
- **Recoverable interval bundles.** `plan.json` freezes inputs, jobs, judges and threshold
  before any call, and a changed plan conflicts. Scores, candidates, summary, annotated copies
  and the next checkpoint are written, then a checksummed `commit.json`, then the checkpoint
  advances by atomic rename. A retry verifies the committed bundle and repairs a missing
  checkpoint write without model calls; a failed judge or write never advances the ledger.
  Atomic renames survive process interruption, not power loss. One process per checkpoint.
- **Window estimates.** Production and anchor summaries are separate per judge: mean and
  clipped 95% Hoeffding bounds `mean ± sqrt(log(40)/(2n))`, with `smallN` below 8 scores,
  where the bound spans `[0,1]`. They assume independent observations, which snapshots of
  related runs are not; read them as descriptive trends with their sample counts.
- **Candidates, not fixtures.** Production scores below the threshold become
  `pending_owner_approval` records pointing at the copied trace. Promotion into an offline
  suite is a human step outside the package.
