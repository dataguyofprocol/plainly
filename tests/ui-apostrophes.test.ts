import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const STRAIGHT = /[A-Za-z]'[A-Za-z]/;

function tsxFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		const p = join(dir, d.name);
		if (d.isDirectory()) return tsxFiles(p);
		return d.name.endsWith(".tsx") ? [p] : [];
	});
}

function insideJsx(node: ts.Node): boolean {
	for (let n = node.parent; n; n = n.parent) {
		if (ts.isJsxAttribute(n) || ts.isJsxExpression(n)) return true;
	}
	return false;
}

function straightApostrophes(file: string): string[] {
	const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const hits: string[] = [];
	const visit = (node: ts.Node) => {
		const text =
			ts.isJsxText(node) ? node.text
			: (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && insideJsx(node) ? node.text
			: null;
		if (text !== null && STRAIGHT.test(text)) {
			const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
			hits.push(`${relative(ROOT, file)}:${line + 1}  ${text.trim().slice(0, 80)}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(src);
	return hits;
}

describe("UI copy uses typographic apostrophes", () => {
	it("no straight apostrophe in JSX text or JSX string literals under components/ and app/", () => {
		const hits = [...tsxFiles(join(ROOT, "components")), ...tsxFiles(join(ROOT, "app"))].flatMap(straightApostrophes);
		assert.deepEqual(hits, [], `use ’ (U+2019) in UI copy:\n${hits.join("\n")}`);
	});
});
