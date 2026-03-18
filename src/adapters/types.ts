import type { WorkspaceManifest, WorkspaceManifestVersion } from "../manifest";

export type LockMode = "none" | "shared" | "exclusive";

export interface StorageLoadResult {
  manifest: WorkspaceManifest;
  files: ReadonlyArray<WorkspaceFileEntry>;
}

export interface StorageSaveResult {
  updatedAt: Date;
  key: string;
  version: WorkspaceManifestVersion;
}

export interface StorageLock {
  key: string;
  leaseId: string;
  acquiredAt: Date;
  mode: LockMode;
}

export interface WorkspaceFileEntry {
  path: string;
  content: Uint8Array;
  size: number;
  hash: string;
}

export interface WorkspacePayload {
  manifest: WorkspaceManifest;
  files: ReadonlyArray<WorkspaceFileEntry>;
}

export interface StorageAdapter {
  loadWorkspace(key: string): Promise<StorageLoadResult | null>;
  saveWorkspace(key: string, payload: WorkspacePayload): Promise<StorageSaveResult>;
  acquireLock?(key: string, mode: LockMode): Promise<StorageLock>;
  releaseLock?(lock: StorageLock): Promise<void>;
}
