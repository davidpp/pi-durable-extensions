import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, expect, onTestFinished, test } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { piDurableHarness, piDurableJudgeHarness, piDurablePairwiseJudge } from "./index.ts";

const model = { provider: "faux", modelId: "faux-1" };

async function setup(responses: string[]) {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-evals-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const faux = fauxProvider();
	faux.setResponses(responses.map((text) => fauxAssistantMessage(text)));
	const models = createModels();
	models.setProvider(faux.provider);
	const open = async (caseDirectory: string) =>
		Harness.open(
			await openNodeSqliteStorage(join(caseDirectory, "session.sqlite")),
			{ models, registry: createRegistry(), settings: { compaction: { enabled: false } } },
			BACKGROUND_CONTEXT,
		);
	return { directory, faux, open };
}

test("runs a case as a durable conversation and reopens it without a model call", async () => {
	const { directory, faux, open } = await setup(["first answer", "second answer"]);
	const harness = piDurableHarness<{ question: string; sample: number }, string>({
		name: "echo",
		directory,
		open,
		case: ({ question, sample }) => ({
			agent: { model, instructions: "Answer." },
			prompt: question,
			key: sample,
		}),
		output: (text) => text,
	});
	const context = { artifacts: {}, setArtifact: () => {} };

	const first = await harness.run({ question: "Hi?", sample: 0 }, context);
	expect(first.output).toBe("first answer");
	// Durable's model context carries the instructions as a system message after the input.
	expect(first.session.events.map((event) => event.type === "message" && event.role)).toEqual([
		"user",
		"system",
		"assistant",
	]);
	expect(first.artifacts).toMatchObject({ durable: { reopened: false } });

	const again = await harness.run({ question: "Hi?", sample: 0 }, context);
	expect(again.output).toBe("first answer");
	expect(again.artifacts).toMatchObject({ durable: { reopened: true } });
	expect(faux.state.callCount).toBe(1);
	expect(first.usage.totalTokens).toBeGreaterThan(0);
	expect(again.usage.totalTokens).toBe(first.usage.totalTokens);
	expect(again.usage.costUsd).toBe(first.usage.costUsd);
	expect(first.usage.metadata?.newTotalTokens).toBe(first.usage.totalTokens);
	expect(again.usage.metadata).toMatchObject({ newCostUsd: 0, newTotalTokens: 0 });

	const nextSample = await harness.run({ question: "Hi?", sample: 1 }, context);
	expect(nextSample.output).toBe("second answer");
	expect(faux.state.callCount).toBe(2);
});

test("judge harness parses a fenced JSON verdict", async () => {
	const { directory, open } = await setup(['Verdict:\n```json\n{ "score": 0.5 }\n```']);
	const judge = piDurableJudgeHarness({ name: "judge", directory, open, agent: { model } });
	const run = await judge.run(
		{ system: "Grade.", prompt: "Answer: 42", responseFormat: { type: "json" } },
		{ artifacts: {}, setArtifact: () => {} },
	);
	expect(run.output).toEqual({ score: 0.5 });
});

test("unkeyed judges reopen the original hash identity", async () => {
	const { directory, faux, open } = await setup(['{ "score": 0.5 }']);
	const durable = { agent: { model, instructions: "Grade." }, prompt: "Answer: 42" };
	const original = piDurableHarness<undefined, string>({
		name: "legacy-judge",
		directory,
		open,
		case: () => durable,
		output: (text) => text,
	});
	const context = { artifacts: {}, setArtifact: () => {} };
	const stored = await original.run(undefined, context);
	const hash = createHash("sha256")
		.update(JSON.stringify({ name: "legacy-judge", ...durable }))
		.digest("hex");
	expect(stored.artifacts).toMatchObject({
		durable: { directory: join(directory, hash.slice(0, 24)) },
	});
	const judge = piDurableJudgeHarness({ name: "legacy-judge", directory, open, agent: { model } });
	const reopened = await judge.run(
		{ system: "Grade.", prompt: "Answer: 42", responseFormat: { type: "json" } },
		context,
	);
	expect(reopened.output).toEqual({ score: 0.5 });
	expect(reopened.artifacts).toMatchObject({
		durable: { directory: join(directory, hash.slice(0, 24)), reopened: true },
	});
	expect(reopened.usage.metadata).toMatchObject({ newCostUsd: 0, newTotalTokens: 0 });
	expect(faux.state.callCount).toBe(1);
});

const outcomes = [
	{ ab: "A", ba: "B", score: 1, verdict: "win", sides: ["candidate", "candidate"], agree: true },
	{ ab: "B", ba: "A", score: 0, verdict: "loss", sides: ["baseline", "baseline"], agree: true },
	{ ab: "tie", ba: "tie", score: 0.5, verdict: "tie", sides: ["tie", "tie"], agree: true },
	{ ab: "A", ba: "A", score: 0.5, verdict: "tie", sides: ["candidate", "baseline"], agree: false },
	{ ab: "B", ba: "B", score: 0.5, verdict: "tie", sides: ["baseline", "candidate"], agree: false },
	{ ab: "tie", ba: "B", score: 0.5, verdict: "tie", sides: ["tie", "candidate"], agree: false },
	{ ab: "A", ba: "tie", score: 0.5, verdict: "tie", sides: ["candidate", "tie"], agree: false },
	{ ab: "tie", ba: "A", score: 0.5, verdict: "tie", sides: ["tie", "baseline"], agree: false },
	{ ab: "B", ba: "tie", score: 0.5, verdict: "tie", sides: ["baseline", "tie"], agree: false },
];

