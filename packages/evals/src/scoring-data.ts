import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { JsonValue } from "vitest-evals/harness";

export type JsonRecord = { [key: string]: JsonValue };
export type ScoringTrace = {
	id: string;
	hash: string;
	/** Maximum observed span start/end time; zero means no observed time. Not an arrival watermark. */
	observedTimeUnixNano: string;
	data: JsonRecord;
};
export class ScoreFailure extends Error {
	constructor(
		public code:
			| "invalid_options"
			| "invalid_trace"
			| "invalid_checkpoint"
			| "conflict"
			| "judge_failed"
			| "io_error",
		message: string,
	) {
		super(message);
	}
}
export function record(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isJson(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	return record(value) && Object.values(value).every(isJson);
}
export function json(text: string): JsonValue {
	const value: unknown = JSON.parse(text, (key: string, entry: unknown) => {
		// OTLP int64 values should use strings; reject unsafe numeric encodings rather than silently round them.
		if (key === "intValue" && typeof entry === "number" && !Number.isSafeInteger(entry))
			throw new Error("Unsafe numeric intValue; encode int64 as a decimal string");
		return entry;
	});
	if (!isJson(value)) throw new Error("Nonfinite JSON value");
	return value;
}
export function canonical(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (record(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const hash = (value: JsonValue) => digest(canonical(value));
export function snapshot(value: unknown): JsonValue {
	// JSON serialization is the contract for configuration identity; functions are intentionally not represented.
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("Not JSON serializable");
	return json(text);
}
export function hasFunctions(value: unknown, seen = new Set<unknown>()): boolean {
	if (typeof value === "function") return true;
	if (!value || typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	return Object.values(value).some((entry) => hasFunctions(entry, seen));
}
export const safeName = (name: unknown): name is string =>
	typeof name === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(name);
export function nano(value: unknown): string {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) value = String(value);
	if (
		typeof value !== "string" ||
		!/^\d+$/.test(value) ||
		BigInt(value) > 18_446_744_073_709_551_615n
	)
		throw new Error("Invalid unsigned nanosecond timestamp");
	return BigInt(value).toString();
}
const id = (value: unknown, length: number): value is string =>
	typeof value === "string" &&
	new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value) &&
	!/^0+$/.test(value);
function objects(value: JsonValue | undefined): JsonRecord[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || !value.every(record))
		throw new Error("Expected an array of objects");
	return value;
}
function attributes(value: JsonValue | undefined): void {
	for (const item of objects(value)) {
		if (item.key != null && typeof item.key !== "string") throw new Error("Invalid attribute key");
		if (item.value != null && !record(item.value)) throw new Error("Invalid attribute value");
	}
}
function spanIdentity(span: JsonRecord) {
	if (!id(span.traceId, 32) || !id(span.spanId, 16))
		throw new Error("Expected nonzero hexadecimal trace/span IDs");
	if (
		span.parentSpanId != null &&
		span.parentSpanId !== "" &&
		span.parentSpanId !== "0000000000000000" &&
		!id(span.parentSpanId, 16)
	)
		throw new Error("Invalid parent span ID");
	if (span.name != null && typeof span.name !== "string") throw new Error("Invalid span name");
	const start = nano(span.startTimeUnixNano ?? "0");
	const end = nano(span.endTimeUnixNano ?? "0");
	if (end !== "0" && BigInt(end) < BigInt(start)) throw new Error("Span end precedes start");
	attributes(span.attributes);
	for (const event of objects(span.events)) {
		nano(event.timeUnixNano ?? "0");
		attributes(event.attributes);
	}
	return {
		traceId: span.traceId.toLowerCase(),
		spanId: span.spanId.toLowerCase(),
		time: BigInt(end) > BigInt(start) ? end : start,
	};
}
function checkCycles(data: JsonRecord): void {
	const parents = new Map<string, string | undefined>();
	for (const resource of objects(data.resourceSpans))
		for (const scope of objects(resource.scopeSpans))
			for (const span of objects(scope.spans))
				if (typeof span.spanId === "string")
					parents.set(
						span.spanId.toLowerCase(),
						typeof span.parentSpanId === "string" ? span.parentSpanId.toLowerCase() : undefined,
					);
	for (const spanId of parents.keys()) {
		const seen = new Set<string>();
		let current: string | undefined = spanId;
		while (current !== undefined && parents.has(current)) {
			if (seen.has(current)) throw new Error("Cyclic local span parents");
			seen.add(current);
			current = parents.get(current);
		}
	}
}
/** Validate scoring-critical OTLP JSON fields; preserve unknown fields and optional protobuf defaults. */
function parseTraces(value: JsonValue): ScoringTrace[] {
	if (!record(value)) throw new Error("Expected an OTLP object");
	const resources = objects(value.resourceSpans);
	const byId = new Map<string, { spans: Set<string>; time: bigint }>();
	for (const resource of resources) {
		if (resource.resource != null && !record(resource.resource))
			throw new Error("Invalid resource");
		if (record(resource.resource)) attributes(resource.resource.attributes);
		for (const scope of objects(resource.scopeSpans)) {
			if (scope.scope != null && !record(scope.scope))
				throw new Error("Invalid instrumentation scope");
			for (const span of objects(scope.spans)) {
				const identity = spanIdentity(span);
				const group = byId.get(identity.traceId) ?? { spans: new Set<string>(), time: 0n };
				if (group.spans.has(identity.spanId)) throw new Error("Duplicate span identity");
				group.spans.add(identity.spanId);
				group.time = group.time > BigInt(identity.time) ? group.time : BigInt(identity.time);
				byId.set(identity.traceId, group);
			}
		}
	}
	if (byId.size === 0) throw new Error("OTLP input has no spans");
	return [...byId]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([traceId, group]) => {
			const data = {
				...value,
				resourceSpans: resources.flatMap((resource) => {
					const originalScopes = objects(resource.scopeSpans);
					if (originalScopes.length === 0) return [resource];
					const scopeSpans = originalScopes.flatMap((scope) => {
						const originalSpans = objects(scope.spans);
						if (originalSpans.length === 0) return [scope];
						const spans = originalSpans.filter(
							(span) => typeof span.traceId === "string" && span.traceId.toLowerCase() === traceId,
						);
						return spans.length ? [{ ...scope, spans }] : [];
					});
					return scopeSpans.length ? [{ ...resource, scopeSpans }] : [];
				}),
			};
			checkCycles(data);
			return { id: traceId, hash: hash(data), observedTimeUnixNano: group.time.toString(), data };
		});
}
export async function loadTraces(
	paths: string[],
): Promise<{ traces: ScoringTrace[]; files: JsonValue[] }> {
	const traces = new Map<string, ScoringTrace>();
	const files: JsonValue[] = [];
	for (const path of [...paths].sort()) {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			throw new ScoreFailure(
				"io_error",
				`Cannot read OTLP file ${path}; supply a readable JSON file`,
			);
		}
		let parsed: ScoringTrace[];
		try {
			parsed = parseTraces(json(text));
		} catch (cause) {
			const encoding =
				cause instanceof Error &&
				cause.message === "Unsafe numeric intValue; encode int64 as a decimal string"
					? "; encode unsafe numeric intValue as a decimal string"
					: "";
			throw new ScoreFailure(
				"invalid_trace",
				`Malformed OTLP file ${path}; check IDs, span identities, arrays and timestamps${encoding}`,
			);
		}
		files.push({ path: resolve(path), hash: digest(text) });
		for (const trace of parsed) {
			const previous = traces.get(trace.id);
			if (previous && previous.hash !== trace.hash)
				throw new ScoreFailure(
					"invalid_trace",
					`Conflicting snapshots for trace ${trace.id}; supply one snapshot per trace ID`,
				);
			traces.set(trace.id, trace);
		}
	}
	return { traces: [...traces.values()].sort((a, b) => a.id.localeCompare(b.id)), files };
}
export function annotate(
	trace: ScoringTrace,
	scores: {
		judge: string;
		score: number;
		modelHash: string;
		promptHash: string;
		interval: string;
		kind: string;
	}[],
): JsonRecord {
	const data = structuredClone(trace.data);
	const spans = objects(data.resourceSpans).flatMap((resource) =>
		objects(resource.scopeSpans).flatMap((scope) => objects(scope.spans)),
	);
	const spanIds = new Set(
		spans.map((span) => (typeof span.spanId === "string" ? span.spanId.toLowerCase() : "")),
	);
	const roots = spans.filter(
		(span) =>
			typeof span.parentSpanId !== "string" || !spanIds.has(span.parentSpanId.toLowerCase()),
	);
	// Generic partial exports can have several locally-rooted spans. Label each as a trace-level score, not a span assessment.
	for (const span of roots) {
		const added = scores.flatMap((score): JsonRecord[] => {
			const prefix = `pi.evals.${score.judge}.`;
			return [
				{ key: `${prefix}score`, value: { doubleValue: score.score } },
				{ key: `${prefix}model_hash`, value: { stringValue: score.modelHash } },
				{ key: `${prefix}prompt_hash`, value: { stringValue: score.promptHash } },
				{ key: `${prefix}interval`, value: { stringValue: score.interval } },
				{ key: `${prefix}kind`, value: { stringValue: score.kind } },
				{ key: `${prefix}scope`, value: { stringValue: "trace_snapshot" } },
			];
		});
		const names = new Set(added.map((entry) => entry.key));
		span.attributes = [
			...objects(span.attributes).filter(
				(entry) => typeof entry.key !== "string" || !names.has(entry.key),
			),
			...added,
		];
	}
	if (roots.length === 0)
		throw new ScoreFailure(
			"invalid_trace",
			`Trace ${trace.id} has no locally-rooted span; check cyclic parent identities`,
		);
	return data;
}
