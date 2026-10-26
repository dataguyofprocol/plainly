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

describe("sanitizeCustomProviders", () => {
	it("keeps a valid entry and normalizes its fields", () => {
		assert.deepEqual(
			sanitizeCustomProviders([{ ...valid, name: "  vLLM ", baseUrl: "http://localhost:8000/v1//", models: [" qwen ", "qwen", "", "llama"] }]),
			[{ id: "custom-vllm", name: "vLLM", baseUrl: "http://localhost:8000/v1", models: ["qwen", "llama"] }],
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
		assert.deepEqual(record!.providers, { custom: [valid], future: 1 });
		const empty = sanitizeUserSettings({ version: 1, providers: { custom: [{ id: "bad" }] } });
		assert.deepEqual(empty!.providers, {});
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
		assert.deepEqual(ok, { ok: true, value: { name: "Ollama", baseUrl: "http://localhost:11434/v1", models: ["llama3"] } });
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
		assert.ok(!parseCustomProviderProbe({}).ok);
	});
});
