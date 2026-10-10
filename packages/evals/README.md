# pi-durable-evals

[vitest-evals](https://github.com/getsentry/vitest-evals) harness adapter for
[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable). Each eval case
runs as one durable conversation in its own storage:

- an unchanged case reopens its committed answer without a model call;
- an interrupted case resumes where it stopped;
- a changed case (agent, prompt or key) starts fresh.

It also ships a both-order pairwise judge and `scoreTraces`, which scores production OTLP traces
on an interval against frozen anchors.

> Pi Durable is experimental. The peer range ends below the next Pi minor version.

## Use

```ts
import { describeEval } from "vitest-evals";
import { parseJsonObject, piDurableHarness, piDurableJudgeHarness } from "pi-durable-evals";

// You own models, registry, settings and storage.
const open = async (directory: string) =>
	Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), { models, registry }, ctx);

const viewer = piDurableHarness<{ sample: number }, JsonValue>({
	name: "viewer",
	directory: ".eval/durable",
	open,
	case: ({ sample }) => ({ agent: { model, instructions }, prompt, key: sample }),
	output: parseJsonObject,
});

describeEval(
	"viewer",
	{
		harness: viewer,
		judgeHarness: piDurableJudgeHarness({ name: "grader", directory: ".eval/durable", open, agent: { model } }),
		judges: [MyJudge],
	},
	(it) => {
		it.for([0, 1, 2].map((sample) => ({ sample })))("sample $sample", async (input, { run }) => {
			await run(input);
		});
	},
);
```

## Pairwise judging and samples

```ts
import { expect } from "vitest";
import { piDurableJudgeHarness, piDurablePairwiseJudge } from "pi-durable-evals";

const quality = piDurablePairwiseJudge<string, string>({
	name: "quality",
	system: "Prefer the answer that best addresses the question.",
	prompt: ({ input, a, b }) => JSON.stringify({ question: input, A: a, B: b }),
});

// Inside an eval test: the baseline is a required assertion parameter.
const result = await run(question);
await expect(result).toSatisfyJudge(quality, {
	baseline,
	judgeHarness: piDurableJudgeHarness({
		name: "grader",
		directory: ".eval/durable",
		open,
		agent: { model },
		key: sample,
	}),
});
```

The judge runs candidate/baseline (A/B), then baseline/candidate (B/A). It appends a JSON
preference instruction to `system`; each verdict must contain `preference: "A" | "B" | "tie"`.
A candidate win needs both orders (score `1`), a baseline win is `0`, and a tie or any
disagreement is `0.5`. Metadata records `verdict`, `agree`, `orderVerdicts` and the raw
`ab`/`ba` responses. A missing baseline, missing harness or malformed verdict throws.

Set the judge harness's `key` to the sample so identical outputs from different samples get
separate grading calls; reusing a key reopens the stored grading. A custom judge can pass a
`DurableJudgeInput` with its own request `key` to `ctx.runJudge`. Pairwise uses `ab` and `ba`,
so even identical candidate and baseline outputs get two conversations.

## Usage and reopening

Each run's artifacts include `durable.directory`, `conversation`, `submission` and `reopened`.
`usage.metadata.newCostUsd` is the spend of this invocation; `usage.costUsd` is what the case
cost to produce. `usage.metadata.newTotalTokens` similarly tracks newly produced tokens.
A completed reopened case has zero new spend/tokens; a resumed case may have nonzero new spend.

vitest-evals 0.17.0's terminal headline and UI summaries show stored cost, not new spend.
The metadata survives the JSON report and shows under the UI's **Raw → Case JSON**.

## Scoring production traces

`scoreTraces` reads OTLP JSON files, such as those from `pi-durable-otel`, and judges them on an
interval you schedule. The CLI loads a JavaScript config module you write, so models, registry,
credentials and storage stay in your code. For example, `judges.mjs`:

```js
import { open, judgeModel } from "./host.js";

export default {
	open,
	judgeDirectory: ".eval/trace-judges",
	anchors: ["frozen/anchor.json"],
	candidateBelow: 0.3,
	judges: [{
		name: "quality",
		agent: { model: judgeModel }, // { provider, modelId }
		configKey: "registry-and-rubric-v1",
		system: "Grade this run against its own artifacts. Return JSON with score in [0,1] and optional rationale.",
		prompt: ({ data }) => JSON.stringify(data),
	}],
};
```

```sh
pi-durable-evals score --config ./judges.mjs --since ./checkpoint.json \
  --interval batch-001 --out ./scored ./traces/run.json
```

The same configuration also works through the public library:

```ts
import { scoreTraces } from "pi-durable-evals";

const result = await scoreTraces({
	...config,
	files: ["traces/run.json"],
	checkpoint: "checkpoint.json",
	intervalId: "batch-001",
	outDirectory: "scored",
});
if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
```

`--since` names a checkpoint file, not a time. It records which trace snapshots each judge has
already scored, so pass every file you want considered: an unseen or changed trace is scored
however old its events are. A missing checkpoint starts fresh; an invalid one fails rather
than resetting. Keep it outside `--out`. The checkpoint grows and is never pruned.

What counts as "already scored" covers the trace bytes, the judge's JSON-visible agent
configuration, model and rendered prompt. Changing any of them re-scores, including an
exporter upgrade that changes the trace bytes. Set `configKey` for behavior JSON cannot see:
the registry, the opener, or function-valued agent configuration.

Anchors are required, frozen traces that every new interval ID judges again, so you can tell
judge or pipeline drift from production change; a shift tells you something moved, not what.
They cannot overlap production traces, and changing them needs a new checkpoint. Reusing an
interval ID is a retry: completed calls reopen without spending, and changed inputs or
configuration conflict.

Each `<out>/<interval>` directory contains:

- `scores.jsonl`: one row per trace and judge with score, rationale, hashes and usage;
- `summary.json`: per-judge production and anchor means with clipped 95% Hoeffding bounds;
- `candidates.jsonl`: production rows below `candidateBelow`, as `pending_owner_approval`;
- `trace-<traceId>.json`: a copy of the trace with `pi.evals.<judge>.*` attributes on its root spans;
- `plan.json`, `checkpoint.json`, `commit.json`: the frozen plan, next checkpoint and checksums.

Inputs are never modified. Score the original exports, not the annotated copies. Validation
covers IDs, parentage and timestamps, not the full OTLP schema; int64 `intValue`s beyond 2^53
must be strings.

Bounds are `mean ± sqrt(log(40)/(2n))`, clipped to `[0,1]`. `smallN` marks `n < 8`, where the
bound spans the whole range. They assume independent scores, which related runs are not, so
read them as trends next to their counts.

The checkpoint advances only after the interval's files are written and verified. A failed
judge or write leaves it untouched, and a retry finishes the interval without new model calls.
A failure names its reason and, when known, the judge's durable directory; an answer from a
model other than the configured one fails. A malformed verdict is stored, so it fails again on
retry; use a new interval ID or change the judge to rejudge it.

Candidates are not fixtures: turning one into an offline eval case is your call. There is no
scheduler or lock; run one process per checkpoint.
