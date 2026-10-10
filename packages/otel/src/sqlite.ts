import { realpath, stat } from "node:fs/promises";
import { versions } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { conversationRecord, entryRecord, integer, InvalidStorage, taskRecord } from "./records.ts";
import type { Snapshot } from "./records.ts";

export class ExportFailure extends Error {
	constructor(
		readonly code:
			| "storage_unreadable"
			| "invalid_storage"
			| "unsupported_schema"
			| "unsupported_runtime"
			| "uncheckpointed_wal"
			| "invalid_options"
			| "unknown_conversation",
		message: string,
	) {
		super(message);
	}
}
export function requireRuntime(version: string): void {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	if (major > 24 || (major === 24 && minor >= 21)) return;
	throw new ExportFailure(
		"unsupported_runtime",
		"Immutable SQLite export requires Node >=24.21.0; upgrade Node before exporting",
	);
}
async function requireCheckpoint(path: string): Promise<void> {
	const wal = await stat(`${path}-wal`).catch((error: unknown) => {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
			return undefined;
		throw new ExportFailure(
			"storage_unreadable",
			"Cannot inspect SQLite WAL; check file permissions",
		);
	});
	if (wal && wal.size > 0)
		throw new ExportFailure(
			"uncheckpointed_wal",
			"SQLite WAL contains data; stop writers and checkpoint through the host before exporting",
		);
}
function records<T extends { id: number }>(
	db: DatabaseSync,
	table: "conversations" | "entries" | "tasks",
	parse: (value: unknown) => T,
): T[] {
	return db
		.prepare(`SELECT id, record FROM ${table} ORDER BY id`)
		.all()
		.map((row) => {
			try {
				if (typeof row.record !== "string") throw new InvalidStorage("expected JSON record text");
				const raw: unknown = JSON.parse(row.record);
				const parsed = parse(raw);
				if (parsed.id !== integer(row.id))
					throw new InvalidStorage("record identity does not match table identity");
				return parsed;
			} catch {
				// Never repeat JSON/parser errors: malformed records can contain private content.
				throw new ExportFailure(
					"invalid_storage",
					`Invalid ${table} record ${integer(row.id)}; inspect storage with the pinned Pi version`,
				);
			}
		});
}

export async function readSqlite(path: string): Promise<Snapshot> {
	let db: DatabaseSync | undefined;
	try {
		requireRuntime(versions.node);
		const canonical = await realpath(path);
		if (!(await stat(canonical)).isFile())
			throw new ExportFailure(
				"storage_unreadable",
				"SQLite input is not a regular file; supply a checkpointed database",
			);
		await requireCheckpoint(canonical);
		// readOnly alone can create WAL/SHM sidecars. Immutable mode neither creates them nor recovers/checkpoints.
		db = new DatabaseSync(`${pathToFileURL(canonical).href}?mode=ro&immutable=1`, {
			readOnly: true,
		});
		db.exec("BEGIN");
		const schema = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get();
		if (schema?.version !== 1)
			throw new ExportFailure(
				"unsupported_schema",
				"Only Durable SQLite schema v1 is supported; export with a compatible Pi/package version",
			);
		const snapshot = {
			conversations: records(db, "conversations", conversationRecord),
			entries: records(db, "entries", entryRecord),
			tasks: records(db, "tasks", taskRecord),
		};
		db.exec("COMMIT");
		await requireCheckpoint(canonical);
		return snapshot;
	} catch (error) {
		if (error instanceof ExportFailure) throw error;
		throw new ExportFailure(
			"storage_unreadable",
			"Cannot read Durable SQLite schema v1; check path, permissions and storage format",
		);
	} finally {
		db?.close();
	}
}
