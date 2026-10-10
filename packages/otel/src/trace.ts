import { createHash } from "node:crypto";
import { attribute, contentEvent, nanos, usageAttributes } from "./otlp.ts";
import type { OtlpAttribute, OtlpEvent, OtlpSpan, OtlpTrace } from "./otlp.ts";
import type { Call, Entry, Snapshot, StoredMessage } from "./records.ts";
import { ExportFailure } from "./sqlite.ts";

/** Content-free limitations observed while exporting; IDs refer to Durable records. */
export type ExportDiagnostic = {
	code:
		| "missing_timestamp"
		| "untimed_span"
		| "nested_tool_calls_omitted"
		| "compaction_usage_unavailable";
	entity: string;
	count?: number;
};
export type ExportedTraces = { traces: OtlpTrace[]; diagnostics: ExportDiagnostic[] };
export type ExportOptions = {
	/** Stable host-owned namespace. Durable's numeric IDs are unique only within one storage. */
	storageId: string;
	/** A root conversation ID; includes its complete ownership/fork subtree. */
	conversation?: number;
	includeContent?: boolean;
};
type Node = {
	key: string;
	parent?: string;
	name: string;
	kind: 1 | 3;
	attributes: OtlpAttribute[];
	events: OtlpEvent[];
	failed: boolean;
	start?: number;
	end?: number;
};
type Tool = { node: Node; entry: Entry; call: Call; taskId?: number };
/** A diagnostic and the span whose root decides whether a selected export reports it. */
type Owned = { owner: string; diagnostic: ExportDiagnostic };
const conversationKey = (id: number) => `conversation:${id}`;
const taskKey = (id: number) => `task:${id}`;
const chatKey = (entry: number, index: number) => `chat:${entry}:${index}`;
const hash = (values: readonly (string | number)[], length: number) =>
	createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, length);
const invalid = (reason: string): never => {
	throw new ExportFailure(
		"invalid_storage",
		`${reason}; inspect storage with the pinned Pi version`,
	);
};

