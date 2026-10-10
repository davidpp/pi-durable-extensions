#!/usr/bin/env node
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { exportTrace } from "./index.ts";
import type { OtlpTrace } from "./index.ts";

const usage = "pi-durable-otel <storage.sqlite…> [--out DIR] [--content] [--storage-id ID]";
const isMissing = (error: unknown) =>
	typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
async function main(): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			options: {
				out: { type: "string" },
				content: { type: "boolean" },
				"storage-id": { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		});
	} catch {
		console.error(`Invalid arguments; usage: ${usage}`);
		return 1;
	}
	const { values, positionals: paths } = parsed;
	if (values.help) {
		console.log(usage);
		return 0;
	}
	if (paths.length === 0 || (values["storage-id"] !== undefined && paths.length !== 1)) {
		console.error(`Supply input paths; --storage-id requires exactly one path; usage: ${usage}`);
		return 1;
	}
	const traces: OtlpTrace[] = [];
	for (const path of paths) {
		const result = await exportTrace(path, {
			storageId: values["storage-id"] ?? resolve(path),
			includeContent: values.content === true,
		});
		if (!result.ok) {
			console.error(`${path}: ${result.error.code}: ${result.error.message}`);
			return 1;
		}
		if (result.value.diagnostics.length)
			console.error(JSON.stringify({ path, diagnostics: result.value.diagnostics }));
		traces.push(...result.value.traces);
	}
	const out = values.out;
	if (out === undefined) {
		console.log(JSON.stringify({ resourceSpans: traces.flatMap((trace) => trace.resourceSpans) }));
		return 0;
	}
	try {
		const files = traces.map((trace) => {
			const id = trace.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.traceId;
			if (!id) throw new Error("No trace identity");
			return { path: join(out, `${id}.json`), trace };
		});
		if (new Set(files.map((file) => file.path)).size !== files.length)
			throw new Error("Duplicate trace identity");
		// Refuse before the first write so a collision never leaves a partial export behind.
		for (const { path } of files)
			if (
				await lstat(path).then(
					() => true,
					(error: unknown) => !isMissing(error),
				)
			)
				throw new Error("Existing trace file");
		await mkdir(out, { recursive: true, mode: 0o700 });
		for (const { path, trace } of files)
			// Exclusive writes still protect inputs/symlinks against a file created after the check.
			await writeFile(path, `${JSON.stringify(trace)}\n`, { flag: "wx", mode: 0o600 });
		return 0;
	} catch {
		console.error(
			`${out}: Cannot write trace files; choose a writable directory without existing trace-ID files`,
		);
		return 1;
	}
}
process.exitCode = await main();
