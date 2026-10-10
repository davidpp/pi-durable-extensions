// vitest-evals harness adapter for Pi Durable. Each eval case is one durable conversation in its own storage.
import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { AssistantEntry } from "@earendil-works/pi-durable";
import type { AgentChange, Harness as DurableHarness, UserInput } from "@earendil-works/pi-durable";
import { createHarness, normalizeRecord } from "vitest-evals/harness";
import type {
	Harness,
	HarnessRun,
	JsonValue,
	TranscriptEvent,
	UsageSummary,
} from "vitest-evals/harness";
import { createJudgeHarness } from "vitest-evals/judges";
import type {
	Judge,
	JudgeHarness,
	JudgeHarnessInput,
	JudgeHarnessOutput,
	JudgeOptions,
} from "vitest-evals/judges";

const ctx = BACKGROUND_CONTEXT;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** One durable conversation: agent configuration, the user input, and an optional key such as a sample index. */
export type DurableCase = { agent: AgentChange; prompt: UserInput; key?: JsonValue };

/** Opens the Durable harness on a case directory. The caller owns models, registry, settings and storage. */
export type OpenDurable = (directory: string) => Promise<DurableHarness>;

type CaseStore = {
	name: string;
	/**
	 * Root for per-case storage. A case directory is keyed by harness name, agent, prompt and key: an unchanged
	 * case reopens its committed answer without a model call, an interrupted one resumes, a changed one starts fresh.
	 * Durable has no multi-process lock; do not run the same case from two processes at once.
	 */
	directory: string;
	open: OpenDurable;
};

export type PiDurableHarnessOptions<TInput, TOutput extends JsonValue | undefined> = CaseStore & {
	case: (input: TInput) => DurableCase;
	output: (text: string, input: TInput) => TOutput;
};

/** A case failure whose message names only Durable state and the case directory, never stored content. */
export class DurableCaseError extends Error {}

type CaseRun = {
	text: string;
	run: Omit<HarnessRun<undefined>, "output">;
};

async function runCase({ name, directory: root, open }: CaseStore, durable: DurableCase) {
	// Tools and extensions hash by their JSON-visible fields; functions are not part of the key.
	const key = sha(JSON.stringify({ name, ...durable }));
	const directory = join(root, key.slice(0, 24));
	const reopened = await access(directory).then(
		() => true,
		() => false,
	);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const started = performance.now();
	const harness = await open(directory);
	try {
		const conversation = await harness.root(ctx, { agent: durable.agent });
		const before = totals(await harness.usage(ctx));
		// The same request ID finds the earlier submission, so reruns and resumes never submit twice.
		const submission = await conversation.submit(
			{ type: "input", content: durable.prompt, requestId: `eval:${key}` },
			ctx,
		);
		const settled = await submission.wait(ctx);
		if (settled.status !== "done" || settled.type !== "input")
			throw new DurableCaseError(
				`Durable submission did not complete in ${directory}: ${settled.status}`,
			);
		const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
		const message = answer?.model?.[0];
		if (message?.role !== "assistant" || message.stopReason !== "stop")
			throw new DurableCaseError(`No complete assistant answer; inspect ${directory}`);
		const after = totals(await harness.usage(ctx));
		const events = transcript((await conversation.context(ctx)).messages);
		const usage: UsageSummary = {
			// The model that produced the stored answer, which the configured reference need not resolve to.
			provider: message.provider,
			model: message.model,
			...after,
			toolCalls: events.filter((event) => event.type === "tool_call").length,
			// Usage is what the case cost to produce; a reopened case reports its stored spend, not new spend.
			metadata: {
				newCostUsd: after.costUsd - before.costUsd,
				newTotalTokens: after.totalTokens - before.totalTokens,
			},
		};
		return {
			text: blocksText(message.content),
			run: {
				session: { events },
				usage,
				timings: { totalMs: performance.now() - started },
				artifacts: {
					durable: {
						directory,
						conversation: conversation.id,
						submission: submission.id,
						reopened,
					},
				},
				errors: [],
			},
		} satisfies CaseRun;
	} finally {
		await harness.close(ctx);
	}
}

/** Application harness: `run(input)` runs `case(input)` as a durable conversation and maps the answer text. */
export function piDurableHarness<TInput, TOutput extends JsonValue | undefined>(
	options: PiDurableHarnessOptions<TInput, TOutput>,
): Harness<TInput, TOutput> {
	return createHarness<TInput, TOutput>({
		name: options.name,
		run: async ({ input }) => {
			const { text, run } = await runCase(options, options.case(input));
			// TypeScript cannot resolve HarnessRun's conditional `output` field for a generic TOutput.
			return { ...run, output: options.output(text, input) } as HarnessRun<TOutput>;
		},
	});
}

/** Optional request identity, passed unchanged through vitest-evals' `ctx.runJudge(...)`. */
export type DurableJudgeInput = JudgeHarnessInput & { key?: JsonValue };

