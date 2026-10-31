/**
 * Attachment UI — the chip row and the picked/dropped-files gate
 * (owner, 2026-10-31: desktop-only path references, readable types only).
 *
 * Same tsx classic-JSX shim as render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentChips, resolveAttachments } from "../components/attachments.tsx";
import { QueuedSteersBody } from "../components/queued-steers.tsx";

describe("resolveAttachments", () => {
	const pathFor = (f: { name: string }) => (f.name.startsWith("web-") ? "" : `/Users/me/${f.name}`);

	it("readable, disk-backed files become paths", () => {
		const r = resolveAttachments([{ name: "lec7.pdf" }, { name: "scan.PNG" }], pathFor, []);
		assert.deepEqual(r, { paths: ["/Users/me/lec7.pdf", "/Users/me/scan.PNG"], errors: [] });
	});

	it("unreadable types are refused once per extension", () => {
		const r = resolveAttachments([{ name: "a.docx" }, { name: "b.docx" }, { name: "notes.md" }], pathFor, []);
		assert.deepEqual(r.paths, ["/Users/me/notes.md"]);
		assert.deepEqual(r.errors, ["Plainly can't read .docx files yet."]);
	});

	it("a File with no disk path is refused, not attached as ''", () => {
		const r = resolveAttachments([{ name: "web-image.png" }], pathFor, []);
		assert.deepEqual(r.paths, []);
		assert.equal(r.errors.length, 1);
		assert.match(r.errors[0]!, /web-image\.png isn't a file on disk/);
	});

	it("no duplicates — against the existing list and within the batch", () => {
		const r = resolveAttachments([{ name: "a.md" }, { name: "a.md" }, { name: "b.md" }], pathFor, ["/Users/me/b.md"]);
		assert.deepEqual(r.paths, ["/Users/me/a.md"]);
	});
});

describe("AttachmentChips", () => {
	it("renders nothing for no files", () => {
		assert.equal(renderToStaticMarkup(<AttachmentChips paths={[]} />), "");
	});

	it("one chip per file: the name, the full path on hover", () => {
		const html = renderToStaticMarkup(<AttachmentChips paths={["/Users/me/Uni/lec7.pdf"]} />);
		assert.ok(html.includes('title="/Users/me/Uni/lec7.pdf"'));
		assert.ok(html.includes(">lec7.pdf<"));
		assert.ok(!html.includes("Remove"), "transcript chips are static");
	});

	it("the composer's chips carry a remove button", () => {
		const html = renderToStaticMarkup(<AttachmentChips paths={["/a/notes.md"]} onRemove={() => {}} />);
		assert.ok(html.includes('aria-label="Remove notes.md"'));
	});
});

describe("QueuedSteersBody with attachments", () => {
	it("shows attached files by name, never the raw marker line", () => {
		const html = renderToStaticMarkup(
			<QueuedSteersBody steers={[{ id: "s1", text: "look at this\n\n[Attached file: /Users/me/scan.png]" }]} />,
		);
		assert.ok(html.includes("look at this · scan.png"));
		assert.ok(!html.includes("[Attached file"));
	});
});
