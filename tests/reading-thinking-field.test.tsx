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
		assert.ok(/<textarea[^>]*class="[^"]*\bftext\b/.test(html), "the padded field primitive is on the textarea");
		assert.ok(html.includes("max-h-40"), "the 160px growth cap stays");
	});
});
