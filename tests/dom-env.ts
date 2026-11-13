// Import FIRST, before react-dom: react-dom decides at load time whether the
// DOM supports input events, so the globals must exist before it evaluates or
// onChange never fires for typed text.
import React from "react";
import { parseHTML } from "linkedom";

export const dom = parseHTML("<html><body></body></html>");
// react-dom probes `"oninput" in document`; linkedom lacks it, and React then
// falls back to a keystroke polyfill that synthetic events never trigger.
Object.assign(dom.document, { oninput: null });
Object.assign(globalThis, {
	React,
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

/** Types into a React-controlled input (fires onChange). */
export function setInputValue(input: HTMLInputElement, value: string): void {
	// React tracks `value` on the element itself; set it through the prototype
	// so the tracker sees a change.
	Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
	input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}
