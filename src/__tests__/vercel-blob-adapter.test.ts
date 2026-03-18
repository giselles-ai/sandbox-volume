import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { VercelBlobStorageAdapterOptions } from "../adapters/vercel-blob";
import { buildManifest, hashContent } from "../manifest";
import type { WorkspacePayload } from "../types";

const workspaceState = new Map<string, string>();
const putMock = mock();
const listMock = mock();

mock.module("@vercel/blob", () => ({
	put: putMock,
	list: listMock,
	del: mock(),
}));

function mockBlobUrl(pathname: string): string {
	return `blob://${pathname}`;
}

function toWorkspacePayload(path: string, content: string): WorkspacePayload {
	const fileContent = new TextEncoder().encode(content);
	const manifest = buildManifest(
		[{ path, content: fileContent }],
		new Date("2026-03-17T00:00:00Z"),
	);

	return {
		manifest: {
			...manifest,
			version: 5,
		},
		files: [
			{
				path,
				size: fileContent.byteLength,
				hash: hashContent(fileContent),
				content: fileContent,
			},
		],
	};
}

function installFetchStub(): void {
	spyOn(globalThis, "fetch").mockImplementation(
		(async (input: string | URL | Request) => {
			const inputUrl =
				typeof input === "string" || input instanceof URL ? input : input.url;
			const rawUrl = String(inputUrl);
			const pathname = rawUrl.replace(/^blob:\/\//, "");
			const text = workspaceState.get(pathname);
			if (!text) {
				return new Response(null, { status: 404, statusText: "not found" });
			}

			return new Response(text, {
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			});
		}) as typeof fetch,
	);
}

beforeEach(() => {
	workspaceState.clear();
	putMock.mockReset();
	listMock.mockReset();
	installFetchStub();
});

afterEach(() => {
	mock.restore();
});

describe("VercelBlobStorageAdapter", () => {
	it("persists and loads manifest + files via blob state", async () => {
		const { createVercelBlobStorageAdapter } = await import(
			"../adapters/vercel-blob"
		);
		const payload = toWorkspacePayload("notes.md", "hello\nfrom blob");
		putMock.mockImplementation(async (pathname: string, body: string) => {
			workspaceState.set(pathname, body);
			return { url: mockBlobUrl(pathname), pathname };
		});

		listMock.mockImplementation(async ({ prefix }: { prefix?: string }) => ({
			blobs: [...workspaceState.entries()]
				.filter(([pathname]) => pathname.startsWith(prefix ?? ""))
				.map(([pathname]) => ({
					pathname,
					url: mockBlobUrl(pathname),
				})),
		}));

		const adapter = createVercelBlobStorageAdapter({
			token: "test-token",
		});

		const saved = await adapter.saveWorkspace("repo/vercel-blob", payload);

		expect(saved.key).toBe("repo/vercel-blob");
		expect(saved.version).toBe(5);
		expect(saved.updatedAt).toEqual(new Date("2026-03-17T00:00:00Z"));
		expect(putMock).toHaveBeenCalledWith(
			"sandbox-volume/repo/vercel-blob/workspace-state.json",
			expect.any(String),
			expect.objectContaining({
				access: "public",
				token: "test-token",
			}),
		);

		const loaded = await adapter.loadWorkspace("repo/vercel-blob");
		expect(loaded).not.toBeNull();
		expect(loaded?.manifest.version).toBe(5);
		expect(loaded?.manifest.updatedAt).toEqual(
			new Date("2026-03-17T00:00:00Z"),
		);
		expect(loaded?.files).toEqual([
			{
				path: "notes.md",
				size: payload.files[0]!.size,
				hash: payload.files[0]!.hash,
				content: expect.any(Uint8Array),
			},
		]);
		expect(new TextDecoder().decode(loaded?.files[0]!.content)).toBe(
			"hello\nfrom blob",
		);
	});

	it("returns null when no workspace state exists", async () => {
		const { createVercelBlobStorageAdapter } = await import(
			"../adapters/vercel-blob"
		);
		listMock.mockResolvedValue({ blobs: [] });

		const adapter = createVercelBlobStorageAdapter();
		const loaded = await adapter.loadWorkspace("repo/missing");

		expect(loaded).toBeNull();
	});

	it("uses env token fallback when token option is omitted", async () => {
		const { VercelBlobStorageAdapter } = await import("../adapters/vercel-blob");
		const payload = toWorkspacePayload("notes.md", "fallback token");
		process.env.BLOB_READ_WRITE_TOKEN = "env-token";
		try {
			putMock.mockImplementation(async (pathname: string, body: string) => {
				workspaceState.set(pathname, body);
				return { url: mockBlobUrl(pathname), pathname };
			});

			listMock.mockResolvedValue({ blobs: [] });

			const adapter = new VercelBlobStorageAdapter();
			await adapter.saveWorkspace("repo/env-token", payload);

			expect(putMock).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(String),
				expect.objectContaining({
					token: "env-token",
				}),
			);
		} finally {
			delete process.env.BLOB_READ_WRITE_TOKEN;
		}
	});

	it("supports namespace option for state path isolation", async () => {
		const { createVercelBlobStorageAdapter } = await import(
			"../adapters/vercel-blob"
		);
		const payload = toWorkspacePayload("notes.md", "namespaced");
		putMock.mockImplementation(async (pathname: string, body: string) => {
			workspaceState.set(pathname, body);
			return { url: mockBlobUrl(pathname), pathname };
		});
		listMock.mockImplementation(async ({ prefix }: { prefix?: string }) => ({
			blobs: [...workspaceState.entries()]
				.filter(([pathname]) => pathname.startsWith(prefix ?? ""))
				.map(([pathname]) => ({
					pathname,
					url: mockBlobUrl(pathname),
				})),
		}));

		const options = {
			namespace: "team-workspace",
		} satisfies VercelBlobStorageAdapterOptions;
		const adapter = createVercelBlobStorageAdapter(options);

		await adapter.saveWorkspace("repo/isolated", payload);

		expect(putMock).toHaveBeenCalledWith(
			"team-workspace/repo/isolated/workspace-state.json",
			expect.any(String),
			expect.any(Object),
		);
	});
});
