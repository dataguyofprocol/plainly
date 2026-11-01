const INLINE_OPEN = "\\(";
const INLINE_CLOSE = "\\)";
const DISPLAY_OPEN = "\\[";
const DISPLAY_CLOSE = "\\]";

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/** True when preceded by an odd number of backslashes. */
function isEscaped(text: string, i: number): boolean {
	let count = 0;
	for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) count += 1;
	return count % 2 === 1;
}

function backtickRun(text: string, i: number): number {
	let count = 0;
	while (text[i + count] === "`") count += 1;
	return count;
}

/** Stops at inline code (returns -1) and returns -1 when unbalanced. */
function findClose(
	text: string,
	from: number,
	close: string,
): number {
	for (let j = from; j < text.length - 1; j++) {
		if (text[j] === "`") return -1;
		if (
			text[j] === "\\" &&
			text[j + 1] === close[1] &&
			!isEscaped(text, j)
		) {
			return j;
		}
	}
	return -1;
}

function atLineStart(text: string, i: number): boolean {
	return i === 0 || text[i - 1] === "\n";
}

/** Returns the index after the closing fence line, or the text end when the
 *  fence is unclosed. */
function copyFencedBlock(text: string, i: number, out: string[]): number {
	const open = FENCE_OPEN_RE.exec(text.slice(i));
	const marker = open?.[1] ?? "```";
	const closeRe = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t]*$`);
	let j = i;
	while (j < text.length) {
		const lineEnd = text.indexOf("\n", j);
		const next = lineEnd === -1 ? text.length : lineEnd + 1;
		const line = text.slice(j, lineEnd === -1 ? text.length : lineEnd);
		out.push(text.slice(j, next));
		if (j > i && closeRe.test(line)) return next;
		j = next;
	}
	return text.length;
}

function displayIsBlockPositioned(text: string, i: number): boolean {
	for (let j = i - 1; j >= 0; j--) {
		const ch = text[j];
		if (ch === "\n") return true;
		if (ch !== " " && ch !== "\t") return false;
	}
	return true;
}

function displayIsIndented(text: string, i: number): boolean {
	let sawWhitespace = false;
	for (let j = i - 1; j >= 0; j--) {
		const ch = text[j];
		if (ch === "\n") return sawWhitespace;
		if (ch !== " " && ch !== "\t") return false;
		sawWhitespace = true;
	}
	return sawWhitespace;
}

function closeEndsLine(text: string, afterClose: number): boolean {
	return afterClose >= text.length || text[afterClose] === "\n";
}

/** micromark closes inline math at any size-matched `$` run, `\$` included,
 *  so `$x = \$5$` would close early. An escaped dollar never closes here,
 *  matching KaTeX's auto-render. */
function findInlineDollarCloseEscapeAware(text: string, from: number): number {
	for (let j = from; j < text.length;) {
		if (text[j] !== "$") {
			j += 1;
			continue;
		}
		if (isEscaped(text, j)) {
			j += 1;
			continue;
		}
		const count = dollarRun(text, j);
		if (count === 1) return canCloseInlineDollar(text, j) ? j : -1;
		j += count;
	}
	return -1;
}

/** Pandoc's single-dollar rule: `$` opens only before a non-space character
 *  and closes only after a non-space character with no digit following, so
 *  currency like `$100` stays prose. */
function canOpenInlineDollar(text: string, i: number, space = /\s/): boolean {
	const next = text[i + 1];
	return next !== undefined && !space.test(next);
}

function canCloseInlineDollar(text: string, j: number, space = /\s/): boolean {
	const prev = text[j - 1];
	const next = text[j + 1];
	return prev !== undefined && !space.test(prev) && !(next !== undefined && next >= "0" && next <= "9");
}

/** JSON escape debris (`\f` of `\forall`, `\t` of `\to`) is whitespace-shaped,
 *  so only a real space blocks an opener in the debris pass. */
const DEBRIS_PASS_SPACE_RE = / /;

/** -1 when `i` cannot open a span or no valid closer follows. */
function findInlineDollarSpanClose(text: string, i: number): number {
	return canOpenInlineDollar(text, i) ? findInlineDollarCloseEscapeAware(text, i + 1) : -1;
}

/** `\$` becomes `\text{\textdollar}`; bare `\textdollar` is text-mode-only in
 *  KaTeX. Even-backslash dollars (row break + dollar) are left alone. */
function replaceEscapedDollars(content: string): string {
	let replaced = "";
	for (let j = 0; j < content.length;) {
		if (content[j] === "\\" && content[j + 1] === "$" && !isEscaped(content, j)) {
			replaced += "\\text{\\textdollar}";
			j += 2;
		} else {
			replaced += content[j];
			j += 1;
		}
	}
	return replaced;
}

/** Rewrites balanced `\(...\)` to `$$...$$` (micromark inline) and `\[...\]`
 *  to a `$$` flow block. Escaped delimiters, code and unbalanced delimiters
 *  (mid-stream chunks) pass through untouched. Single `$` that cannot pair
 *  becomes a literal `\$`. */
export function transformMathDelimiters(markdown: string): string {
	const out: string[] = [];
	let i = 0;

	while (i < markdown.length) {
		const ch = markdown[i]!;

		if (atLineStart(markdown, i) && FENCE_OPEN_RE.test(markdown.slice(i))) {
			i = copyFencedBlock(markdown, i, out);
			continue;
		}

		if (ch === "`") {
			const run = backtickRun(markdown, i);
			let j = i + run;
			while (j < markdown.length) {
				const nextRun = backtickRun(markdown, j);
				if (nextRun === run) break;
				j += Math.max(nextRun, 1);
			}
			if (j < markdown.length) {
				out.push(markdown.slice(i, j + run));
				i = j + run;
			} else {
				out.push(markdown.slice(i, i + run));
				i += run;
			}
			continue;
		}

		if (ch === "\\" && !isEscaped(markdown, i)) {
			const next = markdown[i + 1];
			if (next === "(" || next === "[") {
				const isDisplay = next === "[";
				const open = isDisplay ? DISPLAY_OPEN : INLINE_OPEN;
				const close = isDisplay ? DISPLAY_CLOSE : INLINE_CLOSE;
				const closeAt = findClose(markdown, i + open.length, close);
				if (closeAt !== -1) {
					const content = markdown.slice(i + open.length, closeAt).trim();
					if (content.length > 0) {
						if (isDisplay && displayIsIndented(markdown, i)) {
							// micromark half-parses an indented $$ flow block inside list
							// continuations, so indented display math degrades to the
							// inline form; mathText cannot span line endings.
							out.push(`$$${content.replace(/\s*\n\s*/g, " ")}$$`);
						} else if (isDisplay) {
							// Mid-paragraph flow math half-parses in micromark, so pad
							// with blank lines to force a clean block.
							const afterClose = closeAt + close.length;
							const padBefore =
									displayIsBlockPositioned(markdown, i) ? "" : "\n\n";
							const padAfter =
									closeEndsLine(markdown, afterClose) ? "" : "\n\n";
							out.push(`${padBefore}$$\n${content}\n$$${padAfter}`);
						} else {
							out.push(`$$${content}$$`);
						}
						i = closeAt + close.length;
						continue;
					}
				}
			}
		}

		// Inside a balanced inline span, `\$` is normalized before micromark
		// sees it, or micromark closes at the `\$`. Display runs are copied
		// whole so their second `$` never poses as an inline opener.
		if (ch === "$" && !isEscaped(markdown, i)) {
			const run = dollarRun(markdown, i);
			if (run === 1) {
				const closeAt = findInlineDollarSpanClose(markdown, i);
				if (closeAt !== -1) {
					out.push(`$${replaceEscapedDollars(markdown.slice(i + 1, closeAt))}$`);
					i = closeAt + 1;
					continue;
				}
				out.push("\\$");
				i += 1;
				continue;
			} else {
				out.push(markdown.slice(i, i + run));
				i += run;
				continue;
			}
			}

		out.push(ch);
		i += 1;
	}

	return out.join("");
}

