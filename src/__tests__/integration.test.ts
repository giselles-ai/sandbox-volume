import type { Sandbox } from "@vercel/sandbox";
import { describe, expect, it } from "bun:test";
import {
	createMemoryStorageAdapter,
	createVercelBlobStorageAdapter,
	SandboxVolume,
	VercelBlobStorageAdapter,
	WorkspaceLockConflictError,
} from "../index";

type MockCommandResult = {
	exitCode: number;
	stdout: () => Promise<string>;
};

type MockSandbox = {
	mkdirCalls: string[];
	writtenFiles: Array<{ path: string; content: Buffer }>;
	mkDir: (path: string) => Promise<void>;
	writeFiles: (
		files: Array<{ path: string; content: Buffer }>,
	) => Promise<void>;
	runCommand: (command: string, args: string[]) => Promise<MockCommandResult>;
	readFileToBuffer: (file: { path: string }) => Promise<Buffer | null>;
	setFileState: (state: Record<string, string>) => void;
};

function createMockSandbox(): MockSandbox {
	const fileContents = new Map<string, Buffer>();
	const filePaths: string[] = [];
	const mkdirCalls: string[] = [];
	const writtenFiles: Array<{ path: string; content: Buffer }> = [];

	return {
		mkdirCalls,
		writtenFiles,
		async mkDir(path) {
			mkdirCalls.push(path);
		},
		async writeFiles(files) {
			writtenFiles.push(...files);
			for (const file of files) {
				fileContents.set(file.path, Buffer.from(file.content));
				if (!filePaths.includes(file.path)) {
					filePaths.push(file.path);
				}
			}
		},
		async runCommand(command, args) {
			if (command !== "bash" || args[0] !== "-lc") {
				throw new Error("unexpected command");
			}

			return {
				exitCode: 0,
				stdout: async () => filePaths.join("\0"),
			};
		},
		async readFileToBuffer({ path }) {
			return fileContents.get(path) ?? null;
		},
		setFileState(state) {
			fileContents.clear();
			filePaths.length = 0;
			for (const [path, content] of Object.entries(state)) {
				fileContents.set(path, Buffer.from(content));
				filePaths.push(path);
			}
		},
	};
}

