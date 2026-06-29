/**
 * Centralized path helpers for pi config directories.
 *
 * The config root is fixed at `.pi`; profile selection is handled separately
 * through `PI_PROFILE`.
 *
 * On Linux and macOS, when XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME
 * are set, default-profile paths resolve under `$XDG_*_HOME/pi/`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engines, version } from "../package.json" with { type: "json" };

/** App name (e.g. "pi") */
export const APP_NAME: string = "pi";

/** Config directory name (e.g. ".pi") */
export const CONFIG_DIR_NAME: string = ".pi";

/** Version (e.g. "1.0.0") */
export const VERSION: string = version;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Names Windows treats as reserved device aliases. Matches the basename
 * itself as well as any `BASENAME.<anything>` form, because Windows reserves
 * `CON.foo`/`PRN.txt`/etc. too — using them as a profile name would let
 * `setProfile` accept the input only for directory creation to fail later
 * with a confusing `ENOENT`/`EINVAL`. Case-insensitive: NTFS treats `CON`
 * and `con` identically.
 */
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * Normalize and validate a profile name. Returns `undefined` for the implicit
 * default (empty string, whitespace, or the explicit "default" sentinel) and
 * throws for syntactically invalid or platform-reserved names.
 *
 * Exported so consumers of `@oh-my-pi/pi-utils/dirs` (CLI bootstrap, tests,
 * downstream tools) can validate user input without re-deriving the rules.
 */
