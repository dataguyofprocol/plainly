import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveToolCard } from "../components/artifacts/live-tool-card.tsx";

function part(tool: string, input: unknown) {
	return { type: `tool-${tool}`, toolCallId: "c1", state: "input-streaming", input };
}

describe("LiveToolCard (the working-state grammar)", () => {
	it("spinner + shimmered activity label + headline arg, input on expand", () => {
		const html = renderToStaticMarkup(<LiveToolCard part={part("read", { path: "notes.md" }) as never} />);
		assert.match(html, /data-testid="live-tool-card"/);
		assert.match(html, /data-testid="braille-spinner"/);
		assert.match(html, /Reading a file…/);
		assert.match(html, /notes\.md/);
		assert.match(html, /Input \(streaming\)/);
		assert.match(html, /notes\.md/);
	});

	it("unknown tools stay generic; jobs get their dispatch labels", () => {
		assert.match(renderToStaticMarkup(<LiveToolCard part={part("mystery_tool", {}) as never} />), /Working…/);
		assert.match(
			renderToStaticMarkup(<LiveToolCard part={part("research", { query: "x" }) as never} />),
			/Dispatching research…/,
		);
	});

	it("no input yet renders a placeholder, not an empty pre", () => {
		const html = renderToStaticMarkup(<LiveToolCard part={part("grep", undefined) as never} />);
		assert.match(html, /<pre[^>]*>…<\/pre>/);
	});
});
