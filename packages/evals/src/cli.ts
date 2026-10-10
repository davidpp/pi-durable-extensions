#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { scoreTraces } from "./index.ts";
import type { ScoringConfig } from "./index.ts";

const usage =
	"pi-durable-evals score --config judges.mjs --since checkpoint.json --interval ID --out DIR [trace.json…]";
async function main(): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			options: {
				config: { type: "string" },
				since: { type: "string" },
				interval: { type: "string" },
				out: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		});
	} catch {
		console.error(`Invalid arguments; usage: ${usage}`);
		return 1;
	}
	const { values, positionals } = parsed;
	if (values.help) {
		console.log(usage);
		return 0;
	}
	const [command, ...files] = positionals;
	if (command !== "score" || !values.config || !values.since || !values.interval || !values.out) {
		console.error(`Supply explicit scoring arguments; usage: ${usage}`);
		return 1;
	}
	let config: unknown;
	try {
		const module: { default?: unknown } = await import(pathToFileURL(resolve(values.config)).href);
		config = module.default;
	} catch {
		console.error(
			`Cannot load host JS configuration ${values.config}; supply a readable .mjs module with a default scoring configuration`,
		);
		return 1;
	}
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		console.error(
			`Invalid host configuration ${values.config}; export a default scoring configuration object`,
		);
		return 1;
	}
	// The host module is an untyped boundary; scoreTraces validates every configuration field before effects.
	const scoring = config as ScoringConfig;
	const result = await scoreTraces({
		...scoring,
		files,
		checkpoint: values.since,
		intervalId: values.interval,
		outDirectory: values.out,
	});
	if (!result.ok) {
		console.error(`${result.error.code}: ${result.error.message.replace(/[\r\n]/g, " ")}`);
		return 1;
	}
	console.log(JSON.stringify(result.value));
	return 0;
}
process.exitCode = await main();
