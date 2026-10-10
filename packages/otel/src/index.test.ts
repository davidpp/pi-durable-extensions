import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	configure,
	createRegistry,
	defineTool,
	GenerationTask,
	Harness,
	hook,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, test } from "vitest";
import { exportTrace } from "./index.ts";
import type { ExportedTraces, OtlpSpan } from "./index.ts";

const temporary: string[] = [];
afterEach(async () => {
	for (const directory of temporary.splice(0))
		await rm(directory, { recursive: true, force: true });
});
async function directory() {
	const result = await mkdtemp(join(tmpdir(), "pi-durable-otel-"));
	temporary.push(result);
	return result;
}
const hashFile = async (path: string) =>
	createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
const spend: Usage = {
	input: 12,
	output: 8,
	cacheRead: 3,
	cacheWrite: 2,
	reasoning: 4,
	totalTokens: 25,
	cost: { input: 0.012, output: 0.016, cacheRead: 0.003, cacheWrite: 0.004, total: 0.035 },
};
async function runFixture(withTool = false, withFork = false) {
	const path = join(await directory(), "session.sqlite");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let toolExecutions = 0;
	const registry = createRegistry();
	const tool = defineTool({
		name: "delegate",
		description: "Ask a child",
		parameters: Type.Object({ secret: Type.String() }),
		execute: async (_args, api, context) => {
			toolExecutions++;
			const child = await api.commit(async (tx) => {
				const child = await tx.createConversation({
					ownership: { kind: "task", taskId: api.taskId },
				});
				await configure(tx, child.id, { tools: [], instructions: "secret-child-instructions" });
				return child;
			}, context);
			const handle = await api.conversation(child.id, context);
			if (!handle) throw new Error("Child absent");
			const submission = await handle.submit(
				{ type: "input", content: "secret-child-prompt" },
				context,
			);
			expect((await submission.wait(context)).status).toBe("done");
			return { content: [{ type: "text", text: "secret-tool-result" }], usage: spend };
		},
	});
	registry.install({
		name: "delegate-extension",
		tools: [tool],
		// Faux estimates usage itself. Override at the public Durable hook to exercise stored cache/reasoning/cost.
		hooks: [
			hook(GenerationTask, {
				afterResponse: (message) => {
					message.usage = structuredClone(spend);
				},
			}),
		],
	});
	const first = fauxAssistantMessage(
		withTool
			? fauxToolCall("delegate", { secret: "secret-tool-argument" }, { id: "call-one" })
			: "secret-root-answer",
		{ timestamp: 1_000, stopReason: withTool ? "toolUse" : "stop" },
	);
	first.usage = spend;
	faux.setResponses(
		withTool
			? [
					first,
					fauxAssistantMessage("secret-child-answer", { timestamp: 1_020 }),
					fauxAssistantMessage("secret-root-answer", { timestamp: 1_030 }),
				]
			: [first],
	);
	let now = 1_000;
	const harness = await Harness.open(
		await openNodeSqliteStorage(path),
		{ models, registry, now: () => now++, settings: { compaction: { enabled: false } } },
		ctx,
	);
	try {
		const root = await harness.root(ctx, {
			agent: {
				model: { provider: "faux", modelId: "faux-1" },
				instructions: "secret-root-instructions",
				tools: withTool ? [tool] : [],
			},
		});
		const submission = await root.submit({ type: "input", content: "secret-root-prompt" }, ctx);
		const settled = await submission.wait(ctx);
		expect(settled.status).toBe("done");
		if (withFork && settled.type === "input" && settled.status === "done") {
			const fork = await root.fork(settled.answer, { ownership: { kind: "ownerless" } }, ctx);
			faux.appendResponses([fauxAssistantMessage("secret-fork-answer", { timestamp: 1_050 })]);
			await (await fork.submit({ type: "input", content: "secret-fork-prompt" }, ctx)).wait(ctx);
		}
		const ledger = await harness.usage(ctx);
		return { path, ledger, faux, toolExecutions: () => toolExecutions };
	} finally {
		await harness.close(ctx);
	}
}
async function compactionFixture(stopReason: "stop" | "length") {
	const path = join(await directory(), "session.sqlite");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage("secret-pre-compaction-answer", { timestamp: 1_000 }),
		fauxAssistantMessage("secret-compaction-summary", { stopReason, timestamp: 1_020 }),
	]);
	const harness = await Harness.open(
		await openNodeSqliteStorage(path),
		{
			models,
			registry: createRegistry(),
			settings: {
				compaction: {
					enabled: true,
					reserveTokens: 2048,
					keepRecentTokens: 1,
					backgroundTokens: 0,
				},
				retry: { enabled: false },
			},
		},
		ctx,
	);
	try {
		const root = await harness.root(ctx, {
			agent: { model: { provider: "faux", modelId: "faux-1" } },
		});
		expect(
			(
				await (
					await root.submit({ type: "input", content: "secret-compaction-prompt" }, ctx)
				).wait(ctx)
			).status,
		).toBe("done");
		const before = await harness.usage(ctx);
		const taskId = await root.compact(undefined, ctx);
		const task = await harness.waitForTask(taskId, ctx);
		if (
			task.state.outcome.status === "completed" &&
			task.state.outcome.result.submissionId !== undefined
		) {
			const submission = await harness.submission(task.state.outcome.result.submissionId, ctx);
			expect(await submission?.wait(ctx)).toMatchObject({ status: "done", type: "write" });
		}
		const after = await harness.usage(ctx);
		const entries = (await root.entries({}, 100, undefined, ctx)).items;
		return {
			path,
			faux,
			task,
			entries,
			beforeTokens: Object.values(before.models).reduce((sum, u) => sum + u.totalTokens, 0),
			afterTokens: Object.values(after.models).reduce((sum, u) => sum + u.totalTokens, 0),
		};
	} finally {
		await harness.close(ctx);
	}
}
async function exported(path: string, includeContent = false): Promise<ExportedTraces> {
	const result = await exportTrace(path, { storageId: "fixture", includeContent });
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
}
function spans(value: ExportedTraces): OtlpSpan[] {
	return value.traces.flatMap((trace) =>
		trace.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((scope) => scope.spans)),
	);
}
function attr(span: OtlpSpan | undefined, key: string): string | number | boolean | undefined {
	const value = span?.attributes.find((a) => a.key === key)?.value;
	if (!value) return undefined;
	if ("intValue" in value) return Number(value.intValue);
	if ("doubleValue" in value) return value.doubleValue;
	if ("stringValue" in value) return value.stringValue;
	return value.boolValue;
}
function mutate(path: string, sql: string): void {
	const db = new DatabaseSync(path);
	try {
		db.exec(sql);
	} finally {
		db.close();
	}
}

