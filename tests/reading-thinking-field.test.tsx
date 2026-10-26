import React from "react";
(globalThis as Record<string, unknown>).React = React;
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";

describe("the reading-thinking field (owner round, 2026-10-07)", () => {
	it("carries vertical padding — the 1px-scrollbar absorption", () => {
		const html = renderToStaticMarkup(
			<ReadingThinkingField value="" onChange={() => {}} claim={false} />,
		);
		// The fix (empirically diagnosed): Source Sans 3's font box (22px at
		// 16px) exceeds lh-input's 20px line box by 1px; Chromium counts that
		// in scrollHeight and a zero-padding field-sizing textarea becomes a
		// permanent 1px scroll (a bar shown empty AND at every expansion below
		// max-h). Vertical padding absorbs it — since the finesse pass the
		// v4 field primitive .ftext carries it (10px), replacing py-0.5.
		assert.ok(/<textarea[^>]*class="[^"]*\bftext\b/.test(html), "the padded field primitive is on the textarea");
		// The cap survives: growth past max-h-40 still scrolls honestly.
		assert.ok(html.includes("max-h-40"), "the 160px growth cap stays");
	});
});
