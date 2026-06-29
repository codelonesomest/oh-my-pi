import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDashboardStats } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getAgentDir, getStatsDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = getAgentDir();
const originalHome = process.env.HOME;
const originalXdg: Record<string, string | undefined> = {
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
	XDG_STATE_HOME: process.env.XDG_STATE_HOME,
	XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};
let tempDir: TempDir | null = null;

async function resetStatsDb(): Promise<void> {
	const dbPath = getStatsDbPath();
	await Promise.all([
		fs.rm(dbPath, { force: true }),
		fs.rm(`${dbPath}-wal`, { force: true }),
		fs.rm(`${dbPath}-shm`, { force: true }),
	]);
}

beforeEach(async () => {
	closeDb();
	tempDir = TempDir.createSync("@pi-stats-db-range-");
	const homeDir = tempDir.join("home");
	await fs.mkdir(homeDir, { recursive: true });
	process.env.HOME = homeDir;
	delete process.env.XDG_DATA_HOME;
	delete process.env.XDG_STATE_HOME;
	delete process.env.XDG_CACHE_HOME;
	setAgentDir(path.join(homeDir, ".pi", "agent"));
	await resetStatsDb();
});

afterEach(async () => {
	closeDb();
	await resetStatsDb();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	for (const [key, value] of Object.entries(originalXdg)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

function makeMessage(timestamp: number, entryId: string): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		agentType: "main",
	};
}

describe("getDashboardStats time range", () => {
	it("filters dashboard stats by selected range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		const dayStats = await getDashboardStats("24h");
		expect(dayStats.overall.totalRequests).toBe(1);
		expect(dayStats.byModel[0]).toMatchObject({
			totalRequests: 1,
			model: "gpt-5.4",
			provider: "openai-codex",
		});

		const weekStats = await getDashboardStats("7d");
		expect(weekStats.overall.totalRequests).toBe(2);
		expect(weekStats.byModel[0]).toMatchObject({ totalRequests: 2, model: "gpt-5.4", provider: "openai-codex" });

		const allStats = await getDashboardStats("all");
		expect(allStats.overall.totalRequests).toBe(2);
	});

	it("falls back to 24h for unknown range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		const stats = await getDashboardStats("last century");
		expect(stats.overall.totalRequests).toBe(1);
	});
});