/**
 * Models emitting single-backslash LaTeX inside JSON tool arguments lose the
 * command's first letter to JSON escape resolution (`\f` → form feed +
 * "orall"). Inside balanced math spans these control chars are restored to
 * their two-char escape; outside spans they are left alone.
 *
 * Inline spans restore all six. Display spans keep real newlines, because a
 * real line break is byte-identical to a sloppy `\neq`/`\nabla` and
 * multi-line display math is common.
 */
const ESCAPE_DEBRIS: Record<string, string> = {
	"\b": "\\b",
	"\t": "\\t",
	"\n": "\\n",
	"\v": "\\v",
	"\f": "\\f",
	"\r": "\\r",
};

const DEBRIS_RE = /[\b\t\n\v\f\r]/;

/** `\r` is restored in display spans: `\right`/`\rho` corruption is common. */
const DISPLAY_DEBRIS_RE = /[\b\t\v\f\r]/;

/** Display-only repair; raw arguments and model history stay unchanged. */
export function repairMathForDisplay(text: string): string {
	return healOverescapedCommands(restoreMathEscapes(text));
}

export function restoreMathEscapes(text: string): string {
	if (!DEBRIS_RE.test(text)) return text;
	return restoreDollarMathEscapes(restoreLegacyMathEscapes(text));
}

