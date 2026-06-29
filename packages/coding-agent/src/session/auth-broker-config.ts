/**
 * Resolve auth-broker connection configuration for the local pi client.
 *
 * This is a thin coding-agent wrapper around the shared resolver in
 * `@oh-my-pi/pi-ai/auth-broker/discover` that preserves the process-lifetime
 * memoization expected by the CLI and injects the full `resolveConfigValue`
 * (including `!command` config indirection) from coding-agent's config layer.
 *
 * Precedence (highest first):
 *   1. `PI_AUTH_BROKER_URL` / `PI_AUTH_BROKER_TOKEN` env vars, with legacy
 *      `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` fallback.
 *   2. `auth.broker.url` / `auth.broker.token` in `~/.pi/agent/config.yml`
 *      (hidden from the settings UI; `!command` resolution supported).
 *   3. Token file `~/.pi/auth-broker.token` (paired with URL from env or config).
 *
 * Returns null when no broker URL is configured — caller falls back to the
 * local SQLite store.
 *
 * Reads config.yml directly (instead of going through `Settings.init`) because
 * `discoverAuthStorage` runs before the settings singleton is initialized in
 * `runRootCommand`, and we want hand-edited config entries to be honoured at
 * boot without forcing a startup reorder.
 */

import {
	type AuthBrokerClientConfig,
	type DiscoverAuthStorageOptions,
	discoverAuthStorage as discoverAuthStorageShared,
	getAuthBrokerTokenFilePath,
	resolveAuthBrokerConfig as resolveAuthBrokerConfigShared,
} from "@oh-my-pi/pi-ai/auth-broker/discover";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { resolveConfigValue } from "../config/resolve-config-value";
import type { AuthStorage } from "./auth-storage";

export { type AuthBrokerClientConfig, getAuthBrokerTokenFilePath };

/**
 * Process-lifetime memo for {@link resolveAuthBrokerConfig}. Keyed on the
 * effective env inputs (plus agent dir, which decides which config.yml is read)
 * so tests that flip `PI_AUTH_BROKER_*` or legacy `OMP_AUTH_BROKER_*` between
 * cases still observe the change, while repeated resolution within one CLI
 * invocation skips the config.yml read and any `!command` token resolution.
 */
let cachedConfigKey: string | null = null;
let cachedConfigPromise: Promise<AuthBrokerClientConfig | null> | null = null;

function resolveEnvValue(primaryName: string, legacyName: string): string | undefined {
	const primary = process.env[primaryName]?.trim();
	if (primary) return primary;
	const legacy = process.env[legacyName]?.trim();
	return legacy ? legacy : undefined;
}

/**
 * Read broker configuration. Returns null when the URL is missing
 * (broker disabled — local store is used). Throws when URL is set but no
 * token is available — the caller cannot fall back silently because the
 * user explicitly asked to use the broker.
 *
 * Successful resolutions (including "no broker configured") are memoized for
 * the process lifetime; failures are not, so a missing token can be fixed and
 * retried. Concurrent callers share one in-flight resolution.
 */
export function resolveAuthBrokerConfig(): Promise<AuthBrokerClientConfig | null> {
	const agentDir = getAgentDir();
	const key = [
		resolveEnvValue("PI_AUTH_BROKER_URL", "OMP_AUTH_BROKER_URL") ?? "",
		resolveEnvValue("PI_AUTH_BROKER_TOKEN", "OMP_AUTH_BROKER_TOKEN") ?? "",
		resolveEnvValue("PI_AUTH_BROKER_SNAPSHOT_TTL_MS", "OMP_AUTH_BROKER_SNAPSHOT_TTL_MS") ?? "",
		agentDir,
	].join("\u0000");
	if (cachedConfigPromise && cachedConfigKey === key) return cachedConfigPromise;
	const promise = resolveAuthBrokerConfigShared({
		agentDir,
		configValueResolver: resolveConfigValue,
	});
	cachedConfigKey = key;
	cachedConfigPromise = promise;
	promise.catch(() => {
		if (cachedConfigPromise === promise) {
			cachedConfigPromise = null;
			cachedConfigKey = null;
		}
	});
	return promise;
}

/**
 * Create an AuthStorage instance, using the broker when configured and falling
 * back to the local SQLite store otherwise. Delegates to the shared resolver in
 * pi-ai so the CLI, subagents, and the catalog generator all see the same
 * credentials.
 *
 * Default `agentDir` is the current configured agent directory.
 */
export function discoverAuthStorage(
	agentDir: string = getAgentDir(),
	options?: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver">,
): Promise<AuthStorage> {
	return discoverAuthStorageShared({
		...options,
		agentDir,
		configValueResolver: resolveConfigValue,
	});
}
