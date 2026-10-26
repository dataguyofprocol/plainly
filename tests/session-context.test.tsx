import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeleteSessionBody, DeleteSessionDialog, TRACES_COPY } from "../components/delete-session-dialog.tsx";

/**
 * Wave 6 chunk A — the deletion seam: the two-option delete dialog's
 * plain-language copy (the locked design: both options
 * name their reach, the graph-touching one says so).
 */


describe("DeleteSessionDialog — the node-dialog shape (owner flow rework 2026-09-24; portals no-op in SSR; pin the pure body)", () => {
	it("closed (chat=null) renders nothing", () => {
		const html = renderToStaticMarkup(
			<DeleteSessionDialog chat={null} onClose={() => {}} onDeleted={() => {}} />,
		);
		assert.equal(html, "");
	});

	it("red mono title 'Delete session?' (abort-turn look), the session name below in mono at normal size, no code-block chrome", () => {
		const html = renderToStaticMarkup(
			<DeleteSessionBody
				chat={{ id: "c1", title: "Orbital mechanics" }}
				traces={false}
				busy={false}
				failure={null}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		assert.match(html, /Delete session\?/);
		const title = html.match(/<h2[^>]*>/)?.[0] ?? "";
		assert.match(title, /dlg-title/); // v4 confirm title (finesse pass: the danger well carries the red)
		assert.ok(!title.includes("font-title"), "no serif display title");
		// the name: mono, normal text-sm size (owner, 2026-10-13), NO bg-muted code-block chrome
		const name = html.match(/data-testid="session-name-code"[^>]*>/)?.[0] ?? "";
		assert.match(name, /cd-name/); // v4: the name in the UI sans, normal size
		assert.ok(!name.includes("bg-muted"), "no code-block chrome");
		assert.match(html, /data-testid="session-name-code"[^>]*>Orbital mechanics</);
	});

	it("one unchecked-by-default checkbox for the graph traces — the graph-touching consequence says so", () => {
		const html = renderToStaticMarkup(
			<DeleteSessionBody
				chat={{ id: "c1", title: "Orbital mechanics" }}
				traces={false}
				busy={false}
				failure={null}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		// unchecked by default (preserve-graph) — React SSR omits the
		// attribute when false, so pin its ABSENCE on the rendered input
		assert.ok(!/"checked"/.test(html), "unchecked by default");
		// plain-language consequences on the checkbox body
		assert.ok(html.includes(TRACES_COPY.title));
		assert.ok(html.includes("leave the graph too"));
		assert.ok(html.includes("survive"));
		// the old two-button design is gone
		assert.ok(!html.includes("delete-option-preserve"));
		assert.ok(!html.includes("delete-option-nodes"));
	});

	it("bottom row matches the node dialog: quiet Cancel + destructive-red Delete", () => {
		const html = renderToStaticMarkup(
			<DeleteSessionBody
				chat={{ id: "c1", title: "Orbital mechanics" }}
				traces={true}
				busy={true}
				failure={null}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		assert.match(html, /data-testid="delete-cancel"[^>]*>Cancel</);
		const del = html.match(/data-testid="delete-confirm"[^>]*>/)?.[0] ?? "";
		assert.match(del, /btn danger/); // v4 destructive button
		assert.match(html, /data-testid="delete-confirm"[^>]*>Deleting…</); // busy label on Delete
		// the checkbox survives a busy render (disabled, not unmounted)
		assert.match(html, /data-testid="delete-traces-checkbox"[^>]*disabled=""/);
	});
});