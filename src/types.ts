import type { Sandbox } from "@vercel/sandbox";
import type { LockMode, StorageAdapter, WorkspaceFileEntry } from "./adapters/types";
import type {
  WorkspaceDiff,
  WorkspaceFileChange,
  WorkspaceFileChangeKind,
  WorkspaceManifest,
} from "./manifest";

export type {
  LockMode,
  StorageAdapter,
  StorageLoadResult,
  StorageLock,
  StorageSaveResult,
  WorkspaceFileEntry,
  WorkspacePayload,
} from "./adapters/types";
export type {
  WorkspaceDiff,
  WorkspaceDiffKind,
  WorkspaceFileChange,
  WorkspaceFileChangeKind,
  WorkspaceManifest,
  WorkspaceManifestEntry,
} from "./manifest";

export type WorkspaceLockErrorCode = "acquire" | "conflict" | "release" | "stale";

export interface WorkspaceLockErrorOptions {
  code: WorkspaceLockErrorCode;
  key: string;
  mode?: LockMode;
  leaseId?: string;
  cause?: unknown;
}

export class WorkspaceLockError extends Error {
  override name: string;
  readonly code: WorkspaceLockErrorCode;
  readonly key: string;
  readonly mode: LockMode | undefined;
  readonly leaseId: string | undefined;
  override readonly cause: unknown;

  constructor(message: string, options: WorkspaceLockErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "WorkspaceLockError";
    this.code = options.code;
    this.key = options.key;
    this.mode = options.mode;
    this.leaseId = options.leaseId;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkspaceLockConflictError extends WorkspaceLockError {
  constructor(key: string, mode: LockMode, cause?: unknown) {
    super(`Workspace lock conflict for "${key}" with ${mode} mode`, {
      code: "conflict",
      key,
      mode,
      cause,
    });
    this.name = "WorkspaceLockConflictError";
  }
}

export class WorkspaceLockAcquisitionError extends WorkspaceLockError {
  constructor(key: string, mode: LockMode, cause?: unknown) {
    super(`Failed to acquire workspace lock for "${key}" with ${mode} mode`, {
      code: "acquire",
      key,
      mode,
      cause,
    });
    this.name = "WorkspaceLockAcquisitionError";
  }
}

export class WorkspaceLockReleaseError extends WorkspaceLockError {
  constructor(key: string, mode: LockMode, leaseId: string, cause?: unknown) {
    super(`Failed to release workspace lock for "${key}" (lease ${leaseId}) in ${mode} mode`, {
      code: "release",
      key,
      mode,
      leaseId,
      cause,
    });
    this.name = "WorkspaceLockReleaseError";
  }
}

export class WorkspaceLockStaleError extends WorkspaceLockError {
  constructor(key: string, mode: LockMode, leaseId: string, cause?: unknown) {
    super(`Workspace lock for "${key}" is stale or invalid (lease ${leaseId})`, {
      code: "stale",
      key,
      mode,
      leaseId,
      cause,
    });
    this.name = "WorkspaceLockStaleError";
  }
}

export interface StoragePathRules {
  /**
   * Include pattern list in POSIX style. If omitted or empty, all paths are treated as included.
   */
  include?: string[];
  /**
   * Exclude pattern list in POSIX style. Exclusions always win over inclusions.
   */
  exclude?: string[];
}

export interface SandboxVolumeOptions extends StoragePathRules {
  adapter: StorageAdapter;
  key: string;
  path?: string;
  defaultLockMode?: LockMode;
}

export interface WorkspaceTransactionOptions {
  lock?: LockMode;
}

export interface WorkspaceCommitResult {
  key: string;
  committed: boolean;
  nextVersion: number;
  committedAt: Date;
  diff: WorkspaceDiff;
}

export type WorkspaceChangeKind = WorkspaceFileChangeKind;
export interface WorkspaceChange extends WorkspaceFileChange {
  kind: WorkspaceChangeKind;
}

export interface WorkspaceTransaction {
  readonly key: string;
  readonly sandbox: Sandbox;
  readonly options: WorkspaceTransactionOptions;
  readonly mountPath: string;
  readonly baselineManifest: WorkspaceManifest;
  readonly baselineFiles: WorkspaceFileEntry[];
  open(): Promise<void>;
  diff(): Promise<WorkspaceDiff>;
  commit(): Promise<WorkspaceCommitResult>;
  rewrite(): Promise<WorkspaceCommitResult>;
  close(): Promise<void>;
}

export interface MountOptions extends WorkspaceTransactionOptions {
  path?: string;
}

export type WorkspaceTransactionResult = {
  tx: WorkspaceTransaction;
  diff: WorkspaceDiff;
};

export type VolumeMountCallback<TResult = WorkspaceDiff> = (
  sandbox: Sandbox,
  transaction: WorkspaceTransaction,
) => Promise<TResult>;