describe("memory adapter integration", () => {
	it("persists files across transactions and preserves deletions", async () => {
		const adapter = createMemoryStorageAdapter();
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/integration",
		});

		const firstSandbox = createMockSandbox();
		await volume.mount(firstSandbox as unknown as Sandbox, async () => {
			firstSandbox.setFileState({
				"/vercel/sandbox/workspace/src/index.ts": "console.log('first')",
			});
		});

		const secondSandbox = createMockSandbox();
		const tx2 = await volume.begin(secondSandbox as unknown as Sandbox);

		expect(secondSandbox.mkdirCalls).toEqual(["/vercel/sandbox/workspace"]);
		expect(secondSandbox.writtenFiles).toHaveLength(1);
		expect(secondSandbox.writtenFiles[0]?.path).toBe(
			"/vercel/sandbox/workspace/src/index.ts",
		);

		secondSandbox.setFileState({});
		const secondCommit = await tx2.commit();
		await tx2.close();

		expect(secondCommit.committed).toBe(true);
		expect(secondCommit.diff.kind).toBe("delete");

		const thirdSandbox = createMockSandbox();
		const tx3 = await volume.begin(thirdSandbox as unknown as Sandbox);

		expect(thirdSandbox.mkdirCalls).toEqual(["/vercel/sandbox/workspace"]);
		expect(thirdSandbox.writtenFiles).toHaveLength(0);

		await tx3.close();
	});

	it("persists only filtered paths across multiple transactions", async () => {
		const adapter = createMemoryStorageAdapter();
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/include-exclude",
			include: ["src/**", "package.json"],
			exclude: ["src/generated/**"],
		});

		const firstSandbox = createMockSandbox();
		await volume.mount(firstSandbox as unknown as Sandbox, async () => {
			firstSandbox.setFileState({
				"/vercel/sandbox/workspace/package.json": '{"name":"include-exclude"}',
				"/vercel/sandbox/workspace/src/index.ts": "console.log('first')",
				"/vercel/sandbox/workspace/src/generated/tmp.ts": "ignored",
				"/vercel/sandbox/workspace/README.md": "should be ignored",
			});
		});

		const firstState = adapter.store.get("repo/include-exclude");
		expect(firstState).toBeDefined();
		expect(firstState?.files.map((entry) => entry.path).sort()).toEqual([
			"package.json",
			"src/index.ts",
		]);

		const secondSandbox = createMockSandbox();
		const tx2 = await volume.begin(secondSandbox as unknown as Sandbox);
		expect(secondSandbox.mkdirCalls).toEqual(["/vercel/sandbox/workspace"]);
		expect(secondSandbox.writtenFiles.map((file) => file.path).sort()).toEqual([
			"/vercel/sandbox/workspace/package.json",
			"/vercel/sandbox/workspace/src/index.ts",
		]);

		secondSandbox.setFileState({
			"/vercel/sandbox/workspace/package.json":
				'{"name":"include-exclude","version":1}',
			"/vercel/sandbox/workspace/src/index.ts": "console.log('second')",
			"/vercel/sandbox/workspace/src/new.ts": "created",
			"/vercel/sandbox/workspace/src/generated/tmp.ts": "still ignored",
		});

		const secondCommit = await tx2.commit();
		expect(secondCommit.committed).toBe(true);
		expect(
			secondCommit.diff.changes.map((change) => change.path).sort(),
		).toEqual(["package.json", "src/index.ts", "src/new.ts"]);
		expect(
			secondCommit.diff.changes.some((change) =>
				change.path.startsWith("src/generated/"),
			),
		).toBe(false);

		const secondState = adapter.store.get("repo/include-exclude");
		expect(secondState).toBeDefined();
		expect(secondState?.files.map((entry) => entry.path).sort()).toEqual([
			"package.json",
			"src/index.ts",
			"src/new.ts",
		]);

		await tx2.close();

		const thirdSandbox = createMockSandbox();
		const tx3 = await volume.begin(thirdSandbox as unknown as Sandbox);
		thirdSandbox.setFileState({
			"/vercel/sandbox/workspace/package.json":
				'{"name":"include-exclude","version":1}',
			"/vercel/sandbox/workspace/src/new.ts": "created",
		});

		const thirdCommit = await tx3.commit();
		expect(thirdCommit.committed).toBe(true);
		expect(thirdCommit.diff.kind).toBe("delete");
		expect(thirdCommit.diff.changes).toEqual([
			{
				kind: "delete",
				path: "src/index.ts",
				hash: expect.any(String),
				size: expect.any(Number),
				lastSeenAt: expect.any(Date),
			},
		]);

		const thirdState = adapter.store.get("repo/include-exclude");
		expect(thirdState).toBeDefined();
		expect(thirdState?.files.map((entry) => entry.path).sort()).toEqual([
			"package.json",
			"src/new.ts",
		]);

		await tx3.close();
	});

	it("keeps out-of-scope historical entries until a scoped rewrite/resync", async () => {
		const adapter = createMemoryStorageAdapter();
		const allFilesKey = "repo/filter-caveat";
		const sourceVolume = await SandboxVolume.create({
			adapter,
			key: allFilesKey,
		});

		const bootstrapSandbox = createMockSandbox();
		await sourceVolume.mount(
			bootstrapSandbox as unknown as Sandbox,
			async () => {
				bootstrapSandbox.setFileState({
					"/vercel/sandbox/workspace/package.json": '{"name":"caveat"}',
					"/vercel/sandbox/workspace/src/index.ts": "console.log('kept')",
					"/vercel/sandbox/workspace/dist/out.js": "old artifact",
				});
			},
		);

		const seeded = adapter.store.get(allFilesKey);
		expect(seeded).toBeDefined();
		expect(seeded?.files.map((entry) => entry.path).sort()).toEqual([
			"dist/out.js",
			"package.json",
			"src/index.ts",
		]);

		const scopedVolume = await SandboxVolume.create({
			adapter,
			key: allFilesKey,
			include: ["src/**", "package.json"],
			exclude: ["dist/**"],
		});
		const scopedSandbox = createMockSandbox();
		const scopedTx = await scopedVolume.begin(
			scopedSandbox as unknown as Sandbox,
		);
		scopedSandbox.setFileState({
			"/vercel/sandbox/workspace/package.json": '{"name":"caveat"}',
			"/vercel/sandbox/workspace/src/index.ts": "console.log('kept')",
		});

		const result = await scopedTx.commit();
		expect(result.committed).toBe(false);
		expect(result.diff).toEqual({
			key: allFilesKey,
			kind: "no-op",
			changes: [],
		});

		const unchangedState = adapter.store.get(allFilesKey);
		expect(unchangedState).toBeDefined();
		expect(unchangedState?.files.map((entry) => entry.path).sort()).toEqual([
			"dist/out.js",
			"package.json",
			"src/index.ts",
		]);

		await scopedTx.close();

		const rewrittenSandbox = createMockSandbox();
		rewrittenSandbox.setFileState({
			"/vercel/sandbox/workspace/package.json": '{"name":"caveat"}',
			"/vercel/sandbox/workspace/src/index.ts": "console.log('kept')",
		});
		const rewriteResult = await scopedVolume.rewrite(
			rewrittenSandbox as unknown as Sandbox,
		);
		expect(rewriteResult.committed).toBe(true);
		expect(rewriteResult.diff).toEqual({
			key: allFilesKey,
			kind: "no-op",
			changes: [],
		});

		const rewrittenState = adapter.store.get(allFilesKey);
		expect(rewrittenState).toBeDefined();
		expect(rewrittenState?.files.map((entry) => entry.path).sort()).toEqual([
			"package.json",
			"src/index.ts",
		]);

		const resyncSandbox = createMockSandbox();
		resyncSandbox.setFileState({
			"/vercel/sandbox/workspace/package.json": '{"name":"caveat"}',
			"/vercel/sandbox/workspace/src/index.ts": "console.log('kept')",
		});
		const resyncResult = await scopedVolume.resync(
			resyncSandbox as unknown as Sandbox,
		);
		expect(resyncResult.committed).toBe(true);
	});

	it("is fully usable through package public exports", async () => {
		const exportedBlobAdapter = createVercelBlobStorageAdapter({
			token: "test-token",
		});
		expect(exportedBlobAdapter).toBeInstanceOf(VercelBlobStorageAdapter);

		const explicitError = new WorkspaceLockConflictError(
			"repo/public",
			"exclusive",
		);
		expect(explicitError.code).toBe("conflict");

		const adapter = createMemoryStorageAdapter();
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/public-exported",
			include: ["src/**", "package.json"],
			exclude: ["src/generated/**"],
		});

		const sandbox = createMockSandbox();
		await volume.mount(sandbox as unknown as Sandbox, async () => {
			sandbox.setFileState({
				"/vercel/sandbox/workspace/package.json": '{"name":"public"}',
				"/vercel/sandbox/workspace/src/index.ts": "console.log('public')",
				"/vercel/sandbox/workspace/src/generated/cache.ts": "ignored",
			});
		});

		const verifySandbox = createMockSandbox();
		const tx = await volume.begin(verifySandbox as unknown as Sandbox);
		expect(verifySandbox.mkdirCalls).toEqual(["/vercel/sandbox/workspace"]);
		expect(verifySandbox.writtenFiles.map((file) => file.path).sort()).toEqual(
			[
				"/vercel/sandbox/workspace/package.json",
				"/vercel/sandbox/workspace/src/index.ts",
			].sort(),
		);

		verifySandbox.setFileState({
			"/vercel/sandbox/workspace/package.json": '{"name":"public"}',
			"/vercel/sandbox/workspace/src/index.ts": "console.log('public')",
		});

		const commit = await tx.commit();
		expect(commit.committed).toBe(false);

		await tx.close();

		const rewriteSandbox = createMockSandbox();
		rewriteSandbox.setFileState({
			"/vercel/sandbox/workspace/package.json": '{"name":"public"}',
			"/vercel/sandbox/workspace/src/index.ts": "console.log('public')",
		});

		const rewrite = await volume.rewrite(rewriteSandbox as unknown as Sandbox);
		expect(rewrite.committed).toBe(true);
		expect(rewrite.diff.kind).toBe("no-op");

		const commitOnlySandbox = createMockSandbox();
		commitOnlySandbox.setFileState({
			"/vercel/sandbox/workspace/package.json": '{"name":"public"}',
			"/vercel/sandbox/workspace/src/index.ts": "console.log('public')",
		});
		const commitAllResult = await volume.commitAll(
			commitOnlySandbox as unknown as Sandbox,
		);
		expect(commitAllResult.committed).toBe(false);
	});
});
