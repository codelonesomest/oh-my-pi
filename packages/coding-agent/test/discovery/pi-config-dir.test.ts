import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { getConfigDirs } from "@oh-my-pi/pi-coding-agent/config";
import { getUserPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getAgentDir } from "@oh-my-pi/pi-utils";

describe("native config dirs", () => {
	test("getUserPath resolves the native user scope via getAgentDir (profile-aware)", () => {
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};
		// Native user config follows the active profile through getAgentDir(), not
		// ctx.home, so it stays in sync with builtin.ts and getMCPConfigPath("user").
		// The old behavior joined ctx.home + ".pi/agent" and leaked the default
		// profile's config into every profile.
		expect(getUserPath(ctx, "native", "commands")).toBe(path.join(getAgentDir(), "commands"));
		expect(getUserPath(ctx, "native", "commands")).not.toContain(ctx.home);
	});

	test("getConfigDirs uses the .pi user base", () => {
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".pi", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".pi", level: "user" });
	});
});
