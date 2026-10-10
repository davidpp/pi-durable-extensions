import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { PromptSection } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, onTestFinished, test } from "vitest";
import { scoreTraces } from "./index.ts";
import type { ScoringOptions } from "./index.ts";
import { digest, json, record } from "./scoring-data.ts";
import type { JsonRecord } from "./scoring-data.ts";

const traceId = (n: number) => n.toString(16).padStart(32, "0");
const spanId = (n: number) => n.toString(16).padStart(16, "0");
function trace(n: number, time = "100", extra: JsonRecord = {}): JsonRecord {
	return {
		resourceSpans: [
			{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "pi-durable" } }] },
				scopeSpans: [
					{
						scope: { name: "pi-durable-otel", version: "0.1.0" },
						spans: [
							{
								traceId: traceId(n),
								spanId: spanId(n),
								name: "invoke_agent",
								kind: 1,
								startTimeUnixNano: time,
								endTimeUnixNano: time,
								attributes: [],
								events: [],
								status: { code: 0 },
								...extra,
							},
						],
					},
				],
			},
		],
	};
}
async function setup(
	responses: (string | FauxResponseFactory)[] = Array.from(
		{ length: 20 },
		() => '{"score":0.2,"rationale":"Observed artifacts."}',
	),
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-evals-score-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const production = join(directory, "production.json");
	const anchor = join(directory, "anchor.json");
	await writeFile(production, JSON.stringify(trace(1)));
	await writeFile(anchor, JSON.stringify(trace(2)));
	const faux = fauxProvider();
	faux.setResponses(
		responses.map((response) =>
			typeof response === "string" ? fauxAssistantMessage(response) : response,
		),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const options: ScoringOptions = {
		files: [production],
		anchors: [anchor],
		checkpoint: join(directory, "checkpoint.json"),
		intervalId: "first",
		outDirectory: join(directory, "out"),
		judgeDirectory: join(directory, "judges"),
		candidateBelow: 0.3,
		open: async (caseDirectory) =>
			Harness.open(
				await openNodeSqliteStorage(join(caseDirectory, "session.sqlite")),
				{ models, registry: createRegistry(), settings: { compaction: { enabled: false } } },
				BACKGROUND_CONTEXT,
			),
		judges: [
			{
				name: "quality",
				agent: { model: { provider: "faux", modelId: "faux-1" } },
				system: "Grade only the run's own artifacts.",
				prompt: (input) => JSON.stringify(input.data),
				configKey: "registry-v1",
			},
		],
	};
	return { directory, production, anchor, faux, models, options };
}
async function success(options: ScoringOptions) {
	const result = await scoreTraces(options);
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}
async function objectFile(path: string): Promise<JsonRecord> {
	const value = json(await readFile(path, "utf8"));
	if (!record(value)) throw new Error("Expected object file");
	return value;
}
async function rows(path: string): Promise<JsonRecord[]> {
	const text = (await readFile(path, "utf8")).trim();
	return text
		? text.split("\n").map((line) => {
				const value = json(line);
				if (!record(value)) throw new Error("Expected JSONL object");
				return value;
			})
		: [];
}

test("scores, annotates and produces only owner-pending candidates without modifying inputs", async () => {
	const { options, production, anchor, faux } = await setup(['{"score":0.2}', '{"score":0.8}']);
	const inputBytes = await Promise.all([readFile(production), readFile(anchor)]);
	const result = await success(options);
	expect(result).toMatchObject({
		productionCount: 1,
		anchorCount: 1,
		replayed: false,
		newCostUsd: 0,
	});
	expect(result.newTotalTokens).toBeGreaterThan(0);
	expect(result.summaries).toMatchObject([
		{ kind: "production", n: 1, mean: 0.2, interval95: [0, 1], smallN: true, method: "hoeffding" },
		{ kind: "anchor", n: 1, mean: 0.8, interval95: [0, 1] },
	]);
	const scored = await rows(join(result.directory, "scores.jsonl"));
	expect(scored).toHaveLength(2);
	expect(scored[0]).toMatchObject({
		traceId: traceId(1),
		kind: "production",
		candidate: true,
		model: { provider: "faux", modelId: "faux-1" },
	});
	for (const entry of scored) {
		expect(entry.modelHash).toMatch(/^[a-f0-9]{64}$/);
		expect(entry.configHash).toMatch(/^[a-f0-9]{64}$/);
		expect(entry.promptHash).toMatch(/^[a-f0-9]{64}$/);
	}
	expect(await rows(join(result.directory, "candidates.jsonl"))).toEqual([
		{
			scoreId: scored[0]?.id,
			judge: "quality",
			traceId: traceId(1),
			traceHash: scored[0]?.traceHash,
			status: "pending_owner_approval",
			traceFile: `trace-${traceId(1)}.json`,
		},
	]);
	const annotated = await readFile(join(result.directory, `trace-${traceId(1)}.json`), "utf8");
	expect(annotated).toContain('"pi.evals.quality.score"');
	expect(annotated).toContain('"doubleValue":0.2');
	expect(annotated).toContain('"trace_snapshot"');
	expect(await Promise.all([readFile(production), readFile(anchor)])).toEqual(inputBytes);
	expect((await readdir(result.directory)).sort()).toEqual(
		[
			"candidates.jsonl",
			"checkpoint.json",
			"commit.json",
			"plan.json",
			"scores.jsonl",
			"summary.json",
			`trace-${traceId(1)}.json`,
			`trace-${traceId(2)}.json`,
		].sort(),
	);
	expect(faux.state.callCount).toBe(2);
});

test("same interval replays with zero calls; new empty production interval freshly judges anchors", async () => {
	const { options, faux } = await setup();
	await success(options);
	const again = await success(options);
	expect(again).toMatchObject({ replayed: true, newCostUsd: 0, newTotalTokens: 0 });
	expect(faux.state.callCount).toBe(2);
	const next = await success({ ...options, intervalId: "second" });
	expect(next).toMatchObject({ productionCount: 0, anchorCount: 1, replayed: false });
	expect(next.newTotalTokens).toBeGreaterThan(0);
	expect(next.summaries[0]).toMatchObject({ n: 0, mean: null, interval95: null });
	expect(faux.state.callCount).toBe(3);
	await success({ ...options, intervalId: "third", files: [] });
	expect(faux.state.callCount).toBe(4);
	// A replay of an older completed interval must not roll a newer checkpoint backwards.
	const checkpoint = await readFile(options.checkpoint);
	await success(options);
	expect(await readFile(options.checkpoint)).toEqual(checkpoint);
	expect(faux.state.callCount).toBe(4);
});

test("late arrivals and changed snapshots are scored despite earlier event times", async () => {
	const { options, directory, production, faux } = await setup();
	await success(options);
	const late = join(directory, "late.json");
	await writeFile(late, JSON.stringify(trace(3, "5")));
	const second = await success({ ...options, files: [production, late], intervalId: "late" });
	expect(second.productionCount).toBe(1);
	await writeFile(production, JSON.stringify(trace(1, "10", { name: "Changed snapshot" })));
	const third = await success({ ...options, files: [production, late], intervalId: "revision" });
	expect(third.productionCount).toBe(1);
	expect(await objectFile(options.checkpoint)).toMatchObject({ maxObservedTimeUnixNano: "100" });
	expect((await objectFile(options.checkpoint)).seen).toHaveLength(3);
	expect(faux.state.callCount).toBe(6);
});

test.each(["threshold", "config", "agent", "prompt", "inputs"])(
	"same interval rejects changed %s plan",
	async (change) => {
		const { options, faux } = await setup();
		await success(options);
		const judge = options.judges[0];
		if (!judge) throw new Error("Missing fixture judge");
		const changed = { ...options };
		if (change === "threshold") changed.candidateBelow = 0.5;
		if (change === "config") changed.judges = [{ ...judge, configKey: "registry-v2" }];
		if (change === "agent")
			changed.judges = [{ ...judge, agent: { ...judge.agent, thinkingLevel: "high" } }];
		if (change === "prompt")
			changed.judges = [{ ...judge, prompt: () => "Different grading prompt" }];
		if (change === "inputs") changed.files = [];
		expect(await scoreTraces(changed)).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(faux.state.callCount).toBe(2);
	},
);

test("new judge behavior identity re-scores production instead of treating it as seen", async () => {
	const { options, faux } = await setup();
	await success(options);
	const judge = options.judges[0];
	if (!judge) throw new Error("Missing fixture judge");
	const changed = await success({
		...options,
		intervalId: "new-model-config",
		judges: [
			{ ...judge, configKey: "registry-v2", agent: { ...judge.agent, thinkingLevel: "high" } },
		],
	});
	expect(changed.productionCount).toBe(1);
	expect(faux.state.callCount).toBe(4);
});

test("changed anchors conflict; missing anchors and production overlap fail before calls", async () => {
	const { options, anchor, faux } = await setup();
	expect(await scoreTraces({ ...options, anchors: [] })).toMatchObject({
		ok: false,
		error: { code: "invalid_options" },
	});
	expect(await scoreTraces({ ...options, files: [anchor] })).toMatchObject({
		ok: false,
		error: { code: "invalid_options" },
	});
	expect(faux.state.callCount).toBe(0);
	await success(options);
	await writeFile(anchor, JSON.stringify(trace(2, "101")));
	expect(await scoreTraces({ ...options, intervalId: "changed-anchor" })).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	expect(faux.state.callCount).toBe(2);
});

test.each([
	"not JSON",
	"null",
	'{"version":999}',
	'{"version":1,"seen":[],"anchors":[],"maxObservedTimeUnixNano":"0"}',
])("malformed existing checkpoint %s never resets", async (text) => {
	const { options, faux } = await setup();
	await writeFile(options.checkpoint, text);
	expect(await scoreTraces(options)).toMatchObject({
		ok: false,
		error: { code: "invalid_checkpoint" },
	});
	expect(await readFile(options.checkpoint, "utf8")).toBe(text);
	expect(faux.state.callCount).toBe(0);
});

test("failed judge does not advance an existing checkpoint; retry reopens successful calls", async () => {
	const { options, directory, faux } = await setup([
		'{"score":0.2}',
		'{"score":0.8}',
		'{"score":0.4}',
		'{"score":2}',
	]);
	await success(options);
	const before = await readFile(options.checkpoint);
	const added = join(directory, "new.json");
	await writeFile(added, JSON.stringify(trace(3)));
	const failing = { ...options, files: [added], intervalId: "failing" };
	expect(await scoreTraces(failing)).toMatchObject({
		ok: false,
		error: {
			code: "judge_failed",
			message: expect.stringContaining(
				`verdict lacks a finite score in [0,1]; inspect ${options.judgeDirectory}`,
			),
		},
	});
	expect(await readFile(options.checkpoint)).toEqual(before);
	expect(faux.state.callCount).toBe(4);
	// The malformed completed verdict is immutable: retry reports the same failure with no new calls/spend.
	expect(await scoreTraces(failing)).toMatchObject({ ok: false, error: { code: "judge_failed" } });
	expect(faux.state.callCount).toBe(4);
});

test("interrupted judge opening can retry and reuse the already completed production grading", async () => {
	const { options, faux } = await setup();
	const originalOpen = options.open;
	let opens = 0;
	const failing = {
		...options,
		open: async (path: string) => {
			opens++;
			if (opens === 2) throw new Error("Temporary storage unavailable");
			return originalOpen(path);
		},
	};
	expect(await scoreTraces(failing)).toMatchObject({ ok: false, error: { code: "judge_failed" } });
	expect(faux.state.callCount).toBe(1);
	const retry = await success(options);
	expect(retry.newCostUsd).toBe(0);
	expect(faux.state.callCount).toBe(2);
	const scored = await rows(join(retry.directory, "scores.jsonl"));
	expect(scored[0]?.usage).toMatchObject({ metadata: { newCostUsd: 0, newTotalTokens: 0 } });
});

test("failed artifact write leaves checkpoint untouched and retry uses zero new judge calls", async () => {
	const { options, faux } = await setup();
	const originalOpen = options.open;
	let opened = 0;
	const failing = {
		...options,
		open: async (path: string) => {
			if (++opened === 2)
				await mkdir(join(options.outDirectory, options.intervalId, "scores.jsonl"));
			return originalOpen(path);
		},
	};
	expect(await scoreTraces(failing)).toMatchObject({ ok: false, error: { code: "io_error" } });
	await expect(readFile(options.checkpoint)).rejects.toMatchObject({ code: "ENOENT" });
	expect(faux.state.callCount).toBe(2);
	await rm(join(options.outDirectory, options.intervalId, "scores.jsonl"), { recursive: true });
	const retry = await success(options);
	expect(retry).toMatchObject({ replayed: false, newCostUsd: 0, newTotalTokens: 0 });
	expect(faux.state.callCount).toBe(2);
});

test("commit/checkpoint crash gap repairs from validated bundle with zero new calls", async () => {
	const { options, faux } = await setup();
	const originalOpen = options.open;
	let opened = 0;
	const failing = {
		...options,
		open: async (path: string) => {
			if (++opened === 2) await mkdir(options.checkpoint);
			return originalOpen(path);
		},
	};
	expect(await scoreTraces(failing)).toMatchObject({
		ok: false,
		error: { code: "invalid_checkpoint" },
	});
	await expect(
		readFile(join(options.outDirectory, options.intervalId, "commit.json")),
	).resolves.toBeDefined();
	await rm(options.checkpoint, { recursive: true });
	const retry = await success(options);
	expect(retry).toMatchObject({ replayed: true, newCostUsd: 0, newTotalTokens: 0 });
	expect((await objectFile(options.checkpoint)).seen).toHaveLength(1);
	expect(faux.state.callCount).toBe(2);
});

test.each(["checksum", "traversal", "semantic"])(
	"corrupted committed bundle %s cannot advance checkpoint",
	async (damage) => {
		const { options, faux } = await setup();
		const result = await success(options);
		await rm(options.checkpoint);
		const manifestPath = join(result.directory, "commit.json");
		const manifest = await objectFile(manifestPath);
		if (!record(manifest.files)) throw new Error("Missing fixture checksums");
		if (damage === "traversal") manifest.files["../../unrelated"] = "0".repeat(64);
		else {
			const scoresPath = join(result.directory, "scores.jsonl");
			const scored = await rows(scoresPath);
			if (!scored[0]) throw new Error("Missing fixture row");
			scored[0].score = 0.9;
			const text = scored.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
			await writeFile(scoresPath, text);
			if (damage === "semantic") manifest.files["scores.jsonl"] = digest(text);
		}
		await writeFile(manifestPath, JSON.stringify(manifest));
		expect(await scoreTraces(options)).toMatchObject({ ok: false, error: { code: "conflict" } });
		await expect(readFile(options.checkpoint)).rejects.toMatchObject({ code: "ENOENT" });
		expect(faux.state.callCount).toBe(2);
	},
);

test.each(["../escape", "A", "quality.name", "", "quality/evil"])(
	"unsafe judge name %s fails before effects",
	async (name) => {
		const { options, faux } = await setup();
		const judge = options.judges[0];
		if (!judge) throw new Error("Missing fixture judge");
		expect(await scoreTraces({ ...options, judges: [{ ...judge, name }] })).toMatchObject({
			ok: false,
			error: { code: "invalid_options" },
		});
		expect(faux.state.callCount).toBe(0);
	},
);

test("invalid model, threshold, interval path and duplicate names are rejected", async () => {
	const { options, faux } = await setup();
	const judge = options.judges[0];
	if (!judge) throw new Error("Missing fixture judge");
	for (const changed of [
		{ ...options, intervalId: "../escape" },
		{ ...options, candidateBelow: Number.NaN },
		{ ...options, candidateBelow: 1.1 },
		{ ...options, judges: [judge, judge] },
		{ ...options, judges: [{ ...judge, agent: { model: { provider: "", modelId: "faux-1" } } }] },
		{ ...options, checkpoint: options.files[0] ?? "" },
		// A later interval would find this directory without a plan and refuse it.
		{ ...options, checkpoint: join(options.outDirectory, "later", "checkpoint.json") },
	])
		expect(await scoreTraces(changed)).toMatchObject({
			ok: false,
			error: { code: "invalid_options" },
		});
	expect(faux.state.callCount).toBe(0);
});

test("larger windows use the stated bounded interval and threshold is strictly below", async () => {
	const { options, production, faux } = await setup();
	const spans = Array.from({ length: 16 }, (_, index) => ({
		traceId: traceId(index + 3),
		spanId: spanId(index + 3),
		endTimeUnixNano: "100",
	}));
	await writeFile(production, JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }));
	const result = await success({ ...options, candidateBelow: 0.2 });
	const summary = result.summaries[0];
	expect(summary?.n).toBe(16);
	expect(summary?.smallN).toBe(false);
	expect(summary?.mean).toBeCloseTo(0.2);
	const epsilon = Math.sqrt(Math.log(40) / 32);
	expect(summary?.interval95?.[0]).toBe(0);
	expect(summary?.interval95?.[1]).toBeCloseTo(0.2 + epsilon);
	expect(await rows(join(result.directory, "candidates.jsonl"))).toEqual([]);
	expect(faux.state.callCount).toBe(17);
});

