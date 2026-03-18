import type { Sandbox } from "@vercel/sandbox";
import { describe, expect, it } from "bun:test";

import type {
	LockMode,
	StorageAdapter,
	StorageLoadResult,
	StorageLock,
	WorkspacePayload,
} from "../adapters/types";
import { buildManifest, createEmptyManifest, hashContent } from "../manifest";
import { SandboxVolume } from "../sandbox-volume";
import { WorkspaceLockReleaseError, WorkspaceLockStaleError } from "../types";

type MockReadFileArgs = {
	path: string;
};

type MockCommandResult = {
	exitCode: number;
	stdout: () => Promise<string>;
};

type CommandHandler = (
	command: string,
	args: string[],
) => Promise<MockCommandResult>;

type MockSandbox = {
	mkdirCalls: string[];
	writtenFiles: Array<{ path: string; content: Buffer }>;
	readCalls: string[];
	filePaths: string[];
	fileContents: Map<string, Buffer>;
	setFileState: (state: Record<string, string>) => void;
	setCommandHandler: (handler: CommandHandler) => void;
	mkDir: (path: string) => Promise<void>;
	writeFiles: (
		files: Array<{ path: string; content: Buffer }>,
	) => Promise<void>;
	runCommand: (command: string, args: string[]) => Promise<MockCommandResult>;
	readFileToBuffer: (file: MockReadFileArgs) => Promise<Buffer | null>;
};

function createMockSandbox(commandHandler?: CommandHandler): MockSandbox {
	const fileContents = new Map<string, Buffer>();
	const sandboxState: { filePaths: string[] } = { filePaths: [] };
	const mkdirCalls: string[] = [];
	const writtenFiles: Array<{ path: string; content: Buffer }> = [];
	const readCalls: string[] = [];
	let runCommandHandler =
		commandHandler ??
		(async (command: string, args: string[]): Promise<MockCommandResult> => {
			if (command !== "bash") {
				throw new Error(`unexpected command: ${command}`);
			}
			if (!args || args[0] !== "-lc") {
				throw new Error("unexpected command args");
			}

			return {
				exitCode: 0,
				stdout: async () => sandboxState.filePaths.join("\0"),
			};
		});

	return {
		mkdirCalls,
		writtenFiles,
		readCalls,
		filePaths: sandboxState.filePaths,
		fileContents,
		setFileState: (state) => {
			fileContents.clear();
			const nextPaths = Object.entries(state).map(([path, content]) => {
				fileContents.set(path, Buffer.from(content));
				return path;
			});
			sandboxState.filePaths = [...nextPaths];
		},
		setCommandHandler: (handler) => {
			runCommandHandler = handler;
		},
		mkDir: async (path: string) => {
			mkdirCalls.push(path);
		},
		writeFiles: async (files) => {
			writtenFiles.push(...files);
		},
		runCommand: async (command: string, args: string[]) => {
			return runCommandHandler(command, args);
		},
		readFileToBuffer: async ({ path }) => {
			readCalls.push(path);
			return fileContents.get(path) ?? null;
		},
	};
}

type AdapterSaveSpy = {
	payload: WorkspacePayload;
	savedAt: Date;
	version: number;
};

class InMemoryAdapter implements StorageAdapter {
	public saveCalls: AdapterSaveSpy[] = [];
	private currentVersion: number;

	constructor(
		private readonly initial: StorageLoadResult | null,
		startVersion?: number,
	) {
		this.currentVersion = startVersion ?? initial?.manifest.version ?? 0;
	}

	loadWorkspace(): Promise<StorageLoadResult | null> {
		return Promise.resolve(this.initial);
	}

	saveWorkspace(
		_key: string,
		payload: WorkspacePayload,
	): Promise<{ updatedAt: Date; key: string; version: number }> {
		const nextVersion = ++this.currentVersion;
		const savedAt = new Date("2026-03-17T00:00:00Z");
		this.saveCalls.push({ payload, savedAt, version: nextVersion });
		return Promise.resolve({
			key: _key,
			version: nextVersion,
			updatedAt: savedAt,
		});
	}
}