function pairwise() {
	return piDurablePairwiseJudge<string, string>({
		name: "quality",
		system: "Compare quality.",
		prompt: ({ input, a, b }) => JSON.stringify({ input, A: a, B: b }),
	});
}

test.for(outcomes)("both-order preference $ab/$ba yields $verdict", async (outcome, { task }) => {
	const ab = { preference: outcome.ab, rationale: "First order." };
	const ba = { preference: outcome.ba, rationale: "Second order." };
	const { directory, faux, open } = await setup([JSON.stringify(ab), JSON.stringify(ba)]);
	const judgeHarness = piDurableJudgeHarness({
		name: "pairwise",
		directory,
		open,
		agent: { model },
	});
	await expect("candidate").toSatisfyJudge(pairwise(), {
		input: "Question",
		baseline: "baseline",
		judgeHarness,
		threshold: null,
	});
	const result = task.meta.eval?.scores.at(-1);
	expect(result).toMatchObject({
		score: outcome.score,
		metadata: {
			verdict: outcome.verdict,
			agree: outcome.agree,
			orderVerdicts: outcome.sides,
			ab,
			ba,
		},
	});
	expect(faux.state.callCount).toBe(2);
	expect(
		result?.judgeRuns?.map(
			(run) =>
				run.session.events.flatMap((event) =>
					event.type === "message" && event.role === "user" ? [event.content] : [],
				)[0],
		),
	).toEqual([
		JSON.stringify({ input: "Question", A: "candidate", B: "baseline" }),
		JSON.stringify({ input: "Question", A: "baseline", B: "candidate" }),
	]);
});

test("public ctx.runJudge preserves order keys for equal outputs and reopens both calls", async ({
	task,
}) => {
	const { directory, faux, open } = await setup([
		'{ "preference": "A" }',
		'{ "preference": "B" }',
		'{ "preference": "B" }',
		'{ "preference": "A" }',
	]);
	const judgeHarness = piDurableJudgeHarness({
		name: "equal",
		directory,
		open,
		agent: { model },
		key: 0,
	});
	const options = { input: "Question", baseline: "same", judgeHarness };
	await expect("same").toSatisfyJudge(pairwise(), options);
	const first = task.meta.eval?.scores.at(-1);
	expect(first).toMatchObject({ score: 1, metadata: { verdict: "win", agree: true } });
	const runs = first?.judgeRuns;
	expect(runs).toHaveLength(2);
	expect(runs?.[0]?.artifacts?.durable).not.toEqual(runs?.[1]?.artifacts?.durable);
	expect(faux.state.callCount).toBe(2);
	await expect("same").toSatisfyJudge(pairwise(), options);
	const reopened = task.meta.eval?.scores.at(-1)?.judgeRuns;
	expect(reopened).toHaveLength(2);
	for (const run of reopened ?? []) {
		expect(run.artifacts).toMatchObject({ durable: { reopened: true } });
		expect(run.usage.metadata).toMatchObject({ newCostUsd: 0, newTotalTokens: 0 });
	}
	expect(faux.state.callCount).toBe(2);
	const next = {
		...options,
		judgeHarness: piDurableJudgeHarness({
			name: "equal",
			directory,
			open,
			agent: { model },
			key: 1,
		}),
		threshold: null,
	};
	await expect("same").toSatisfyJudge(pairwise(), next);
	expect(task.meta.eval?.scores.at(-1)).toMatchObject({ score: 0, metadata: { verdict: "loss" } });
	expect(faux.state.callCount).toBe(4);
	await expect("same").toSatisfyJudge(pairwise(), next);
	expect(faux.state.callCount).toBe(4);
});

test("sample keys isolate identical grading prompts through the public matcher", async ({
	task,
}) => {
	const { directory, faux, open } = await setup(['{ "score": 0.5 }', '{ "score": 0.5 }']);
	const judge = createJudge<string, string>("sample", async ({ runJudge }) => {
		if (!runJudge) throw new Error("Sample judge requires a harness");
		expect(
			await runJudge({ prompt: "Identical output", responseFormat: { type: "json" } }),
		).toEqual({ score: 0.5 });
		return { score: 0.5 };
	});
	const sample = (key: number) =>
		piDurableJudgeHarness({ name: "sample", directory, open, agent: { model }, key });
	for (const key of [0, 0, 1, 1])
		await expect("same").toSatisfyJudge(judge, { judgeHarness: sample(key), threshold: null });
	expect(faux.state.callCount).toBe(2);
	const runs = task.meta.eval?.scores.flatMap((score) => score.judgeRuns ?? []);
	expect(runs?.map((run) => run.artifacts?.durable)).toMatchObject([
		{ reopened: false },
		{ reopened: true },
		{ reopened: false },
		{ reopened: true },
	]);
	expect(runs?.[0]?.artifacts?.durable).not.toEqual(runs?.[2]?.artifacts?.durable);
});

