import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

type Registry =
	| "published"
	| "absent"
	| "network"
	| "auth"
	| "malformed"
	| "wrong-version"
	| "unstructured-404";
type State = {
	status: string;
	head: string;
	registry: Record<string, Registry>;
	tags: Record<string, string>;
	publishFailures: number;
};

const bun = execFileSync("bun", ["-e", "console.log(process.execPath)"], {
	encoding: "utf8",
}).trim();

async function sandbox(
	run: (fixture: {
		invoke: (dryRun?: boolean) => ReturnType<typeof spawnSync>;
		commands: () => Promise<string[]>;
		state: () => Promise<State>;
		update: (state: State) => Promise<void>;
	}) => Promise<void>,
	overrides: Partial<State> = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-release-"));
	try {
		const scripts = join(directory, "scripts");
		const bin = join(directory, "bin");
		await mkdir(scripts);
		await mkdir(bin);
		await copyFile(new URL("./release.ts", import.meta.url), join(scripts, "release.ts"));
		for (const name of ["a", "b", "private"]) {
			const workspace = join(directory, "packages", name);
			await mkdir(workspace, { recursive: true });
			await writeFile(
				join(workspace, "package.json"),
				JSON.stringify({ name, version: "0.1.0", private: name === "private" }),
			);
		}
		const statePath = join(directory, "state.json");
		const commandLog = join(directory, "commands.log");
		const update = (state: State) => writeFile(statePath, JSON.stringify(state));
		await update({
			status: "",
			head: "release-head",
			registry: { "a@0.1.0": "absent", "b@0.1.0": "absent" },
			tags: {},
			publishFailures: 0,
			...overrides,
		});
		// Every external command is replaced. Unknown arguments fail closed in the sandbox.
		for (const command of ["bun", "npm", "git"]) {
			await writeFile(
				join(bin, command),
				`#!${bun}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const command = ${JSON.stringify(command)};
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.STATE_PATH, "utf8"));
appendFileSync(process.env.COMMAND_LOG, command + " " + args.join(" ") + "\\n");
const save = () => writeFileSync(process.env.STATE_PATH, JSON.stringify(state));
const output = value => console.log(value);
if (command === "npm" && args[0] === "view" && args[2] === "version" && args[3] === "--json") {
  const mode = state.registry[args[1]];
  if (mode === "published") { output(JSON.stringify("0.1.0")); process.exit(0); }
  if (mode === "wrong-version") { output(JSON.stringify("0.2.0")); process.exit(0); }
  if (mode === "absent") { output(JSON.stringify({ error: { code: "E404" } })); process.exit(1); }
  if (mode === "network" || mode === "auth") { output(JSON.stringify({ error: { code: mode === "auth" ? "E401" : "ECONNRESET" } })); process.exit(1); }
  if (mode === "malformed" || mode === "unstructured-404") { output(mode === "malformed" ? "not JSON" : "E404 Not Found"); process.exit(1); }
}
if (command === "git") {
  if (args.join(" ") === "status --porcelain --untracked-files=all") { output(state.status); process.exit(0); }
  if (args.join(" ") === "rev-parse --verify HEAD") { output(state.head); process.exit(0); }
  if (args.slice(0, 3).join(" ") === "show-ref --verify --quiet") { process.exit(Object.hasOwn(state.tags, args[3].slice(10)) ? 0 : 1); }
  if (args.slice(0, 2).join(" ") === "rev-parse --verify") {
    const commit = state.tags[args[2].slice(10, -9)];
    if (!commit || commit === "not-a-commit") process.exit(1);
    output(commit); process.exit(0);
  }
  if (args[0] === "tag" && args.length === 3 && !Object.hasOwn(state.tags, args[1])) { state.tags[args[1]] = args[2]; save(); process.exit(0); }
}
if (command === "bun" && (args.join(" ") === "publish --dry-run" || args.join(" ") === "publish --access public")) {
  if (args[1] === "--dry-run") process.exit(0);
  if (state.publishFailures > 0) { state.publishFailures--; save(); console.error("simulated publication failure"); process.exit(1); }
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  state.registry[manifest.name + "@" + manifest.version] = "published"; save(); process.exit(0);
}
console.error("Unexpected fake command", command, args); process.exit(99);
`,
				{ mode: 0o755 },
			);
		}
		await writeFile(commandLog, "");
		await run({
			invoke: (dryRun = false) =>
				spawnSync(bun, [join(scripts, "release.ts"), ...(dryRun ? ["--dry-run"] : [])], {
					encoding: "utf8",
					env: { ...process.env, PATH: bin, STATE_PATH: statePath, COMMAND_LOG: commandLog },
				}),
			commands: async () => (await readFile(commandLog, "utf8")).trim().split("\n").filter(Boolean),
			state: async () => JSON.parse(await readFile(statePath, "utf8")),
			update,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const mutations = (commands: string[]) =>
	commands.filter(
		(command) => command.startsWith("git tag ") || command === "bun publish --access public",
	);

test("dry-run packs every public package without registry lookup or Git access", async () => {
	await sandbox(
		async ({ invoke, commands }) => {
			const result = invoke(true);
			expect(result.status, String(result.stderr)).toBe(0);
			expect(await commands()).toEqual(["bun publish --dry-run", "bun publish --dry-run"]);
			expect(result.stdout).toContain("dry run a@0.1.0: packed, not published");
			expect(result.stdout).toContain("dry run b@0.1.0: packed, not published");
			expect(result.stdout).not.toContain("private@0.1.0");
		},
		{ status: "?? untracked", registry: {} },
	);
});

test.each([" M tracked", "M  staged", "?? untracked"])(
	"rejects dirty/untracked tree: %s",
	async (status) => {
		await sandbox(
			async ({ invoke, commands }) => {
				const result = invoke();
				expect(result.status).not.toBe(0);
				expect(result.stderr).toContain("clean committed tree");
				expect(await commands()).toEqual(["git status --porcelain --untracked-files=all"]);
			},
			{ status },
		);
	},
);

test.each<Registry>(["network", "auth", "malformed", "wrong-version", "unstructured-404"])(
	"registry %s fails closed before any mutation",
	async (mode) => {
		await sandbox(
			async ({ invoke, commands }) => {
				const result = invoke();
				expect(result.status).not.toBe(0);
				expect(result.stderr).toContain("Registry lookup failed for b@0.1.0");
				expect(await commands()).toContain("npm view a@0.1.0 version --json");
				expect(mutations(await commands())).toEqual([]);
			},
			{ registry: { "a@0.1.0": "absent", "b@0.1.0": mode } },
		);
	},
);

test("published historical tags resolve to commits and skip without requiring current HEAD", async () => {
	await sandbox(
		async ({ invoke, commands }) => {
			const result = invoke();
			expect(result.status, String(result.stderr)).toBe(0);
			expect(result.stdout).toContain("skip a@0.1.0: already on npm");
			expect(mutations(await commands())).toEqual([]);
		},
		{
			registry: { "a@0.1.0": "published", "b@0.1.0": "published" },
			tags: { "a@0.1.0": "historical-a", "b@0.1.0": "historical-b" },
		},
	);
});

test("unpublished wrong-HEAD tag aborts all packages before mutation", async () => {
	await sandbox(
		async ({ invoke, commands }) => {
			const result = invoke();
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Tag b@0.1.0 differs from release HEAD release-head");
			expect(mutations(await commands())).toEqual([]);
		},
		{ tags: { "b@0.1.0": "historical" } },
	);
});

test("existing tag must resolve to a commit", async () => {
	await sandbox(
		async ({ invoke, commands }) => {
			const result = invoke();
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Tag a@0.1.0 does not resolve to a commit");
			expect(mutations(await commands())).toEqual([]);
		},
		{
			registry: { "a@0.1.0": "published", "b@0.1.0": "absent" },
			tags: { "a@0.1.0": "not-a-commit" },
		},
	);
});

test("published missing tag requires manual provenance verification, then accepts recovery", async () => {
	await sandbox(
		async ({ invoke, commands, state, update }) => {
			const failed = invoke();
			expect(failed.status).not.toBe(0);
			expect(failed.stderr).toContain(
				"verify the published artifact's source commit, manually tag that commit with a@0.1.0",
			);
			expect(mutations(await commands())).toEqual([]);
			const recovered = await state();
			recovered.tags["a@0.1.0"] = "verified-historical-commit";
			await update(recovered);
			const retried = invoke();
			expect(retried.status, String(retried.stderr)).toBe(0);
			expect(mutations(await commands())).toEqual([]);
		},
		{
			registry: { "a@0.1.0": "published", "b@0.1.0": "published" },
			tags: { "b@0.1.0": "historical" },
		},
	);
});

test("publication failure retains intent tag and same-HEAD retry publishes without retagging", async () => {
	await sandbox(
		async ({ invoke, commands, state }) => {
			const failed = invoke();
			expect(failed.status).not.toBe(0);
			expect(failed.stderr).toContain("simulated publication failure");
			expect((await state()).tags).toEqual({ "a@0.1.0": "release-head" });
			expect(mutations(await commands())).toEqual([
				"git tag a@0.1.0 release-head",
				"bun publish --access public",
			]);
			const retried = invoke();
			expect(retried.status, String(retried.stderr)).toBe(0);
			expect((await state()).registry).toEqual({ "a@0.1.0": "published", "b@0.1.0": "published" });
			expect(mutations(await commands())).toEqual([
				"git tag a@0.1.0 release-head",
				"bun publish --access public",
				"bun publish --access public",
				"git tag b@0.1.0 release-head",
				"bun publish --access public",
			]);
			expect(retried.stdout).toContain("Release succeeded");
		},
		{ publishFailures: 1 },
	);
});
