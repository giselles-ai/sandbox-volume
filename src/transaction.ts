import type { Sandbox } from "@vercel/sandbox";

import {
	buildManifest,
	createEmptyManifest,
	diffManifests,
	hasChanges,
	type WorkspaceDiff,
	type WorkspaceManifest,
} from "./manifest";
import { filterPathsByRules } from "./path-rules";
import {
	collectWorkspaceFiles,
	hydrateWorkspaceFiles,
	normalizeMountPath,
	scanWorkspaceFilePaths,
} from "./sandbox-files";
import type {
	LockMode,
	StorageAdapter,
	StorageLock,
	StoragePathRules,
	WorkspaceCommitResult,
	WorkspaceFileEntry,
	WorkspaceTransaction as WorkspaceTransactionHandle,
	WorkspaceTransactionOptions,
} from "./types";
import {
	WorkspaceLockAcquisitionError,
	WorkspaceLockConflictError,
	WorkspaceLockError,
	WorkspaceLockReleaseError,
	WorkspaceLockStaleError,
} from "./types";

interface WorkspaceTransactionInit {
	key: string;
	sandbox: Sandbox;
	adapter: StorageAdapter;
	mountPath: string;
	lock?: LockMode;
	pathRules?: StoragePathRules | null;
}

interface CommitOptions {
	force?: boolean;
}

export class WorkspaceTransaction implements WorkspaceTransactionHandle {
	readonly #key: string;
	readonly #sandbox: Sandbox;
	readonly #adapter: StorageAdapter;
	readonly #mountPath: string;
	readonly #options: WorkspaceTransactionOptions;
	#opened = false;
	#closed = false;
	#lock: StorageLock | null = null;
	#baselineManifest = createEmptyManifest();
	#baselineFiles: WorkspaceFileEntry[] = [];
	readonly #pathRules: StoragePathRules | null;

	constructor(input: WorkspaceTransactionInit) {
		this.#key = input.key;
		this.#sandbox = input.sandbox;
		this.#adapter = input.adapter;
		this.#mountPath = normalizeMountPath(input.mountPath);
		this.#options = input.lock ? { lock: input.lock } : {};
		this.#pathRules = input.pathRules ?? null;
	}

	get key(): string {
		return this.#key;
	}

	get sandbox(): Sandbox {
		return this.#sandbox;
	}

	get options(): WorkspaceTransactionOptions {
		return this.#options;
	}

	get mountPath(): string {
		return this.#mountPath;
	}

	get baselineManifest() {
		return this.#baselineManifest;
	}

	get baselineFiles() {
		return this.#baselineFiles;
	}

	async open(): Promise<void> {
		if (this.#closed) {
			throw new Error("Cannot open a closed transaction.");
		}

		if (this.#opened) {
			return;
		}

		const lockMode = this.#options.lock ?? "none";
		if (lockMode !== "none") {
			if (!this.#adapter.acquireLock || !this.#adapter.releaseLock) {
				throw new Error(
					"StorageAdapter requires acquireLock and releaseLock for locking.",
				);
			}
			this.#lock = await this.#acquireLock(lockMode);
		}

		try {
			const loaded = await this.#adapter.loadWorkspace(this.#key);
			if (loaded) {
				const filteredManifest = this.#filterManifestByRules(loaded.manifest);
				const managedPaths = new Set(
					filteredManifest.paths.map((entry) => entry.path),
				);
				this.#baselineManifest = filteredManifest;
				this.#baselineFiles = loaded.files.filter((file) =>
					managedPaths.has(file.path),
				);
			}
			await hydrateWorkspaceFiles(
				this.#sandbox,
				this.#mountPath,
				loaded?.files.filter((file) =>
					this.#pathRules
						? filterPathsByRules([file.path], this.#pathRules).length > 0
						: true,
				) ?? [],
			);
			this.#opened = true;
		} catch (error) {
			await this.#releaseLock();
			throw error;
		}
	}

	async #acquireLock(lockMode: LockMode): Promise<StorageLock> {
		if (!this.#adapter.acquireLock) {
			throw new Error(
				"StorageAdapter requires acquireLock to perform locking.",
			);
		}