test.each(['{ "preference": "neither" }', '{ "score": 1 }', "[]", "not JSON"])(
	"malformed verdict %s throws with judge and order context",
	async (response) => {
		const { directory, open } = await setup([response]);
		const judgeHarness = piDurableJudgeHarness({
			name: "invalid",
			directory,
			open,
			agent: { model },
		});
		await expect(
			expect("candidate").toSatisfyJudge(pairwise(), { baseline: "baseline", judgeHarness }),
		).rejects.toThrow(/Pairwise judge "quality" failed for ab:.*return JSON/);
	},
);

test("malformed second-order verdict identifies ba", async () => {
	const { directory, faux, open } = await setup([
		'{ "preference": "A" }',
		'{ "preference": null }',
	]);
	const judgeHarness = piDurableJudgeHarness({
		name: "invalid-ba",
		directory,
		open,
		agent: { model },
	});
	await expect(
		expect("candidate").toSatisfyJudge(pairwise(), { baseline: "baseline", judgeHarness }),
	).rejects.toThrow(/Pairwise judge "quality" failed for ba:.*return JSON/);
	expect(faux.state.callCount).toBe(2);
});

test("invalid judge JSON names the stored case without echoing the answer", async () => {
	const { directory, open } = await setup(['{ "secret-answer": }']);
	const judge = piDurableJudgeHarness({ name: "unparsable", directory, open, agent: { model } });
	const run = judge.run(
		{ system: "Grade.", prompt: "Answer: 42", responseFormat: { type: "json" } },
		{ artifacts: {}, setArtifact: () => {} },
	);
	await expect(run).rejects.toThrow(`Judge answer is not a JSON object; inspect ${directory}`);
	await expect(run).rejects.not.toThrow("secret-answer");
});

test("pairwise requires a baseline rather than judging against nothing", async () => {
	const { directory, faux, open } = await setup([]);
	const judgeHarness = piDurableJudgeHarness({ name: "grader", directory, open, agent: { model } });
	// A JavaScript caller can omit the baseline that TypeScript requires.
	const untyped: { baseline: string } = JSON.parse("{}");
	await expect(
		expect("candidate").toSatisfyJudge(pairwise(), { ...untyped, judgeHarness }),
	).rejects.toThrow('Pairwise judge "quality" requires a baseline');
	expect(faux.state.callCount).toBe(0);
});

test("pairwise requires a configured judge harness", async () => {
	await expect(
		expect("candidate").toSatisfyJudge(pairwise(), { baseline: "baseline" }),
	).rejects.toThrow('Pairwise judge "quality" requires a judgeHarness');
});

const suiteDirectory = await mkdtemp(join(tmpdir(), "pi-evals-public-suite-"));
afterAll(() => rm(suiteDirectory, { recursive: true, force: true }));
const suiteFaux = fauxProvider();
suiteFaux.setResponses(
	["same", '{"preference":"A"}', '{"preference":"B"}'].map((text) => fauxAssistantMessage(text)),
);
const suiteModels = createModels();
suiteModels.setProvider(suiteFaux.provider);
const suiteOpen = async (directory: string) =>
	Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{
			models: suiteModels,
			registry: createRegistry(),
			settings: { compaction: { enabled: false } },
		},
		BACKGROUND_CONTEXT,
	);
const suiteHarness = piDurableHarness<number, string>({
	name: "suite-app",
	directory: suiteDirectory,
	open: suiteOpen,
	case: (sample) => ({ agent: { model }, prompt: "Question", key: sample }),
	output: (text) => text,
});
const suiteJudgeHarness = piDurableJudgeHarness({
	name: "suite-grader",
	directory: suiteDirectory,
	open: suiteOpen,
	agent: { model },
	key: 0,
});
describeEval(
	"public pairwise object",
	{ harness: suiteHarness, judgeHarness: suiteJudgeHarness },
	(it) => {
		it("reaches the structural Judge through describeEval and reopens both equal-output orders", async ({
			run,
			task,
		}) => {
			const judge = piDurablePairwiseJudge<number, string>({
				name: "suite-quality",
				system: "Compare quality.",
				prompt: ({ a, b }) => JSON.stringify({ A: a, B: b }),
			});
			for (let invocation = 0; invocation < 2; invocation++) {
				const result = await run(0);
				await expect(result).toSatisfyJudge(judge, { baseline: "same" });
			}
			expect(suiteFaux.state.callCount).toBe(3);
			expect(task.meta.eval?.scores.at(-1)).toMatchObject({
				score: 1,
				metadata: { agree: true, verdict: "win" },
			});
			for (const run of task.meta.eval?.scores.at(-1)?.judgeRuns ?? [])
				expect(run.usage.metadata).toMatchObject({ newCostUsd: 0, newTotalTokens: 0 });
		});
	},
);
