import { logger } from "@oh-my-pi/pi-utils";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MCP_TIMEOUT_ENV = "PI_MCP_TIMEOUT_MS";
const LEGACY_MCP_TIMEOUT_ENV = "OMP_MCP_TIMEOUT_MS";

let neverAbortController: AbortController | undefined;

function readMCPTimeoutEnv(): { raw: string; legacy: boolean } | undefined {
	const primary = Bun.env[MCP_TIMEOUT_ENV]?.trim();
	if (primary) return { raw: primary, legacy: false };
	const legacy = Bun.env[LEGACY_MCP_TIMEOUT_ENV]?.trim();
	if (legacy) return { raw: legacy, legacy: true };
	return undefined;
}

export function resolveMCPTimeoutMs(configTimeout?: number): number {
	const env = readMCPTimeoutEnv();
	if (env) {
		const value = Number(env.raw);
		if (Number.isFinite(value) && value >= 0) return value;
		logger.warn(
			env.legacy
				? "Ignoring invalid PI_MCP_TIMEOUT_MS env value from legacy OMP_MCP_TIMEOUT_MS fallback; expected a non-negative number"
				: "Ignoring invalid PI_MCP_TIMEOUT_MS env value; expected a non-negative number",
			{ value: env.raw },
		);
	}
	return configTimeout ?? DEFAULT_MCP_TIMEOUT_MS;
}

export function isMCPTimeoutEnabled(timeoutMs: number): boolean {
	return timeoutMs > 0;
}

export function describeMCPTimeout(timeoutMs: number): string {
	return isMCPTimeoutEnabled(timeoutMs) ? `${timeoutMs}ms` : "disabled";
}

export function getNeverAbortSignal(): AbortSignal {
	neverAbortController ??= new AbortController();
	return neverAbortController.signal;
}

export function createMCPTimeout(
	timeoutMs: number,
	signal?: AbortSignal,
): {
	signal?: AbortSignal;
	clear: () => void;
	isTimeoutAbort: (error: unknown) => boolean;
} {
	if (!isMCPTimeoutEnabled(timeoutMs)) {
		return {
			signal,
			clear: () => {},
			isTimeoutAbort: () => false,
		};
	}

	const abortController = new AbortController();
	const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
	const operationSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	return {
		signal: operationSignal,
		clear: () => clearTimeout(timeoutId),
		isTimeoutAbort: error =>
			error instanceof Error && error.name === "AbortError" && abortController.signal.aborted && !signal?.aborted,
	};
}
