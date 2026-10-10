import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { exportTrace } from "./index.ts";
import { requireRuntime } from "./sqlite.ts";

// Mock runtime metadata only in this isolated test module, not the SQLite implementation.
vi.mock("node:process", () => ({ versions: { node: "22.13.0" } }));

test("the public API rejects an unsupported runtime before opening or creating input files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-otel-runtime-"));
	try {
		expect(
			await exportTrace(join(directory, "missing.sqlite"), { storageId: "runtime-test" }),
		).toMatchObject({
			ok: false,
			error: { code: "unsupported_runtime", message: expect.stringContaining("upgrade Node") },
		});
		expect(await readdir(directory)).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects runtimes below the verified immutable-URI minimum with an upgrade action", () => {
	for (const version of ["22.13.0", "22.21.0", "24.20.0", "24.0.0"]) {
		expect(() => requireRuntime(version)).toThrow("upgrade Node before exporting");
		try {
			requireRuntime(version);
		} catch (error) {
			expect(error).toMatchObject({ code: "unsupported_runtime" });
		}
	}
	for (const version of ["24.21.0", "24.22.0", "25.0.0"])
		expect(() => requireRuntime(version)).not.toThrow();
});