		try {
			return await this.#adapter.acquireLock(this.#key, lockMode);
		} catch (error) {
			if (
				error instanceof WorkspaceLockConflictError ||
				(error instanceof WorkspaceLockError && error.code === "conflict")
			) {
				throw error;
			}

			if (
				error instanceof WorkspaceLockAcquisitionError ||
				error instanceof WorkspaceLockStaleError
			) {
				throw error;
			}

			if (error instanceof WorkspaceLockError) {
				throw new WorkspaceLockAcquisitionError(this.#key, lockMode, error);
			}

			if (
				error instanceof Error &&
				/(already|held|conflict|exists)/i.test(error.message)
			) {
				throw new WorkspaceLockConflictError(this.#key, lockMode, error);
			}

			throw new WorkspaceLockAcquisitionError(this.#key, lockMode, error);
		}
	}

	async diff(): Promise<WorkspaceDiff> {
		await this.open();

		const files = await this.#scan();
		const now = new Date();
		const manifest = buildManifest(
			files.map((file) => ({
				path: file.path,
				content: file.content,
			})),
			now,
		);
		return diffManifests(this.#key, this.#baselineManifest, manifest);
	}

	async commit(): Promise<WorkspaceCommitResult> {
		return this.#commitWithOptions();
	}

	async rewrite(): Promise<WorkspaceCommitResult> {
		return this.#commitWithOptions({ force: true });
	}

	async #commitWithOptions(
		options: CommitOptions = {},
	): Promise<WorkspaceCommitResult> {
		await this.open();
		const scannedFiles = await this.#scan();
		const manifest = buildManifest(
			scannedFiles.map((file) => ({
				path: file.path,
				content: file.content,
			})),
		);
		const diff = diffManifests(this.#key, this.#baselineManifest, manifest);
		const shouldPersist = options.force || hasChanges(diff);

		if (!shouldPersist) {
			return {
				key: this.#key,
				committed: false,
				nextVersion: this.#baselineManifest.version,
				committedAt: new Date(),
				diff,
			};
		}

		const saved = await this.#adapter.saveWorkspace(this.#key, {
			manifest: {
				...manifest,
				version: this.#baselineManifest.version + 1,
			},
			files: scannedFiles,
		});

		this.#baselineManifest = {
			...manifest,
			version: saved.version,
			updatedAt: saved.updatedAt,
		};
		this.#baselineFiles = scannedFiles;

		return {
			key: this.#key,
			committed: true,
			nextVersion: saved.version,
			committedAt: saved.updatedAt,
			diff,
		};
	}

	async #scan(): Promise<WorkspaceFileEntry[]> {
		const paths = await scanWorkspaceFilePaths(
			this.#sandbox,
			this.#mountPath,
			this.#pathRules,
		);
		return collectWorkspaceFiles(this.#sandbox, this.#mountPath, paths);
	}

	async close(): Promise<void> {
		if (this.#closed) {
			return;
		}

		this.#closed = true;
		await this.#releaseLock();
	}

	async #releaseLock(): Promise<void> {
		if (!this.#lock) {
			return;
		}

		const lock = this.#lock;
		this.#lock = null;
		try {
			await this.#adapter.releaseLock?.(lock);
		} catch (error) {
			if (error instanceof WorkspaceLockStaleError) {
				throw error;
			}

			if (
				error instanceof WorkspaceLockReleaseError ||
				error instanceof WorkspaceLockError
			) {
				throw new WorkspaceLockReleaseError(
					lock.key,
					lock.mode,
					lock.leaseId,
					error,
				);
			}

			throw new WorkspaceLockReleaseError(
				lock.key,
				lock.mode,
				lock.leaseId,
				error,
			);
		}
	}

	#filterManifestByRules(manifest: WorkspaceManifest): WorkspaceManifest {
		if (!this.#pathRules) {
			return manifest;
		}

		const managedPaths = new Set(
			filterPathsByRules(
				manifest.paths.map((entry) => entry.path),
				this.#pathRules,
			),
		);

		return {
			...manifest,
			paths: manifest.paths.filter((entry) => managedPaths.has(entry.path)),
		};
	}
}