/** Judge harness for `ctx.runJudge(...)`: the judge's system prompt becomes the agent instructions. */
export function piDurableJudgeHarness(
	options: CaseStore & {
		agent: Omit<AgentChange, "instructions">;
		/** Stable sample identity. Create a harness per sample to grade identical outputs independently. */
		key?: JsonValue;
	},
): Harness<DurableJudgeInput, JudgeHarnessOutput> {
	return createJudgeHarness({
		name: options.name,
		run: async ({ system, prompt, responseFormat, key }: DurableJudgeInput) => {
			const { text, run } = await runCase(options, {
				agent: { ...options.agent, instructions: system ?? "" },
				prompt,
				// Undefined preserves the original unkeyed JSON hash input, including existing stored judges.
				key:
					options.key === undefined && key === undefined
						? undefined
						: {
								...(options.key === undefined ? {} : { sample: options.key }),
								...(key === undefined ? {} : { request: key }),
							},
			});
			if (responseFormat?.type !== "json") return { ...run, output: text };
			let output: JsonValue;
			try {
				output = parseJsonObject(text);
			} catch {
				// Parser messages can quote the answer; name the stored case instead.
				throw new DurableCaseError(
					`Judge answer is not a JSON object; inspect ${run.artifacts.durable.directory}`,
				);
			}
			// A full HarnessRun: createJudgeHarness treats any other object as the raw judge output.
			return { ...run, output };
		},
	});
}

/** Compares the output with an assertion-supplied baseline in both presentation orders. */
export function piDurablePairwiseJudge<TInput, TOutput extends JsonValue>(options: {
	name: string;
	system: string;
	prompt: (comparison: { input: TInput; a: TOutput; b: TOutput }) => string;
	judgeHarness?: JudgeHarness;
}): Judge<JudgeOptions<TInput, TOutput, { baseline: TOutput }>> {
	return {
		name: options.name,
		judgeHarness: options.judgeHarness,
		assess: async ({ input, output, baseline, runJudge }) => {
			if (baseline === undefined)
				throw new Error(
					`Pairwise judge "${options.name}" requires a baseline; pass it in the toSatisfyJudge options`,
				);
			if (!runJudge)
				throw new Error(
					`Pairwise judge "${options.name}" requires a judgeHarness; configure one on the judge, suite or assertion`,
				);
			const ask = async (order: "ab" | "ba", a: TOutput, b: TOutput) => {
				try {
					const request: DurableJudgeInput = {
						system: `${options.system}\n\nReturn a JSON object with "preference": "A", "B", or "tie".`,
						prompt: options.prompt({ input, a, b }),
						responseFormat: { type: "json" },
						key: order,
					};
					const raw = await runJudge(request);
					return { raw, preference: pairwisePreference(raw) };
				} catch (cause) {
					const message = cause instanceof Error ? cause.message : String(cause);
					throw new Error(
						`Pairwise judge "${options.name}" failed for ${order}: ${message}; inspect the judge run and return JSON with preference A, B or tie`,
						{ cause },
					);
				}
			};
			const ab = await ask("ab", output, baseline);
			const ba = await ask("ba", baseline, output);
			const first = pairwiseSide(ab.preference, "A");
			const second = pairwiseSide(ba.preference, "B");
			const agree = first === second;
			const verdict = agree ? first : "tie";
			return {
				score: verdict === "candidate" ? 1 : verdict === "baseline" ? 0 : 0.5,
				metadata: {
					verdict: verdict === "candidate" ? "win" : verdict === "baseline" ? "loss" : "tie",
					agree,
					orderVerdicts: [first, second],
					ab: ab.raw,
					ba: ba.raw,
				},
			};
		},
	};
}

function pairwisePreference(raw: JudgeHarnessOutput): "A" | "B" | "tie" {
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
		const preference = raw.preference;
		if (preference === "A" || preference === "B" || preference === "tie") return preference;
	}
	throw new Error(`Invalid pairwise preference in ${JSON.stringify(raw)}`);
}

function pairwiseSide(preference: "A" | "B" | "tie", candidate: "A" | "B") {
	return preference === "tie" ? "tie" : preference === candidate ? "candidate" : "baseline";
}

/** The outermost JSON object in model text, tolerating code fences and prose around it. */
export function parseJsonObject(text: string): JsonValue {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("Answer has no JSON object");
	return JSON.parse(text.slice(start, end + 1));
}

function blocksText(content: string | readonly { type: string; text?: string }[]) {
	return typeof content === "string"
		? content
		: content
				.flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
				.join("\n");
}

function assistantEvents(message: Extract<Message, { role: "assistant" }>): TranscriptEvent[] {
	const text = blocksText(message.content);
	const events: TranscriptEvent[] = text
		? [
				{
					type: "message",
					role: "assistant",
					content: text,
					metadata: {
						model: `${message.provider}/${message.model}`,
						stopReason: message.stopReason,
					},
				},
			]
		: [];
	for (const block of message.content)
		if (block.type === "toolCall")
			events.push({
				type: "tool_call",
				id: block.id,
				name: block.name,
				arguments: normalizeRecord(block.arguments),
			});
	return events;
}

function transcript(messages: readonly Message[]): TranscriptEvent[] {
	return messages.flatMap((message): TranscriptEvent[] => {
		if (message.role === "assistant") return assistantEvents(message);
		const content = blocksText(message.content);
		if (message.role !== "toolResult") return [{ type: "message", role: message.role, content }];
		return [
			{
				type: "tool_result",
				toolCallId: message.toolCallId,
				name: message.toolName,
				content,
				...(message.isError ? { error: { message: content } } : {}),
			},
		];
	});
}

type UsageLedger = Awaited<ReturnType<DurableHarness["usage"]>>;
function totals(ledger: UsageLedger) {
	const sum = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: 0 };
	for (const usage of [...Object.values(ledger.models), ...Object.values(ledger.tools)]) {
		sum.inputTokens += usage.input;
		sum.outputTokens += usage.output;
		sum.reasoningTokens += usage.reasoning ?? 0;
		sum.totalTokens += usage.totalTokens;
		sum.costUsd += usage.cost.total;
	}
	return sum;
}