function restoreLegacyMathEscapes(text: string): string {
	if (!DEBRIS_RE.test(text)) return text;
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === "\\" && !isEscaped(text, i)) {
			const next = text[i + 1];
			if (next === "(" || next === "[") {
				const isDisplay = next === "[";
				const open = isDisplay ? DISPLAY_OPEN : INLINE_OPEN;
				const close = isDisplay ? DISPLAY_CLOSE : INLINE_CLOSE;
				const closeAt = findClose(text, i + open.length, close);
				if (closeAt !== -1) {
					const inner = text.slice(i + open.length, closeAt);
					const debris = isDisplay ? DISPLAY_DEBRIS_RE : DEBRIS_RE;
					out.push(open + inner.replace(debris, (c) => ESCAPE_DEBRIS[c]!) + close);
					i = closeAt + close.length;
					continue;
				}
			}
		}
		out.push(ch);
		i += 1;
	}
	return out.join("");
}

function dollarRun(text: string, i: number): number {
	let count = 0;
	while (text[i + count] === "$") count += 1;
	return count;
}

/** Native math fences start at a line's block position; one-line $$…$$
 *  stays inline. A flow opener may carry metadata but never another $. */
function dollarIsDisplay(text: string, i: number, size: number): boolean {
	if (size < 2 || !displayIsBlockPositioned(text, i)) return false;
	const end = text.indexOf("\n", i + size);
	return !text.slice(i + size, end === -1 ? text.length : end).includes("$");
}

/** Mirrors micromark's delimiter runs: exact size inline, at least the
 *  opener's size on an otherwise-empty line for display. Inside math,
 *  backslashes are TeX data, not Markdown escapes for closing dollars. */
function findDollarClose(
	text: string,
	from: number,
	size: number,
	isDisplay: boolean,
	space?: RegExp,
): { at: number; after: number } | undefined {
	if (isDisplay) {
		let lineEnd = text.indexOf("\n", from);
		while (lineEnd !== -1) {
			const start = lineEnd + 1;
			lineEnd = text.indexOf("\n", start);
			const line = text.slice(start, lineEnd === -1 ? text.length : lineEnd);
			const close = /^([ \t]{0,3})(\$+)[ \t]*\r?$/.exec(line);
			if (close && close[2]!.length >= size) {
				const at = start + close[1]!.length;
				return { at, after: at + close[2]!.length };
			}
		}
		return undefined;
	}
	for (let j = from; j < text.length;) {
		if (text[j] !== "$") {
			j += 1;
			continue;
		}
		const count = dollarRun(text, j);
		if (count === size) {
			return size === 1 && !canCloseInlineDollar(text, j, space) ? undefined : { at: j, after: j + count };
		}
		j += count;
	}
	return undefined;
}