test("function-valued agent behavior requires a host config key rather than hashing function source", async () => {
	const { options, faux, models } = await setup();
	const judge = options.judges[0];
	if (!judge) throw new Error("Missing fixture judge");
	const extension = {
		name: "custom",
		wraps: [{ section: "unused", wrap: (section: PromptSection) => section }],
	};
	const agent = { ...judge.agent, extensions: [extension] };
	const registry = createRegistry();
	registry.install(extension);
	const open = async (directory: string) =>
		Harness.open(
			await openNodeSqliteStorage(join(directory, "session.sqlite")),
			{ models, registry, settings: { compaction: { enabled: false } } },
			BACKGROUND_CONTEXT,
		);
	const configured = { ...options, open, judges: [{ ...judge, agent, configKey: undefined }] };
	expect(await scoreTraces(configured)).toMatchObject({
		ok: false,
		error: { code: "invalid_options" },
	});
	expect(faux.state.callCount).toBe(0);
	await success({ ...options, open, judges: [{ ...judge, agent, configKey: "behavior-v1" }] });
	expect(faux.state.callCount).toBe(2);
});

test("unrelated existing interval directory is never overwritten", async () => {
	const { options, faux } = await setup();
	const directory = join(options.outDirectory, options.intervalId);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "unrelated.txt"), "Keep me");
	expect(await scoreTraces(options)).toMatchObject({ ok: false, error: { code: "conflict" } });
	expect(await readFile(join(directory, "unrelated.txt"), "utf8")).toBe("Keep me");
	expect(faux.state.callCount).toBe(0);
});

