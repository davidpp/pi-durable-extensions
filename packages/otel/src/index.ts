import { ExportFailure, readSqlite } from "./sqlite.ts";
import { convert } from "./trace.ts";
import type { ExportOptions, ExportedTraces } from "./trace.ts";

export type { OtlpAttribute, OtlpEvent, OtlpSpan, OtlpTrace } from "./otlp.ts";
export type { ExportOptions, ExportDiagnostic, ExportedTraces } from "./trace.ts";
export type ExportResult =
	| { ok: true; value: ExportedTraces }
	| { ok: false; error: { code: ExportFailure["code"]; message: string } };

/** Export quiescent, checkpointed Durable SQLite v1. Opens immutable/read-only; never executes Durable code. */
export async function exportTrace(path: string, options: ExportOptions): Promise<ExportResult> {
	try {
		if (
			typeof path !== "string" ||
			path.length === 0 ||
			typeof options !== "object" ||
			options === null ||
			typeof options.storageId !== "string" ||
			options.storageId.trim().length === 0
		)
			throw new ExportFailure(
				"invalid_options",
				"Supply a SQLite path and nonempty stable storageId namespace",
			);
		if (
			options.conversation !== undefined &&
			(!Number.isSafeInteger(options.conversation) || options.conversation <= 0)
		)
			throw new ExportFailure(
				"invalid_options",
				"Conversation selector must be a positive integer root ID",
			);
		if (options.includeContent !== undefined && typeof options.includeContent !== "boolean")
			throw new ExportFailure("invalid_options", "includeContent must be an explicit boolean");
		return { ok: true, value: convert(await readSqlite(path), options) };
	} catch (error) {
		if (error instanceof ExportFailure)
			return { ok: false, error: { code: error.code, message: error.message } };
		// Internal errors can contain stored content. Preserve privacy at this package's public boundary.
		return {
			ok: false,
			error: {
				code: "invalid_storage",
				message: "Cannot convert Durable records; inspect storage with the pinned Pi version",
			},
		};
	}
}
