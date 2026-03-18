import type { Sandbox } from "@vercel/sandbox";
import { WorkspaceTransaction as DefaultWorkspaceTransaction } from "./transaction";
import type {
  MountOptions,
  SandboxVolumeOptions,
  StorageAdapter,
  VolumeMountCallback,
  WorkspaceCommitResult,
  WorkspaceDiff,
  WorkspaceTransaction,
} from "./types";

const DEFAULT_MOUNT_PATH = "/vercel/sandbox/workspace";

export class SandboxVolume {
  readonly #options: SandboxVolumeOptions;

  private constructor(options: SandboxVolumeOptions) {
    this.#options = options;
  }

  static async create(options: SandboxVolumeOptions): Promise<SandboxVolume> {
    if (!options.adapter) {
      throw new Error("SandboxVolumeOptions.adapter is required.");
    }

    if (!options.key) {
      throw new Error("SandboxVolumeOptions.key is required.");
    }

    return new SandboxVolume(options);
  }

  get key(): string {
    return this.#options.key;
  }

  get adapter(): StorageAdapter {
    return this.#options.adapter;
  }

  get path(): string {
    return this.#options.path ?? DEFAULT_MOUNT_PATH;
  }

  async begin(sandbox: Sandbox, options: MountOptions = {}): Promise<WorkspaceTransaction> {
    const mountPath = options.path ?? this.path;
    const transactionInput = {
      key: this.key,
      sandbox,
      adapter: this.adapter,
      mountPath,
      pathRules: {
        ...(this.#options.include ? { include: this.#options.include } : {}),
        ...(this.#options.exclude ? { exclude: this.#options.exclude } : {}),
      },
      ...((options.lock ?? this.#options.defaultLockMode)
        ? { lock: options.lock ?? this.#options.defaultLockMode }
        : {}),
    };
    const tx = new DefaultWorkspaceTransaction(transactionInput);
    await tx.open();
    return tx;
  }

  async mount<TResult = WorkspaceDiff>(
    sandbox: Sandbox,
    callback: VolumeMountCallback<TResult>,
    options: MountOptions = {},
  ): Promise<TResult> {
    const tx = await this.begin(sandbox, options);
    let callbackError: unknown = null;
    let callbackResult: TResult | undefined;

    try {
      callbackResult = await callback(sandbox, tx);
      await tx.commit();
    } catch (error) {
      callbackError = error;
    }

    try {
      await tx.close();
    } catch (closeError) {
      if (callbackError === null) {
        callbackError = closeError;
      }
    }

    if (callbackError !== null) {
      throw callbackError;
    }

    return callbackResult as TResult;
  }

  async commitAll(sandbox: Sandbox): Promise<WorkspaceCommitResult> {
    const tx = await this.begin(sandbox);
    let commitError: unknown = null;
    let commitResult: WorkspaceCommitResult | undefined;

    try {
      commitResult = await tx.commit();
    } catch (error) {
      commitError = error;
    }

    try {
      await tx.close();
    } catch (closeError) {
      if (commitError === null) {
        commitError = closeError;
      }
    }

    if (commitError !== null) {
      throw commitError;
    }

    if (commitResult === undefined) {
      throw new Error("Unexpected state: commit did not return a result.");
    }

    return commitResult;
  }

  async rewrite(sandbox: Sandbox, options: MountOptions = {}): Promise<WorkspaceCommitResult> {
    const tx = await this.begin(sandbox, options);
    let rewriteError: unknown = null;
    let rewriteResult: WorkspaceCommitResult | undefined;

    try {
      rewriteResult = await tx.rewrite();
    } catch (error) {
      rewriteError = error;
    }

    try {
      await tx.close();
    } catch (closeError) {
      if (rewriteError === null) {
        rewriteError = closeError;
      }
    }

    if (rewriteError !== null) {
      throw rewriteError;
    }

    if (rewriteResult === undefined) {
      throw new Error("Unexpected state: rewrite did not return a result.");
    }

    return rewriteResult;
  }

  async resync(sandbox: Sandbox, options: MountOptions = {}): Promise<WorkspaceCommitResult> {
    return this.rewrite(sandbox, options);
  }
}