class TransactionLockAdapter implements StorageAdapter {
	public loadCount = 0;
	public releaseBehavior: "stale" | "generic";
	public readonly lock: StorageLock;
	private released = false;

	constructor(
		public readonly key: string,
		releaseBehavior: "stale" | "generic",
	) {
		this.releaseBehavior = releaseBehavior;
		this.lock = {
			key,
			leaseId: `lock:${key}`,
			acquiredAt: new Date("2026-03-17T00:00:00Z"),
			mode: "exclusive" as LockMode,
		};
	}

	loadWorkspace(): Promise<StorageLoadResult | null> {
		this.loadCount += 1;
		return Promise.resolve({
			manifest: createEmptyManifest(),
			files: [],
		});
	}

	saveWorkspace(
		_key: string,
		_payload: WorkspacePayload,
	): Promise<{ updatedAt: Date; key: string; version: number }> {
		return Promise.resolve({
			updatedAt: new Date("2026-03-17T00:00:00Z"),
			key: _key,
			version: 1,
		});
	}

	async acquireLock(): Promise<StorageLock> {
		return { ...this.lock };
	}

	async releaseLock(): Promise<void> {
		if (this.released) {
			return;
		}
		this.released = true;

		if (this.releaseBehavior === "stale") {
			throw new WorkspaceLockStaleError(
				this.key,
				"exclusive",
				this.lock.leaseId,
			);
		}

		throw new Error("adapter release transport failure");
	}
}

function createWorkspaceFile(path: string, content: string) {
	const bytes = new TextEncoder().encode(content);
	return {
		path,
		content: bytes,
		size: bytes.byteLength,
		hash: hashContent(bytes),
	};
}

