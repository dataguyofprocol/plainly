/**
 * pi-ai reads provider keys from process.env NATIVELY at every request
 * (auth/context.js's defaultProviderAuthContext reads live env), so the
 * switch works by DELETING the vars from the process — assert the
 * deletion directly, because that is what a fresh user's engines see.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

for (const varName of [
	"OPENROUTER_API_KEY",
	"DEEPGRAM_API_KEY",
	"TAVILY_API_KEY",
	"BRAVE_API_KEY",
	"OPENAI_API_KEY",
	"ZAI_API_KEY",
]) {
	delete process.env[varName];
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fresh-env-keys-"));
const AUTH = path.join(TMP, "auth.json");
process.env.LH_AUTH_FILE = AUTH;

fs.writeFileSync(AUTH, JSON.stringify({ OPENAI_API_KEY: "sk-file-fresh-file-fresh" }));

process.env.OPENROUTER_API_KEY = "sk-or-env-env-env";
process.env.OPENAI_API_KEY = "sk-openai-env-env-env";

process.env.LH_IGNORE_ENV_KEYS = "1";

const { deleteKey, envKeysIgnored, initAuthEnv, keyStatuses, keyValue, saveKey } = await import(
	"../src/server/keys.ts"
);
const { authStore } = await import("../src/store/auth.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("the fresh-user switch (boot under LH_IGNORE_ENV_KEYS=1)", () => {
	it("the switch reads live (the launcher exports it before boot)", () => {
		assert.equal(envKeysIgnored(), true);
	});

	it("THE ENGINE PATH: env-only keys are DELETED from the process — pi-ai's native per-request env resolution finds nothing", () => {
		assert.equal(process.env.OPENROUTER_API_KEY, undefined, "deleted from process.env at boot");
	});

	it("the env copy of a file-backed var is deleted; the FILE value is what fills the env (only auth.json counts)", () => {
		assert.equal(process.env.OPENAI_API_KEY, "sk-file-fresh-file-fresh", "the env copy died; the fill-gap reflected the file value");
		assert.equal(authStore.authVars().OPENAI_API_KEY, "sk-file-fresh-file-fresh");
	});

	it("keyValue: env keys invisible, file keys visible — and a post-boot env reintroduction stays invisible (belt-and-suspenders)", () => {
		assert.equal(keyValue("OPENROUTER_API_KEY"), undefined, "env key invisible under the switch");
		assert.equal(keyValue("OPENAI_API_KEY"), "sk-file-fresh-file-fresh", "file key visible");
		process.env.OPENROUTER_API_KEY = "sk-or-reintroduced-late";
		try {
			assert.equal(keyValue("OPENROUTER_API_KEY"), undefined, "reintroduced env key stays invisible to the seam");
		} finally {
			delete process.env.OPENROUTER_API_KEY;
		}
	});

	it("unset switch = today's env-wins behavior (the read seam, live-checked)", () => {
		process.env.LH_IGNORE_ENV_KEYS = undefined;
		process.env.OPENROUTER_API_KEY = "sk-or-env-wins";
		try {
			assert.equal(keyValue("OPENROUTER_API_KEY"), "sk-or-env-wins", "env wins without the switch");
			assert.equal(keyValue("OPENAI_API_KEY"), "sk-file-fresh-file-fresh", "file is the fallback without the switch");
		} finally {
			delete process.env.OPENROUTER_API_KEY;
			process.env.LH_IGNORE_ENV_KEYS = "1";
		}
	});

	it("the status view is the fresh machine's: file sources only, no env rows, no shadowing", () => {
		const rows = keyStatuses();
		const openai = rows.find((r) => r.id === "OPENAI_API_KEY");
		assert.ok(openai, "the file-backed provider key has a row");
		assert.equal(openai!.present, true);
		assert.equal(openai!.source, "file", "realEnv is empty under the switch — nothing reports as env");
		assert.equal(openai!.shadowedByEnv, false);
		assert.equal(rows.some((r) => r.id === "OPENROUTER_API_KEY"), false, "the env-only key is gone everywhere — no row");
		assert.equal(rows.some((r) => r.source === "env"), false, "no env-owned key under the switch");
	});

	it("a fresh user CAN add keys mid-session: save reflects file → env (engines see it, no restart)", () => {
		const result = saveKey("ZAI_API_KEY", "zai-fresh-sim-key-1234567890");
		assert.equal(result.ok, true);
		assert.equal(authStore.authVars().ZAI_API_KEY, "zai-fresh-sim-key-1234567890", "persisted to the file");
		assert.equal(process.env.ZAI_API_KEY, "zai-fresh-sim-key-1234567890", "reflected into env for pi-ai");
		const row = keyStatuses().find((r) => r.id === "ZAI_API_KEY");
		assert.equal(row!.source, "file", "the status honestly reports the file as the source");
		deleteKey("ZAI_API_KEY");
		assert.equal(process.env.ZAI_API_KEY, undefined);
		assert.equal(authStore.authVars().ZAI_API_KEY, undefined);
	});

	it("re-running initAuthEnv is idempotent — deleted env keys never resurrect", () => {
		process.env.OPENROUTER_API_KEY = "sk-or-zombie";
		initAuthEnv();
		assert.equal(process.env.OPENROUTER_API_KEY, undefined, "a reintroduced env key is re-deleted");
		assert.equal(process.env.OPENAI_API_KEY, "sk-file-fresh-file-fresh", "the file reflection survives re-init");
	});
});
