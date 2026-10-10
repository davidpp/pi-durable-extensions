import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentChange } from "@earendil-works/pi-durable";
import type { JsonValue } from "vitest-evals/harness";
import { DurableCaseError, piDurableJudgeHarness } from "./durable.ts";
import type { OpenDurable } from "./durable.ts";
import {
	annotate,
	canonical,
	hasFunctions,
	hash,
	json,
	loadTraces,
	record,
	safeName,
	ScoreFailure,
	snapshot,
} from "./scoring-data.ts";
import type { JsonRecord, ScoringTrace } from "./scoring-data.ts";
import {
	advanceCheckpoint,
	checkpointHash,
	createPlan,
	loadBundle,
	parseCheckpoint,
	readCheckpoint,
	readPlan,
	saveBundle,
} from "./scoring-store.ts";
import type { AnchorStamp, Checkpoint } from "./scoring-store.ts";

export type { ScoringTrace } from "./scoring-data.ts";
export type TraceJudge = {
	name: string;
	agent: Omit<AgentChange, "instructions" | "model"> & {
		model: { provider: string; modelId: string };
	};
	system: string;
	/** Reference-free prompt built from this snapshot's own artifacts. Called before any model calls. */
	prompt: (trace: ScoringTrace) => string;
	/** Host-controlled identity for behavioral dependencies not visible in JSON (functions, registry, opener). */
	configKey?: JsonValue;
};
export type ScoringConfig = {
	anchors: string[];
	judges: TraceJudge[];
	open: OpenDurable;
	judgeDirectory: string;
	candidateBelow: number;
};
export type ScoringOptions = ScoringConfig & {
	files: string[];
	/** Snapshot ledger path, not a timestamp cutoff. A missing file initializes; an invalid file never resets. */
	checkpoint: string;
	/** Stable retry identity. Every new interval must use a fresh ID to re-score anchors. */
	intervalId: string;
	outDirectory: string;
};
export type WindowSummary = {
	judge: string;
	kind: "production" | "anchor";
	n: number;
	mean: number | null;
	interval95: [number, number] | null;
	method: "hoeffding";
	confidence: 0.95;
	smallN: boolean;
};
export type ScoreResult =
	| {
			ok: true;
			value: {
				directory: string;
				productionCount: number;
				anchorCount: number;
				summaries: WindowSummary[];
				replayed: boolean;
				newCostUsd: number | null;
				newTotalTokens: number | null;
			};
	  }
	| { ok: false; error: { code: ScoreFailure["code"]; message: string } };