describe("workspace transaction commit", () => {
	it("commits modified files with update diff", async () => {
		const sandbox = createMockSandbox();
		const initialFiles = [
			createWorkspaceFile("src/index.ts", "console.log(1)"),
		];
		const adapter = new InMemoryAdapter({
			manifest: buildManifest(
				initialFiles.map(({ path, content }) => ({ path, content })),
				new Date("2026-03-17T00:00:00Z"),
			),
			files: initialFiles,
		});
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/update",
		});
		const tx = await volume.begin(sandbox as unknown as Sandbox);

		sandbox.setFileState({
			"/workspace/src/index.ts": "console.log(2)",
		});

		const result = await tx.commit();

		expect(result.committed).toBe(true);
		expect(result.diff.kind).toBe("update");
		expect(result.diff.changes).toEqual([
			{
				kind: "update",
				path: "src/index.ts",
				hash: hashContent("console.log(2)"),
				size: expect.any(Number),
				lastSeenAt: expect.any(Date),
			},
		]);
		expect(adapter.saveCalls).toHaveLength(1);
		const saveCall = adapter.saveCalls[0];
		expect(saveCall).toBeDefined();
		expect(saveCall?.payload.files).toEqual([
			{
				path: "src/index.ts",
				size: expect.any(Number),
				hash: hashContent("console.log(2)"),
				content: expect.any(Buffer),
			},
		]);
		await tx.close();
	});

	it("commits newly added files with create diff", async () => {
		const sandbox = createMockSandbox();
		const initialFiles = [
			createWorkspaceFile("src/index.ts", "console.log(1)"),
		];
		const adapter = new InMemoryAdapter({
			manifest: buildManifest(
				initialFiles.map(({ path, content }) => ({ path, content })),
				new Date("2026-03-17T00:00:00Z"),
			),
			files: initialFiles,
		});
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/create",
		});
		const tx = await volume.begin(sandbox as unknown as Sandbox);

		sandbox.setFileState({
			"/workspace/src/index.ts": "console.log(1)",
			"/workspace/src/new.ts": "new file",
		});

		const result = await tx.commit();

		expect(result.committed).toBe(true);
		expect(result.diff.kind).toBe("create");
		expect(result.diff.changes).toEqual(
			expect.arrayContaining([
				{
					kind: "create",
					path: "src/new.ts",
					hash: hashContent("new file"),
					size: 8,
					lastSeenAt: expect.any(Date),
				},
			]),
		);
		expect(adapter.saveCalls).toHaveLength(1);
		const createSaveCall = adapter.saveCalls[0];
		expect(createSaveCall).toBeDefined();
		expect(createSaveCall?.payload.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "src/index.ts",
				}),
				expect.objectContaining({
					path: "src/new.ts",
				}),
			]),
		);
		await tx.close();
	});

	it("falls back to node scanning when bash find is unavailable", async () => {
		const commandCalls: string[] = [];
		const sandbox = createMockSandbox(async (command, args) => {
			commandCalls.push(`${command}:${args[0]}`);

			if (command === "bash") {
				return {
					exitCode: 127,
					stdout: async () => "bash: find: command not found",
				};
			}

			if (command === "node" && args[0] === "-e") {
				return {
					exitCode: 0,
					stdout: async () =>
						"/workspace/src/index.ts\0/workspace/src/new.ts\0",
				};
			}

			throw new Error(`unexpected command: ${command}`);
		});

		const initialFiles = [
			createWorkspaceFile("src/index.ts", "console.log(1)"),
		];
		const adapter = new InMemoryAdapter({
			manifest: buildManifest(
				initialFiles.map(({ path, content }) => ({ path, content })),
				new Date("2026-03-17T00:00:00Z"),
			),
			files: initialFiles,
		});
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/find-fallback",
		});
		const tx = await volume.begin(sandbox as unknown as Sandbox);

		sandbox.setFileState({
			"/workspace/src/index.ts": "console.log(1)",
			"/workspace/src/new.ts": "created",
		});

		const result = await tx.commit();

		expect(commandCalls).toEqual(["bash:-lc", "node:-e"]);
		expect(result.committed).toBe(true);
		expect(result.diff.changes).toEqual([
			{
				kind: "create",
				path: "src/new.ts",
				hash: hashContent("created"),
				size: 7,
				lastSeenAt: expect.any(Date),
			},
		]);
		expect(adapter.saveCalls).toHaveLength(1);
		const saveCall = adapter.saveCalls[0];
		expect(saveCall).toBeDefined();
		expect(saveCall?.payload.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "src/index.ts",
				}),
				expect.objectContaining({
					path: "src/new.ts",
				}),
			]),
		);
		await tx.close();
	});

	it("commits deletions", async () => {
		const sandbox = createMockSandbox();
		const initialFiles = [
			createWorkspaceFile("src/index.ts", "console.log(1)"),
			createWorkspaceFile("src/obsolete.ts", "obsolete"),
		];
		const adapter = new InMemoryAdapter({
			manifest: buildManifest(
				initialFiles.map(({ path, content }) => ({ path, content })),
				new Date("2026-03-17T00:00:00Z"),
			),
			files: initialFiles,
		});
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/delete",
		});
		const tx = await volume.begin(sandbox as unknown as Sandbox);

		sandbox.setFileState({
			"/workspace/src/index.ts": "console.log(1)",
		});

		const result = await tx.commit();

		expect(result.committed).toBe(true);
		expect(result.diff.kind).toBe("delete");
		expect(result.diff.changes).toEqual([
			{
				kind: "delete",
				path: "src/obsolete.ts",
				hash: expect.any(String),
				size: expect.any(Number),
				lastSeenAt: expect.any(Date),
			},
		]);
		expect(adapter.saveCalls).toHaveLength(1);
		const deleteSaveCall = adapter.saveCalls[0];
		expect(deleteSaveCall).toBeDefined();
		expect(deleteSaveCall?.payload.files).toEqual([
			{
				path: "src/index.ts",
				content: expect.any(Buffer),
				size: expect.any(Number),
				hash: hashContent("console.log(1)"),
			},
		]);
		await tx.close();
	});

	it("returns no-op for unchanged workspace and skips persistence", async () => {
		const sandbox = createMockSandbox();
		const initialFile = createWorkspaceFile("src/index.ts", "console.log(1)");
		const baselineManifest = {
			...buildManifest(
				[{ path: initialFile.path, content: initialFile.content }],
				new Date("2026-03-17T00:00:00Z"),
			),
			version: 9,
		};
		const adapter = new InMemoryAdapter(
			{
				manifest: baselineManifest,
				files: [initialFile],
			},
			9,
		);
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/no-op",
		});
		const tx = await volume.begin(sandbox as unknown as Sandbox);

		sandbox.setFileState({
			"/workspace/src/index.ts": "console.log(1)",
		});

		const result = await tx.commit();

		expect(result.committed).toBe(false);
		expect(result.diff).toEqual({
			key: "repo/no-op",
			kind: "no-op",
			changes: [],
		});
		expect(result.nextVersion).toBe(9);
		expect(adapter.saveCalls).toHaveLength(0);
		await tx.close();
	});

	it("ignores excluded files during scan and commit payload", async () => {
		const sandbox = createMockSandbox();
		const initialFiles = [
			createWorkspaceFile("src/index.ts", "console.log(1)"),
			createWorkspaceFile("coverage/out.json", '{"keep":false}'),
		];
		const adapter = new InMemoryAdapter({
			manifest: buildManifest(
				initialFiles.map(({ path, content }) => ({ path, content })),
				new Date("2026-03-17T00:00:00Z"),
			),
			files: initialFiles,
		});
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/exclude-scan",
			exclude: ["coverage/**"],
		});
		const tx = await volume.begin(sandbox as unknown as Sandbox);

		sandbox.setFileState({
			"/workspace/src/index.ts": "console.log(2)",
			"/workspace/coverage/out.json": "mutated",
		});

		const result = await tx.commit();

		expect(result.committed).toBe(true);
		expect(result.diff.changes).toEqual([
			{
				kind: "update",
				path: "src/index.ts",
				hash: hashContent("console.log(2)"),
				size: expect.any(Number),
				lastSeenAt: expect.any(Date),
			},
		]);
		expect(adapter.saveCalls).toHaveLength(1);
		const saveCall = adapter.saveCalls[0];
		expect(saveCall).toBeDefined();
		expect(saveCall?.payload.files).toHaveLength(1);
		expect(saveCall?.payload.files[0]).toMatchObject({
			path: "src/index.ts",
			size: expect.any(Number),
			hash: hashContent("console.log(2)"),
		});
		expect(
			saveCall?.payload.files.some((file) => file.path === "coverage/out.json"),
		).toBe(false);
		await tx.close();
	});

	it("does not emit deletes for newly excluded historical files", async () => {
		const sandbox = createMockSandbox();
		const initialFiles = [
			createWorkspaceFile("src/index.ts", "console.log(1)"),
			createWorkspaceFile("dist/out.js", "ignored"),
		];
		const adapter = new InMemoryAdapter({
			manifest: buildManifest(
				initialFiles.map(({ path, content }) => ({ path, content })),
				new Date("2026-03-17T00:00:00Z"),
			),
			files: initialFiles,
		});
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/exclude-historic",
			exclude: ["dist/**"],
		});
		const tx = await volume.begin(sandbox as unknown as Sandbox);

		sandbox.setFileState({
			"/workspace/src/index.ts": "console.log(1)",
		});

		const result = await tx.commit();

		expect(result.committed).toBe(false);
		expect(result.diff.kind).toBe("no-op");
		expect(
			result.diff.changes.every((change) => change.path !== "dist/out.js"),
		).toBe(true);
		expect(adapter.saveCalls).toHaveLength(0);
		await tx.close();
	});

	it("returns explicit stale lock error from transaction close", async () => {
		const sandbox = createMockSandbox();
		const adapter = new TransactionLockAdapter("repo/tx-stale-close", "stale");
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/tx-stale-close",
			defaultLockMode: "exclusive",
		});
		const tx = await volume.begin(sandbox as unknown as Sandbox);

		await expect(tx.close()).rejects.toBeInstanceOf(WorkspaceLockStaleError);
		expect(adapter.loadCount).toBe(1);
	});

	it("returns explicit lock release error from transaction close", async () => {
		const sandbox = createMockSandbox();
		const adapter = new TransactionLockAdapter(
			"repo/tx-release-fail",
			"generic",
		);
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/tx-release-fail",
			defaultLockMode: "exclusive",
		});
		const tx = await volume.begin(sandbox as unknown as Sandbox);

		await expect(tx.close()).rejects.toBeInstanceOf(WorkspaceLockReleaseError);
		expect(adapter.loadCount).toBe(1);
	});
});
