import type { Sandbox } from "@vercel/sandbox";
import type { WorkspaceFileEntry } from "./adapters/types";
import { hashContent } from "./manifest";
import { filterPathsByRules } from "./path-rules";
import type { StoragePathRules } from "./types";

function toAbsoluteMountPath(mountPath: string): string {
	if (!mountPath.startsWith("/")) {
		return `/${mountPath}`;
	}
	return mountPath;
}

function joinPaths(root: string, relativePath: string): string {
	const cleanRoot = root.endsWith("/") ? root.slice(0, -1) : root;
	return `${cleanRoot}/${relativePath}`;
}

interface ScanStrategy {
	name: string;
	run: (sandbox: Sandbox, mountPath: string) => Promise<string[]>;
}

const NODE_SCAN_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");

const mountPath = process.argv[2];
if (!mountPath) {
  process.exit(64);
}

const queue = [mountPath];
const out = [];

while (queue.length > 0) {
  const current = queue.pop();
  if (!current) {
    continue;
  }

  const entries = fs.readdirSync(current, { withFileTypes: true });

  for (const entry of entries) {
    const absolute = path.posix.join(current, entry.name);
    if (entry.isDirectory()) {
      queue.push(absolute);
      continue;
    }
    
    out.push(absolute);
  }
}

process.stdout.write(out.join("\\0"));
`;

async function scanWithFind(
	sandbox: Sandbox,
	mountPath: string,
): Promise<string[]> {
	const result = await sandbox.runCommand("bash", [
		"-lc",
		`find ${JSON.stringify(mountPath)} -type f -print0`,
	]);
	if (result.exitCode !== 0) {
		const output = await result.stdout();
		const message =
			output.trim().length > 0
				? ` ${output.trim()}`
				: ` (exitCode=${result.exitCode})`;
		throw new Error(`find command failed:${message}`);
	}

	const output = await result.stdout();
	if (!output) {
		return [];
	}

	return output.split("\0").filter((path) => path.length > 0);
}

async function scanWithNode(
	sandbox: Sandbox,
	mountPath: string,
): Promise<string[]> {
	const result = await sandbox.runCommand("node", [
		"-e",
		NODE_SCAN_SCRIPT,
		mountPath,
	]);
	if (result.exitCode !== 0) {
		const output = await result.stdout();
		const message =
			output.trim().length > 0
				? ` ${output.trim()}`
				: ` (exitCode=${result.exitCode})`;
		throw new Error(`node walker failed:${message}`);
	}

	const output = await result.stdout();
	if (!output) {
		return [];
	}
	return output.split("\0").filter((path) => path.length > 0);
}

const DEFAULT_SCAN_STRATEGIES: ScanStrategy[] = [
	{
		name: "bash-find",
		run: scanWithFind,
	},
	{
		name: "node-recursive",
		run: scanWithNode,
	},
];

export function normalizeMountPath(mountPath: string): string {
	return toAbsoluteMountPath(mountPath);
}

export async function hydrateWorkspaceFiles(
	sandbox: Sandbox,
	mountPath: string,
	files: ReadonlyArray<WorkspaceFileEntry>,
): Promise<void> {
	const normalizedMountPath = normalizeMountPath(mountPath);
	await sandbox.mkDir(normalizedMountPath);

	if (files.length === 0) {
		return;
	}

	await sandbox.writeFiles(
		files.map((file) => {
			return {
				path: joinPaths(normalizedMountPath, file.path),
				content: Buffer.from(file.content),
			};
		}),
	);
}

function toRelativeWorkspacePath(
	mountPath: string,
	absolutePath: string,
): string {
	const normalizedMountPath = normalizeMountPath(mountPath);

	if (normalizedMountPath === "/") {
		return absolutePath.replace(/^\/+/, "");
	}

	if (!absolutePath.startsWith(`${normalizedMountPath}/`)) {
		return absolutePath;
	}

	return absolutePath.slice(normalizedMountPath.length + 1);
}

export async function scanWorkspaceFilePaths(
	sandbox: Sandbox,
	mountPath: string,
	rules?: StoragePathRules | null,
): Promise<string[]> {
	const normalizedMountPath = normalizeMountPath(mountPath);
	const errors: string[] = [];

	for (const strategy of DEFAULT_SCAN_STRATEGIES) {
		try {
			const paths = await strategy.run(sandbox, normalizedMountPath);
			return filterPathsByRules(
				paths.map((path) => toRelativeWorkspacePath(normalizedMountPath, path)),
				rules,
			).filter((path) => path.length > 0);
		} catch (error) {
			errors.push(
				`${strategy.name}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	throw new Error(
		`Failed to scan workspace files under ${normalizedMountPath}. ` +
			`Tried strategies: ${errors.join(" | ")}`,
	);
}

export async function collectWorkspaceFiles(
	sandbox: Sandbox,
	mountPath: string,
	filePaths: ReadonlyArray<string> = [],
): Promise<WorkspaceFileEntry[]> {
	const normalizedMountPath = normalizeMountPath(mountPath);
	const fileList =
		filePaths.length > 0
			? filePaths
			: await scanWorkspaceFilePaths(sandbox, normalizedMountPath);

	const results = await Promise.all(
		fileList.map(async (path) => {
			const sandboxPath = joinPaths(normalizedMountPath, path);
			const content = await sandbox.readFileToBuffer({ path: sandboxPath });
			if (!content) {
				return null;
			}

			return {
				path,
				content,
				size: content.byteLength,
				hash: hashContent(content),
			} satisfies WorkspaceFileEntry;
		}),
	);

	const files: WorkspaceFileEntry[] = [];
	for (const entry of results) {
		if (entry) {
			files.push(entry);
		}
	}
	return files;
}