test("exports faux tools and an owned child with recorded parentage, no execution and no storage writes", async () => {
	const fixture = await runFixture(true);
	const before = await hashFile(fixture.path);
	const files = await readdir(join(fixture.path, ".."));
	const value = await exported(fixture.path);
	const all = spans(value);
	expect(value.diagnostics).toEqual([]);
	expect(all.filter((s) => s.name.startsWith("chat "))).toHaveLength(3);
	expect(all.filter((s) => s.name === "execute_tool delegate")).toHaveLength(1);
	const tool = all.find((s) => s.name === "execute_tool delegate");
	const child = all.find(
		(s) => s.name === "invoke_agent" && attr(s, "gen_ai.conversation.id") !== "1",
	);
	expect(child?.parentSpanId).toBe(tool?.spanId);
	const generation = all.find((s) => s.spanId === tool?.parentSpanId);
	expect(generation?.name).toBe("pi.durable.task pi.generation");
	expect(all.find((s) => s.spanId === generation?.parentSpanId)?.name).toBe("invoke_agent");
	expect(
		all
			.filter((s) => s.name.startsWith("chat "))
			.every((s) => s.startTimeUnixNano === s.endTimeUnixNano && s.kind === 3),
	).toBe(true);
	for (const s of all) {
		expect(s.traceId).toMatch(/^[a-f0-9]{32}$/);
		expect(s.spanId).toMatch(/^[a-f0-9]{16}$/);
		expect(BigInt(s.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(s.startTimeUnixNano));
		if (s.parentSpanId) expect(all.some((p) => p.spanId === s.parentSpanId)).toBe(true);
	}
	const cost = all.reduce((sum, s) => sum + Number(attr(s, "pi.durable.cost.usd") ?? 0), 0);
	const tokens = all.reduce(
		(sum, s) => sum + Number(attr(s, "pi.durable.usage.total_tokens") ?? 0),
		0,
	);
	const usage = [...Object.values(fixture.ledger.models), ...Object.values(fixture.ledger.tools)];
	expect(cost).toBeCloseTo(
		usage.reduce((sum, u) => sum + u.cost.total, 0),
		12,
	);
	expect(tokens).toBe(usage.reduce((sum, u) => sum + u.totalTokens, 0));
	expect(JSON.stringify(value)).not.toContain("secret-");
	expect(all.every((s) => s.events.length === 0)).toBe(true);
	expect(await exported(fixture.path)).toEqual(value);
	expect(fixture.faux.state.callCount).toBe(3);
	expect(fixture.toolExecutions()).toBe(1);
	expect(await hashFile(fixture.path)).toBe(before);
	expect(await readdir(join(fixture.path, ".."))).toEqual(files);
});

test("content is explicit; cache input and reasoning map without double counting", async () => {
	const { path } = await runFixture(true);
	const all = spans(await exported(path, true));
	const text = JSON.stringify(all);
	for (const secret of [
		"root-prompt",
		"root-instructions",
		"root-answer",
		"tool-argument",
		"tool-result",
		"child-prompt",
		"child-answer",
	])
		expect(text).toContain(`secret-${secret}`);
	const first = all.find((s) => attr(s, "pi.durable.usage.input_tokens") === 12 && s.kind === 3);
	expect(attr(first, "gen_ai.usage.input_tokens")).toBe(17);
	expect(attr(first, "gen_ai.usage.output_tokens")).toBe(8);
	expect(attr(first, "gen_ai.usage.reasoning.output_tokens")).toBe(4);
	expect(attr(first, "pi.durable.usage.total_tokens")).toBe(25);
	const ids = (list: OtlpSpan[]) => list.map((s) => [s.traceId, s.spanId]);
	expect(ids(all)).toEqual(ids(spans(await exported(path))));
});

test("fork ancestry does not export inherited responses twice; namespaces survive relocation", async () => {
	const { path } = await runFixture(false, true);
	const original = await exported(path);
	expect(spans(original).filter((s) => s.name.startsWith("chat "))).toHaveLength(2);
	expect(original.traces).toHaveLength(1);
	const copy = join(await directory(), "copy #?.sqlite");
	await copyFile(path, copy);
	expect(await exported(copy)).toEqual(original);
	const different = await exportTrace(copy, { storageId: "different" });
	expect(different.ok && spans(different.value)[0]?.traceId).not.toBe(spans(original)[0]?.traceId);
	expect(await exportTrace(path, { storageId: "fixture", conversation: 1 })).toEqual({
		ok: true,
		value: original,
	});
	expect(await exportTrace(path, { storageId: "fixture", conversation: 999 })).toMatchObject({
		ok: false,
		error: { code: "unknown_conversation" },
	});
});

test("rejects missing paths, unsupported schemas, malformed private records and invalid selectors with Results", async () => {
	const dir = await directory();
	const missing = join(dir, "missing.sqlite");
	expect(await exportTrace(missing, { storageId: "fixture" })).toMatchObject({
		ok: false,
		error: { code: "storage_unreadable" },
	});
	expect(await readdir(dir)).toEqual([]);
	const { path } = await runFixture();
	// JSON.parse stands in for a JavaScript caller that omits options entirely.
	for (const options of [
		{ storageId: "" },
		{ storageId: "fixture", conversation: -1 },
		JSON.parse("null"),
	])
		expect(await exportTrace(path, options)).toMatchObject({
			ok: false,
			error: { code: "invalid_options" },
		});
	mutate(path, "UPDATE durable_schema SET version=2");
	expect(await exportTrace(path, { storageId: "fixture" })).toMatchObject({
		ok: false,
		error: { code: "unsupported_schema" },
	});
	mutate(
		path,
		"UPDATE durable_schema SET version=1; UPDATE entries SET record=json_set(record, '$.model[0].usage.input', 'secret-malformed') WHERE json_extract(record, '$.model[0].role')='assistant'",
	);
	const failure = await exportTrace(path, { storageId: "fixture" });
	expect(failure).toMatchObject({ ok: false, error: { code: "invalid_storage" } });
	expect(JSON.stringify(failure)).not.toContain("secret-malformed");
});

test("rejects uncheckpointed WAL without changing database or sidecars", async () => {
	const { path } = await runFixture();
	const db = new DatabaseSync(path);
	try {
		db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE durable_metadata SET next_seq=next_seq+1",
		);
		const before = await Promise.all([path, `${path}-wal`, `${path}-shm`].map(hashFile));
		expect(await exportTrace(path, { storageId: "fixture" })).toMatchObject({
			ok: false,
			error: { code: "uncheckpointed_wal" },
		});
		expect(await Promise.all([path, `${path}-wal`, `${path}-shm`].map(hashFile))).toEqual(before);
	} finally {
		db.close();
	}
});

