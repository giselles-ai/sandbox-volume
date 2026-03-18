import {
  createMemoryStorageAdapter,
  SandboxVolume,
  type WorkspaceCommitResult,
  type WorkspaceDiff,
} from "@giselles-ai/sandbox-volume";
import { Sandbox } from "@vercel/sandbox";

const adapter = createMemoryStorageAdapter();
const key = "example/manual-volume";
const workspacePath = "/vercel/sandbox/workspace";

function inspectFileState(result: WorkspaceCommitResult | WorkspaceDiff, label: string) {
  console.log(`\n[${label}]`);
  console.log(JSON.stringify(result, replacer, 2));
}

function replacer(_key: string, value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

async function stopIfPossible(sandbox: Sandbox): Promise<void> {
  const stop = sandbox?.stop;
  if (typeof stop !== "function") {
    return;
  }

  try {
    await Promise.race([
      stop.call(sandbox),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("sandbox.stop() timed out after 10s"));
        }, 10_000);
      }),
    ]);
  } catch (error) {
    console.warn("sandbox.stop() failed:", error);
  }
}

async function runShell(
  sandbox: Sandbox,
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  const result = await sandbox.runCommand(command, args);
  const output = await result.stdout();
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${output}`);
  }

  return { exitCode: result.exitCode, stdout: output };
}

async function main() {
  const sandboxes: Sandbox[] = [];
  const addSandbox = async () => {
    const sandbox = await Sandbox.create({ runtime: "node24" });
    sandboxes.push(sandbox);
    return sandbox;
  };

  const volume = await SandboxVolume.create({
    adapter,
    key,
    path: workspacePath,
    include: ["**/*"],
    exclude: [".sandbox/**"],
  });

  try {
    console.log("=== phase 1: mount auto-commit flow ===");
    const sandbox = await addSandbox();
    const preCommitDiff = await volume.mount(sandbox, async (txSandbox, tx) => {
      const before = await tx.diff();
      console.log("mount: diff before write", before);

      await txSandbox.writeFiles([
        {
          path: `${workspacePath}/package.json`,
          content: Buffer.from('{"name":"manual-volume-demo"}\n'),
        },
        {
          path: `${workspacePath}/src/index.ts`,
          content: Buffer.from('export const message = "hello";\n'),
        },
      ]);

      const after = await tx.diff();
      console.log("mount: diff before auto-commit", after);
      return after;
    });

    inspectFileState(preCommitDiff, "phase 1 result (mount return)");
    console.log(
      "phase 1 stored paths:",
      [...(adapter.store.get(key)?.files ?? [])].map((file) => file.path),
    );

    console.log("\n=== phase 2: begin + commit flow ===");
    const hydratedSandbox = await addSandbox();
    const tx = await volume.begin(hydratedSandbox);
    const baselineDiff = await tx.diff();
    inspectFileState(baselineDiff, "phase 2: diff immediately after begin (should be no-op)");

    await hydratedSandbox.writeFiles([
      {
        path: `${workspacePath}/src/index.ts`,
        content: Buffer.from('export const message = "updated";\n'),
      },
      {
        path: `${workspacePath}/notes.md`,
        content: Buffer.from("updated note\n"),
      },
    ]);
    await runShell(hydratedSandbox, "bash", ["-lc", `rm -f ${workspacePath}/package.json`]);

    const changedDiff = await tx.diff();
    inspectFileState(changedDiff, "phase 2: diff before commit");
    const commitResult = await tx.commit();
    inspectFileState(commitResult, "phase 2: commit result");
    await tx.close();

    console.log(
      "phase 2 persisted paths:",
      [...(adapter.store.get(key)?.files ?? [])].map((file) => file.path),
    );

    console.log("\n=== phase 3: commitAll + rewrite ===");
    const noOpSandbox = await addSandbox();
    const noOpResult = await volume.commitAll(noOpSandbox);
    inspectFileState(noOpResult, "phase 3: commitAll without edits");
    const rewriteSandbox = await addSandbox();
    const rewriteResult = await volume.rewrite(rewriteSandbox);
    inspectFileState(rewriteResult, "phase 3: rewrite(force)");

    console.log("\n✅ verification complete");
  } finally {
    await Promise.all(sandboxes.map((sandbox) => stopIfPossible(sandbox)));
  }
}

void main().catch((error) => {
  console.error("❌ verification failed:", error);
  process.exitCode = 1;
});
