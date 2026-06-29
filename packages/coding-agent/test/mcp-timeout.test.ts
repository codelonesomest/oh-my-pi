import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { logger } from "@oh-my-pi/pi-utils";

const ORIGINAL_PI_TIMEOUT = process.env.PI_MCP_TIMEOUT_MS;
const ORIGINAL_OMP_TIMEOUT = process.env.OMP_MCP_TIMEOUT_MS;

function restoreEnv(name: "PI_MCP_TIMEOUT_MS" | "OMP_MCP_TIMEOUT_MS", value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

function clearTimeoutEnv(): void {
	delete process.env.PI_MCP_TIMEOUT_MS;
	delete process.env.OMP_MCP_TIMEOUT_MS;
}

afterEach(() => {
	restoreEnv("PI_MCP_TIMEOUT_MS", ORIGINAL_PI_TIMEOUT);
	restoreEnv("OMP_MCP_TIMEOUT_MS", ORIGINAL_OMP_TIMEOUT);
});

describe("MCP timeout configuration", () => {
	test("uses the default timeout when no config or env override is set", () => {
		clearTimeoutEnv();

		expect(resolveMCPTimeoutMs()).toBe(30_000);
	});

	test("uses per-server timeout when env override is unset", () => {
		clearTimeoutEnv();

		expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
	});

	test("uses PI_MCP_TIMEOUT_MS before legacy OMP_MCP_TIMEOUT_MS", () => {
		process.env.PI_MCP_TIMEOUT_MS = "0";
		process.env.OMP_MCP_TIMEOUT_MS = "180000";

		const timeout = resolveMCPTimeoutMs(30_000);
		expect(timeout).toBe(0);
		expect(isMCPTimeoutEnabled(timeout)).toBe(false);
	});

	test("uses legacy OMP_MCP_TIMEOUT_MS when PI_MCP_TIMEOUT_MS is unset", () => {
		delete process.env.PI_MCP_TIMEOUT_MS;
		process.env.OMP_MCP_TIMEOUT_MS = "180000";

		expect(resolveMCPTimeoutMs(30_000)).toBe(180_000);
	});

	test("falls through to legacy OMP_MCP_TIMEOUT_MS when PI_MCP_TIMEOUT_MS is empty", () => {
		process.env.PI_MCP_TIMEOUT_MS = "   ";
		process.env.OMP_MCP_TIMEOUT_MS = "45000";

		expect(resolveMCPTimeoutMs(30_000)).toBe(45_000);
	});

	test("rejects negative PI_MCP_TIMEOUT_MS values and warns with the primary name", () => {
		process.env.PI_MCP_TIMEOUT_MS = "-1";
		process.env.OMP_MCP_TIMEOUT_MS = "180000";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("PI_MCP_TIMEOUT_MS");
		} finally {
			warn.mockRestore();
		}
	});

	test("rejects invalid legacy OMP_MCP_TIMEOUT_MS values and warns with the primary name", () => {
		delete process.env.PI_MCP_TIMEOUT_MS;
		process.env.OMP_MCP_TIMEOUT_MS = "not-a-number";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs()).toBe(30_000);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("PI_MCP_TIMEOUT_MS");
			expect(warn.mock.calls[0]?.[0]).toContain("OMP_MCP_TIMEOUT_MS");
		} finally {
			warn.mockRestore();
		}
	});
});