test("omits genuinely untimed spans and nested calls with diagnostics, never fabricates times", async () => {
	const { path } = await runFixture(true);
	mutate(
		path,
		"UPDATE entries SET record=json_remove(record, '$.model[0].timestamp') WHERE json_extract(record, '$.model[0].role')='assistant'; UPDATE entries SET record=json_set(record, '$.model[0].nestedCalls', json('{\"calls\":[{\"id\":\"nested\",\"name\":\"hidden\",\"durationMs\":10}],\"complete\":true}')) WHERE json_extract(record, '$.model[0].role')='toolResult'",
	);
	const value = await exported(path);
	expect(value.diagnostics.filter((d) => d.code === "missing_timestamp")).toHaveLength(3);
	expect(
		value.diagnostics.filter((d) => d.code === "untimed_span" && d.entity.startsWith("chat:")),
	).toHaveLength(3);
	expect(value.diagnostics.find((d) => d.code === "nested_tool_calls_omitted")?.count).toBe(1);
	expect(spans(value).some((s) => s.name.startsWith("chat "))).toBe(false);
	expect(spans(value).every((s) => s.startTimeUnixNano && s.endTimeUnixNano)).toBe(true);
	mutate(path, "UPDATE entries SET record=json_remove(record, '$.model[0].timestamp')");
	const empty = await exported(path);
	expect(empty.traces).toEqual([]);
	expect(
		empty.diagnostics.some((d) => d.entity === "conversation:1" && d.code === "untimed_span"),
	).toBe(true);
});

