import type { Sandbox } from "@vercel/sandbox";
import { describe, expect, it } from "bun:test";
import type {
	StorageAdapter,
	StorageLoadResult,
	StorageLock,
} from "../adapters/types";
import { createEmptyManifest } from "../manifest";
import { SandboxVolume } from "../sandbox-volume";
import { WorkspaceLockConflictError, WorkspaceLockStaleError } from "../types";

type MockCommandResult = {
	exitCode: number;
	stdout: () => Promise<string>;
};

type MockReadFileArgs = {
	path: string;
};

type MockWriteFile = {
	path: string;
	content: Buffer;
};

type MockSandbox = {
	mkdirCalls: string[];
	writtenFiles: MockWriteFile[];
	mkDir: (path: string) => Promise<void>;
	writeFiles: (files: MockWriteFile[]) => Promise<void>;
	runCommand: (command: string, args: string[]) => Promise<MockCommandResult>;
	readFileToBuffer: (file: MockReadFileArgs) => Promise<Buffer | null>;
	setFileState: (state: Record<string, string>) => void;
};

function createMockSandbox(): MockSandbox {
	const fileContents = new Map<string, Buffer>();
	const sandboxState: { filePaths: string[] } = { filePaths: [] };
	const mkd: string[] = [];
	const writtenFiles: MockWriteFile[] = [];

	return {
		mkdirCalls: mkd,
		writtenFiles,
		mkDir: async (path: string) => {
			mkd.push(path);
		},
		writeFiles: async (files) => {
			writtenFiles.push(...files);
		},
		runCommand: async (command: string, args: string[]) => {
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
		},
		readFileToBuffer: async ({ path }) => fileContents.get(path) ?? null,
		setFileState: (state) => {
			fileContents.clear();
			const nextPaths = Object.entries(state).map(([path, content]) => {
				fileContents.set(path, Buffer.from(content));
				return path;
			});
			sandboxState.filePaths = [...nextPaths];
		},
	};
}

class LockingAdapter implements StorageAdapter {
	public events: string[] = [];
	public saveCalls = 0;
	private readonly lock: StorageLock;

	constructor(
		private readonly initial: StorageLoadResult | null,
		options: { key: string },
	) {
		this.lock = {
			key: options.key,
			leaseId: `lease:${options.key}`,
			acquiredAt: new Date("2026-03-17T00:00:00Z"),
			mode: "exclusive",
		};
	}

	async loadWorkspace(): Promise<StorageLoadResult | null> {
		this.events.push("loadWorkspace");
		return this.initial;
	}

	async saveWorkspace(): Promise<{
		updatedAt: Date;
		key: string;
		version: number;
	}> {
		this.saveCalls += 1;
		this.events.push("saveWorkspace");
		return {
			updatedAt: new Date("2026-03-17T00:00:00Z"),
			key: this.lock.key,
			version: 1,
		};
	}

	async acquireLock(): Promise<StorageLock> {
		this.events.push(`acquire:${this.lock.mode}`);
		return this.lock;
	}

	async releaseLock(): Promise<void> {
		this.events.push(`release:${this.lock.leaseId}`);
	}
}

class AlwaysConflictAdapter implements StorageAdapter {
	public events: string[] = [];

	async loadWorkspace(): Promise<StorageLoadResult | null> {
		this.events.push("loadWorkspace");
		return null;
	}

	async saveWorkspace(): Promise<{
		updatedAt: Date;
		key: string;
		version: number;
	}> {
		this.events.push("saveWorkspace");
		return {
			updatedAt: new Date("2026-03-17T00:00:00Z"),
			key: "repo/mount-conflict",
			version: 1,
		};
	}

	async acquireLock(): Promise<StorageLock> {
		this.events.push("acquire:exclusive");
		throw new WorkspaceLockConflictError("repo/mount-conflict", "exclusive");
	}

	async releaseLock(): Promise<void> {
		this.events.push("release");
	}
}

class StaleReleaseAdapter implements StorageAdapter {
	public events: string[] = [];
	private readonly lock: StorageLock = {
		key: "repo/mount-stale",
		leaseId: "stale:lease",
		acquiredAt: new Date("2026-03-17T00:00:00Z"),
		mode: "exclusive",
	};

