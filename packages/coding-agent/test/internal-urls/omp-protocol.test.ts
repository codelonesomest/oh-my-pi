import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";

describe("OmpProtocolHandler", () => {
	it("treats pi://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("pi://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("pi://tools/read.md");
		const prefixed = await router.resolve("pi://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});
});