test("generic child tasks preserve parentage, while untimed leaf tasks are diagnosed", async () => {
	const { path, faux } = await runFixture();
	mutate(
		path,
		`
		INSERT INTO tasks (id,conversation_id,kind,status,abort_requested,background,record)
		SELECT 999,1,'"fixture-child"','terminal',0,0,
		json_object('id',999,'conversationId',1,'kind','fixture-child','owner',id,
		'state',json_object('status','terminal','outcome',json_object('status','completed')))
		FROM tasks LIMIT 1;
		UPDATE entries SET record=json_set(record,'$.byTaskId',999)
		WHERE json_extract(record,'$.model[0].role')='assistant';
		INSERT INTO tasks (id,conversation_id,kind,status,abort_requested,background,record)
		VALUES (1000,1,'"untimed"','pending',0,0,
		'{"id":1000,"conversationId":1,"kind":"untimed","owner":999,"state":{"status":"pending"}}');
	`,
	);
	const value = await exported(path);
	const all = spans(value);
	const child = all.find((s) => s.name === "pi.durable.task fixture-child");
	expect(all.find((s) => s.name.startsWith("chat "))?.parentSpanId).toBe(child?.spanId);
	expect(all.find((s) => s.spanId === child?.parentSpanId)?.name).toBe(
		"pi.durable.task pi.generation",
	);
	expect(value.diagnostics).toContainEqual({ code: "untimed_span", entity: "task:1000" });
	expect(faux.state.callCount).toBe(1);
});