	async loadWorkspace(): Promise<StorageLoadResult | null> {
		this.events.push("loadWorkspace");
		return null;
	}

	async saveWorkspace(): Promise<{
		updatedAt: Date;
		key: string;
		version: number;
	}> {
		this.events.push("saveWorkspace");
		return {
			updatedAt: new Date("2026-03-17T00:00:00Z"),
			key: this.lock.key,
			version: 1,
		};
	}

	async acquireLock(): Promise<StorageLock> {
		this.events.push("acquire:exclusive");
		return { ...this.lock };
	}

	async releaseLock(): Promise<void> {
		this.events.push(`release:${this.lock.leaseId}`);
		throw new WorkspaceLockStaleError(
			this.lock.key,
			this.lock.mode,
			this.lock.leaseId,
		);
	}
}

describe("mount", () => {
	it("acquires and releases lock in success path with implicit commit", async () => {
		const sandbox = createMockSandbox();
		const adapter = new LockingAdapter(
			{
				manifest: createEmptyManifest(),
				files: [],
			},
			{ key: "repo/mount-success" },
		);
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/mount-success",
			defaultLockMode: "exclusive",
		});

		const value = await volume.mount(
			sandbox as unknown as Sandbox,
			async (txSandbox) => {
				sandbox.setFileState({
					"/vercel/sandbox/workspace/app.ts": "console.log('ok')",
				});
				expect(txSandbox).toBeDefined();
				return "result";
			},
		);

		expect(value).toBe("result");
		expect(adapter.saveCalls).toBe(1);
		expect(adapter.events).toEqual([
			"acquire:exclusive",
			"loadWorkspace",
			"saveWorkspace",
			"release:lease:repo/mount-success",
		]);
	});

	it("releases lock and skips save when callback fails", async () => {
		const sandbox = createMockSandbox();
		const adapter = new LockingAdapter(
			{
				manifest: createEmptyManifest(),
				files: [],
			},
			{ key: "repo/mount-fail" },
		);
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/mount-fail",
			defaultLockMode: "exclusive",
		});

		await expect(
			volume.mount(sandbox as unknown as Sandbox, async () => {
				throw new Error("callback failed");
			}),
		).rejects.toThrow("callback failed");

		expect(adapter.saveCalls).toBe(0);
		expect(adapter.events).toEqual([
			"acquire:exclusive",
			"loadWorkspace",
			"release:lease:repo/mount-fail",
		]);
	});

	it("close() is idempotent", async () => {
		const sandbox = createMockSandbox();
		const adapter = new LockingAdapter(
			{
				manifest: createEmptyManifest(),
				files: [],
			},
			{ key: "repo/close-idempotent" },
		);
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/close-idempotent",
			defaultLockMode: "exclusive",
		});
		const tx = await volume.begin(sandbox as unknown as Sandbox);

		await tx.close();
		await tx.close();

		expect(adapter.events).toEqual([
			"acquire:exclusive",
			"loadWorkspace",
			"release:lease:repo/close-idempotent",
		]);
	});

	it("propagates conflict as WorkspaceLockConflictError", async () => {
		const sandbox = createMockSandbox();
		const adapter = new AlwaysConflictAdapter();
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/mount-conflict",
			defaultLockMode: "exclusive",
		});

		await expect(
			volume.begin(sandbox as unknown as Sandbox),
		).rejects.toBeInstanceOf(WorkspaceLockConflictError);

		expect(adapter.events).toEqual(["acquire:exclusive"]);
	});

	it("surfaces stale lock errors from release when callback succeeds", async () => {
		const sandbox = createMockSandbox();
		const adapter = new StaleReleaseAdapter();
		const volume = await SandboxVolume.create({
			adapter,
			key: "repo/mount-stale",
			defaultLockMode: "exclusive",
		});

		await expect(
			volume.mount(sandbox as unknown as Sandbox, async () => {
				expect(adapter.events).toEqual(["acquire:exclusive", "loadWorkspace"]);
			}),
		).rejects.toBeInstanceOf(WorkspaceLockStaleError);

		expect(adapter.events).toContain("release:stale:lease");
	});
});
