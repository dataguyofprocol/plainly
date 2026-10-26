/**
 * Custom OpenAI-compatible providers end to end (custom-endpoint wave,
 * 2026-10-26): the /api/providers/custom routes over a temp data dir and
 * auth file, the engine registry picking up writes with no restart, the
 * catalog listing (keyless providers usable), the generic keys API
 * refusing LH_CUSTOM_* vars, and pricing treating custom models as
 * UNPRICED. The probe's fetch is swapped — no test touches the network.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-providers-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
for (const name of Object.keys(process.env)) if (name.startsWith("LH_CUSTOM_")) delete process.env[name];

const listRoute = await import("../app/api/providers/custom/route.ts");
const idRoute = await import("../app/api/providers/custom/[id]/route.ts");
const probeRoute = await import("../app/api/providers/custom/probe/route.ts");
const keyRoute = await import("../app/api/keys/[id]/route.ts");
const { customProviderProbe, keyStatuses, modelCatalog, validateModelsSettings } = await import("../src/server/index.ts");
const { piModels, CUSTOM_PROVIDER_NO_KEY } = await import("../src/agent/models.ts");
const { callCost } = await import("../src/server/pricing.ts");
const { authStore } = await import("../src/store/auth.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const create = (body: unknown) => listRoute.POST(new Request("http://localhost/api/providers/custom", json(body)));
const update = (id: string, body: unknown) =>
	idRoute.PUT(new Request(`http://localhost/api/providers/custom/${id}`, { ...json(body), method: "PUT" }), params(id));

describe("the custom provider routes", () => {
	it("creates a keyless provider, mints its id, and lists it", async () => {
		const res = await create({ name: "Local Ollama", baseUrl: "http://localhost:11434/v1/", models: ["llama3", "qwen"] });
		assert.equal(res.status, 201);
		const { provider } = await res.json();
		assert.deepEqual(provider, {
			id: "custom-local-ollama",
			name: "Local Ollama",
			baseUrl: "http://localhost:11434/v1",
			models: ["llama3", "qwen"],
			keyPresent: false,
		});
		const list = await (await listRoute.GET()).json();
		assert.deepEqual(list.providers.map((p: { id: string }) => p.id), ["custom-local-ollama"]);
	});

	it("de-duplicates a second provider with the same name and stores its key", async () => {
		const res = await create({ name: "Local Ollama", baseUrl: "https://gw.example/v1", models: ["m"], apiKey: "tok-1" });
		const { provider } = await res.json();
		assert.equal(provider.id, "custom-local-ollama-2");
		assert.equal(provider.keyPresent, true);
		assert.equal(authStore.authVars().LH_CUSTOM_LOCAL_OLLAMA_2_API_KEY, "tok-1");
		assert.equal(process.env.LH_CUSTOM_LOCAL_OLLAMA_2_API_KEY, "tok-1", "reflected into env immediately");
	});

	it("rejects an invalid body with a user-facing 400", async () => {
		const res = await create({ name: "x", baseUrl: "localhost:1234", models: ["m"] });
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /base URL/);
	});

	it("updates fields partially, null removing the key; 404 on unknown id", async () => {
		const renamed = await (await update("custom-local-ollama-2", { name: "Gateway", models: ["m", "n"] })).json();
		assert.deepEqual(renamed.provider, { id: "custom-local-ollama-2", name: "Gateway", baseUrl: "https://gw.example/v1", models: ["m", "n"], keyPresent: true });
		const keyless = await (await update("custom-local-ollama-2", { apiKey: null })).json();
		assert.equal(keyless.provider.keyPresent, false);
		assert.equal(authStore.authVars().LH_CUSTOM_LOCAL_OLLAMA_2_API_KEY, undefined);
		assert.equal(process.env.LH_CUSTOM_LOCAL_OLLAMA_2_API_KEY, undefined);
		const rekeyed = await (await update("custom-local-ollama-2", { apiKey: "tok-2" })).json();
		assert.equal(rekeyed.provider.keyPresent, true);
		assert.equal((await update("custom-nope", { name: "x" })).status, 404);
		assert.equal((await update("custom-local-ollama-2", { models: [] })).status, 400);
	});

	it("registers custom models in the engine registry and the catalog", async () => {
		const model = piModels().getModel("custom-local-ollama-2", "n");
		assert.ok(model, "an update re-syncs the registry");
		assert.equal(model.api, "openai-completions");
		assert.equal(model.baseUrl, "https://gw.example/v1");
		assert.deepEqual(model.input, ["text"]);
		assert.equal(model.reasoning, false);
		assert.equal(model.contextWindow, 128000);
		assert.equal(model.maxTokens, 8192);
		assert.equal(piModels().getProvider("custom-local-ollama-2")?.name, "Gateway");
		assert.deepEqual(validateModelsSettings({ strong: { model: { provider: "custom-local-ollama", id: "llama3" } } }), { ok: true });

		// keyed → the stored key; keyless → the placeholder (configured by design)
		assert.equal((await piModels().getAuth("custom-local-ollama-2"))?.auth.apiKey, "tok-2");
		assert.equal((await piModels().getAuth("custom-local-ollama"))?.auth.apiKey, CUSTOM_PROVIDER_NO_KEY);

		const catalog = modelCatalog();
		const keyless = catalog.providers.find((p) => p.id === "custom-local-ollama");
		assert.deepEqual(keyless, { id: "custom-local-ollama", envVar: "LH_CUSTOM_LOCAL_OLLAMA_API_KEY", keyPresent: true, name: "Local Ollama", keyless: true });
		assert.equal(catalog.providers.find((p) => p.id === "custom-local-ollama-2")?.keyless, false);
		const llama = catalog.models.find((m) => m.provider === "custom-local-ollama" && m.id === "llama3");
		assert.ok(llama, "custom models federate into the pickers");
		assert.equal(llama.unpriced, true);
	});

	it("prices custom models as unknown, never $0", () => {
		assert.equal(callCost({ inputTokens: 1000, outputTokens: 500 }, "custom-local-ollama:llama3"), null);
	});

	it("keeps LH_CUSTOM_* vars out of the generic keys API", async () => {
		assert.ok(!keyStatuses().some((s) => s.id.startsWith("LH_CUSTOM_")), "no generic status rows");
		const res = await keyRoute.PUT(
			new Request("http://localhost/api/keys/LH_CUSTOM_LOCAL_OLLAMA_API_KEY", { ...json({ value: "sneaky-key-123" }), method: "PUT" }),
			params("LH_CUSTOM_LOCAL_OLLAMA_API_KEY"),
		);
		assert.equal(res.status, 404);
		assert.equal(authStore.authVars().LH_CUSTOM_LOCAL_OLLAMA_API_KEY, undefined);
	});

	it("deletes a provider with its key and drops it from the registry", async () => {
		const res = await idRoute.DELETE(new Request("http://localhost/api/providers/custom/custom-local-ollama-2", { method: "DELETE" }), params("custom-local-ollama-2"));
		assert.equal(res.status, 204);
		assert.equal(authStore.authVars().LH_CUSTOM_LOCAL_OLLAMA_2_API_KEY, undefined);
		assert.equal(process.env.LH_CUSTOM_LOCAL_OLLAMA_2_API_KEY, undefined);
		assert.equal(piModels().getProvider("custom-local-ollama-2"), undefined);
		assert.ok(!modelCatalog().providers.some((p) => p.id === "custom-local-ollama-2"));
		const again = await idRoute.DELETE(new Request("http://localhost/x", { method: "DELETE" }), params("custom-local-ollama-2"));
		assert.equal(again.status, 404);
	});
});

describe("the probe route", () => {
	const probe = (body: unknown) => probeRoute.POST(new Request("http://localhost/api/providers/custom/probe", json(body)));
	const original = customProviderProbe.fetch;
	after(() => {
		customProviderProbe.fetch = original;
	});

	it("lists the endpoint's models, sending the key as a bearer token", async () => {
		let seen: { url: string; auth: string | null } | undefined;
		customProviderProbe.fetch = async (url, init) => {
			seen = { url, auth: new Headers(init.headers).get("authorization") };
			return Response.json({ object: "list", data: [{ id: "a" }, { id: "b" }, { id: "a" }, { nope: 1 }] });
		};
		const res = await probe({ baseUrl: "http://h:8000/v1/", apiKey: "k1" });
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true, models: ["a", "b"] });
		assert.deepEqual(seen, { url: "http://h:8000/v1/models", auth: "Bearer k1" });
	});

	it("sends no Authorization header without a key", async () => {
		let auth: string | null = "unset";
		customProviderProbe.fetch = async (_url, init) => {
			auth = new Headers(init.headers).get("authorization");
			return Response.json({ data: [] });
		};
		assert.deepEqual(await (await probe({ baseUrl: "http://h/v1" })).json(), { ok: true, models: [] });
		assert.equal(auth, null);
	});

	it("reports unreachable, unauthorized and non-OpenAI answers as ok:false with status 200", async () => {
		const cases: Array<[() => Promise<Response>, RegExp]> = [
			[async () => { throw new TypeError("fetch failed"); }, /Could not reach/],
			[async () => { throw new DOMException("timed out", "TimeoutError"); }, /within 8s/],
			[async () => new Response("no", { status: 401 }), /401 unauthorized/],
			[async () => new Response("nope", { status: 404 }), /OpenAI-compatible/],
			[async () => new Response("<html>", { status: 200 }), /not JSON/],
			[async () => Response.json({ models: [] }), /no model list/],
		];
		for (const [fetchImpl, pattern] of cases) {
			customProviderProbe.fetch = fetchImpl;
			const res = await probe({ baseUrl: "http://h/v1" });
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.ok, false);
			assert.match(body.error, pattern);
		}
	});

	it("400s a malformed body", async () => {
		assert.equal((await probe({ baseUrl: "" })).status, 400);
	});
});