test("independent roots export separate traces; selectors include only the requested root", async () => {
	const { path } = await runFixture();
	mutate(
		path,
		`
		INSERT INTO conversations (id,record) VALUES (999,'{"id":999}');
		INSERT INTO entries (id,conversation_id,commit_seq,record) VALUES
		(1000,999,1,'{"id":1000,"conversationId":999,"model":[{"role":"user","content":"secret-other","timestamp":2000}]}'),
		(1001,999,2,'{"id":1001,"conversationId":999,"model":[{"role":"user","content":"secret-untimed"}]}');
	`,
	);
	const value = await exported(path);
	expect(value.traces).toHaveLength(2);
	const untimed = { code: "missing_timestamp", entity: "entry:1001:message:0" };
	expect(value.diagnostics).toContainEqual(untimed);
	const selected = await exportTrace(path, { storageId: "fixture", conversation: 999 });
	if (!selected.ok) throw new Error(selected.error.message);
	expect(selected.value.traces).toHaveLength(1);
	expect(spans(selected.value)).toHaveLength(1);
	expect(attr(spans(selected.value)[0], "gen_ai.conversation.id")).toBe("999");
	expect(selected.value.diagnostics).toContainEqual(untimed);
	const other = await exportTrace(path, { storageId: "fixture", conversation: 1 });
	if (!other.ok) throw new Error(other.error.message);
	expect(other.value.diagnostics).not.toContainEqual(untimed);
});

test.each<{ stopReason: "stop" | "length"; expectedOutcome: "completed" | "failed" }>([
	{ stopReason: "stop", expectedOutcome: "completed" },
	{ stopReason: "length", expectedOutcome: "failed" },
])(
	"diagnoses unavailable compaction spend for $expectedOutcome summarization",
	async ({ stopReason, expectedOutcome }) => {
		const fixture = await compactionFixture(stopReason);
		expect(fixture.task).toMatchObject({
			kind: "pi.compaction",
			input: { reason: "manual" },
			state: { outcome: { status: expectedOutcome } },
		});
		expect(fixture.faux.state.callCount).toBe(2);
		expect(fixture.afterTokens).toBeGreaterThan(fixture.beforeTokens);
		const summary = fixture.entries.find((entry) => entry.kind === "pi.compaction");
		if (expectedOutcome === "completed") {
			expect(summary?.model?.map((message) => message.role)).toEqual(["user"]);
			expect(summary?.data).toEqual({ reason: "manual" });
			expect(fixture.task.state.outcome).toMatchObject({
				result: { submissionId: expect.any(Number) },
			});
		} else {
			expect(summary).toBeUndefined();
			expect(fixture.task.state.outcome).toMatchObject({
				error: { detail: { reason: "model_error" } },
			});
		}
		const beforeHash = await hashFile(fixture.path);
		const value = await exported(fixture.path);
		expect(value.diagnostics).toContainEqual({
			code: "compaction_usage_unavailable",
			entity: `task:${fixture.task.id}`,
		});
		const exportedTokens = spans(value).reduce(
			(sum, s) => sum + Number(attr(s, "pi.durable.usage.total_tokens") ?? 0),
			0,
		);
		expect(exportedTokens).toBe(fixture.beforeTokens);
		expect(exportedTokens).toBeLessThan(fixture.afterTokens);
		// Faux records zero costs. The missing summarizer tokens do not justify inventing a dollar amount.
		expect(
			spans(value).reduce((sum, s) => sum + Number(attr(s, "pi.durable.cost.usd") ?? 0), 0),
		).toBe(0);
		expect(spans(value).filter((s) => s.name.startsWith("chat "))).toHaveLength(1);
		expect(JSON.stringify(value)).not.toContain("secret-");
		expect(await hashFile(fixture.path)).toBe(beforeHash);
		expect(fixture.faux.state.callCount).toBe(2);
	},
);

test("compaction coverage warnings are conservative even for a no-op task with no spend", async () => {
	const path = join(await directory(), "session.sqlite");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(
		await openNodeSqliteStorage(path),
		{ models, registry: createRegistry(), settings: { compaction: { enabled: true } } },
		ctx,
	);
	let taskId = 0;
	try {
		const root = await harness.root(ctx, {
			agent: { model: { provider: "faux", modelId: "faux-1" } },
		});
		const id = await root.compact(undefined, ctx);
		taskId = id;
		expect((await harness.waitForTask(id, ctx)).state.outcome).toMatchObject({
			status: "completed",
			result: {},
		});
		await harness.waitForIdle(ctx);
		expect(faux.state.callCount).toBe(0);
	} finally {
		await harness.close(ctx);
	}
	const value = await exported(path);
	expect(value.diagnostics).toContainEqual({
		code: "compaction_usage_unavailable",
		entity: `task:${taskId}`,
	});
	expect(value.traces).toEqual([]);
});

