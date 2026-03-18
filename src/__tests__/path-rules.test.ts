import { describe, expect, it } from "bun:test";

import { filterPathsByRules, matchesPathRules } from "../path-rules";

describe("path rules", () => {
	describe("matchesPathRules", () => {
		it("supports include-only matching", () => {
			expect(
				matchesPathRules("src/index.ts", {
					include: ["src/**"],
				}),
			).toBe(true);
			expect(
				matchesPathRules("README.md", {
					include: ["src/**"],
				}),
			).toBe(false);
		});

		it("supports exclude-only matching", () => {
			expect(
				matchesPathRules("src/generated/a.ts", {
					exclude: ["src/generated/**"],
				}),
			).toBe(false);
			expect(
				matchesPathRules("src/index.ts", {
					exclude: ["src/generated/**"],
				}),
			).toBe(true);
		});

		it("supports exclude-overrides-include", () => {
			expect(
				matchesPathRules("src/generated/a.ts", {
					include: ["src/**"],
					exclude: ["src/generated/**"],
				}),
			).toBe(false);
			expect(
				matchesPathRules("src/index.ts", {
					include: ["src/**"],
					exclude: ["src/generated/**"],
				}),
			).toBe(true);
		});

		it("matches root file patterns", () => {
			expect(
				matchesPathRules("package.json", {
					include: ["package.json"],
				}),
			).toBe(true);
			expect(
				matchesPathRules("src/package.json", {
					include: ["package.json"],
				}),
			).toBe(false);
		});

		it("supports nested glob matching", () => {
			expect(
				matchesPathRules("src/generated/a.ts", {
					include: ["src/**"],
				}),
			).toBe(true);
		});
	});

	it("filters multiple paths with include/exclude rules", () => {
		expect(
			filterPathsByRules(
				["package.json", "src/index.ts", "src/generated/a.ts", "README.md"],
				{
					include: ["src/**", "package.json"],
					exclude: ["src/generated/**"],
				},
			),
		).toEqual(["package.json", "src/index.ts"]);
	});
});
