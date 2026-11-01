import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

describe("LH_DATA_DIR seam", () => {
	it("relocates data/chats/graph under LH_DATA_DIR, keeps prompts ROOT-anchored", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-seam-"));
		process.env.LH_DATA_DIR = dir;
		try {
			const { PATHS, ROOT } = await import("../config.ts");
			assert.equal(PATHS.data, dir, "PATHS.data resolves the env value (resolved absolute)");
			assert.equal(PATHS.chats, path.join(dir, "chats"));
			assert.equal(PATHS.graph, path.join(dir, "graph"));
			assert.equal(
				PATHS.teacherPrompt,
				path.join(ROOT, "src", "agent", "system-prompt.md"),
				"read-only prompt assets stay bundle-anchored on purpose",
			);
		} finally {
			delete process.env.LH_DATA_DIR;
		}
	});

	it("unset = the repo data/ exactly as before (fresh child process, no env)", () => {
		const env: Record<string, string | undefined> = { ...process.env };
		delete env.NODE_ENV;
		delete env.LH_DATA_DIR;
		delete env.LH_AUTH_FILE;
		const out = execFileSync(
			process.execPath,
			["--import", TSX_LOADER, "--eval", `const m = await import(${JSON.stringify(path.join(REPO_ROOT, "config.ts"))}); console.log(JSON.stringify({ data: m.PATHS.data, chats: m.PATHS.chats }));`],
			{ cwd: REPO_ROOT, encoding: "utf-8", env: env as NodeJS.ProcessEnv },
		);
		const parsed = JSON.parse(out) as { data: string; chats: string | null };
		assert.equal(parsed.data, path.join(REPO_ROOT, "data"));
		assert.equal(parsed.chats, path.join(REPO_ROOT, "data", "chats"));
	});
});