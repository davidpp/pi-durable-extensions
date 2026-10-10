import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { annotate, loadTraces } from "./scoring-data.ts";
import type { JsonRecord } from "./scoring-data.ts";

const traceId = "1".repeat(32);
const spanId = "2".repeat(16);
const span = (extra: JsonRecord = {}): JsonRecord => ({ traceId, spanId, ...extra });
const envelope = (spans: JsonRecord[]): JsonRecord => ({
	resourceSpans: [{ scopeSpans: [{ spans }] }],
});
async function files(texts: string[]) {
	const directory = await mkdtemp(join(tmpdir(), "score-otlp-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	return Promise.all(
		texts.map(async (text, index) => {
			const path = join(directory, `${index}.json`);
			await writeFile(path, text);
			return path;
		}),
	);
}

test("accepts ProtoJSON null/default fields and retains unknown empty metadata containers", async () => {
	const input: JsonRecord = {
		unknownEnvelope: "keep",
		resourceSpans: [
			{ resource: null, emptyMetadata: "keep-resource", scopeSpans: null },
			{
				resource: null,
				scopeSpans: [
					{ scope: null, emptyMetadata: "keep-scope", spans: [] },
					{
						scope: null,
						spans: [
							span({
								name: null,
								parentSpanId: null,
								attributes: null,
								events: null,
								startTimeUnixNano: null,
								endTimeUnixNano: null,
								unknownSpan: "keep",
							}),
						],
					},
				],
			},
		],
	};
	const result = await loadTraces(await files([JSON.stringify(input)]));
	expect(result.traces[0]?.data).toEqual(input);
	expect(result.traces[0]?.observedTimeUnixNano).toBe("0");
	const trace = result.traces[0];
	if (!trace) throw new Error("Missing fixture trace");
	expect(JSON.stringify(annotate(trace, []))).toContain("keep-resource");
	expect(JSON.stringify(annotate(trace, []))).toContain("keep-scope");
});

test("batched OTLP splits trace IDs while preserving empty metadata and partial-export local roots", async () => {
	const input = envelope([
		span({ parentSpanId: "3".repeat(16) }),
		{ traceId: "4".repeat(32), spanId: "5".repeat(16), endTimeUnixNano: 10 },
	]);
	const result = await loadTraces(await files([JSON.stringify(input)]));
	expect(result.traces).toHaveLength(2);
	for (const trace of result.traces) {
		const annotated = annotate(trace, [
			{
				judge: "quality",
				score: 0.5,
				modelHash: "model",
				promptHash: "prompt",
				interval: "first",
				kind: "production",
			},
		]);
		expect(JSON.stringify(annotated)).toContain("pi.evals.quality.score");
	}
});

test.each([
	"not JSON",
	"null",
	"{}",
	'{"resourceSpans":{}}',
	JSON.stringify(envelope([span({ traceId: "0".repeat(32) })])),
	JSON.stringify(envelope([span({ spanId: "0".repeat(16) })])),
	JSON.stringify(envelope([span({ startTimeUnixNano: "10", endTimeUnixNano: "5" })])),
	JSON.stringify(envelope([span({ endTimeUnixNano: "18446744073709551616" })])),
	JSON.stringify(envelope([span({ endTimeUnixNano: -1 })])),
	JSON.stringify(envelope([span({ attributes: {} })])),
	JSON.stringify(envelope([span(), span()])),
	JSON.stringify(envelope([span({ parentSpanId: spanId })])),
	JSON.stringify(
		envelope([
			span(),
			{ traceId, spanId: "3".repeat(16), parentSpanId: "4".repeat(16) },
			{ traceId, spanId: "4".repeat(16), parentSpanId: "3".repeat(16) },
		]),
	),
])("rejects malformed/scoring-ambiguous OTLP %s", async (text) => {
	await expect(loadTraces(await files([text]))).rejects.toMatchObject({ code: "invalid_trace" });
});

test("unsafe numeric int64 fails explicitly; string int64 is retained without rounding", async () => {
	const unsafe = JSON.stringify(
		envelope([span({ attributes: [{ key: "counter", value: { intValue: "9007199254740993" } }] })]),
	).replace('"9007199254740993"', "9007199254740993");
	await expect(loadTraces(await files([unsafe]))).rejects.toMatchObject({ code: "invalid_trace" });
	const safe = envelope([
		span({ attributes: [{ key: "counter", value: { intValue: "9007199254740993" } }] }),
	]);
	const result = await loadTraces(await files([JSON.stringify(safe)]));
	expect(result.traces[0]?.data).toEqual(safe);
});

test("differing unknown empty-container metadata creates conflicting snapshots, not silent deduplication", async () => {
	const first = {
		...envelope([span()]),
		resourceSpans: [{ scopeSpans: [{ spans: [span()] }, { spans: [], unknown: "first" }] }],
	};
	const second = {
		...envelope([span()]),
		resourceSpans: [{ scopeSpans: [{ spans: [span()] }, { spans: [], unknown: "second" }] }],
	};
	await expect(
		loadTraces(await files([JSON.stringify(first), JSON.stringify(second)])),
	).rejects.toMatchObject({ code: "invalid_trace" });
});

test("identical snapshots dedupe across files and object property order", async () => {
	const first = envelope([span()]);
	const second = { resourceSpans: [{ scopeSpans: [{ spans: [{ spanId, traceId }] }] }] };
	const result = await loadTraces(await files([JSON.stringify(first), JSON.stringify(second)]));
	expect(result.traces).toHaveLength(1);
});