function node(key: string, name: string, parent?: string): Node {
	return { key, name, parent, kind: 1, attributes: [], events: [], failed: false };
}
function get(nodes: Map<string, Node>, key: string): Node {
	return nodes.get(key) ?? invalid(`Missing span ancestor ${key}`);
}
function insert(nodes: Map<string, Node>, value: Node): void {
	if (nodes.has(value.key)) invalid(`Duplicate identity ${value.key}`);
	nodes.set(value.key, value);
}
function observe(n: Node, timestamp: number | undefined): void {
	if (timestamp === undefined) return;
	n.start = Math.min(n.start ?? timestamp, timestamp);
	n.end = Math.max(n.end ?? timestamp, timestamp);
}
function validateForks(snapshot: Snapshot): void {
	for (const c of snapshot.conversations) {
		if (!c.parent) continue;
		const target = snapshot.entries.find((e) => e.id === c.parent?.at);
		if (!target) return invalid(`Missing fork entry for conversation ${c.id}`);
		const seen = new Set<number>([c.id]);
		let sourceId: number | undefined = c.parent.conversationId;
		let upper = c.parent.at;
		let visible = false;
		while (sourceId !== undefined) {
			if (seen.has(sourceId)) invalid(`Cyclic fork ancestry ${c.id}`);
			seen.add(sourceId);
			const source = snapshot.conversations.find((value) => value.id === sourceId);
			if (!source) return invalid(`Missing fork conversation ${c.id}`);
			if (source.id === target.conversationId && target.id <= upper) visible = true;
			// Each fork inherits only through its parent's inclusive cutoff.
			if (source.parent) upper = Math.min(upper, source.parent.at);
			sourceId = source.parent?.conversationId;
		}
		if (!visible) invalid(`Invisible fork entry for conversation ${c.id}`);
	}
}
function containers(snapshot: Snapshot): Map<string, Node> {
	const nodes = new Map<string, Node>();
	validateForks(snapshot);
	for (const c of snapshot.conversations) {
		const parent = c.owner
			? taskKey(c.owner.taskId)
			: c.parent
				? conversationKey(c.parent.conversationId)
				: undefined;
		const n = node(conversationKey(c.id), "invoke_agent", parent);
		n.attributes.push(
			attribute("gen_ai.operation.name", "invoke_agent"),
			attribute("gen_ai.conversation.id", String(c.id)),
		);
		if (c.parent)
			n.attributes.push(
				attribute("pi.durable.fork.conversation_id", c.parent.conversationId),
				attribute("pi.durable.fork.entry_id", c.parent.at),
			);
		if (
			c.owner &&
			snapshot.tasks.find((t) => t.id === c.owner?.taskId)?.conversationId !==
				c.owner.conversationId
		)
			invalid(`Invalid conversation owner ${c.id}`);
		insert(nodes, n);
	}
	for (const t of snapshot.tasks) {
		if (!nodes.has(conversationKey(t.conversationId))) invalid(`Missing task conversation ${t.id}`);
		if (
			t.owner &&
			snapshot.tasks.find((o) => o.id === t.owner)?.conversationId !== t.conversationId
		)
			invalid(`Invalid task owner ${t.id}`);
		const n = node(
			taskKey(t.id),
			`pi.durable.task ${t.kind}`,
			t.owner ? taskKey(t.owner) : conversationKey(t.conversationId),
		);
		n.attributes.push(
			attribute("pi.durable.task.id", t.id),
			attribute("pi.durable.task.kind", t.kind),
			attribute("pi.durable.task.status", t.status),
		);
		if (t.outcome) n.attributes.push(attribute("pi.durable.task.outcome", t.outcome));
		n.failed = t.outcome === "failed" || t.outcome === "faulted" || t.outcome === "orphaned";
		insert(nodes, n);
	}
	return nodes;
}
function entryParent(snapshot: Snapshot, entry: Entry): string {
	if (!snapshot.conversations.some((c) => c.id === entry.conversationId))
		invalid(`Missing entry conversation ${entry.id}`);
	if (entry.byTaskId === undefined) return conversationKey(entry.conversationId);
	if (snapshot.tasks.find((t) => t.id === entry.byTaskId)?.conversationId !== entry.conversationId)
		invalid(`Invalid entry task ${entry.id}`);
	return taskKey(entry.byTaskId);
}
function addChats(snapshot: Snapshot, nodes: Map<string, Node>, options: ExportOptions): Tool[] {
	const tools: Tool[] = [];
	for (const e of snapshot.entries) {
		const parent = entryParent(snapshot, e);
		for (const [index, message] of e.messages.entries()) {
			if (message.role !== "assistant") continue;
			const n = node(chatKey(e.id, index), `chat ${message.model}`, parent);
			n.kind = 3;
			n.attributes.push(
				attribute("gen_ai.operation.name", "chat"),
				attribute("gen_ai.request.model", message.model),
				attribute("gen_ai.provider.name", message.provider),
				attribute("pi.durable.entry.id", e.id),
				attribute("pi.durable.stop_reason", message.stopReason),
				attribute("gen_ai.conversation.id", String(e.conversationId)),
				...usageAttributes(message.usage),
			);
			if (message.responseModel)
				n.attributes.push(attribute("gen_ai.response.model", message.responseModel));
			if (message.responseId)
				n.attributes.push(attribute("gen_ai.response.id", message.responseId));
			observe(n, message.timestamp);
			n.failed = message.stopReason === "error" || message.stopReason === "aborted";
			if (options.includeContent && message.timestamp !== undefined)
				n.events.push(contentEvent("pi.durable.output", message.timestamp, message.content));
			insert(nodes, n);
			for (const [callIndex, call] of message.calls.entries()) {
				if (tools.some((t) => t.entry.id === e.id && t.call.id === call.id))
					invalid(`Duplicate tool call in entry ${e.id}`);
				const matching = snapshot.tasks.filter(
					(t) =>
						t.conversationId === e.conversationId &&
						t.call?.assistant === e.id &&
						t.call.callId === call.id,
				);
				if (matching.length > 1) invalid(`Ambiguous tool task for entry ${e.id}`);
				const task = matching[0];
				const tool = task
					? get(nodes, taskKey(task.id))
					: node(`tool:${e.id}:${index}:${callIndex}`, `execute_tool ${call.name}`, parent);
				if (!task) insert(nodes, tool);
				tool.name = `execute_tool ${call.name}`;
				tool.attributes.push(
					attribute("gen_ai.operation.name", "execute_tool"),
					attribute("gen_ai.tool.name", call.name),
					attribute("gen_ai.tool.call.id", call.id),
					attribute("gen_ai.conversation.id", String(e.conversationId)),
					attribute("pi.durable.entry.id", e.id),
				);
				observe(tool, message.timestamp);
				if (options.includeContent && message.timestamp !== undefined)
					tool.events.push(
						contentEvent("pi.durable.tool.input", message.timestamp, call.arguments),
					);
				tools.push({ node: tool, entry: e, call, taskId: task?.id });
			}
		}
	}
	for (const t of snapshot.tasks)
		if (t.call && !tools.some((tool) => tool.taskId === t.id))
			invalid(`Missing tool call for task ${t.id}`);
	return tools;
}

