/**
 * Custom OpenAI-compatible providers, the pure layer (custom-endpoint
 * wave, 2026-10-26): the settings sanitizer (lenient — invalid entries
 * drop), the id minting (slug + -2/-3 de-duplication inside the 40-char
 * budget), the key env-var mapping, and the strict write-side parsers the
 * routes answer 400 from.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	customProviderEnvVar,
	isCustomProviderEnvVar,
	isCustomProviderId,
	mintCustomProviderId,
	parseCustomProviderCreate,
	parseCustomProviderProbe,
	parseCustomProviderUpdate,
	sanitizeCustomProviders,
	slugifyProviderName,
} from "../src/core/custom-providers.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";

const valid = { id: "custom-vllm", name: "vLLM", baseUrl: "http://localhost:8000/v1", models: ["qwen"] };
const bare = (id: string) => ({ id, vision: true, thinking: true, thinkingFormat: "openai", contextWindow: 128_000, maxTokens: 8192 });

describe("sanitizeCustomProviders", () => {
	it("keeps a valid entry and normalizes its fields", () => {
		assert.deepEqual(
			sanitizeCustomProviders([{ ...valid, name: "  vLLM ", baseUrl: "http://localhost:8000/v1//", models: [" qwen ", "qwen", "", "llama"] }]),
			[{ id: "custom-vllm", name: "vLLM", baseUrl: "http://localhost:8000/v1", models: [bare("qwen"), bare("llama")] }],
		);
	});

	it("drops every invalid entry and keeps the first of a duplicate id", () => {
		const out = sanitizeCustomProviders([
			valid,
			{ ...valid, name: "duplicate" },
			{ ...valid, id: "vllm" }, // missing prefix
			{ ...valid, id: "custom-Bad" }, // uppercase
			{ ...valid, id: `custom-${"a".repeat(41)}` }, // slug over 40
			{ ...valid, id: "custom-a", name: "" },
			{ ...valid, id: "custom-b", name: "x".repeat(61) },
			{ ...valid, id: "custom-c", baseUrl: "ftp://host" },
			{ ...valid, id: "custom-d", baseUrl: "not a url" },
			{ ...valid, id: "custom-e", models: [] },
			{ ...valid, id: "custom-f", models: [" "] },
			{ ...valid, id: "custom-g", models: [1] },
			"junk",
			null,
		]);
		assert.deepEqual(out.map((e) => e.id), ["custom-vllm"]);
		assert.equal(out[0]!.name, "vLLM");
		assert.deepEqual(sanitizeCustomProviders("nope"), []);
	});

	it("truncates a model list over the 50 cap", () => {
		const models = Array.from({ length: 60 }, (_, i) => `m${i}`);
		assert.equal(sanitizeCustomProviders([{ ...valid, models }])[0]!.models.length, 50);
	});

	it("rides inside the settings record's providers section, unknown keys preserved", () => {
		const record = sanitizeUserSettings({ version: 1, providers: { custom: [valid, { id: "bad" }], future: 1 } });
		assert.deepEqual(record!.providers, { custom: [{ ...valid, models: [bare("qwen")] }], future: 1 });
		const empty = sanitizeUserSettings({ version: 1, providers: { custom: [{ id: "bad" }] } });
		assert.deepEqual(empty!.providers, {});
	});
});

describe("per-model capabilities", () => {
	it("reads bare ids (records before capabilities) at the defaults", () => {
		assert.deepEqual(sanitizeCustomProviders([valid])[0]!.models, [bare("qwen")]);
	});

	it("keeps set capabilities and settles the thinking format", () => {
		const [entry] = sanitizeCustomProviders([
			{
				...valid,
				models: [
					{ id: "vl", vision: true, thinking: true, contextWindow: 32_768, maxTokens: 4096 },
					{ id: "qwq", thinking: true, thinkingFormat: "qwen" },
					{ id: "plain", thinking: false, thinkingFormat: "qwen" },
					"qwq",
				],
			},
		]);
		assert.deepEqual(entry!.models, [
			{ id: "vl", vision: true, thinking: true, thinkingFormat: "openai", contextWindow: 32_768, maxTokens: 4096 },
			{ id: "qwq", vision: true, thinking: true, thinkingFormat: "qwen", contextWindow: 128_000, maxTokens: 8192 },
			{ id: "plain", vision: true, thinking: false, contextWindow: 128_000, maxTokens: 8192 },
		]);
	});

	it("falls back to the default for a bad capability field, and caps max output at the context", () => {
		const [entry] = sanitizeCustomProviders([
			{ ...valid, models: [{ id: "m", vision: "yes", thinkingFormat: "nope", contextWindow: 10, maxTokens: -1 }, { id: "small", contextWindow: 4096 }] },
		]);
		assert.deepEqual(entry!.models, [bare("m"), { ...bare("small"), contextWindow: 4096, maxTokens: 4096 }]);
	});

	it("parses model objects strictly, absent fields at their defaults", () => {
		const ok = parseCustomProviderCreate({ name: "x", baseUrl: "http://x/v1", models: ["a", { id: "b", vision: true, contextWindow: 4096 }, { id: "c", thinking: true, thinkingFormat: "deepseek" }] });
		assert.deepEqual(ok, {
			ok: true,
			value: {
				name: "x",
				baseUrl: "http://x/v1",
				models: [bare("a"), { ...bare("b"), vision: true, contextWindow: 4096, maxTokens: 4096 }, { ...bare("c"), thinking: true, thinkingFormat: "deepseek" }],
			},
		});
		for (const model of [
			{ id: "m", vision: "yes" },
			{ id: "m", thinkingFormat: "chat-template" },
			{ id: "m", contextWindow: 100 },
			{ id: "m", contextWindow: 4096, maxTokens: 8192 },
			{ id: "m", maxTokens: 1.5 },
			{ vision: true },
		]) {
			const result = parseCustomProviderCreate({ name: "x", baseUrl: "http://x/v1", models: [model] });
			assert.ok(!result.ok && result.error.length > 0, JSON.stringify(model));
		}
	});
});

describe("id minting", () => {
	it("slugifies the name", () => {
		assert.equal(slugifyProviderName("My vLLM Box!"), "my-vllm-box");
		assert.equal(slugifyProviderName("  Café  Ollama "), "cafe-ollama");
		assert.equal(slugifyProviderName("日本"), "provider");
	});

	it("de-duplicates with -2, -3 …", () => {
		assert.equal(mintCustomProviderId("LM Studio", []), "custom-lm-studio");
		assert.equal(mintCustomProviderId("LM Studio", ["custom-lm-studio"]), "custom-lm-studio-2");
		assert.equal(mintCustomProviderId("LM Studio", ["custom-lm-studio", "custom-lm-studio-2"]), "custom-lm-studio-3");
	});

	it("keeps a long name's suffixed id inside the 40-char slug budget", () => {
		const long = "a".repeat(80);
		const first = mintCustomProviderId(long, []);
		const second = mintCustomProviderId(long, [first]);
		assert.equal(first, `custom-${"a".repeat(40)}`);
		assert.equal(second, `custom-${"a".repeat(38)}-2`);
		assert.ok(isCustomProviderId(first) && isCustomProviderId(second));
	});
});

describe("the key env var", () => {
	it("maps the slug to LH_CUSTOM_<SLUG>_API_KEY", () => {
		assert.equal(customProviderEnvVar("custom-my-vllm-2"), "LH_CUSTOM_MY_VLLM_2_API_KEY");
		assert.ok(isCustomProviderEnvVar("LH_CUSTOM_MY_VLLM_2_API_KEY"));
		assert.ok(!isCustomProviderEnvVar("OPENAI_API_KEY"));
	});
});

describe("the write-side parsers", () => {
	it("accepts a create body, a blank key meaning keyless", () => {
		const ok = parseCustomProviderCreate({ name: " Ollama ", baseUrl: "http://localhost:11434/v1/", models: ["llama3"], apiKey: "" });
		assert.deepEqual(ok, { ok: true, value: { name: "Ollama", baseUrl: "http://localhost:11434/v1", models: [bare("llama3")] } });
		const keyed = parseCustomProviderCreate({ name: "Gw", baseUrl: "https://gw.example/v1", models: ["m"], apiKey: " short " });
		assert.ok(keyed.ok && keyed.value.apiKey === "short", "no length floor for custom keys");
	});

	it("rejects bad create bodies with user-facing errors", () => {
		for (const body of [
			null,
			{ baseUrl: "http://x/v1", models: ["m"] },
			{ name: "x", baseUrl: "localhost:8000", models: ["m"] },
			{ name: "x", baseUrl: "http://x/v1", models: [] },
			{ name: "x", baseUrl: "http://x/v1", models: "m" },
			{ name: "x", baseUrl: "http://x/v1", models: ["m"], apiKey: "has space" },
			{ name: "x", baseUrl: "http://x/v1", models: Array.from({ length: 51 }, (_, i) => `m${i}`) },
		]) {
			const result = parseCustomProviderCreate(body);
			assert.ok(!result.ok && result.error.length > 0, JSON.stringify(body));
		}
	});

	it("parses partial updates, null removing the key", () => {
		assert.deepEqual(parseCustomProviderUpdate({ apiKey: null }), { ok: true, value: { apiKey: null } });
		assert.deepEqual(parseCustomProviderUpdate({ name: "New" }), { ok: true, value: { name: "New" } });
		assert.ok(!parseCustomProviderUpdate({ baseUrl: "nope" }).ok);
		assert.ok(!parseCustomProviderUpdate({ apiKey: "" }).ok);
	});

	it("parses probe bodies", () => {
		assert.deepEqual(parseCustomProviderProbe({ baseUrl: "http://h/v1/" }), { ok: true, value: { baseUrl: "http://h/v1" } });
		assert.deepEqual(parseCustomProviderProbe({ baseUrl: "http://h/v1", apiKey: "k" }), { ok: true, value: { baseUrl: "http://h/v1", apiKey: "k" } });
		assert.deepEqual(parseCustomProviderProbe({ baseUrl: "http://h/v1", providerId: "custom-h" }), { ok: true, value: { baseUrl: "http://h/v1", providerId: "custom-h" } });
		assert.deepEqual(parseCustomProviderProbe({ baseUrl: "http://h/v1", providerId: "../etc" }), { ok: true, value: { baseUrl: "http://h/v1" } });
		assert.ok(!parseCustomProviderProbe({}).ok);
	});
});
