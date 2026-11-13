import { dom, setInputValue } from "./dom-env.ts";
import { act, useState } from "react";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { CustomModelsField, modelWithDetected } from "../components/custom-models-field.tsx";
import type { CustomModelEntry } from "../src/core/custom-providers.ts";

let root: Root | null = null;
let latest: CustomModelEntry[] = [];

function Harness({ initial }: { initial: CustomModelEntry[] }) {
	const [models, setModels] = useState(initial);
	latest = models;
	return <CustomModelsField baseUrl="http://h:11434/v1" apiKey="" models={models} onChange={setModels} />;
}

/** One typed commit per mount: linkedom drops later synthetic input events. */
async function mountAndCommit(model: CustomModelEntry, value: string): Promise<HTMLInputElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<Harness initial={[model]} />));
	const input = host.querySelector('[data-testid="custom-model-gpt-6-luna-name"]') as HTMLInputElement | null;
	assert.ok(input);
	input.setAttribute("type", "text");
	await act(async () => setInputValue(input, value));
	await act(async () => {
		input.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
	});
	return input;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("CustomModelsField display name", () => {
	it("previews the fallback as the placeholder and commits a trimmed name", async () => {
		const input = await mountAndCommit(modelWithDetected("GPT_6_LUNA", undefined), "  Luna  ");
		assert.equal(input.getAttribute("placeholder"), "GPT 6 Luna");
		assert.equal(latest[0]!.name, "Luna");
	});

	it("an empty commit unsets the name, so the fallback shows again", async () => {
		await mountAndCommit({ ...modelWithDetected("GPT_6_LUNA", undefined), name: "Luna" }, "");
		assert.equal(latest[0]!.name, undefined);
	});
});
