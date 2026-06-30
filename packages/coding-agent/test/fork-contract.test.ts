import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { captureBaseline, commitToBranch } from "@oh-my-pi/pi-coding-agent/task/worktree";
import {
	__resetDirsFromEnvForTests,
	APP_NAME,
	CONFIG_DIR_NAME,
	getAgentDir,
	getGpuCachePath,
	removeWithRetries,
	setAgentDir,
} from "@oh-my-pi/pi-utils";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return stdout.trim();
}

async function createBranchFixture(): Promise<{ isolation: string; parent: string }> {
	const parent = await makeTempDir("pi-fork-contract-parent-");
	const isolation = await makeTempDir("pi-fork-contract-iso-");

	await runGit(parent, ["init", "-q", "-b", "main"]);
	await runGit(parent, ["config", "user.email", "parent@example.com"]);
	await runGit(parent, ["config", "user.name", "Parent User"]);
	await fs.writeFile(path.join(parent, "tracked.txt"), "base\n");
	await runGit(parent, ["add", "tracked.txt"]);
	await runGit(parent, ["commit", "-q", "-m", "initial"]);

	await runGit(parent, ["clone", "-q", "--no-hardlinks", "--local", parent, isolation]);
	await runGit(isolation, ["config", "user.email", "agent@example.com"]);
	await runGit(isolation, ["config", "user.name", "Agent User"]);

	return { isolation, parent };
}

describe("fork contract", () => {
	let originalAgentDir: string;
	let originalPiProfile: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(() => {
		originalAgentDir = getAgentDir();
		originalPiProfile = process.env.PI_PROFILE;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
	});

	afterEach(async () => {
		restoreEnv("PI_PROFILE", originalPiProfile);
		restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
		setAgentDir(originalAgentDir);
		__resetDirsFromEnvForTests();
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	it("exports the fork identity as pi", () => {
		expect(APP_NAME).toBe("pi");
		expect(CONFIG_DIR_NAME).toBe(".pi");
	});

	it("resolves the GPU cache under $XDG_CACHE_HOME/pi when the XDG app root exists", async () => {
		if (process.platform === "win32") return;

		const tempRoot = await makeTempDir("pi-fork-contract-xdg-");
		const xdgCacheHome = path.join(tempRoot, "cache");
		process.env.XDG_CACHE_HOME = xdgCacheHome;
		delete process.env.PI_PROFILE;
		await fs.mkdir(path.join(xdgCacheHome, APP_NAME), { recursive: true });
		// Reset the module-level active profile from env first, then neutralize any
		// inherited custom agent-dir override so the default-profile XDG contract is exercised.
		__resetDirsFromEnvForTests();
		setAgentDir(path.join(os.homedir(), CONFIG_DIR_NAME, "agent"));

		expect(getGpuCachePath()).toBe(path.join(xdgCacheHome, APP_NAME, "gpu_cache.json"));
	});

	it("creates pi/task branches when persisting isolation changes", async () => {
		const { isolation, parent } = await createBranchFixture();
		const baseline = await captureBaseline(parent);
		await fs.writeFile(path.join(isolation, "tracked.txt"), "fork contract\n");
		await runGit(isolation, ["add", "tracked.txt"]);
		await runGit(isolation, ["commit", "-q", "-m", "test: update tracked fixture"]);

		const taskId = "fork-contract";
		const result = await commitToBranch(isolation, baseline, taskId, undefined);

		expect(result?.branchName).toBe(`pi/task/${taskId}`);
		expect(await runGit(parent, ["branch", "--list", `pi/task/${taskId}`])).toBe(`pi/task/${taskId}`);
	});
});
