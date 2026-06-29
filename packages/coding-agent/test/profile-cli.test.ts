import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME, VERSION } from "../../utils/src/dirs";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const packageRoot = path.join(repoRoot, "packages", "coding-agent");

interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface WorkspacePackageJson {
	name?: unknown;
}

async function createCliSandbox(root: string): Promise<string> {
	const sandboxPackageRoot = path.join(root, "coding-agent");
	const nodeModulesScope = path.join(sandboxPackageRoot, "node_modules", "@oh-my-pi");
	await fs.mkdir(nodeModulesScope, { recursive: true });
	await fs.cp(path.join(packageRoot, "src"), path.join(sandboxPackageRoot, "src"), { recursive: true });

	for (const packageDir of await fs.readdir(path.join(repoRoot, "packages"))) {
		try {
			const packageRoot = path.join(repoRoot, "packages", packageDir);
			const packageJson = JSON.parse(
				await Bun.file(path.join(packageRoot, "package.json")).text(),
			) as WorkspacePackageJson;
			if (typeof packageJson.name !== "string" || !packageJson.name.startsWith("@oh-my-pi/")) continue;
			await fs.symlink(packageRoot, path.join(nodeModulesScope, packageJson.name.slice("@oh-my-pi/".length)), "dir");
		} catch {
			// Some package directories do not expose a workspace package entrypoint.
		}
	}

	return sandboxPackageRoot;
}

async function assertChildUsesWorkspaceUtils(
	childEnv: Record<string, string | undefined>,
	sandboxPackageRoot: string,
): Promise<void> {
	const proc = Bun.spawn(
		[
			process.execPath,
			"-e",
			`import { APP_NAME } from "@oh-my-pi/pi-utils/dirs"; if (APP_NAME !== "pi") { console.error(APP_NAME); process.exit(1); }`,
		],
		{
			cwd: sandboxPackageRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: childEnv,
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`CLI profile test resolved stale pi-utils (stdout: ${stdout.trim()}, stderr: ${stderr.trim()})`);
	}
}

async function runCliProcess(
	args: readonly string[],
	home: string,
	sandboxPackageRoot: string,
	env: Record<string, string | undefined> = {},
): Promise<CliResult> {
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		NO_COLOR: "1",
		PI_NO_TITLE: "1",
		...env,
	};
	if (env.PI_PROFILE === undefined) delete childEnv.PI_PROFILE;
	if (env.PI_PROFILE_BOOTSTRAP_SENTINEL === undefined) delete childEnv.PI_PROFILE_BOOTSTRAP_SENTINEL;
	await assertChildUsesWorkspaceUtils(childEnv, sandboxPackageRoot);

	const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
		cwd: sandboxPackageRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: childEnv,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe("global --profile flag", () => {
	let tempRoot = "";
	let tempHome = "";
	let sandboxPackageRoot = "";

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-profile-cli-home-"));
		tempHome = path.join(tempRoot, "home");
		await fs.mkdir(tempHome, { recursive: true });
		sandboxPackageRoot = await createCliSandbox(tempRoot);
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("accepts an explicit profile before dispatching root flags", async () => {
		const result = await runCliProcess(["--profile=work", "--version"], tempHome, sandboxPackageRoot);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`${APP_NAME}/${VERSION}`);
		expect(result.stderr).toBe("");
	});

	it("accepts a profile inherited from PI_PROFILE at run time", async () => {
		const result = await runCliProcess(["--version"], tempHome, sandboxPackageRoot, { PI_PROFILE: "work" });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`${APP_NAME}/${VERSION}`);
		expect(result.stderr).toBe("");
	});

	it("accepts the profile flag after other root flags", async () => {
		const result = await runCliProcess(["--version", "--profile", "office"], tempHome, sandboxPackageRoot);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`${APP_NAME}/${VERSION}`);
		expect(result.stderr).toBe("");
	});

	it("installs a shell alias and exits before command dispatch", async () => {
		const result = await runCliProcess(
			["--profile", "work", "--alias", "pi-work", "--version"],
			tempHome,
			sandboxPackageRoot,
			{
				SHELL: "/bin/bash",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Created pi-work");
		expect(result.stdout).not.toContain(`${APP_NAME}/${VERSION}`);
		const bashProfile = await Bun.file(
			path.join(tempHome, process.platform === "darwin" ? ".bash_profile" : ".bashrc"),
		).text();
		expect(bashProfile).toContain("# >>> pi profile alias: pi-work >>>");
		expect(bashProfile).toContain("--profile=work");
	});

	it("installs a shell alias when launch is explicit", async () => {
		const result = await runCliProcess(
			["launch", "--profile", "work", "--alias", "pi-work", "--version"],
			tempHome,
			sandboxPackageRoot,
			{
				SHELL: "/bin/bash",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Created pi-work");
		expect(result.stdout).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("installs a shell alias when acp is explicit", async () => {
		const result = await runCliProcess(
			["acp", "--profile", "work", "--alias", "pi-work", "--version"],
			tempHome,
			sandboxPackageRoot,
			{
				SHELL: "/bin/bash",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Created pi-work");
		expect(result.stdout).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("rejects missing profile values without dispatching", async () => {
		const result = await runCliProcess(["--profile", "--version"], tempHome, sandboxPackageRoot);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("--profile requires a profile name");
		expect(result.stdout).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("loads profile agent .env before command modules import pi-utils env", async () => {
		const defaultAgentDir = path.join(tempHome, ".pi", "agent");
		const profileAgentDir = path.join(tempHome, ".pi", "profiles", "work", "agent");
		await fs.mkdir(defaultAgentDir, { recursive: true });
		await fs.mkdir(profileAgentDir, { recursive: true });
		await Bun.write(path.join(defaultAgentDir, ".env"), "PI_PROFILE_BOOTSTRAP_SENTINEL=default\n");
		await Bun.write(path.join(profileAgentDir, ".env"), "PI_PROFILE_BOOTSTRAP_SENTINEL=work\n");

		const result = await runCliProcess(["--profile", "work", "--alias", "pi-work"], tempHome, sandboxPackageRoot, {
			SHELL: "/bin/bash",
		});

		expect(result.exitCode).toBe(0);
		const bashProfile = await Bun.file(
			path.join(tempHome, process.platform === "darwin" ? ".bash_profile" : ".bashrc"),
		).text();
		expect(bashProfile).toContain("# >>> pi profile alias: pi-work >>>");
		expect(bashProfile).toContain("--profile=work");
		expect(bashProfile).not.toContain("default");
	});

	it("surfaces an invalid PI_PROFILE env as a clean error", async () => {
		const result = await runCliProcess(["--version"], tempHome, sandboxPackageRoot, { PI_PROFILE: ".." });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Invalid PI profile");
		expect(result.stdout).not.toContain(`${APP_NAME}/${VERSION}`);
	});
});