test("ancestry corruption returns failures, not dangling parents or infinite recursion", async () => {
	const { path } = await runFixture();
	mutate(path, "UPDATE tasks SET record=json_set(record, '$.owner', id)");
	expect(await exportTrace(path, { storageId: "fixture" })).toMatchObject({
		ok: false,
		error: { code: "invalid_storage" },
	});
});

test("CLI stdout is OTLP only, diagnostics go to stderr; private files are exclusive writes", async () => {
	const { path } = await runFixture();
	// Build the actual shipped CLI, rather than relying on a TS loader unavailable to package consumers.
	execFileSync("bun", ["run", "--cwd", join(import.meta.dirname, ".."), "build"]);
	const cli = join(import.meta.dirname, "../dist/cli.js");
	const before = await hashFile(path);
	const invocation = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
	expect(invocation.status).toBe(0);
	expect(JSON.parse(invocation.stdout)).toHaveProperty("resourceSpans");
	expect(invocation.stdout).not.toContain("secret-");
	const out = join(await directory(), "out");
	expect(spawnSync(process.execPath, [cli, path, "--out", out]).status).toBe(0);
	expect(await readdir(out)).toHaveLength(1);
	expect(spawnSync(process.execPath, [cli, path, "--out", out]).status).toBe(1);
	expect(await hashFile(path)).toBe(before);
	// A later collision refuses the whole export instead of leaving the earlier traces written.
	const copy = join(await directory(), "copy.sqlite");
	await copyFile(path, copy);
	const partial = join(await directory(), "partial");
	expect(spawnSync(process.execPath, [cli, copy, "--out", partial]).status).toBe(0);
	const existing = await readdir(partial);
	expect(spawnSync(process.execPath, [cli, path, copy, "--out", partial]).status).toBe(1);
	expect(await readdir(partial)).toEqual(existing);
	mutate(
		path,
		"UPDATE entries SET record=json_remove(record, '$.model[0].timestamp') WHERE json_extract(record, '$.model[0].role')='assistant'",
	);
	const limited = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
	expect(limited.status).toBe(0);
	expect(JSON.parse(limited.stdout)).toHaveProperty("resourceSpans");
	expect(limited.stderr).toContain("missing_timestamp");
	expect(limited.stderr).not.toContain("secret-");
	expect(spawnSync(process.execPath, [cli, path, path, "--storage-id", "one"]).status).toBe(1);
});

test("table identity mismatches and timestamps outside OTLP range return private failures", async () => {
	const { path } = await runFixture();
	mutate(
		path,
		"UPDATE entries SET record=json_set(record,'$.model[0].timestamp',9007199254740991)",
	);
	expect(await exportTrace(path, { storageId: "fixture" })).toMatchObject({
		ok: false,
		error: { code: "invalid_storage" },
	});
	mutate(path, "UPDATE entries SET record=json_set(record,'$.model[0].timestamp',1000,'$.id',999)");
	expect(await exportTrace(path, { storageId: "fixture" })).toMatchObject({
		ok: false,
		error: { code: "invalid_storage" },
	});
});

test("invalid fork cutoffs are rejected even when ownership is the chosen span ancestry", async () => {
	const { path } = await runFixture(true);
	mutate(
		path,
		"UPDATE conversations SET record=json_set(record,'$.parent',json('{\"conversationId\":1,\"at\":99999}')) WHERE id<>1",
	);
	expect(await exportTrace(path, { storageId: "fixture" })).toMatchObject({
		ok: false,
		error: { code: "invalid_storage" },
	});
});

test("a nonempty orphan WAL is also rejected (immutable SQLite must not silently ignore it)", async () => {
	const { path } = await runFixture();
	await writeFile(`${path}-wal`, "nonempty");
	expect(await exportTrace(path, { storageId: "fixture" })).toMatchObject({
		ok: false,
		error: { code: "uncheckpointed_wal" },
	});
});

test("the instrumentation scope version is the package version", async () => {
	const { path } = await runFixture();
	const manifest: { version: string } = JSON.parse(
		await readFile(join(import.meta.dirname, "../package.json"), "utf8"),
	);
	const [trace] = (await exported(path)).traces;
	expect(trace?.resourceSpans[0]?.scopeSpans[0]?.scope.version).toBe(manifest.version);
});
