/**
 * THE TEST SANDBOX (2026-10-27): a test process can never resolve the
 * learner's real data. Before this, tests that forgot to set LH_DATA_DIR
 * wrote hundreds of fixture sessions ("Fixture mixed queue", "steer: live",
 * …) into the repo's data/. Each case runs config.ts in a fresh child
 * process so the import-time resolution is observed cleanly.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const PROBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sandbox-probe-"));
const PROBE = path.join(PROBE_DIR, "probe.mts");
fs.writeFileSync(
	PROBE,
	`import { existsSync } from "node:fs";
import { PATHS, AUTH_FILE } from ${JSON.stringify(path.join(ROOT, "config.ts"))};
console.log(JSON.stringify({ data: PATHS.data, auth: AUTH_FILE, exists: existsSync(PATHS.data) }));`,
);
after(() => fs.rmSync(PROBE_DIR, { recursive: true, force: true }));

function probe(env: Record<string, string | undefined>): { data: string; auth: string; exists: boolean } {
	const base = { ...process.env };
	delete base.LH_DATA_DIR;
	delete base.LH_AUTH_FILE;
	const res = spawnSync(TSX, [PROBE], { env: { ...base, ...env } as NodeJS.ProcessEnv, encoding: "utf8", cwd: ROOT });
	assert.equal(res.status, 0, res.stderr);
	return JSON.parse(res.stdout.trim().split("\n").at(-1)!);
}

describe("config.ts test sandbox", () => {
	it("under NODE_ENV=test with no LH_DATA_DIR, data and auth live in a temp dir — never the repo", () => {
		const r = probe({ NODE_ENV: "test" });
		assert.notEqual(r.data, path.join(ROOT, "data"));
		assert.ok(r.data.startsWith(fs.realpathSync(os.tmpdir())) || r.data.startsWith(os.tmpdir()), r.data);
		assert.equal(r.auth, path.join(r.data, "auth.json"));
		assert.equal(r.exists, true, "the sandbox exists while the process runs");
		assert.equal(fs.existsSync(r.data), false, "and is removed when it exits");
	});

	it("an explicit LH_DATA_DIR still wins", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sandbox-explicit-"));
		try {
			assert.equal(probe({ NODE_ENV: "test", LH_DATA_DIR: dir }).data, dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("outside tests the default is unchanged: the repo's data/", () => {
		assert.equal(probe({ NODE_ENV: "development" }).data, path.join(ROOT, "data"));
	});
});