function restoreDollarMathEscapes(text: string): string {
	if (!DEBRIS_RE.test(text) || !text.includes("$")) return text;
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (atLineStart(text, i) && FENCE_OPEN_RE.test(text.slice(i))) {
			i = copyFencedBlock(text, i, out);
			continue;
		}
		if (text[i] === "`") {
			const run = backtickRun(text, i);
			let j = i + run;
			while (j < text.length) {
				const nextRun = backtickRun(text, j);
				if (nextRun === run) break;
				j += Math.max(nextRun, 1);
			}
			const after = j < text.length ? j + run : i + run;
			out.push(text.slice(i, after));
			i = after;
			continue;
		}
		// Legacy spans were already repaired by their own pass.
		if (text[i] === "\\" && !isEscaped(text, i)) {
			const next = text[i + 1];
			if (next === "(" || next === "[") {
				const closeAt = findClose(text, i + 2, next === "[" ? DISPLAY_CLOSE : INLINE_CLOSE);
				if (closeAt !== -1) {
					out.push(text.slice(i, closeAt + 2));
					i = closeAt + 2;
					continue;
				}
			}
		}
		if (text[i] === "$" && !isEscaped(text, i)) {
			const size = dollarRun(text, i);
			const isDisplay = dollarIsDisplay(text, i, size);
			const close = size === 1 && !canOpenInlineDollar(text, i, DEBRIS_PASS_SPACE_RE)
				? undefined
				: findDollarClose(text, i + size, size, isDisplay, DEBRIS_PASS_SPACE_RE);
			if (close) {
				const debris = isDisplay ? DISPLAY_DEBRIS_RE : DEBRIS_RE;
				out.push(
					text.slice(i, i + size) +
					text.slice(i + size, close.at).replace(debris, (c) => ESCAPE_DEBRIS[c]!) +
					text.slice(close.at, close.after),
				);
				i = close.after;
				continue;
			}
			out.push(text.slice(i, i + size));
			i += size;
			continue;
		}
		out.push(text[i]!);
		i += 1;
	}
	return out.join("");
}

/**
 * Some models emit doubled backslashes inside JSON tool arguments (`\\nabla`),
 * which KaTeX reads as a row break plus plain letters. Inside balanced math
 * spans only, an even backslash run directly before a letter or a
 * punctuation command (`,;:!|`) collapses to one backslash. Even runs before
 * anything else are real row breaks; odd runs are row break(s) plus a real
 * command, so both stay.
 */
const COMMAND_START_CLASS = "[A-Za-z,;:!|]";

function halveOverescapedCommandRuns(inner: string): string {
	return inner.replace(
		new RegExp("(\\\\+)(?=" + COMMAND_START_CLASS + ")", "g"),
		(run: string) => (run.length % 2 === 0 ? "\\" : run),
	);
}

export function healOverescapedCommands(text: string): string {
	if (!text.includes("\\\\")) return text;
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (atLineStart(text, i) && FENCE_OPEN_RE.test(text.slice(i))) {
			i = copyFencedBlock(text, i, out);
			continue;
		}
		if (text[i] === "`") {
			const run = backtickRun(text, i);
			let j = i + run;
			while (j < text.length) {
				const nextRun = backtickRun(text, j);
				if (nextRun === run) break;
				j += Math.max(nextRun, 1);
			}
			const after = j < text.length ? j + run : i + run;
			out.push(text.slice(i, after));
			i = after;
			continue;
		}
		if (text[i] === "\\" && !isEscaped(text, i)) {
			const next = text[i + 1];
			if (next === "(" || next === "[") {
				const isDisplay = next === "[";
				const open = isDisplay ? DISPLAY_OPEN : INLINE_OPEN;
				const close = isDisplay ? DISPLAY_CLOSE : INLINE_CLOSE;
				const closeAt = findClose(text, i + open.length, close);
				if (closeAt !== -1) {
					const inner = text.slice(i + open.length, closeAt);
					out.push(open + halveOverescapedCommandRuns(inner) + close);
					i = closeAt + close.length;
					continue;
				}
			}
		}
		if (text[i] === "$" && !isEscaped(text, i)) {
			const size = dollarRun(text, i);
			const isDisplay = dollarIsDisplay(text, i, size);
			const close = size === 1 && !canOpenInlineDollar(text, i)
				? undefined
				: findDollarClose(text, i + size, size, isDisplay);
			if (close) {
				out.push(
					text.slice(i, i + size) +
					halveOverescapedCommandRuns(text.slice(i + size, close.at)) +
					text.slice(close.at, close.after),
			);
				i = close.after;
				continue;
			}
			out.push(text.slice(i, i + size));
			i += size;
			continue;
		}
		out.push(text[i]!);
		i += 1;
	}
	return out.join("");
}