test("a verdict from a model other than the configured one fails and names its stored case", async () => {
	const { options } = await setup();
	// A host provider that resolves its own reference but streams through another provider's model.
	const core = createFauxCore({});
	core.setResponses(Array.from({ length: 2 }, () => fauxAssistantMessage('{"score":0.9}')));
	const [answering] = core.models;
	const models = createModels();
	models.setProvider(
		createProvider({
			id: "aliased",
			auth: { apiKey: { name: "Aliased", resolve: async () => ({ auth: {} }) } },
			models: [{ ...answering, provider: "aliased", id: "alias" }],
			api: { stream: core.stream, streamSimple: core.streamSimple },
		}),
	);
	const judge = options.judges[0];
	if (!judge) throw new Error("Missing fixture judge");
	const result = await scoreTraces({
		...options,
		open: async (directory) =>
			Harness.open(
				await openNodeSqliteStorage(join(directory, "session.sqlite")),
				{ models, registry: createRegistry(), settings: { compaction: { enabled: false } } },
				BACKGROUND_CONTEXT,
			),
		judges: [{ ...judge, agent: { model: { provider: "aliased", modelId: "alias" } } }],
	});
	expect(result).toMatchObject({
		ok: false,
		error: {
			code: "judge_failed",
			message: expect.stringContaining(
				`answered by faux/alias, not the configured model; inspect ${options.judgeDirectory}`,
			),
		},
	});
	expect(core.state.callCount).toBe(1);
	expect(await readFile(options.checkpoint).catch(() => undefined)).toBeUndefined();
});
