/**
 * GET /api/stt/token's failure reasons (dictation round 4, 2026-10-29):
 * a grant Deepgram refuses for the KEY ITSELF (401/403) comes back tagged
 * `reason: "key-rejected"` so the client can offer "Fix key"; any other
 * upstream failure stays untagged. Deepgram is faked at global fetch — no
 * network. The LH_DATA_DIR seam is set BEFORE any config-loading import.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stt-token-"));
process.env.LH_DATA_DIR = TMP_DATA;
const savedKey = process.env.DEEPGRAM_API_KEY;
process.env.DEEPGRAM_API_KEY = "test-deepgram-key-0000000000";

const route = await import("../app/api/stt/token/route.ts");
const realFetch = globalThis.fetch;

after(() => {
	if (savedKey === undefined) delete process.env.DEEPGRAM_API_KEY;
	else process.env.DEEPGRAM_API_KEY = savedKey;
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const deepgramAnswers = (status: number, body: unknown) => {
	globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
};

describe("stt token route", () => {
	it("returns the minted token on success", async () => {
		deepgramAnswers(200, { access_token: "jwt" });
		const res = await route.GET();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { token: "jwt" });
	});

	it("tags a 403 as key-rejected and names the Member role", async () => {
		deepgramAnswers(403, { err_code: "FORBIDDEN" });
		const res = await route.GET();
		const body = (await res.json()) as { message: string; reason?: string };
		assert.equal(res.status, 502);
		assert.equal(body.reason, "key-rejected");
		assert.match(body.message, /Member role/);
	});

	it("tags a 401 as key-rejected", async () => {
		deepgramAnswers(401, { err_code: "INVALID_AUTH" });
		const body = (await (await route.GET()).json()) as { reason?: string };
		assert.equal(body.reason, "key-rejected");
	});

	it("leaves other upstream failures untagged", async () => {
		deepgramAnswers(500, { err_code: "INTERNAL" });
		const res = await route.GET();
		const body = (await res.json()) as { message: string; reason?: string };
		assert.equal(res.status, 502);
		assert.equal(body.reason, undefined);
		assert.match(body.message, /500/);
	});
});
