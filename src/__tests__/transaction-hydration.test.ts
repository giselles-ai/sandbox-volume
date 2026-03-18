import type { Sandbox } from "@vercel/sandbox";
import { describe, expect, it } from "bun:test";
import type { StorageAdapter, StorageLoadResult } from "../adapters/types";
import { createEmptyManifest } from "../manifest";
import { SandboxVolume } from "../sandbox-volume";

type MockWriteFile = {
	path: string;
	content: Buffer;
};

type MockSandbox = {
	mkdirCalls: string[];
	writtenFiles: MockWriteFile[];
	mkDir: (path: string) => Promise<void>;
	writeFiles: (
		files: Array<{ path: string; content: Buffer }>,
	) => Promise<void>;
};

const textEncoder = new TextEncoder();

function createSandboxMock(): MockSandbox {
	const mkdirCalls: string[] = [];
	const writtenFiles: MockWriteFile[] = [];

	return {
		mkdirCalls,
		writtenFiles,
		mkDir: async (path: string) => {
			mkdirCalls.push(path);
		},
		writeFiles: async (files) => {
			writtenFiles.push(...files);
		},
	};
}

class InMemoryAdapter implements StorageAdapter {
	constructor(private readonly initial: StorageLoadResult | null) {}

	async loadWorkspace(): Promise<StorageLoadResult | null> {
		return this.initial;
	}

	async saveWorkspace(): Promise<{
		updatedAt: Date;
		key: string;
		version: number;
	}> {
		return { updatedAt: new Date(), key: "ignored", version: 1 };
	}
}

describe("Workspace hydration", () => {
	it("hydrates stored files into mount path", async () => {
		const sandbox = createSandboxMock();
		const adapter = new InMemoryAdapter({
			manifest: createEmptyManifest(),
			files: [
				{
					path: "src/index.ts",
					size: 12,
					hash: "h1",
					content: textEncoder.encode("console.log(1)"),
				},
			],
		});
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/alpha",
		});
		const tx = await volume.begin(sandbox as unknown as Sandbox);

		expect(sandbox.mkdirCalls).toEqual(["/workspace"]);
		expect(sandbox.writtenFiles).toHaveLength(1);
		expect(sandbox.writtenFiles[0]?.path).toBe("/workspace/src/index.ts");
		expect(new TextDecoder().decode(sandbox.writtenFiles[0]?.content)).toBe(
			"console.log(1)",
		);

		await tx.close();
	});

	it("hydrates empty workspace without writes", async () => {
		const sandbox = createSandboxMock();
		const adapter = new InMemoryAdapter(null);
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/empty",
			path: "/project",
		});

		await volume.begin(sandbox as unknown as Sandbox);

		expect(sandbox.mkdirCalls).toEqual(["/project"]);
		expect(sandbox.writtenFiles).toHaveLength(0);
	});

	it("hydrates only include-matched files", async () => {
		const sandbox = createSandboxMock();
		const adapter = new InMemoryAdapter({
			manifest: createEmptyManifest(),
			files: [
				{
					path: "src/index.ts",
					size: 12,
					hash: "h1",
					content: textEncoder.encode("console.log(1)"),
				},
				{
					path: "dist/bundle.js",
					size: 10,
					hash: "h2",
					content: textEncoder.encode("ignored"),
				},
			],
		});
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/include",
			include: ["src/**"],
		});

		await volume.begin(sandbox as unknown as Sandbox);

		expect(sandbox.mkdirCalls).toEqual(["/workspace"]);
		expect(sandbox.writtenFiles).toHaveLength(1);
		expect(sandbox.writtenFiles[0]?.path).toBe("/workspace/src/index.ts");
		expect(new TextDecoder().decode(sandbox.writtenFiles[0]?.content)).toBe(
			"console.log(1)",
		);
	});

	it("hydrates all files except excludes", async () => {
		const sandbox = createSandboxMock();
		const adapter = new InMemoryAdapter({
			manifest: createEmptyManifest(),
			files: [
				{
					path: "src/index.ts",
					size: 12,
					hash: "h1",
					content: textEncoder.encode("console.log(1)"),
				},
				{
					path: "coverage/out.json",
					size: 11,
					hash: "h2",
					content: textEncoder.encode("ignored"),
				},
			],
		});
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/exclude",
			exclude: ["coverage/**"],
		});

		await volume.begin(sandbox as unknown as Sandbox);

		expect(sandbox.mkdirCalls).toEqual(["/workspace"]);
		expect(sandbox.writtenFiles).toHaveLength(1);
		expect(sandbox.writtenFiles[0]?.path).toBe("/workspace/src/index.ts");
	});
});
