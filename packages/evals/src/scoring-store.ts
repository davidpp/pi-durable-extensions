import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "vitest-evals/harness";
import {
	canonical,
	digest,
	hash,
	json,
	nano,
	record,
	ScoreFailure,
	snapshot,
} from "./scoring-data.ts";
import type { JsonRecord } from "./scoring-data.ts";

export type AnchorStamp = { id: string; hash: string };
export type Checkpoint = {
	version: 1;
	seen: string[];
	anchors: AnchorStamp[];
	maxObservedTimeUnixNano: string;
};
const hex = (value: unknown, length: number): value is string =>
	typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const missing = (error: unknown) =>
	error instanceof Error && "code" in error && error.code === "ENOENT";
export function parseCheckpoint(value: JsonValue): Checkpoint | null {
	if (value === null) return null;
	if (
		!record(value) ||
		value.version !== 1 ||
		!Array.isArray(value.seen) ||
		!value.seen.every((entry): entry is string => hex(entry, 64)) ||
		new Set(value.seen).size !== value.seen.length ||
		!Array.isArray(value.anchors) ||
		value.anchors.length === 0
	)
		throw new ScoreFailure(
			"invalid_checkpoint",
			"Malformed checkpoint ledger; restore a valid checkpoint, do not reset it silently",
		);
	const anchors: AnchorStamp[] = [];
	for (const entry of value.anchors) {
		if (!record(entry) || !hex(entry.id, 32) || /^0+$/.test(entry.id) || !hex(entry.hash, 64))
			throw new ScoreFailure(
				"invalid_checkpoint",
				"Malformed frozen anchors; restore a valid checkpoint",
			);
		anchors.push({ id: entry.id, hash: entry.hash });
	}
	if (new Set(anchors.map((entry) => entry.id)).size !== anchors.length)
		throw new ScoreFailure(
			"invalid_checkpoint",
			"Duplicate checkpoint anchors; restore a valid checkpoint",
		);
	let time: string;
	try {
		time = nano(value.maxObservedTimeUnixNano);
	} catch {
		throw new ScoreFailure(
			"invalid_checkpoint",
			"Malformed checkpoint timestamp; restore a valid checkpoint",
		);
	}
	const parsed = {
		version: 1,
		seen: value.seen,
		anchors,
		maxObservedTimeUnixNano: time,
	} satisfies Checkpoint;
	if (canonical(snapshot(parsed)) !== canonical(value))
		throw new ScoreFailure(
			"invalid_checkpoint",
			"Unsupported checkpoint fields or encoding; supply the version 1 snapshot ledger",
		);
	return parsed;
}
export const checkpointHash = (value: Checkpoint | null) => hash(snapshot(value));
export async function readCheckpoint(path: string): Promise<Checkpoint | null> {
	try {
		if (!(await lstat(path)).isFile()) throw new Error("Not a regular file");
		const value = json(await readFile(path, "utf8"));
		const parsed = parseCheckpoint(value);
		if (!parsed) throw new Error("Null checkpoint");
		return parsed;
	} catch (error) {
		if (missing(error)) return null;
		throw new ScoreFailure(
			"invalid_checkpoint",
			`Cannot read checkpoint ${path}; restore a valid regular ledger file`,
		);
	}
}
export async function readPlan(directory: string): Promise<JsonRecord | undefined> {
	try {
		await lstat(directory);
	} catch (error) {
		if (missing(error)) return undefined;
		throw new ScoreFailure(
			"io_error",
			`Cannot inspect interval directory ${directory}; choose a readable output directory`,
		);
	}
	try {
		if (
			!(await lstat(directory)).isDirectory() ||
			!(await lstat(join(directory, "plan.json"))).isFile()
		)
			throw new Error("Not an owned interval");
		const plan = json(await readFile(join(directory, "plan.json"), "utf8"));
		if (!record(plan)) throw new Error("Not a plan");
		return plan;
	} catch {
		throw new ScoreFailure(
			"conflict",
			`Unrecognized interval directory ${directory}; use a new interval ID without replacing unrelated output`,
		);
	}
}
export async function createPlan(directory: string, plan: JsonRecord): Promise<void> {
	try {
		await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
		await mkdir(directory, { mode: 0o700 });
		await writeFile(join(directory, "plan.json"), `${canonical(plan)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	} catch {
		throw new ScoreFailure(
			"io_error",
			`Cannot reserve interval directory ${directory}; choose a writable unused interval ID`,
		);
	}
}
async function atomicWrite(path: string, text: string): Promise<void> {
	const temporary = join(dirname(path), `.pi-evals-${randomUUID()}.tmp`);
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} catch {
		throw new ScoreFailure(
			"io_error",
			`Cannot write ${path}; choose a writable owned output/checkpoint location`,
		);
	} finally {
		await rm(temporary, { force: true });
	}
}
export async function saveBundle(
	directory: string,
	planHash: string,
	files: Map<string, string>,
): Promise<void> {
	const checksums: JsonRecord = {};
	for (const [name, text] of files) {
		await atomicWrite(join(directory, name), text);
		checksums[name] = digest(text);
	}
	await atomicWrite(
		join(directory, "commit.json"),
		`${canonical({ version: 1, planHash, files: checksums })}\n`,
	);
}
export async function loadBundle(
	directory: string,
	planHash: string,
	names: string[],
): Promise<Map<string, string> | undefined> {
	const commitPath = join(directory, "commit.json");
	try {
		await lstat(commitPath);
	} catch (error) {
		if (missing(error)) return undefined;
		throw new ScoreFailure(
			"io_error",
			`Cannot inspect ${commitPath}; restore access to the interval bundle`,
		);
	}
	try {
		if (!(await lstat(commitPath)).isFile()) throw new Error("Not a regular manifest");
		const manifest = json(await readFile(commitPath, "utf8"));
		if (
			!record(manifest) ||
			manifest.version !== 1 ||
			manifest.planHash !== planHash ||
			!record(manifest.files) ||
			Object.keys(manifest).sort().join(",") !== "files,planHash,version" ||
			Object.keys(manifest.files).sort().join(",") !== [...names].sort().join(",")
		)
			throw new Error("Manifest differs from expected plan");
		const files = new Map<string, string>();
		// Names come only from the validated plan, never from manifest-controlled paths.
		for (const name of names) {
			const path = join(directory, name);
			if (!(await lstat(path)).isFile()) throw new Error("Not a regular artifact");
			const text = await readFile(path, "utf8");
			if (manifest.files[name] !== digest(text)) throw new Error("Artifact checksum mismatch");
			files.set(name, text);
		}
		return files;
	} catch {
		throw new ScoreFailure(
			"conflict",
			`Invalid committed bundle ${directory}; restore its artifacts/manifest before retrying`,
		);
	}
}
function covers(current: Checkpoint, next: Checkpoint): boolean {
	const seen = new Set(current.seen);
	return (
		canonical(snapshot(current.anchors)) === canonical(snapshot(next.anchors)) &&
		BigInt(current.maxObservedTimeUnixNano) >= BigInt(next.maxObservedTimeUnixNano) &&
		next.seen.every((key) => seen.has(key))
	);
}
export async function advanceCheckpoint(
	path: string,
	base: Checkpoint | null,
	next: Checkpoint,
	replayed: boolean,
): Promise<void> {
	const current = await readCheckpoint(path);
	if (
		current &&
		(checkpointHash(current) === checkpointHash(next) || (replayed && covers(current, next)))
	)
		return;
	if (checkpointHash(current) !== checkpointHash(base))
		throw new ScoreFailure(
			"conflict",
			`Checkpoint ${path} changed during this interval; serialize runs and retry against the original ledger`,
		);
	await atomicWrite(path, `${canonical(snapshot(next))}\n`);
}
