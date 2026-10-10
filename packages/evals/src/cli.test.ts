import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
function run(args: string[]) {
	return spawnSync(process.execPath, ["--experimental-transform-types", cli, ...args], {
		encoding: "utf8",
		timeout: 10_000,
	});
}
test("CLI help and invalid arguments use the actual entry point without model calls", () => {
	const help = run(["--help"]);
	expect(help.status).toBe(0);
	expect(help.stdout).toContain("score --config judges.mjs --since checkpoint.json");
	for (const args of [[], ["score", "--unknown"], ["score", "--since", "checkpoint.json"]]) {
		const invalid = run(args);
		expect(invalid.status).toBe(1);
		expect(invalid.stderr).toContain("usage:");
	}
});
test("CLI explicitly validates the host module and surfaces Result errors", async () => {
	const directory = await mkdtemp(join(tmpdir(), "score-cli-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const config = join(directory, "config.mjs");
	const args = [
		"score",
		"--config",
		config,
		"--since",
		join(directory, "checkpoint.json"),
		"--interval",
		"first",
		"--out",
		join(directory, "out"),
	];
	expect(run(args).stderr).toContain("Cannot load host JS configuration");
	await writeFile(config, "export default null;");
	expect(run(args).stderr).toContain("Invalid host configuration");
	await writeFile(config, "export default {};");
	const invalid = run(args);
	expect(invalid.status).toBe(1);
	expect(invalid.stderr).toContain("invalid_options:");
});
