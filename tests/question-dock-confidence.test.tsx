import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const quizInput = {
	question: "Which planet is closest to the Sun?",
	options: [
		{ label: "Mercury", value: "mercury" },
		{ label: "Venus", value: "venus" },
	],
	correctAnswer: "mercury",
	explanation: "Mercury orbits closest.",
};

let root: Root | null = null;
let submitted: QuestionAnswerData | null = null;

async function mount(): Promise<Element> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<QuestionDock
				toolName="quiz"
				toolCallId="call-conf"
				input={quizInput as never}
				expanded
				onExpand={() => {}}
				onSubmit={(a: QuestionAnswerData) => {
					submitted = a;
				}}
			/>,
		),
	);
	return host;
}

const click = async (el: Element | null | undefined) => {
	assert.ok(el, "element exists");
	await act(async () => {
		const event = new dom.window.Event("click", { bubbles: true, cancelable: true });
		Object.assign(event, { button: 0, detail: 1 });
		el!.dispatchEvent(event);
	});
};

const byText = (host: Element, selector: string, text: string) =>
	[...host.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text);

const pickMercury = (host: Element) =>
	click([...host.querySelectorAll("[data-kbdrow]")].find((el) => el.textContent?.includes("Mercury")));

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	submitted = null;
	document.body.innerHTML = "";
});

describe("lesson dock confidence: optional, no default (owner, 2026-11-13)", () => {
	it("starts with no level selected and says it is optional", async () => {
		const host = await mount();
		const ladder = host.querySelector('[data-testid="confidence-control"]');
		assert.ok(ladder);
		assert.equal(ladder.querySelectorAll('[aria-checked="true"]').length, 0, "nothing pre-selected");
		assert.ok(host.textContent?.includes("optional"));
	});

	it("an untouched ladder sends no confidence", async () => {
		const host = await mount();
		await pickMercury(host);
		await click(byText(host, "button", "Submit"));
		assert.ok(submitted, "submitted");
		assert.equal(submitted!.confidence, undefined);
		assert.equal(submitted!.correct, true);
	});

	it("a picked level is sent as its percentage", async () => {
		const host = await mount();
		await pickMercury(host);
		await click(byText(host, '[data-testid="confidence-control"] button', "Fairly sure"));
		await click(byText(host, "button", "Submit"));
		assert.equal(submitted!.confidence, 75);
	});
});