function addEvidence(
	snapshot: Snapshot,
	nodes: Map<string, Node>,
	tools: Tool[],
	options: ExportOptions,
	diagnostics: Owned[],
): void {
	for (const e of snapshot.entries) {
		const parent = get(nodes, entryParent(snapshot, e));
		for (const [index, message] of e.messages.entries()) {
			if (message.timestamp === undefined)
				diagnostics.push({
					owner: parent.key,
					diagnostic: { code: "missing_timestamp", entity: `entry:${e.id}:message:${index}` },
				});
			if (message.role === "assistant") continue;
			if (message.role !== "toolResult") {
				observe(parent, message.timestamp);
				if (options.includeContent && message.timestamp !== undefined)
					parent.events.push(
						contentEvent("pi.durable.input", message.timestamp, {
							role: message.role,
							content: message.content,
							sections: message.sections,
						}),
					);
				continue;
			}
			const tool = findTool(tools, e, message);
			observe(tool.node, message.timestamp);
			tool.node.failed ||= message.isError;
			if (message.usage) tool.node.attributes.push(...usageAttributes(message.usage));
			if (options.includeContent && message.timestamp !== undefined)
				tool.node.events.push(
					contentEvent("pi.durable.tool.output", message.timestamp, message.content),
				);
			if (message.nestedCount)
				diagnostics.push({
					owner: parent.key,
					diagnostic: {
						code: "nested_tool_calls_omitted",
						entity: `entry:${e.id}:message:${index}`,
						count: message.nestedCount,
					},
				});
		}
	}
}
function findTool(
	tools: Tool[],
	entry: Entry,
	message: Extract<StoredMessage, { role: "toolResult" }>,
): Tool {
	const candidates = tools.filter(
		(tool) =>
			tool.entry.conversationId === entry.conversationId &&
			tool.entry.id < entry.id &&
			tool.call.id === message.toolCallId,
	);
	const tool =
		entry.byTaskId !== undefined && tools.some((tool) => tool.taskId === entry.byTaskId)
			? candidates.find((tool) => tool.taskId === entry.byTaskId)
			: candidates.at(-1);
	if (!tool || tool.call.name !== message.toolName)
		return invalid(`Unmatched tool result entry ${entry.id}`);
	return tool;
}

