import type { Usage } from "@earendil-works/pi-ai";

export type OtlpAttribute = {
	key: string;
	value:
		| { stringValue: string }
		| { intValue: string }
		| { doubleValue: number }
		| { boolValue: boolean };
};
export type OtlpEvent = { name: string; timeUnixNano: string; attributes: OtlpAttribute[] };
export type OtlpSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: 1 | 3;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpAttribute[];
	events: OtlpEvent[];
	status: { code: 0 | 2 };
};
/** OTLP ExportTraceServiceRequest JSON containing one root conversation's trace. */
export type OtlpTrace = {
	resourceSpans: {
		resource: { attributes: OtlpAttribute[] };
		scopeSpans: { scope: { name: string; version: string }; spans: OtlpSpan[] }[];
	}[];
};

export function attribute(key: string, value: string | number | boolean): OtlpAttribute {
	return {
		key,
		value:
			typeof value === "string"
				? { stringValue: value }
				: typeof value === "boolean"
					? { boolValue: value }
					: Number.isInteger(value)
						? { intValue: String(value) }
						: { doubleValue: value },
	};
}

export function usageAttributes(usage: Usage): OtlpAttribute[] {
	const pairs: [string, number][] = [
		["gen_ai.usage.input_tokens", usage.input + usage.cacheRead + usage.cacheWrite],
		["gen_ai.usage.output_tokens", usage.output],
		["gen_ai.usage.cache_read.input_tokens", usage.cacheRead],
		["gen_ai.usage.cache_write.input_tokens", usage.cacheWrite],
		["pi.durable.usage.input_tokens", usage.input],
		["pi.durable.usage.total_tokens", usage.totalTokens],
	];
	if (usage.reasoning !== undefined)
		pairs.push(["gen_ai.usage.reasoning.output_tokens", usage.reasoning]);
	if (usage.cacheWrite1h !== undefined)
		pairs.push(["pi.durable.usage.cache_write_1h_tokens", usage.cacheWrite1h]);
	return [
		...pairs.map(([key, value]) => attribute(key, value)),
		// Cost has no standard GenAI attribute in the pinned precedent. Always encode currency as double.
		{ key: "pi.durable.cost.usd", value: { doubleValue: usage.cost.total } },
		attribute("pi.durable.cost.basis", "stored_estimate"),
	];
}

export const nanos = (timestamp: number) => (BigInt(timestamp) * 1_000_000n).toString();
export function contentEvent(name: string, timestamp: number, value: unknown): OtlpEvent {
	return {
		name,
		timeUnixNano: nanos(timestamp),
		attributes: [attribute("pi.durable.content", JSON.stringify(value))],
	};
}
