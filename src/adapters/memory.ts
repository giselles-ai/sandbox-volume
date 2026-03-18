import type { WorkspaceManifest } from "../manifest";
import { WorkspaceLockConflictError, WorkspaceLockStaleError } from "../types";
import type {
	LockMode,
	StorageAdapter,
	StorageLoadResult,
	StorageLock,
	WorkspaceFileEntry,
	WorkspacePayload,
} from "./types";

export interface MemoryWorkspaceState {
	manifest: WorkspaceManifest;
	files: WorkspaceFileEntry[];
}

export interface MemoryStorageAdapterOptions {
	store?: Map<string, MemoryWorkspaceState>;
}

function cloneManifest(manifest: WorkspaceManifest): WorkspaceManifest {
	return {
		version: manifest.version,
		updatedAt: new Date(manifest.updatedAt),
		paths: manifest.paths.map((entry) => ({
			path: entry.path,
			hash: entry.hash,
			size: entry.size,
			lastSeenAt: new Date(entry.lastSeenAt),
		})),
	};
}

function cloneWorkspaceFile(file: WorkspaceFileEntry): WorkspaceFileEntry {
	return {
		path: file.path,
		size: file.size,
		hash: file.hash,
		content: new Uint8Array(file.content),
	};
}

function cloneState(state: MemoryWorkspaceState): MemoryWorkspaceState {
	return {
		manifest: cloneManifest(state.manifest),
		files: state.files.map((file) => cloneWorkspaceFile(file)),
	};
}

export class InMemoryStorageAdapter implements StorageAdapter {
	#state: Map<string, MemoryWorkspaceState>;
	#locks = new Map<string, StorageLock>();
	#nextLeaseId = 0;

	constructor(options: MemoryStorageAdapterOptions = {}) {
		this.#state = options.store ?? new Map();
	}

	get store(): ReadonlyMap<string, MemoryWorkspaceState> {
		return this.#state;
	}

	async loadWorkspace(key: string): Promise<StorageLoadResult | null> {
		const state = this.#state.get(key);
		if (!state) {
			return null;
		}

		return cloneState(state);
	}

	async saveWorkspace(
		key: string,
		payload: WorkspacePayload,
	): Promise<{
		key: string;
		updatedAt: Date;
		version: number;
	}> {
		if (
			typeof payload.manifest.version !== "number" ||
			!Number.isFinite(payload.manifest.version)
		) {
			throw new Error("WorkspacePayload.manifest.version is required.");
		}
		const manifest = cloneManifest({
			...payload.manifest,
			updatedAt: new Date(payload.manifest.updatedAt),
		});

		this.#state.set(key, {
			manifest: cloneManifest(manifest),
			files: payload.files.map((file) => cloneWorkspaceFile(file)),
		});

		return {
			key,
			version: manifest.version,
			updatedAt: new Date(manifest.updatedAt),
		};
	}

	async acquireLock(key: string, mode: LockMode): Promise<StorageLock> {
		if (this.#locks.has(key)) {
			throw new WorkspaceLockConflictError(key, mode);
		}

		const lock: StorageLock = {
			key,
			leaseId: `memory:${++this.#nextLeaseId}`,
			acquiredAt: new Date(),
			mode,
		};
		this.#locks.set(key, lock);
		return { ...lock };
	}

	async releaseLock(lock: StorageLock): Promise<void> {
		const current = this.#locks.get(lock.key);
		if (!current) {
			throw new WorkspaceLockStaleError(
				lock.key,
				lock.mode,
				lock.leaseId,
				"Missing lock in adapter state",
			);
		}
		if (current.leaseId !== lock.leaseId) {
			throw new WorkspaceLockStaleError(
				lock.key,
				lock.mode,
				lock.leaseId,
				`Mismatched lease id for ${lock.key}: expected ${current.leaseId}`,
			);
		}

		this.#locks.delete(lock.key);
	}
}

export function createMemoryStorageAdapter(
	options: MemoryStorageAdapterOptions = {},
): InMemoryStorageAdapter {
	return new InMemoryStorageAdapter(options);
}