/**
 * Some models double-escape newlines in prose fields, storing `\` + `n`.
 * Only a string with no real newline is a candidate. Every unescaped `\n`
 * outside math spans and code spans becomes a newline; inside spans
 * `$\nabla$` survives. Callers opt in per field; never pass code-bearing
 * strings.
 */
export function decodeOverescapedNewlines(text: string): string {
	if (text.includes("\n") || !text.includes("\\n")) return text;
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (text[i] === "`") {
			const run = backtickRun(text, i);
			let j = i + run;
			while (j < text.length) {
				const nextRun = backtickRun(text, j);
				if (nextRun === run) break;
				j += Math.max(nextRun, 1);
			}
			const after = j < text.length ? j + run : i + run;
			out.push(text.slice(i, after));
			i = after;
			continue;
		}
		if (text[i] === "\\" && !isEscaped(text, i)) {
			const next = text[i + 1];
			if (next === "(" || next === "[") {
				const closeAt = findClose(text, i + 2, next === "[" ? DISPLAY_CLOSE : INLINE_CLOSE);
				if (closeAt !== -1) {
					out.push(text.slice(i, closeAt + 2));
					i = closeAt + 2;
					continue;
				}
			}
			if (next === "n") {
				out.push("\n");
				i += 2;
				continue;
			}
		}
		if (text[i] === "$" && !isEscaped(text, i)) {
			const size = dollarRun(text, i);
			const close = findDollarClose(text, i + size, size, false);
			if (close) {
				out.push(text.slice(i, close.after));
				i = close.after;
				continue;
			}
			out.push(text.slice(i, i + size));
			i += size;
			continue;
		}
		out.push(text[i]!);
		i += 1;
	}
	return out.join("");
}

export type MathSpan = { math: boolean; text: string };

/** Splits text into prose and math runs for one-line previews. Recognizes
 *  balanced `\(…\)`, `\[…\]`, `$$…$$` and `$…$`; code spans stay prose.
 *  Math runs carry the inner TeX without delimiters. */
export function splitMathSpans(text: string): MathSpan[] {
	const out: MathSpan[] = [];
	let prose = "";
	const flush = () => {
		if (prose) out.push({ math: false, text: prose });
		prose = "";
	};
	let i = 0;
	while (i < text.length) {
		if (text[i] === "`") {
			const run = backtickRun(text, i);
			const close = text.indexOf("`".repeat(run), i + run);
			const after = close === -1 ? i + run : close + run;
			prose += text.slice(i, after);
			i = after;
			continue;
		}
		if (text[i] === "\\" && !isEscaped(text, i) && (text[i + 1] === "(" || text[i + 1] === "[")) {
			const closeAt = findClose(text, i + 2, text[i + 1] === "[" ? DISPLAY_CLOSE : INLINE_CLOSE);
			if (closeAt !== -1) {
				flush();
				out.push({ math: true, text: text.slice(i + 2, closeAt) });
				i = closeAt + 2;
				continue;
			}
		}
		if (text[i] === "$" && !isEscaped(text, i)) {
			const size = dollarRun(text, i);
			const closeAt = size === 1 ? findInlineDollarSpanClose(text, i) : text.indexOf("$$", i + size);
			if (size <= 2 && closeAt !== -1) {
				flush();
				out.push({ math: true, text: text.slice(i + size, closeAt) });
				i = closeAt + size;
				continue;
			}
			prose += text.slice(i, i + size);
			i += size;
			continue;
		}
		prose += text[i];
		i += 1;
	}
	flush();
	return out;
}