export function normalizeProfileName(profile: string | undefined): string | undefined {
	const normalized = profile?.trim();
	if (!normalized || normalized === "default") return undefined;
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		!PROFILE_NAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized)
	) {
		throw new Error(
			`Invalid PI profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
				`cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name ` +
				`(CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension).`,
		);
	}
	return normalized;
}

/**
 * Resolve the active profile from the profile env var. `PI_PROFILE` is the
 * only supported selector and an explicitly empty value selects the default
 * profile. Delegates validation/normalization to {@link normalizeProfileName}
 * (which throws on a syntactically invalid value).
 */
export function resolveProfileEnv(piProfile: string | undefined): string | undefined {
	return normalizeProfileName(piProfile);
}

function getProfileFromEnv(): string | undefined {
	return resolveProfileEnv(process.env.PI_PROFILE);
}

/**
 * Module-load profile resolution. Unlike {@link getProfileFromEnv}, an invalid
 * PI_PROFILE value does NOT throw here — a bad env var must not crash a bare
 * `import` of this module with an uncaught stack trace before the CLI's error
 * handling is in scope. The default profile is used instead; the CLI
 * re-validates the env (see `runCli` in coding-agent/src/cli.ts) so the user
 * still gets a clean "Invalid PI profile" message.
 */
function readProfileFromEnvSafe(): string | undefined {
	try {
		return getProfileFromEnv();
	} catch {
		return undefined;
	}
}

function getBaseConfigRoot(): string {
	return path.join(os.homedir(), getConfigDirName());
}

function getProfileConfigRoot(profile: string | undefined): string {
	const root = getBaseConfigRoot();
	return profile ? path.join(root, "profiles", profile) : root;
}
// =============================================================================
// Project directory
// =============================================================================

/**
 * On macOS, strip /private prefix only when both paths resolve to the same location.
 * This preserves aliases like /private/tmp -> /tmp without rewriting unrelated paths.
 */
function standardizeMacOSPath(p: string): string {
	if (process.platform !== "darwin" || !p.startsWith("/private/")) return p;
	const stripped = p.slice("/private".length);
	try {
		if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
			return stripped;
		}
	} catch {}
	return p;
}

export function resolveEquivalentPath(inputPath: string): string {
	const resolvedPath = path.resolve(inputPath);
	try {
		return fs.realpathSync(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

export function normalizePathForComparison(inputPath: string): string {
	const resolvedPath = resolveEquivalentPath(inputPath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

export function pathIsWithin(root: string, candidate: string): boolean {
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function relativePathWithinRoot(root: string, candidate: string): string | null {
	if (!pathIsWithin(root, candidate)) return null;
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative || null;
}

let projectDir = standardizeMacOSPath(process.cwd());

/** Get the project directory. */
export function getProjectDir(): string {
	return projectDir;
}

/** Set the project directory. */
export function setProjectDir(dir: string): void {
	projectDir = standardizeMacOSPath(path.resolve(dir));
	process.chdir(projectDir);
}

/**
 * Whether `dir` resolves to an existing directory. Any stat failure — a deleted
 * path (ENOENT), permission error, or a non-directory — returns `false`, so
 * callers can decide whether a directory is safe to `chdir` into or adopt as a
 * working directory before {@link setProjectDir} throws on it.
 */
export async function directoryExists(dir: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/** Get the config directory name relative to home (fixed ".pi"). */
export function getConfigDirName(): string {
	return CONFIG_DIR_NAME;
}

/** Get the config agent directory name relative to home (e.g. ".pi/agent"). */
export function getConfigAgentDirName(): string {
	const profile = getActiveProfile();
	return profile ? path.join(getConfigDirName(), "profiles", profile, "agent") : `${getConfigDirName()}/agent`;
}

// =============================================================================
// DirResolver — cached, XDG-aware path resolution
// =============================================================================

type XdgCategory = "data" | "state" | "cache";

/**
 * Resolves and caches all pi directory paths. On Linux, when XDG environment
 * variables are set, paths are redirected under $XDG_*_HOME/pi/. A new
 * instance is created whenever the agent directory changes, which naturally
 * invalidates all cached paths.
 */
class DirResolver {
	readonly configRoot: string;
	readonly agentDir: string;

	// Per-category base dirs. Without XDG, all three equal configRoot / agentDir.
	// With XDG on Linux, they point to $XDG_*_HOME/pi/.
	readonly #rootDirs: Record<XdgCategory, string>;
	readonly #agentDirs: Record<XdgCategory, string>;

	readonly #rootCache = new Map<string, string>();
	readonly #agentCache = new Map<string, string>();

	constructor(options: { agentDirOverride?: string; profile?: string } = {}) {
		const profile = normalizeProfileName(options.profile);
		this.configRoot = getProfileConfigRoot(profile);

		const defaultAgent = path.join(this.configRoot, "agent");
		const agentDirOverride = profile ? undefined : options.agentDirOverride;
		this.agentDir = agentDirOverride ? path.resolve(agentDirOverride) : defaultAgent;
		const isDefault = this.agentDir === defaultAgent;

		// XDG is a Linux convention. On supported platforms, default profile state
		// resolves under $XDG_*_HOME/pi once `pi config init-xdg` has migrated
		// the user's data. Named profiles follow a stricter rule: the XDG choice
		// is keyed on the profile-specific XDG path, never the base app root.
		//
		// Why: if we consulted the base app root for named profiles too, the same
		// profile could resolve to `~/.pi/profiles/<name>` on first activation
		// (when no $XDG_*_HOME/pi exists yet) and then silently move to
		// `$XDG_*_HOME/pi/profiles/<name>` the moment the base appeared, orphaning
		// the earlier state. Pinning on the profile path means a profile's location
		// is decided at first activation and stays put until the user explicitly
		// migrates it (e.g. by mkdir'ing the XDG profile dir).
		let xdgData: string | undefined;
		let xdgState: string | undefined;
		let xdgCache: string | undefined;
		if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
			const resolveIf = (envVar: string) => {
				const value = process.env[envVar];
				if (!value) return undefined;
				try {
					const appRoot = path.join(value, APP_NAME);
					if (profile) {
						const profilePath = path.join(appRoot, "profiles", profile);
						if (fs.existsSync(profilePath)) {
							return profilePath;
						}
						return undefined;
					}
					if (fs.existsSync(appRoot)) {
						return appRoot;
					}
				} catch {}
				return undefined;
			};
			xdgData = resolveIf("XDG_DATA_HOME");
			xdgState = resolveIf("XDG_STATE_HOME");
			xdgCache = resolveIf("XDG_CACHE_HOME");
		}

		this.#rootDirs = {
			data: xdgData ?? this.configRoot,
			state: xdgState ?? this.configRoot,
			cache: xdgCache ?? this.configRoot,
		};
		// XDG flattens the agent/ prefix: ~/.pi/agent/sessions → $XDG_DATA_HOME/pi/sessions
		this.#agentDirs = {
			data: xdgData ?? this.agentDir,
			state: xdgState ?? this.agentDir,
			cache: xdgCache ?? this.agentDir,
		};
	}

	/** Config-root subdirectory, with optional XDG override. */
	rootSubdir(subdir: string, xdg?: XdgCategory): string {
		const cached = this.#rootCache.get(subdir);
		if (cached) return cached;
		const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
		const result = path.join(base, subdir);
		this.#rootCache.set(subdir, result);
		return result;
	}

	/** Agent subdirectory, with optional XDG override. */
	agentSubdir(userAgentDir: string | undefined, subdir: string, xdg?: XdgCategory): string {
		if (!userAgentDir || userAgentDir === this.agentDir) {
			const cached = this.#agentCache.get(subdir);
			if (cached) return cached;
			const base = xdg ? this.#agentDirs[xdg] : this.agentDir;
			const result = path.join(base, subdir);
			this.#agentCache.set(subdir, result);
			return result;
		}
		return path.join(userAgentDir, subdir);
	}
}

let activeProfile = readProfileFromEnvSafe();
let agentDirOverride: string | undefined;

function resolveActiveAgentDirOverride(): string | undefined {
	return activeProfile ? undefined : agentDirOverride;
}

let dirs = new DirResolver({
	agentDirOverride: resolveActiveAgentDirOverride(),
	profile: activeProfile,
});

/**
 * Rebuild the dirs resolver from the current environment, reusing the
 * module-load profile. Directory-affecting keys (XDG_*_HOME) loaded from a
 * profile/agent `.env` only reach `process.env` *after* this module froze the
 * resolver at import time, so `env.ts` calls this once after applying its `.env`
 * files. The agent `.env` location derives from the profile name + home before
 * this runs, so the rebuild re-reads only the directory vars, never the profile
 * selection. The in-memory agent-dir override is preserved.
 */
export function refreshDirsFromEnv(): void {
	dirs = new DirResolver({
		agentDirOverride: resolveActiveAgentDirOverride(),
		profile: activeProfile,
	});
}

// =============================================================================
// Root directories
// =============================================================================

/** Get the config root directory (~/.pi). */
export function getConfigRootDir(): string {
	return dirs.configRoot;
}

/** Set the coding agent directory. Creates a fresh resolver, invalidating all cached paths. */
export function setAgentDir(dir: string): void {
	agentDirOverride = dir;
	dirs = new DirResolver({
		agentDirOverride: resolveActiveAgentDirOverride(),
		profile: activeProfile,
	});
}

/**
 * Test-only: rebuild profile + directory state from the current process env.
 * Production code keeps the module-load profile stable; tests that mutate
 * `setAgentDir`/`setProfile` need an exact restore point after they put env vars
 * back.
 */
export function __resetDirsFromEnvForTests(): void {
	activeProfile = readProfileFromEnvSafe();
	dirs = new DirResolver({
		agentDirOverride: resolveActiveAgentDirOverride(),
		profile: activeProfile,
	});
}

/** Activate a named profile. Passing undefined or "default" returns to the default profile. */
export function setProfile(profile: string | undefined): void {
	activeProfile = normalizeProfileName(profile);
	if (activeProfile) {
		process.env.PI_PROFILE = activeProfile;
	} else {
		delete process.env.PI_PROFILE;
	}
	dirs = new DirResolver({
		agentDirOverride: resolveActiveAgentDirOverride(),
		profile: activeProfile,
	});
}

/** Get the active named profile. Undefined means the default profile. */
export function getActiveProfile(): string | undefined {
	return activeProfile;
}

/** Resolve the config root that backs a profile without activating it. */
export function getProfileRootDir(profile: string | undefined): string {
	return getProfileConfigRoot(normalizeProfileName(profile));
}
/** Get the agent config directory (~/.pi/agent). */
export function getAgentDir(): string {
	return dirs.agentDir;
}

/** Get the project-local config directory (.pi). */
export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

// =============================================================================
// Config-root subdirectories (~/.pi/*)
// =============================================================================

/** Get the reports directory (~/.pi/reports). */
export function getReportsDir(): string {
	return dirs.rootSubdir("reports", "state");
}

/** Get the logs directory (~/.pi/logs). */
export function getLogsDir(): string {
	return dirs.rootSubdir("logs", "state");
}

/** Get the path to a dated log file (~/.pi/logs/pi.YYYY-MM-DD.log). */
export function getLogPath(date = new Date()): string {
	return path.join(getLogsDir(), `${APP_NAME}.${date.toISOString().slice(0, 10)}.log`);
}

/**
 * Get the plugins directory (~/.pi/plugins or its XDG equivalent).
 *
 * No-arg form (production callers) goes through the XDG-aware DirResolver so
 * reads and writes always agree. The optional `home` parameter is for test
 * isolation: when it differs from `os.homedir()` it short-circuits the resolver
 * and returns `<home>/<configDir>/plugins` so tests with a temp HOME get a
 * deterministic path. Passing `os.homedir()` explicitly is identical to the
 * no-arg form — XDG semantics are preserved.
 */
export function getPluginsDir(home?: string): string {
	if (home !== undefined && home !== os.homedir()) {
		return path.join(home, getConfigDirName(), "plugins");
	}
	return dirs.rootSubdir("plugins", "data");
}

/** Where npm installs packages (~/.pi/plugins/node_modules). */
export function getPluginsNodeModules(home?: string): string {
	return path.join(getPluginsDir(home), "node_modules");
}

/** Plugin manifest (~/.pi/plugins/package.json). */
export function getPluginsPackageJson(home?: string): string {
	return path.join(getPluginsDir(home), "package.json");
}

/** Plugin runtime config file name. */
export const PLUGINS_LOCKFILE_NAME = "pi-plugins.lock.json";

/** Plugin lock file (~/.pi/plugins/pi-plugins.lock.json). */
export function getPluginsLockfile(home?: string): string {
	return path.join(getPluginsDir(home), PLUGINS_LOCKFILE_NAME);
}

/** Get the remote mount directory (~/.pi/remote). */
export function getRemoteDir(): string {
	return dirs.rootSubdir("remote", "data");
}

/**
 * Expand a leading `~` and require an absolute result. Returns `undefined` for
 * empty/whitespace input or a path that is still relative after expansion.
 *
 * A worktree base is process-global and consumed by both creation
 * (PR checkout, task isolation) and cleanup (`pi worktree`). A relative value
 * would resolve against whatever cwd happened to launch `pi`, so checkout and
 * cleanup could disagree — we refuse it rather than silently bind it to cwd.
 */
function resolveWorktreeBase(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	let p = trimmed;
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/") || p.startsWith("~\\")) p = os.homedir() + p.slice(1);
	return path.isAbsolute(p) ? path.normalize(p) : undefined;
}

function firstNonBlankEnv(primary: string | undefined, legacy: string | undefined): string | undefined {
	if (primary?.trim()) return primary;
	if (legacy?.trim()) return legacy;
	return undefined;
}

let worktreesDirOverride: string | undefined;

/**
 * Relocate the base directory for agent-managed worktrees (PR checkouts, task
 * isolation, and `pi worktree` cleanup all read the same base). Driven by the
 * `worktree.base` setting in coding-agent; pass `undefined`/empty to clear and
 * fall back to `PI_WORKTREE_DIR`, legacy `OMP_WORKTREE_DIR`, or the `~/.pi/wt`
 * default.
 *
 * `~` is expanded and a relative path is rejected (see {@link resolveWorktreeBase}).
 * Returns the absolute path that took effect, or `undefined` if the input was
 * cleared or rejected — callers can warn on a non-empty input that returns
 * `undefined`.
 */
export function setWorktreesDir(dir: string | undefined): string | undefined {
	worktreesDirOverride = resolveWorktreeBase(dir);
	return worktreesDirOverride;
}

/**
 * Get the agent-managed worktrees directory. Resolution order: the
 * `PI_WORKTREE_DIR` env var, then legacy `OMP_WORKTREE_DIR`, then the
 * {@link setWorktreesDir} override (the `worktree.base` setting), then the
 * `~/.pi/wt` default. Env vars and the override are `~`-expanded and must be
 * absolute; empty, whitespace-only, or relative values are ignored and
 * resolution falls through.
 */
export function getWorktreesDir(): string {
	return (
		resolveWorktreeBase(process.env.PI_WORKTREE_DIR) ??
		resolveWorktreeBase(process.env.OMP_WORKTREE_DIR) ??
		worktreesDirOverride ??
		dirs.rootSubdir("wt", "data")
	);
}

/** Get the SSH control socket directory (~/.pi/ssh-control). */
export function getSshControlDir(): string {
	return dirs.rootSubdir("ssh-control", "state");
}

/** Get the remote host info directory (~/.pi/remote-host). */
export function getRemoteHostDir(): string {
	return dirs.rootSubdir("remote-host", "data");
}

/** Get the managed Python venv directory (~/.pi/python-env). */
export function getPythonEnvDir(): string {
	return dirs.rootSubdir("python-env", "data");
}

/** Get the shared Python gateway state directory (~/.pi/agent/python-gateway; XDG default: $XDG_STATE_HOME/pi/python-gateway). */
export function getPythonGatewayDir(): string {
	return dirs.agentSubdir(undefined, "python-gateway", "state");
}

/** Get the puppeteer sandbox directory (~/.pi/puppeteer). */
export function getPuppeteerDir(): string {
	return dirs.rootSubdir("puppeteer", "cache");
}

/** Get DOCS_RS cache directory () */
export function getDocsRsCacheDir(): string {
	return dirs.rootSubdir("webcache", "cache");
}

/**Get AutoQa db directory */
export function getAutoQaDbDir(): string {
	return dirs.rootSubdir("autoqa.db", "data");
}
/**
 * Stable 7-character hex digest of an absolute filesystem path.
 *
 * Used to pack the project identity into a single short fs-safe segment
 * (e.g. PR-checkout and task-isolation worktree dirs under `~/.pi/wt/`).
 * Bun.hash is non-cryptographic — collision space is ~2^28, which is fine
 * for naming a handful of repos on a single machine. Same input on the
 * same Bun runtime yields the same output.
 */
export function hashPath(absPath: string): string {
	return Bun.hash(path.resolve(absPath)).toString(16).padStart(16, "0").slice(-7);
}

/** Get the path to a single worktree directory (~/.pi/wt/<segment>). */
export function getWorktreeDir(segment: string): string {
	return path.join(getWorktreesDir(), segment);
}

/** Get the GPU cache path (~/.pi/gpu_cache.json). */
export function getGpuCachePath(): string {
	return dirs.rootSubdir("gpu_cache.json", "cache");
}

/**
 * Get the GitHub view cache database path (~/.pi/cache/github-cache.db).
 * Honors `PI_GITHUB_CACHE_DB` first, then legacy `OMP_GITHUB_CACHE_DB`, so
 * tests can isolate the cache file without touching the rest of the config root.
 */
export function getGithubCacheDbPath(): string {
	const override = firstNonBlankEnv(process.env.PI_GITHUB_CACHE_DB, process.env.OMP_GITHUB_CACHE_DB);
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "github-cache.db"), "cache");
}

/**
 * Get the encrypted auth-broker snapshot cache path (~/.pi/cache/auth-broker-snapshot.enc).
 * Honors `PI_AUTH_BROKER_SNAPSHOT_CACHE` first, then legacy
 * `OMP_AUTH_BROKER_SNAPSHOT_CACHE`, so tests and operators can isolate or
 * relocate the cache file.
 */
export function getAuthBrokerSnapshotCachePath(): string {
	const override = firstNonBlankEnv(
		process.env.PI_AUTH_BROKER_SNAPSHOT_CACHE,
		process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE,
	);
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "auth-broker-snapshot.enc"), "cache");
}

/** Get the local FastEmbed model cache directory (~/.pi/cache/fastembed). */
export function getFastembedCacheDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed"), "cache");
}

/** Get the on-demand fastembed runtime install root (~/.pi/cache/fastembed-runtime). */
export function getFastembedRuntimeDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed-runtime"), "cache");
}

/** Get the natives directory (~/.pi/natives). */
export function getNativesDir(): string {
	return dirs.rootSubdir("natives", "cache");
}

/** Get the stats database path (~/.pi/stats.db). */
export function getStatsDbPath(): string {
	return dirs.rootSubdir("stats.db", "data");
}

/** Get the autoresearch state directory (~/.pi/autoresearch). */
export function getAutoresearchDir(): string {
	return dirs.rootSubdir("autoresearch", "state");
}

/** Get the per-project autoresearch state directory (~/.pi/autoresearch/<encoded-project>). */
export function getAutoresearchProjectDir(encodedProject: string): string {
	return path.join(getAutoresearchDir(), encodedProject);
}

/** Get the per-project autoresearch SQLite database path (~/.pi/autoresearch/<encoded-project>.db). */
export function getAutoresearchDbPath(encodedProject: string): string {
	return path.join(getAutoresearchDir(), `${encodedProject}.db`);
}

/** Get the per-run artifact directory (~/.pi/autoresearch/<encoded-project>/runs/<runId>). */
export function getAutoresearchRunDir(encodedProject: string, runId: number): string {
	return path.join(getAutoresearchProjectDir(encodedProject), "runs", String(runId).padStart(4, "0"));
}

// =============================================================================
// Agent subdirectories (~/.pi/agent/*)
// =============================================================================

/** Get the path to agent.db (SQLite database for settings and auth storage). */
export function getAgentDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "agent.db", "data");
}

/** Get the last-seen-changelog-version marker file (~/.pi/agent/last-changelog-version). */
export function getLastChangelogVersionPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "last-changelog-version", "state");
}

/** Get the path to history.db (SQLite database for session history). */
export function getHistoryDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "history.db", "data");
}

/** Get the path to models.db (model cache database). */
export function getModelDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "models.db", "data");
}

/** Get the tiny title model cache directory (~/.pi/agent/cache/tiny-models). */
export function getTinyModelsCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "tiny-models"), "cache");
}

/** Get the document conversion cache directory (~/.pi/agent/cache/document-conversions; XDG default: $XDG_CACHE_HOME/pi/cache/document-conversions). */
export function getDocumentConversionCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "document-conversions"), "cache");
}

/** Get the sessions directory (~/.pi/agent/sessions). */
export function getSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "sessions", "data");
}

/** Get the content-addressed blob store directory (~/.pi/agent/blobs). */
export function getBlobsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "blobs", "data");
}

/** Get the custom themes directory (~/.pi/agent/themes). */
export function getCustomThemesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "themes");
}

/** Get the tools directory (~/.pi/agent/tools). */
export function getToolsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "tools");
}

/** Get the slash commands directory (~/.pi/agent/commands). */
export function getCommandsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "commands");
}

/** Get the prompts directory (~/.pi/agent/prompts). */
export function getPromptsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "prompts");
}

/** Get the user-level Python modules directory (~/.pi/agent/modules). */
export function getAgentModulesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "modules");
}

/** Get the memories directory (~/.pi/agent/memories). */
export function getMemoriesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "memories", "state");
}

/** Get the terminal sessions directory (~/.pi/agent/terminal-sessions). */
export function getTerminalSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "terminal-sessions", "state");
}

/** Get the crash log path (~/.pi/agent/pi-crash.log). */
export function getCrashLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "pi-crash.log", "state");
}

/** Get the debug log path (~/.pi/agent/pi-debug.log). */
export function getDebugLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, `${APP_NAME}-debug.log`, "state");
}

// =============================================================================
// Project subdirectories (.pi/*)
// =============================================================================

/** Get the project-level Python modules directory (.pi/modules). */
export function getProjectModulesDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "modules");
}

/** Get the project-level prompts directory (.pi/prompts). */
export function getProjectPromptsDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "prompts");
}

/** Get the project-level plugin overrides path (.pi/plugin-overrides.json). */
export function getProjectPluginOverridesPath(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}

// =============================================================================
// MCP config paths
// =============================================================================

/** Get the primary MCP config file path (first candidate). */
export function getMCPConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "mcp.json");
	}
	return path.join(getProjectAgentDir(cwd), "mcp.json");
}

/** Get the SSH config file path. */
export function getSSHConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "ssh.json");
	}
	return path.join(getProjectAgentDir(cwd), "ssh.json");
}

// =============================================================================
// Install identity
// =============================================================================

let cachedInstallId: string | null = null;

const INSTALL_ID_FILE = "install-id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Persistent per-install UUID stored at `~/.pi/install-id`.
 *
 * Generated lazily on first call and persisted with `O_CREAT|O_EXCL` so
 * concurrent first-call races don't clobber each other (loser re-reads the
 * winner's id). Survives independently of agent state: deleting
 * `~/.pi/agent/` does not regenerate it. Server-side dedup for grievance
 * pushes (and similar telemetry) keys on this id.
 *
 * Anchored to the base config root (`~/.pi/install-id`) regardless of the
 * active profile: install identity is per-install, not per-profile, so every
 * profile shares one id and the global cache stays correct no matter the
 * profile / `getInstallId` call order.
 */
export function getInstallId(): string {
	if (cachedInstallId) return cachedInstallId;
	const filePath = path.join(getBaseConfigRoot(), INSTALL_ID_FILE);

	let observedInvalid = false;
	try {
		const existing = fs.readFileSync(filePath, "utf8").trim();
		if (UUID_RE.test(existing)) {
			cachedInstallId = existing;
			return existing;
		}
		// File present but unparseable — fall through and overwrite below.
		observedInvalid = existing.length > 0;
	} catch {}

	const next = crypto.randomUUID();
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		// If we already saw garbage in the file, unlink first so O_EXCL doesn't
		// trip on it. Ignored if the unlink races against another writer.
		if (observedInvalid) {
			try {
				fs.unlinkSync(filePath);
			} catch {}
		}
		const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			fs.writeSync(fd, `${next}\n`);
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		// Lost the create race — re-read whatever the winner wrote.
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			try {
				const existing = fs.readFileSync(filePath, "utf8").trim();
				if (UUID_RE.test(existing)) {
					cachedInstallId = existing;
					return existing;
				}
			} catch {}
		}
		// Any other failure: keep the generated id in-memory so the rest of
		// this process has a stable value; future processes will retry.
	}

	cachedInstallId = next;
	return next;
}

/** Test-only: clear cached install id. Never call from production code. */
export function __resetInstallIdCacheForTests(): void {
	cachedInstallId = null;
}
