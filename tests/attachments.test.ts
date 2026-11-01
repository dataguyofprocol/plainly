import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	attachmentExtension,
	attachmentKind,
	attachmentName,
	attachmentRefusal,
	isAttachable,
	splitAttachments,
	withAttachments,
} from "../src/core/attachments.ts";

describe("withAttachments / splitAttachments", () => {
	it("words, a blank line, then one marker per file", () => {
		const text = withAttachments("  why does step 3 hold?  ", ["/Users/me/Uni/lec7.pdf", "/Users/me/notes.md"]);
		assert.equal(
			text,
			"why does step 3 hold?\n\n[Attached file: /Users/me/Uni/lec7.pdf]\n[Attached file: /Users/me/notes.md]",
		);
	});

	it("no files: the words alone, unchanged shape", () => {
		assert.equal(withAttachments(" hello ", []), "hello");
	});

	it("files alone: just the markers", () => {
		assert.equal(withAttachments("", ["/a/b.png"]), "[Attached file: /a/b.png]");
	});

	it("round-trips", () => {
		const paths = ["/x/notes [draft].md", "/y/scan.pdf"];
		assert.deepEqual(splitAttachments(withAttachments("line one\nline two", paths)), {
			text: "line one\nline two",
			paths,
		});
	});

	it("only the TRAILING run counts — a marker mid-message stays prose", () => {
		const content = "see [Attached file: /a.md] here\n[Attached file: /b.md]\nand more";
		assert.deepEqual(splitAttachments(content), { text: content, paths: [] });
	});

	it("plain text passes through untouched", () => {
		assert.deepEqual(splitAttachments("hello\n\n"), { text: "hello\n\n", paths: [] });
	});
});

describe("readable types", () => {
	it("accepts text, the read tool's images, and PDF — case-insensitive", () => {
		for (const name of ["a.md", "a.markdown", "a.txt", "a.PDF", "a.jpg", "a.jpeg", "a.png", "a.gif", "a.webp", "a.bmp"]) {
			assert.ok(isAttachable(name), name);
		}
	});

	it("refuses what the agent can't read yet", () => {
		for (const name of ["thesis.docx", "slides.pptx", "book.epub", "Makefile", ".bashrc"]) {
			assert.ok(!isAttachable(name), name);
		}
	});

	it("names and extensions come from the last path segment", () => {
		assert.equal(attachmentName("/Users/me/Uni/lec7.pdf"), "lec7.pdf");
		assert.equal(attachmentName("C:\\Users\\me\\scan.png"), "scan.png");
		assert.equal(attachmentExtension("/a.b/README"), "");
		assert.equal(attachmentExtension("Notes.TXT"), ".txt");
	});

	it("kinds pick the chip icon", () => {
		assert.equal(attachmentKind("/a/b.pdf"), "pdf");
		assert.equal(attachmentKind("/a/b.webp"), "image");
		assert.equal(attachmentKind("/a/b.md"), "text");
	});

	it("the refusal names the extension, or the file when it has none", () => {
		assert.equal(attachmentRefusal("thesis.docx"), "Plainly can't read .docx files yet.");
		assert.equal(attachmentRefusal("Makefile"), "Plainly can't read Makefile yet.");
	});
});
