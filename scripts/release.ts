import { readdir } from "node:fs/promises";
import { join } from "node:path";
// Dry-run packs every public package without registry or Git access.
import { $ } from "bun";

const dryRun = process.argv.includes("--dry-run");
const root = join(import.meta.dir, "..");

type Manifest = { name: string; version: string; private?: boolean };
type Package = { directory: string; label: string; manifest: Manifest };

async function isPublished({ label, manifest }: Package) {
	const result = await $`npm view ${label} version --json`.quiet().nothrow();
	let response: unknown;
	try {
		response = JSON.parse(result.stdout.toString());
	} catch {
		throw new Error(
			`Registry lookup failed for ${label}: invalid JSON; check npm connectivity/authentication and retry.`,
		);
	}
	if (result.exitCode === 0 && response === manifest.version) return true;
	if (
		result.exitCode !== 0 &&
		typeof response === "object" &&
		response !== null &&
		"error" in response &&
		typeof response.error === "object" &&
		response.error !== null &&
		"code" in response.error &&
		response.error.code === "E404"
	)
		return false;
	throw new Error(
		`Registry lookup failed for ${label}: expected exact version or E404; check npm connectivity/authentication and retry.`,
	);
}

async function tagCommit(label: string) {
	const result = await $`git show-ref --verify --quiet ${`refs/tags/${label}`}`
		.cwd(root)
		.nothrow()
		.quiet();
	if (result.exitCode === 1) return undefined;
	if (result.exitCode !== 0)
		throw new Error(`Cannot inspect tag ${label}; fix Git state and retry.`);
	const commit = await $`git rev-parse --verify ${`refs/tags/${label}^{commit}`}`
		.cwd(root)
		.nothrow()
		.quiet();
	if (commit.exitCode !== 0)
		throw new Error(`Tag ${label} does not resolve to a commit; inspect it before releasing.`);
	return commit.stdout.toString().trim();
}

const packages: Package[] = [];
for (const entry of await readdir(join(root, "packages"))) {
	const directory = join(root, "packages", entry);
	const manifest: Manifest = await Bun.file(join(directory, "package.json")).json();
	if (!manifest.private)
		packages.push({ directory, label: `${manifest.name}@${manifest.version}`, manifest });
}

if (dryRun) {
	for (const { directory, label } of packages) {
		await $`bun publish --dry-run`.cwd(directory);
		console.log(`dry run ${label}: packed, not published`);
	}
} else {
	const status = await $`git status --porcelain --untracked-files=all`.cwd(root).quiet();
	if (status.stdout.toString().trim())
		throw new Error(
			"Release requires a clean committed tree; commit or remove pending changes and untracked files, then retry.",
		);
	const head = (await $`git rev-parse --verify HEAD`.cwd(root).quiet()).stdout.toString().trim();
	const plans = [];
	// Resolve every registry/tag state before creating tags or publishing any package.
	for (const pkg of packages) {
		const published = await isPublished(pkg);
		const commit = await tagCommit(pkg.label);
		if (published && commit === undefined)
			throw new Error(
				`Published ${pkg.label} has no local tag; verify the published artifact's source commit, manually tag that commit with ${pkg.label}, then retry.`,
			);
		if (!published && commit !== undefined && commit !== head)
			throw new Error(
				`Tag ${pkg.label} differs from release HEAD ${head}; if it was never pushed and the version is not on npm, delete it with git tag -d and retry; otherwise inspect the prior release attempt.`,
			);
		plans.push({ ...pkg, published, tagged: commit !== undefined });
	}
	for (const { directory, label, published, tagged } of plans) {
		if (published) {
			console.log(`skip ${label}: already on npm`);
			continue;
		}
		// The local tag records release intent, not proof of successful publication.
		if (!tagged) await $`git tag ${label} ${head}`.cwd(root);
		await $`bun publish --access public`.cwd(directory);
		console.log(`published ${label}`);
	}
	console.log(
		"Release succeeded; push version tags only after verifying all intended publications.",
	);
}
