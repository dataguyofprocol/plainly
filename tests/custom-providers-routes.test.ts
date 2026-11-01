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
const bare = (id: string) => ({ id, vision: true, thinking: true, thinkingFormat: "openai", contextWindow: 128_000, maxTokens: 8192 });
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
			models: [bare("llama3"), bare("qwen")],
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
		assert.deepEqual(renamed.provider, { id: "custom-local-ollama-2", name: "Gateway", baseUrl: "https://gw.example/v1", models: [bare("m"), bare("n")], keyPresent: true });
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
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.reasoning, true);
		assert.equal(model.contextWindow, 128000);
		assert.equal(model.maxTokens, 8192);
		assert.equal(piModels().getProvider("custom-local-ollama-2")?.name, "Gateway");
		assert.deepEqual(validateModelsSettings({ strong: { model: { provider: "custom-local-ollama", id: "llama3" } } }), { ok: true });

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

	it("carries each model's capabilities into the engine and the vision picker", async () => {
		const res = await update("custom-local-ollama", {
			models: [
				{ id: "llama3", vision: false, thinking: false },
				{ id: "llava", vision: true, thinking: false, contextWindow: 32_768, maxTokens: 4096 },
				{ id: "qwq", vision: false, thinking: true, thinkingFormat: "qwen" },
			],
		});
		assert.equal(res.status, 200);
		const llava = piModels().getModel("custom-local-ollama", "llava");
		assert.deepEqual(llava?.input, ["text", "image"]);
		assert.equal(llava?.reasoning, false);
		assert.equal(llava?.contextWindow, 32_768);
		assert.equal(llava?.maxTokens, 4096);
		const qwq = piModels().getModel("custom-local-ollama", "qwq");
		assert.equal(qwq?.reasoning, true);
		assert.equal((qwq?.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat, "qwen");
		const catalog = modelCatalog().models.filter((m) => m.provider === "custom-local-ollama");
		assert.deepEqual(catalog.filter((m) => m.input.includes("image")).map((m) => m.id), ["llava"], "only vision models fill the vision slot");
		assert.ok(catalog.find((m) => m.id === "qwq")!.supportedLevels.includes("high"), "a thinking model offers levels");
		assert.deepEqual(catalog.find((m) => m.id === "llama3")!.supportedLevels, ["off"]);
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
			if (!url.endsWith("/v1/models")) return new Response("no", { status: 404 });
			seen = { url, auth: new Headers(init.headers).get("authorization") };
			return Response.json({ object: "list", data: [{ id: "a" }, { id: "b" }, { id: "a" }, { nope: 1 }] });
		};
		const res = await probe({ baseUrl: "http://h:8000/v1/", apiKey: "k1" });
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true, models: ["a", "b"], detected: {} });
		assert.deepEqual(seen, { url: "http://h:8000/v1/models", auth: "Bearer k1" });
	});

	it("sends no Authorization header without a key", async () => {
		let auth: string | null = "unset";
		customProviderProbe.fetch = async (_url, init) => {
			auth = new Headers(init.headers).get("authorization");
			return Response.json({ data: [] });
		};
		assert.deepEqual(await (await probe({ baseUrl: "http://h/v1" })).json(), { ok: true, models: [], detected: {} });
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

	it("reads capabilities from OpenRouter-style /models fields", async () => {
		customProviderProbe.fetch = async (url) =>
			url.endsWith("/models")
				? Response.json({
						data: [
							{ id: "vl", architecture: { input_modalities: ["text", "image"] }, context_length: 200_000, top_provider: { max_completion_tokens: 16_000 }, supported_parameters: ["tools", "reasoning"] },
							{ id: "txt", architecture: { input_modalities: ["text"] }, supported_parameters: ["tools"] },
							{ id: "vllm", max_model_len: 32_768 },
							{ id: "bare" },
						],
					})
				: new Response("no", { status: 404 });
		const body = await (await probe({ baseUrl: "https://gw.example/api/v1" })).json();
		assert.deepEqual(body.detected, {
			vl: { vision: true, thinking: true, contextWindow: 200_000, maxTokens: 16_000 },
			txt: { vision: false, thinking: false },
			vllm: { contextWindow: 32_768 },
		});
	});

	it("reads capabilities from Ollama's /api/show and LM Studio's /api/v0/models", async () => {
		const seen: string[] = [];
		customProviderProbe.fetch = async (url, init) => {
			seen.push(url);
			if (url === "http://h:11434/v1/models") return Response.json({ data: [{ id: "llava" }, { id: "qwen3" }, { id: "gemma" }] });
			if (url === "http://h:11434/api/version") return Response.json({ version: "0.12.0" });
			if (url === "http://h:11434/api/show") {
				const model = JSON.parse(String(init.body)).model;
				if (model === "llava") return Response.json({ capabilities: ["completion", "vision"], model_info: { "llama.context_length": 32_768 } });
				if (model === "qwen3") return Response.json({ capabilities: ["completion", "tools", "thinking"] });
				return new Response("not found", { status: 404 });
			}
			if (url === "http://h:11434/api/v0/models") return Response.json({ data: [{ id: "gemma", type: "vlm", max_context_length: 8192 }] });
			return new Response("no", { status: 404 });
		};
		const body = await (await probe({ baseUrl: "http://h:11434/v1" })).json();
		assert.deepEqual(body.detected, {
			llava: { vision: true, thinking: false, contextWindow: 32_768 },
			qwen3: { vision: false, thinking: true },
			gemma: { vision: true, contextWindow: 8192 },
		});
		assert.ok(seen.includes("http://h:11434/api/version"));
	});

	it("skips the native APIs when the base URL does not end in /v1, and survives their failures", async () => {
		const seen: string[] = [];
		customProviderProbe.fetch = async (url) => {
			seen.push(url);
			if (url.endsWith("/models")) return Response.json({ data: [{ id: "a" }] });
			throw new TypeError("fetch failed");
		};
		assert.deepEqual((await (await probe({ baseUrl: "http://h/openai" })).json()).detected, {});
		assert.deepEqual(seen, ["http://h/openai/models"]);
		assert.deepEqual((await (await probe({ baseUrl: "http://h/v1" })).json()).detected, {});
	});

	it("sends a saved provider's stored key when none is typed", async () => {
		await create({ name: "Keyed", baseUrl: "http://k/v1", models: ["m"], apiKey: "stored-key" });
		let auth: string | null = null;
		customProviderProbe.fetch = async (url, init) => {
			if (url.endsWith("/models")) auth = new Headers(init.headers).get("authorization");
			return Response.json({ data: [] });
		};
		await probe({ baseUrl: "http://k/v1", providerId: "custom-keyed" });
		assert.equal(auth, "Bearer stored-key");
		await probe({ baseUrl: "http://k/v1", providerId: "custom-keyed", apiKey: "typed" });
		assert.equal(auth, "Bearer typed", "a typed key wins");
	});

	it("400s a malformed body", async () => {
		assert.equal((await probe({ baseUrl: "" })).status, 400);
	});
});
