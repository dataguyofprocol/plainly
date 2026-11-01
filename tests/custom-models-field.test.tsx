import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CustomModelsField, modelWithDetected } from "../components/custom-models-field.tsx";
import type { CustomModelEntry } from "../src/core/custom-providers.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const originalFetch = globalThis.fetch;
let root: Root | null = null;
let latest: CustomModelEntry[] = [];

function Harness({ initial }: { initial: CustomModelEntry[] }) {
	const [models, setModels] = useState(initial);
	latest = models;
	return <CustomModelsField baseUrl="http://h:11434/v1" apiKey="" models={models} onChange={setModels} autoFill />;
}

async function mount(initial: CustomModelEntry[] = []) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<Harness initial={initial} />));
	return host;
}

const click = async (el: Element | null) => {
	assert.ok(el, "element exists");
	await act(async () => {
		const event = new dom.window.Event("click", { bubbles: true, cancelable: true });
		Object.assign(event, { button: 0, detail: 1 });
		el!.dispatchEvent(event);
	});
};

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	globalThis.fetch = originalFetch;
});

describe("modelWithDetected", () => {
	it("applies what the server described over the defaults", () => {
		assert.deepEqual(modelWithDetected("m", undefined), { id: "m", vision: true, thinking: true, thinkingFormat: "openai", contextWindow: 128_000, maxTokens: 8192 });
		assert.deepEqual(modelWithDetected("t", { vision: false, thinking: false }), { id: "t", vision: false, thinking: false, contextWindow: 128_000, maxTokens: 8192 });
		assert.deepEqual(modelWithDetected("v", { vision: true, thinking: true, contextWindow: 4096 }), {
			id: "v",
			vision: true,
			thinking: true,
			thinkingFormat: "openai",
			contextWindow: 4096,
			maxTokens: 4096,
		});
	});
});

describe("CustomModelsField", () => {
	it("adds the probed models with their detected capabilities", async () => {
		globalThis.fetch = async (input) => {
			assert.equal(String(input), "/api/providers/custom/probe");
			return Response.json({ ok: true, models: ["llava", "llama3"], detected: { llava: { vision: true, contextWindow: 32_768 } } });
		};
		const host = await mount();
		await click(host.querySelector('[data-testid="custom-models-find"]'));
		assert.deepEqual(latest.map((m) => [m.id, m.vision, m.contextWindow]), [
			["llava", true, 32_768],
			["llama3", true, 128_000],
		]);
		assert.ok(host.querySelector('[data-testid="custom-model-llava"]')?.textContent?.includes("Read from server"));
		assert.ok(!host.querySelector('[data-testid="custom-model-llama3"]')?.textContent?.includes("Read from server"));
	});

	it("toggles vision and thinking per model, the format select only while thinking", async () => {
		const host = await mount([modelWithDetected("qwen", undefined)]);
		assert.ok(host.querySelector('[data-testid="custom-model-qwen-format"]'));
		await click(host.querySelector('[data-testid="toggle-qwen-vision"]'));
		await click(host.querySelector('[data-testid="toggle-qwen-thinking"]'));
		assert.equal(latest[0]!.vision, false);
		assert.equal(latest[0]!.thinking, false);
		assert.equal(latest[0]!.thinkingFormat, undefined);
		assert.equal(host.querySelector('[data-testid="custom-model-qwen-format"]'), null);
		await click(host.querySelector('[data-testid="toggle-qwen-thinking"]'));
		assert.equal(latest[0]!.thinking, true);
		assert.equal(latest[0]!.thinkingFormat, "openai");
		await click(host.querySelector('[data-testid="custom-model-qwen-remove"]'));
		assert.deepEqual(latest, []);
	});
});
