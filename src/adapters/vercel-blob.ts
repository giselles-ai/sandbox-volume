import type { ListBlobResult, PutCommandOptions } from "@vercel/blob";
import type { WorkspaceManifest } from "../manifest";
import type {
	StorageAdapter,
	StorageLoadResult,
	StorageSaveResult,
	WorkspacePayload,
} from "./types";

const DEFAULT_NAMESPACE = "sandbox-volume";
const DEFAULT_STATE_FILE_NAME = "workspace-state.json";

function normalizeNamespace(namespace: string): string {
	return namespace.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_NAMESPACE;
}

function normalizeWorkspaceKey(key: string): string {
	return key.trim().replace(/^\/+|\/+$/g, "");
}

function toStatePath(namespace: string, key: string): string {
	return `${namespace}/${normalizeWorkspaceKey(key)}/${DEFAULT_STATE_FILE_NAME}`;
}

function decodeBase64(content: string): Uint8Array {
	return new Uint8Array(Buffer.from(content, "base64"));
}

function encodeBase64(content: Uint8Array): string {
	return Buffer.from(content).toString("base64");
}

function serializeManifest(manifest: WorkspaceManifest): {
	version: number;
	updatedAt: string;
	paths: Array<{
		path: string;
		hash: string;
		size: number;
		lastSeenAt: string;
	}>;
} {
	return {
		version: manifest.version,
		updatedAt: manifest.updatedAt.toISOString(),
		paths: manifest.paths.map((entry) => ({
			path: entry.path,
			hash: entry.hash,
			size: entry.size,
			lastSeenAt: entry.lastSeenAt.toISOString(),
		})),
	};
}

function deserializeManifest(serialized: {
	version: number;
	updatedAt: string;
	paths: Array<{
		path: string;
		hash: string;
		size: number;
		lastSeenAt: string;
	}>;
}): WorkspaceManifest {
	return {
		version: serialized.version,
		updatedAt: new Date(serialized.updatedAt),
		paths: serialized.paths.map((entry) => ({
			path: entry.path,
			hash: entry.hash,
			size: entry.size,
			lastSeenAt: new Date(entry.lastSeenAt),
		})),
	};
}

interface PersistedWorkspaceState {
	manifest: {
		version: number;
		updatedAt: string;
		paths: Array<{
			path: string;
			hash: string;
			size: number;
			lastSeenAt: string;
		}>;
	};
	files: Array<{
		path: string;
		size: number;
		hash: string;
		content: string;
	}>;
}

function isPersistedWorkspaceState(
	value: unknown,
): value is PersistedWorkspaceState {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as {
		manifest?: unknown;
		files?: unknown;
	};

	if (typeof candidate.manifest !== "object" || candidate.manifest === null) {
		return false;
	}

	const manifest = candidate.manifest as { paths?: unknown };
	return Array.isArray(candidate.files) && Array.isArray(manifest.paths);
}

export interface VercelBlobStorageAdapterOptions {
	/**
	 * Prefix namespace for keys under the Blob store.
	 */
	namespace?: string;
	/**
	 * Blob write token. Defaults to BLOB_READ_WRITE_TOKEN.
	 */
	token?: string;
	/**
	 * Blob access mode.
	 */
	access?: PutCommandOptions["access"];
}

export class VercelBlobStorageAdapter implements StorageAdapter {
	readonly #namespace: string;
	readonly #access: PutCommandOptions["access"];
	readonly #token: string;

	constructor(options: VercelBlobStorageAdapterOptions = {}) {
		this.#namespace = normalizeNamespace(
			options.namespace ?? DEFAULT_NAMESPACE,
		);
		this.#access = options.access ?? "public";
		this.#token = options.token ?? process.env.BLOB_READ_WRITE_TOKEN ?? "";
	}

	#stateBlobPath(key: string): string {
		return toStatePath(this.#namespace, key);
	}

	#blobClient() {
		// Importing lazily keeps package startup independent from optional runtime availability.
		return import("@vercel/blob");
	}

	async loadWorkspace(key: string): Promise<StorageLoadResult | null> {
		const { list } = await this.#blobClient();
		const statePath = this.#stateBlobPath(key);
		const prefix = statePath;

		const listing = await list({
			prefix,
			token: this.#token,
		});

		const state = this.#resolveStateBlob(listing, statePath);
		if (!state) {
			return null;
		}

		const response = await fetch(state.url);
		if (!response.ok) {
			throw new Error(
				`Failed to load workspace state for ${key}: ${response.status}`,
			);
		}

		const payloadText = await response.text();
		let payload: unknown;
		try {
			payload = JSON.parse(payloadText);
		} catch {
			throw new Error(`Corrupted workspace state for ${key}.`);
		}

		if (!isPersistedWorkspaceState(payload)) {
			throw new Error(`Invalid workspace state format for ${key}.`);
		}

		return {
			manifest: deserializeManifest(payload.manifest),
			files: payload.files.map((file) => ({
				path: file.path,
				size: file.size,
				hash: file.hash,
				content: decodeBase64(file.content),
			})),
		};
	}

	#resolveStateBlob(
		listing: ListBlobResult,
		statePath: string,
	): { url: string } | null {
		for (const blob of listing.blobs) {
			if (blob.pathname === statePath) {
				return { url: blob.url };
			}

			const fromUrl = this.#blobPathFromUrl(blob.url);
			if (fromUrl === statePath) {
				return { url: blob.url };
			}
		}

		return null;
	}

	#blobPathFromUrl(url: string): string {
		try {
			return new URL(url).pathname.replace(/^\//, "");
		} catch {
			return url;
		}
	}

	async saveWorkspace(
		key: string,
		payload: WorkspacePayload,
	): Promise<StorageSaveResult> {
		const { put } = await this.#blobClient();
		const stateBlobPath = this.#stateBlobPath(key);
		const serialized = {
			manifest: serializeManifest(payload.manifest),
			files: payload.files.map((entry) => ({
				path: entry.path,
				size: entry.size,
				hash: entry.hash,
				content: encodeBase64(entry.content),
			})),
		};

		const putOptions: PutCommandOptions = {
			token: this.#token,
			access: this.#access,
		};

		await put(stateBlobPath, JSON.stringify(serialized), putOptions);

		return {
			key,
			version: payload.manifest.version,
			updatedAt: new Date(payload.manifest.updatedAt),
		};
	}
}

export function createVercelBlobStorageAdapter(
	options: VercelBlobStorageAdapterOptions = {},
): VercelBlobStorageAdapter {
	return new VercelBlobStorageAdapter(options);
}