function ancestry(nodes: Map<string, Node>): Map<string, string[]> {
	const paths = new Map<string, string[]>();
	for (const n of nodes.values()) {
		const path: string[] = [];
		let current: Node | undefined = n;
		while (current) {
			if (path.includes(current.key)) invalid(`Cyclic ancestry ${n.key}`);
			path.push(current.key);
			current = current.parent === undefined ? undefined : get(nodes, current.parent);
		}
		paths.set(n.key, path);
	}
	return paths;
}
function emit(
	n: Node,
	path: string[],
	nodes: Map<string, Node>,
	namespace: string,
	traceId: string,
): OtlpSpan | undefined {
	if (n.start === undefined || n.end === undefined) return undefined;
	const parent = path.slice(1).find((key) => get(nodes, key).start !== undefined);
	return {
		traceId,
		spanId: hash(["pi-durable-otel", "span", namespace, n.key], 16),
		...(parent === undefined
			? {}
			: { parentSpanId: hash(["pi-durable-otel", "span", namespace, parent], 16) }),
		name: n.name,
		kind: n.kind,
		startTimeUnixNano: nanos(n.start),
		endTimeUnixNano: nanos(n.end),
		attributes: [
			...n.attributes,
			attribute(
				"pi.durable.time_basis",
				n.kind === 3 ? "message_observation" : "message_observation_envelope",
			),
		],
		events: n.events,
		status: { code: n.failed ? 2 : 0 },
	};
}
function selected(
	evidence: Owned[],
	paths: Map<string, string[]>,
	options: ExportOptions,
): ExportDiagnostic[] {
	const root = options.conversation;
	return evidence
		.filter(({ owner }) => root === undefined || paths.get(owner)?.at(-1) === conversationKey(root))
		.map(({ diagnostic }) => diagnostic);
}
export function convert(snapshot: Snapshot, options: ExportOptions): ExportedTraces {
	const diagnostics: ExportDiagnostic[] = [];
	const nodes = containers(snapshot);
	const tools = addChats(snapshot, nodes, options);
	const evidence: Owned[] = [];
	addEvidence(snapshot, nodes, tools, options, evidence);
	const paths = ancestry(nodes);
	diagnostics.push(...selected(evidence, paths, options));
	// Widen ancestors using only committed message observations, not execution intervals or commit sequence numbers.
	for (const n of nodes.values()) {
		const { start, end } = n;
		for (const key of paths.get(n.key)?.slice(1) ?? []) {
			observe(get(nodes, key), start);
			observe(get(nodes, key), end);
		}
	}
	const roots = [...nodes.values()].filter((n) => n.parent === undefined);
	if (
		options.conversation !== undefined &&
		!roots.some((n) => n.key === conversationKey(options.conversation ?? 0))
	)
		throw new ExportFailure(
			"unknown_conversation",
			"Conversation selector must name an existing root; inspect conversation IDs in storage",
		);
	const traces: OtlpTrace[] = [];
	for (const root of roots) {
		if (options.conversation !== undefined && root.key !== conversationKey(options.conversation))
			continue;
		const traceId = hash(["pi-durable-otel", "trace", options.storageId, root.key], 32);
		// Compaction attempts charge the ledger without assistant entries, including failed attempts.
		// Task presence is conservative: no-op/hook-only tasks can also have incurred no model spend.
		for (const task of snapshot.tasks)
			if (task.kind === "pi.compaction" && paths.get(taskKey(task.id))?.at(-1) === root.key)
				diagnostics.push({ code: "compaction_usage_unavailable", entity: taskKey(task.id) });
		const spans: OtlpSpan[] = [];
		for (const n of nodes.values()) {
			const path = paths.get(n.key) ?? [];
			if (path.at(-1) !== root.key) continue;
			const span = emit(n, path, nodes, options.storageId, traceId);
			if (span) spans.push(span);
			else diagnostics.push({ code: "untimed_span", entity: n.key });
		}
		if (spans.length)
			traces.push({
				resourceSpans: [
					{
						resource: { attributes: [attribute("service.name", "pi-durable")] },
						scopeSpans: [{ scope: { name: "pi-durable-otel", version: "0.1.0" }, spans }],
					},
				],
			});
	}
	return { traces, diagnostics };
}
