import type { Usage } from "@earendil-works/pi-ai";

// Projections of Pi 1.0.2 records: validate every field used for identity, parentage, timing and spend.
export type Conversation = {
	id: number;
	parent?: { conversationId: number; at: number };
	owner?: { conversationId: number; taskId: number };
};
export type Call = { id: string; name: string; arguments: unknown };
type CommonMessage = { timestamp?: number; content: unknown };
export type StoredMessage = CommonMessage &
	(
		| { role: "user" | "system"; sections?: unknown }
		| {
				role: "assistant";
				model: string;
				provider: string;
				responseModel?: string;
				responseId?: string;
				stopReason: string;
				usage: Usage;
				calls: Call[];
		  }
		| {
				role: "toolResult";
				toolCallId: string;
				toolName: string;
				isError: boolean;
				usage?: Usage;
				nestedCount: number;
		  }
	);
export type Entry = {
	id: number;
	conversationId: number;
	byTaskId?: number;
	messages: StoredMessage[];
};
export type StoredTask = {
	id: number;
	conversationId: number;
	owner?: number;
	kind: string;
	status: string;
	outcome?: string;
	call?: { assistant: number; callId: string };
};
export type Snapshot = { conversations: Conversation[]; entries: Entry[]; tasks: StoredTask[] };

export class InvalidStorage extends Error {}
function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new InvalidStorage("expected a JSON object");
	// The guard excludes null and arrays; JSON.parse supplies plain data, not class instances.
	return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new InvalidStorage("expected a JSON array");
	return value;
}
export function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new InvalidStorage("expected a nonnegative safe integer");
	return value;
}
function id(value: unknown): number {
	const parsed = integer(value);
	if (parsed === 0) throw new InvalidStorage("expected a positive Durable ID");
	return parsed;
}
function text(value: unknown): string {
	if (typeof value !== "string") throw new InvalidStorage("expected a string");
	return value;
}
function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
	return value === undefined ? undefined : parse(value);
}
function enumeration(value: unknown, choices: readonly string[]): string {
	const parsed = text(value);
	if (!choices.includes(parsed)) throw new InvalidStorage("unsupported record state");
	return parsed;
}
function timestamp(value: unknown): number {
	const parsed = integer(value);
	if (parsed > 18_446_744_073_709)
		throw new InvalidStorage("timestamp exceeds OTLP uint64 nanoseconds");
	return parsed;
}
function money(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		throw new InvalidStorage("expected a finite nonnegative cost");
	return value;
}
function usage(value: unknown): Usage {
	const u = object(value);
	const cost = object(u.cost);
	const result: Usage = {
		input: integer(u.input),
		output: integer(u.output),
		cacheRead: integer(u.cacheRead),
		cacheWrite: integer(u.cacheWrite),
		totalTokens: integer(u.totalTokens),
		reasoning: optional(u.reasoning, integer),
		cacheWrite1h: optional(u.cacheWrite1h, integer),
		cost: {
			input: money(cost.input),
			output: money(cost.output),
			cacheRead: money(cost.cacheRead),
			cacheWrite: money(cost.cacheWrite),
			total: money(cost.total),
		},
	};
	if (!Number.isSafeInteger(result.input + result.cacheRead + result.cacheWrite))
		throw new InvalidStorage("input token sum exceeds safe integer range");
	return result;
}
function message(value: unknown): StoredMessage {
	const m = object(value);
	const common = {
		timestamp: optional(m.timestamp, timestamp),
		content: typeof m.content === "string" ? m.content : array(m.content),
	};
	if (m.role === "user" || m.role === "system")
		return { ...common, role: m.role, sections: m.sections };
	if (m.role === "assistant") {
		const calls = array(m.content).flatMap((value): Call[] => {
			const block = object(value);
			return block.type === "toolCall"
				? [{ id: text(block.id), name: text(block.name), arguments: object(block.arguments) }]
				: [];
		});
		return {
			...common,
			role: m.role,
			model: text(m.model),
			provider: text(m.provider),
			responseModel: optional(m.responseModel, text),
			responseId: optional(m.responseId, text),
			stopReason: enumeration(m.stopReason, [
				"pending",
				"stop",
				"length",
				"toolUse",
				"error",
				"aborted",
				"deferred",
			]),
			usage: usage(m.usage),
			calls,
		};
	}
	if (m.role === "toolResult") {
		if (typeof m.isError !== "boolean")
			throw new InvalidStorage("expected tool result isError boolean");
		return {
			...common,
			role: m.role,
			content: array(m.content),
			toolCallId: text(m.toolCallId),
			toolName: text(m.toolName),
			isError: m.isError,
			usage: optional(m.usage, usage),
			nestedCount: m.nestedCalls === undefined ? 0 : array(object(m.nestedCalls).calls).length,
		};
	}
	throw new InvalidStorage("unsupported message role");
}
export function conversationRecord(value: unknown): Conversation {
	const c = object(value);
	return {
		id: id(c.id),
		parent: optional(c.parent, (value) => {
			const p = object(value);
			return { conversationId: id(p.conversationId), at: id(p.at) };
		}),
		owner: optional(c.owner, (value) => {
			const o = object(value);
			return { conversationId: id(o.conversationId), taskId: id(o.taskId) };
		}),
	};
}
export function entryRecord(value: unknown): Entry {
	const e = object(value);
	return {
		id: id(e.id),
		conversationId: id(e.conversationId),
		byTaskId: optional(e.byTaskId, id),
		messages: e.model === undefined ? [] : array(e.model).map(message),
	};
}
export function taskRecord(value: unknown): StoredTask {
	const t = object(value);
	const state = object(t.state);
	const kind = text(t.kind);
	const input = kind === "pi.tool" ? object(t.input) : undefined;
	return {
		id: id(t.id),
		conversationId: id(t.conversationId),
		owner: optional(t.owner, id),
		kind,
		status: enumeration(state.status, ["pending", "running", "waiting", "completing", "terminal"]),
		outcome: optional(state.outcome, (value) =>
			enumeration(object(value).status, ["completed", "failed", "aborted", "orphaned", "faulted"]),
		),
		call:
			input === undefined
				? undefined
				: { assistant: id(input.assistant), callId: text(input.callId) },
	};
}