type JudgeIdentity = {
	name: string;
	agent: JsonValue;
	configKey: JsonValue;
	modelHash: string;
	configHash: string;
	system: string;
};
type Job = {
	kind: "production" | "anchor";
	trace: ScoringTrace;
	judge: TraceJudge;
	identity: JudgeIdentity;
	prompt: string;
	promptHash: string;
	key: string;
	id: string;
};
type ScoreRow = {
	id: string;
	interval: string;
	kind: "production" | "anchor";
	traceId: string;
	traceHash: string;
	judge: string;
	model: JsonValue;
	modelHash: string;
	configHash: string;
	promptHash: string;
	score: number;
	rationale: string | null;
	candidate: boolean;
	usage: JsonValue;
};
function invalid(message: string): never {
	throw new ScoreFailure("invalid_options", message);
}
function paths(value: unknown, label: string, mandatory: boolean): string[] {
	if (
		!Array.isArray(value) ||
		!value.every(
			(entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
		) ||
		(mandatory && value.length === 0)
	)
		invalid(`${label} must be ${mandatory ? "nonempty " : ""}file paths`);
	const result = value.map((path) => resolve(path));
	if (new Set(result).size !== result.length) invalid(`${label} contains duplicate paths`);
	return result.sort();
}
function validModel(value: unknown): boolean {
	return (
		record(value) &&
		typeof value.provider === "string" &&
		value.provider.trim().length > 0 &&
		typeof value.modelId === "string" &&
		value.modelId.trim().length > 0
	);
}
function validate(options: ScoringOptions): {
	inputs: string[];
	anchors: string[];
	directory: string;
	checkpoint: string;
	identities: JudgeIdentity[];
} {
	if (!options || typeof options !== "object") invalid("Scoring options are required");
	if (
		typeof options.intervalId !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(options.intervalId)
	)
		invalid(
			"intervalId must be 1-96 letters, digits, underscores or hyphens, starting with a letter or digit",
		);
	for (const path of [options.checkpoint, options.outDirectory, options.judgeDirectory])
		if (typeof path !== "string" || path.trim().length === 0)
			invalid("Checkpoint, output and judge storage paths are required");
	if (typeof options.open !== "function") invalid("A Durable opener is required");
	if (
		!Number.isFinite(options.candidateBelow) ||
		options.candidateBelow < 0 ||
		options.candidateBelow > 1
	)
		invalid("candidateBelow must be finite and in [0,1]");
	const inputs = paths(options.files, "Production inputs", false);
	const anchors = paths(options.anchors, "Frozen anchors", true);
	const checkpoint = resolve(options.checkpoint);
	const outDirectory = resolve(options.outDirectory);
	const directory = join(outDirectory, options.intervalId);
	// Any path under the output root is some interval's directory, current or future.
	const offset = relative(outDirectory, checkpoint);
	if (
		offset === "" ||
		(!offset.startsWith("..") && !isAbsolute(offset)) ||
		[...inputs, ...anchors].includes(checkpoint)
	)
		invalid("Checkpoint must be outside the output directory and separate from input files");
	if (!Array.isArray(options.judges) || options.judges.length === 0)
		invalid("At least one judge is required");
	const names = new Set<string>();
	const identities = options.judges.map((judge) => {
		if (!judge || typeof judge !== "object" || !safeName(judge.name) || names.has(judge.name))
			invalid("Judge names must be unique and match [a-z][a-z0-9_-]{0,63}");
		names.add(judge.name);
		if (!judge.agent || typeof judge.agent !== "object" || !validModel(judge.agent.model))
			invalid(`Judge ${judge.name} needs agent.model with a provider and modelId`);
		if (
			"instructions" in judge.agent ||
			typeof judge.system !== "string" ||
			!judge.system.trim() ||
			typeof judge.prompt !== "function"
		)
			invalid(
				`Judge ${judge.name} needs a system rubric and prompt function, not agent instructions`,
			);
		if (hasFunctions(judge.agent) && judge.configKey === undefined)
			invalid(`Judge ${judge.name} needs configKey for function-valued agent dependencies`);
		let agent: JsonValue;
		let configKey: JsonValue;
		try {
			agent = snapshot(judge.agent);
			configKey = judge.configKey === undefined ? null : snapshot(judge.configKey);
		} catch {
			return invalid(`Judge ${judge.name} has non-JSON configuration`);
		}
		return {
			name: judge.name,
			agent,
			configKey,
			modelHash: hash(snapshot(judge.agent.model)),
			configHash: hash({ agent, configKey }),
			system: judge.system,
		};
	});
	return { inputs, anchors, directory, checkpoint, identities };
}
function buildJobs(
	traces: ScoringTrace[],
	kind: Job["kind"],
	options: ScoringOptions,
	identities: JudgeIdentity[],
): Job[] {
	return traces.flatMap((trace) =>
		options.judges.map((judge, index) => {
			const identity = identities[index];
			if (!identity) return invalid("Missing judge identity");
			let prompt: string;
			try {
				prompt = judge.prompt(structuredClone(trace));
			} catch {
				throw new ScoreFailure(
					"invalid_options",
					`Judge ${judge.name} could not format trace ${trace.id}; fix its reference-free prompt function`,
				);
			}
			if (typeof prompt !== "string") invalid(`Judge ${judge.name} prompt must return a string`);
			const promptHash = hash({
				system: identity.system,
				prompt,
				responseFormat: { type: "json" },
			});
			const key = hash({
				kind,
				traceHash: trace.hash,
				judge: judge.name,
				configHash: identity.configHash,
				modelHash: identity.modelHash,
				promptHash,
			});
			return {
				kind,
				trace,
				judge,
				identity,
				prompt,
				promptHash,
				key,
				id: hash({ interval: options.intervalId, key }),
			};
		}),
	);
}
function row(
	job: Job,
	options: ScoringOptions,
	verdict: { score: number; rationale: string | null; usage: JsonValue },
): ScoreRow {
	const { score, rationale, usage } = verdict;
	return {
		id: job.id,
		interval: options.intervalId,
		kind: job.kind,
		traceId: job.trace.id,
		traceHash: job.trace.hash,
		judge: job.judge.name,
		model: snapshot(job.judge.agent.model),
		modelHash: job.identity.modelHash,
		configHash: job.identity.configHash,
		promptHash: job.promptHash,
		score,
		rationale,
		candidate: job.kind === "production" && score < options.candidateBelow,
		usage,
	};
}
function summaries(rows: ScoreRow[], judges: TraceJudge[]): WindowSummary[] {
	return judges.flatMap((judge) =>
		(["production", "anchor"] as const).map((kind) => {
			const values = rows
				.filter((entry) => entry.kind === kind && entry.judge === judge.name)
				.map((entry) => entry.score);
			const n = values.length;
			const mean = n ? values.reduce((sum, value) => sum + value, 0) / n : null;
			const epsilon = n ? Math.sqrt(Math.log(40) / (2 * n)) : 0;
			const interval95: [number, number] | null =
				mean === null ? null : [Math.max(0, mean - epsilon), Math.min(1, mean + epsilon)];
			return {
				judge: judge.name,
				kind,
				n,
				mean,
				interval95,
				method: "hoeffding",
				confidence: 0.95,
				// Below 8 observations epsilon >= 0.5, so the unclipped interval is at least as wide as [0,1].
				smallN: n < 8,
			};
		}),
	);
}
function nextCheckpoint(base: Checkpoint | null, anchors: AnchorStamp[], jobs: Job[]): Checkpoint {
	const seen = new Set(base?.seen ?? []);
	let time = BigInt(base?.maxObservedTimeUnixNano ?? "0");
	for (const job of jobs)
		if (job.kind === "production") {
			seen.add(job.key);
			const observed = BigInt(job.trace.observedTimeUnixNano);
			if (observed > time) time = observed;
		}
	return { version: 1, seen: [...seen].sort(), anchors, maxObservedTimeUnixNano: time.toString() };
}
function bundle(
	rows: ScoreRow[],
	jobs: Job[],
	options: ScoringOptions,
	next: Checkpoint,
): Map<string, string> {
	const files = new Map<string, string>();
	files.set(
		"scores.jsonl",
		rows.map((entry) => canonical(snapshot(entry))).join("\n") + (rows.length ? "\n" : ""),
	);
	files.set(
		"summary.json",
		`${canonical(snapshot({ interval: options.intervalId, summaries: summaries(rows, options.judges) }))}\n`,
	);
	files.set(
		"candidates.jsonl",
		rows
			.filter((entry) => entry.candidate)
			.map((entry) =>
				canonical({
					scoreId: entry.id,
					judge: entry.judge,
					traceId: entry.traceId,
					traceHash: entry.traceHash,
					status: "pending_owner_approval",
					traceFile: `trace-${entry.traceId}.json`,
				}),
			)
			.join("\n") + (rows.some((entry) => entry.candidate) ? "\n" : ""),
	);
	files.set("checkpoint.json", `${canonical(snapshot(next))}\n`);
	const traces = new Map(jobs.map((job) => [job.trace.id, job.trace]));
	for (const [traceId, trace] of traces)
		files.set(
			`trace-${traceId}.json`,
			`${canonical(
				annotate(
					trace,
					rows.filter((entry) => entry.traceId === traceId),
				),
			)}\n`,
		);
	return files;
}
function restoreRows(files: Map<string, string>, jobs: Job[], options: ScoringOptions): ScoreRow[] {
	try {
		const lines = (files.get("scores.jsonl") ?? "").trim().split("\n");
		if (lines.length !== jobs.length) throw new Error("Score count differs");
		return lines.map((line, index) => {
			const value = json(line);
			const job = jobs[index];
			if (
				!job ||
				!record(value) ||
				typeof value.score !== "number" ||
				!Number.isFinite(value.score) ||
				value.score < 0 ||
				value.score > 1 ||
				(value.rationale !== null && typeof value.rationale !== "string") ||
				!record(value.usage)
			)
				throw new Error("Invalid score row");
			const expected = row(job, options, {
				score: value.score,
				rationale: value.rationale,
				usage: value.usage,
			});
			if (canonical(snapshot(expected)) !== canonical(value))
				throw new Error("Score identity differs from plan");
			return expected;
		});
	} catch {
		throw new ScoreFailure(
			"conflict",
			"Committed scores do not match the interval plan; restore the original bundle before retrying",
		);
	}
}
function judgeFailure(job: Job, reason: string): ScoreFailure {
	return new ScoreFailure(
		"judge_failed",
		`Judge ${job.judge.name} failed for ${job.kind} trace ${job.trace.id}: ${reason}; fix the judge and return JSON with a finite score in [0,1]`,
	);
}
async function assess(job: Job, options: ScoringOptions): Promise<ScoreRow> {
	if (
		hash({ agent: snapshot(job.judge.agent), configKey: job.identity.configKey }) !==
		job.identity.configHash
	)
		throw judgeFailure(job, "agent configuration changed during the interval");
	const harness = piDurableJudgeHarness({
		name: job.judge.name,
		directory: options.judgeDirectory,
		open: options.open,
		agent: job.judge.agent,
	});
	let run: Awaited<ReturnType<typeof harness.run>>;
	try {
		run = await harness.run(
			{
				system: job.identity.system,
				prompt: job.prompt,
				responseFormat: { type: "json" },
				key: { scoring: job.id, configHash: job.identity.configHash },
			},
			{ artifacts: {}, setArtifact: () => {} },
		);
	} catch (cause) {
		// Host and provider errors can carry stored content; only Durable case errors are known to be content-free.
		throw judgeFailure(
			job,
			cause instanceof DurableCaseError
				? cause.message
				: `judge run threw ${cause instanceof Error ? cause.name : typeof cause}`,
		);
	}
	const durable = record(run.artifacts) ? run.artifacts.durable : undefined;
	const where = record(durable) ? `; inspect ${String(durable.directory)}` : "";
	const value = run.output;
	if (
		!record(value) ||
		typeof value.score !== "number" ||
		!Number.isFinite(value.score) ||
		value.score < 0 ||
		value.score > 1 ||
		(value.rationale !== undefined && typeof value.rationale !== "string")
	)
		throw judgeFailure(job, `verdict lacks a finite score in [0,1]${where}`);
	if (
		run.usage.provider !== job.judge.agent.model.provider ||
		run.usage.model !== job.judge.agent.model.modelId
	)
		throw judgeFailure(
			job,
			`answered by ${String(run.usage.provider)}/${String(run.usage.model)}, not the configured model${where}`,
		);
	return row(job, options, {
		score: value.score,
		rationale: typeof value.rationale === "string" ? value.rationale : null,
		usage: snapshot(run.usage),
	});
}
function newUsage(rows: ScoreRow[], field: "newCostUsd" | "newTotalTokens"): number | null {
	let total = 0;
	for (const entry of rows) {
		const metadata = record(entry.usage) && entry.usage.metadata;
		const value = record(metadata) && metadata[field];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
		total += value;
	}
	return Number.isFinite(total) ? total : null;
}
function completed(
	directory: string,
	rows: ScoreRow[],
	options: ScoringOptions,
	replayed: boolean,
): ScoreResult {
	return {
		ok: true,
		value: {
			directory,
			productionCount: rows.filter((entry) => entry.kind === "production").length,
			anchorCount: rows.filter((entry) => entry.kind === "anchor").length,
			summaries: summaries(rows, options.judges),
			replayed,
			newCostUsd: replayed ? 0 : newUsage(rows, "newCostUsd"),
			newTotalTokens: replayed ? 0 : newUsage(rows, "newTotalTokens"),
		},
	};
}
function failed(error: unknown): ScoreResult {
	if (error instanceof ScoreFailure)
		return { ok: false, error: { code: error.code, message: error.message } };
	// System errors carry a code such as ENOENT; anything else is a defect or invalid host input, not storage.
	const system =
		error instanceof Error && "code" in error && typeof error.code === "string"
			? error.code
			: undefined;
	return {
		ok: false,
		error: {
			code: "io_error",
			message: system
				? `Cannot score trace interval (${system}); inspect configured storage and retry the same interval ID`
				: `Unexpected ${error instanceof Error ? error.name : typeof error} while scoring; fix the host configuration or report it, then retry the same interval ID`,
		},
	};
}
/** Scores one interval of OTLP trace snapshots. Run one process per checkpoint; there is no writer lock. */
export async function scoreTraces(options: ScoringOptions): Promise<ScoreResult> {
	try {
		const checked = validate(options);
		const production = await loadTraces(checked.inputs);
		const anchored = await loadTraces(checked.anchors);
		const anchors = anchored.traces.map((trace) => ({ id: trace.id, hash: trace.hash }));
		const anchorIds = new Set(anchors.map((entry) => entry.id));
		if (production.traces.some((trace) => anchorIds.has(trace.id)))
			invalid("Production and anchor trace IDs overlap");
		// Validate parent topology/annotation before incurring judge spend.
		for (const trace of [...production.traces, ...anchored.traces]) annotate(trace, []);
		const current = await readCheckpoint(checked.checkpoint);
		if (current && canonical(snapshot(current.anchors)) !== canonical(snapshot(anchors)))
			throw new ScoreFailure(
				"conflict",
				"Frozen anchors changed; restore them or explicitly start a new checkpoint",
			);
		const previousPlan = await readPlan(checked.directory);
		const base = previousPlan ? parseCheckpoint(previousPlan.baseCheckpoint ?? null) : current;
		const allJobs = [
			...buildJobs(production.traces, "production", options, checked.identities),
			...buildJobs(anchored.traces, "anchor", options, checked.identities),
		];
		const seen = new Set(base?.seen);
		const jobs = allJobs.filter((job) => job.kind === "anchor" || !seen.has(job.key));
		const plan: JsonRecord = {
			version: 1,
			interval: options.intervalId,
			checkpoint: checked.checkpoint,
			judgeDirectory: resolve(options.judgeDirectory),
			baseCheckpoint: snapshot(base),
			files: production.files,
			anchorFiles: anchored.files,
			anchors: snapshot(anchors),
			candidateBelow: options.candidateBelow,
			judges: snapshot(checked.identities),
			jobs: snapshot(
				jobs.map((job) => ({
					id: job.id,
					key: job.key,
					kind: job.kind,
					traceId: job.trace.id,
					traceHash: job.trace.hash,
					judge: job.judge.name,
					promptHash: job.promptHash,
				})),
			),
		};
		if (previousPlan && canonical(previousPlan) !== canonical(plan))
			throw new ScoreFailure(
				"conflict",
				`Interval ${options.intervalId} plan changed; restore its inputs/configuration or use a new interval ID`,
			);
		const planHash = hash(plan);
		const next = nextCheckpoint(base, anchors, jobs);
		const names = [...bundle([], jobs, options, next).keys()];
		const saved = previousPlan ? await loadBundle(checked.directory, planHash, names) : undefined;
		let rows: ScoreRow[];
		if (saved) {
			rows = restoreRows(saved, jobs, options);
			const expected = bundle(rows, jobs, options, next);
			if ([...expected].some(([name, text]) => saved.get(name) !== text))
				throw new ScoreFailure(
					"conflict",
					"Committed artifacts do not match scores/input snapshots; restore the original interval bundle",
				);
		} else {
			if (checkpointHash(current) !== checkpointHash(base))
				throw new ScoreFailure(
					"conflict",
					"Checkpoint advanced beyond a pending interval; serialize runs before retrying",
				);
			if (!previousPlan) await createPlan(checked.directory, plan);
			rows = [];
			for (const job of jobs) rows.push(await assess(job, options));
			await saveBundle(checked.directory, planHash, bundle(rows, jobs, options, next));
			// Verify actual file content before advancing the ledger, including the commit/checkpoint crash gap.
			const written = await loadBundle(checked.directory, planHash, names);
			if (
				!written ||
				[...bundle(rows, jobs, options, next)].some(([name, text]) => written.get(name) !== text)
			)
				throw new ScoreFailure(
					"conflict",
					"Written bundle verification failed; restore output files before retrying",
				);
		}
		await advanceCheckpoint(checked.checkpoint, base, next, saved !== undefined);
		return completed(checked.directory, rows, options, saved !== undefined);
	} catch (error) {
		return failed(error);
	}
}
