import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getActiveProfile,
	getAuthBrokerSnapshotCachePath,
	getConfigDirName,
	getDocumentConversionCacheDir,
	getGithubCacheDbPath,
	getProfileRootDir,
	getWorktreesDir,
	setAgentDir,
	setWorktreesDir,
} from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

const migratedPathEnvKeys = [
	"PI_WORKTREE_DIR",
	"OMP_WORKTREE_DIR",
	"PI_GITHUB_CACHE_DB",
	"OMP_GITHUB_CACHE_DB",
	"PI_AUTH_BROKER_SNAPSHOT_CACHE",
	"OMP_AUTH_BROKER_SNAPSHOT_CACHE",
] as const;

describe("migrated path env overrides", () => {
	let originalEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		originalEnv = {};
		for (const key of migratedPathEnvKeys) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		setWorktreesDir(undefined);
		__resetDirsFromEnvForTests();
	});

	afterEach(() => {
		for (const key of migratedPathEnvKeys) {
			restoreEnv(key, originalEnv[key]);
		}
		setWorktreesDir(undefined);
		__resetDirsFromEnvForTests();
	});

	it("prefers PI_* overrides over legacy OMP_* fallbacks", () => {
		const piWorktrees = path.join(os.tmpdir(), "pi-worktrees", Snowflake.next());
		const ompWorktrees = path.join(os.tmpdir(), "omp-worktrees", Snowflake.next());
		const piGithubDb = path.join(os.tmpdir(), "pi-github-cache.db");
		const ompGithubDb = path.join(os.tmpdir(), "omp-github-cache.db");
		const piAuthCache = path.join(os.tmpdir(), "pi-auth-broker-snapshot.enc");
		const ompAuthCache = path.join(os.tmpdir(), "omp-auth-broker-snapshot.enc");

		process.env.PI_WORKTREE_DIR = piWorktrees;
		process.env.OMP_WORKTREE_DIR = ompWorktrees;
		process.env.PI_GITHUB_CACHE_DB = piGithubDb;
		process.env.OMP_GITHUB_CACHE_DB = ompGithubDb;
		process.env.PI_AUTH_BROKER_SNAPSHOT_CACHE = piAuthCache;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = ompAuthCache;

		expect(getWorktreesDir()).toBe(piWorktrees);
		expect(getGithubCacheDbPath()).toBe(piGithubDb);
		expect(getAuthBrokerSnapshotCachePath()).toBe(piAuthCache);
	});

	it("uses legacy OMP_* fallbacks when PI_* overrides are unset", () => {
		const ompWorktrees = path.join(os.tmpdir(), "omp-worktrees", Snowflake.next());
		const ompGithubDb = path.join(os.tmpdir(), "omp-github-cache.db");
		const ompAuthCache = path.join(os.tmpdir(), "omp-auth-broker-snapshot.enc");

		process.env.OMP_WORKTREE_DIR = ompWorktrees;
		process.env.OMP_GITHUB_CACHE_DB = ompGithubDb;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = ompAuthCache;

		expect(getWorktreesDir()).toBe(ompWorktrees);
		expect(getGithubCacheDbPath()).toBe(ompGithubDb);
		expect(getAuthBrokerSnapshotCachePath()).toBe(ompAuthCache);
	});

	it("ignores empty PI_* overrides before resolving legacy fallbacks", () => {
		const ompWorktrees = path.join(os.tmpdir(), "omp-worktrees", Snowflake.next());
		const ompGithubDb = path.join(os.tmpdir(), "omp-github-cache.db");
		const ompAuthCache = path.join(os.tmpdir(), "omp-auth-broker-snapshot.enc");

		process.env.PI_WORKTREE_DIR = " \t";
		process.env.OMP_WORKTREE_DIR = ompWorktrees;
		process.env.PI_GITHUB_CACHE_DB = "";
		process.env.OMP_GITHUB_CACHE_DB = ompGithubDb;
		process.env.PI_AUTH_BROKER_SNAPSHOT_CACHE = "\n";
		process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = ompAuthCache;

		expect(getWorktreesDir()).toBe(ompWorktrees);
		expect(getGithubCacheDbPath()).toBe(ompGithubDb);
		expect(getAuthBrokerSnapshotCachePath()).toBe(ompAuthCache);
	});

	it("uses default paths when PI_* overrides are empty and legacy fallbacks are unset", () => {
		const defaultWorktrees = getWorktreesDir();
		const defaultGithubDb = getGithubCacheDbPath();
		const defaultAuthCache = getAuthBrokerSnapshotCachePath();

		process.env.PI_WORKTREE_DIR = "";
		process.env.PI_GITHUB_CACHE_DB = " \t";
		process.env.PI_AUTH_BROKER_SNAPSHOT_CACHE = "\n";

		expect(getWorktreesDir()).toBe(defaultWorktrees);
		expect(getGithubCacheDbPath()).toBe(defaultGithubDb);
		expect(getAuthBrokerSnapshotCachePath()).toBe(defaultAuthCache);
	});
});

describe("document conversion cache directory", () => {
	let tempRoot = "";
	let originalPiProfile: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(async () => {
		originalPiProfile = process.env.PI_PROFILE;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		tempRoot = path.join(os.tmpdir(), "pi-utils-document-cache", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
	});

	afterEach(async () => {
		restoreEnv("PI_PROFILE", originalPiProfile);
		restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("uses XDG_CACHE_HOME for the default agent dir when $XDG_CACHE_HOME/pi exists", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
		await fs.mkdir(path.join(process.env.XDG_CACHE_HOME, "pi"), { recursive: true });

		const defaultAgentDir = path.join(os.homedir(), getConfigDirName(), "agent");
		setAgentDir(defaultAgentDir);

		expect(getDocumentConversionCacheDir()).toBe(
			path.join(process.env.XDG_CACHE_HOME, "pi", "cache", "document-conversions"),
		);
	});

	it("stays under a custom agent dir override", () => {
		const customAgentDir = path.join(tempRoot, "custom-agent");

		setAgentDir(customAgentDir);

		expect(getDocumentConversionCacheDir()).toBe(path.join(customAgentDir, "cache", "document-conversions"));
	});
});

describe("test directory state cleanup", () => {
	it("restores the active profile from the current env after setAgentDir mutations", () => {
		const originalPiProfile = process.env.PI_PROFILE;
		const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		try {
			process.env.PI_PROFILE = "cache-profile";
			delete process.env.XDG_CACHE_HOME;
			__resetDirsFromEnvForTests();

			setAgentDir(path.join(os.tmpdir(), "pi-utils-document-cache", Snowflake.next(), "agent"));
			expect(getActiveProfile()).toBe("cache-profile");

			process.env.PI_PROFILE = "cache-profile";
			__resetDirsFromEnvForTests();

			expect(getActiveProfile()).toBe("cache-profile");
			expect(getDocumentConversionCacheDir()).toBe(
				path.join(getProfileRootDir("cache-profile"), "agent", "cache", "document-conversions"),
			);
		} finally {
			restoreEnv("PI_PROFILE", originalPiProfile);
			restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
			__resetDirsFromEnvForTests();
		}
	});
});
