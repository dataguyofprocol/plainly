/**
 * Legacy math delimiter preprocessing — the \(...\)/\[...\] reader.
 *
 * Current authoring uses `$...$` inline and `$$...$$` on separate lines for
 * display (owner, 2026-10-12). This pure transform keeps correctly formed
 * old backslash-delimited content readable; dollar math passes through to
 * Streamdown's native parser. Escape restoration below recognizes both
 * syntaxes while retaining the existing recovery rules.
 *
 * Rules:
 * - `\(...\)` → `$$...$$` (two-dollar inline, still accepted by micromark),
 *   `\[...\]` → `$$\n...\n$$` (block form: flow math).
 * - An escaped delimiter (`\\(` = literal backslash + paren) is left alone.
 * - Nothing inside fenced code blocks or inline code spans is touched.
 * - Unbalanced delimiters are left untouched: Streamdown streams chunks, and
 *   an incomplete `\[` completes on a later chunk (the whole text is
 *   re-transformed each render).
 *
 * Pure string → string. No markdown parsing — a single linear scan with a
 * code-state machine, cheap enough to run in the render path of a memo'd
 * component.
 */

const INLINE_OPEN = "\\(";
const INLINE_CLOSE = "\\)";
const DISPLAY_OPEN = "\\[";
const DISPLAY_CLOSE = "\\]";

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Is the backslash at `i` itself escaped (i.e. preceded by an odd number of
 * backslashes)? If so, the `\(`/`\[` starting there is a literal backslash
 * followed by a bracket — not a delimiter.
 */
function isEscaped(text: string, i: number): boolean {
	let count = 0;
	for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) count += 1;
	return count % 2 === 1;
}

/** Length of the backtick run starting at `i` (0 if `text[i]` is not a tick). */
function backtickRun(text: string, i: number): number {
	let count = 0;
	while (text[i + count] === "`") count += 1;
	return count;
}

/**
 * Try to find the closing delimiter for the opening one at `i` (2 chars,
 * already verified unescaped). The close scan stops at inline code spans and
 * fence starts (barriers — math never contains them), and returns -1 when the
 * delimiter is unbalanced (mid-stream chunk).
 */
function findClose(
	text: string,
	from: number,
	close: string,
): number {
	for (let j = from; j < text.length - 1; j++) {
		if (text[j] === "`") return -1; // inline code barrier
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

/** True when `i` sits at the start of a line (position 0 or right after \n). */
function atLineStart(text: string, i: number): boolean {
	return i === 0 || text[i - 1] === "\n";
}

/**
 * Copy a fenced code block starting at `i` (line start, fence regex matched)
 * verbatim to the output. Returns the index after the closing fence line —
 * or the end of the text when the fence is unclosed (mid-stream: everything
 * after is literal code until the chunk completes).
 */
function copyFencedBlock(text: string, i: number, out: string[]): number {
	const open = FENCE_OPEN_RE.exec(text.slice(i));
	const marker = open?.[1] ?? "```";
	const closeRe = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t]*$`);
	let j = i;
	// Copy lines until the matching closing fence.
	while (j < text.length) {
		const lineEnd = text.indexOf("\n", j);
		const next = lineEnd === -1 ? text.length : lineEnd + 1;
		const line = text.slice(j, lineEnd === -1 ? text.length : lineEnd);
		out.push(text.slice(j, next));
		if (j > i && closeRe.test(line)) return next; // closing fence line
		j = next;
	}
	return text.length;
}

/** Is the `\[` at `i` block-positioned (own line, only whitespace before)? */
function displayIsBlockPositioned(text: string, i: number): boolean {
	for (let j = i - 1; j >= 0; j--) {
		const ch = text[j];
		if (ch === "\n") return true;
		if (ch !== " " && ch !== "\t") return false;
	}
	return true;
}

/** Is the `\[` at `i` indented (whitespace before it on the line)? */
function displayIsIndented(text: string, i: number): boolean {
	let sawWhitespace = false;
	for (let j = i - 1; j >= 0; j--) {
		const ch = text[j];
		if (ch === "\n") return sawWhitespace;
		if (ch !== " " && ch !== "\t") return false; // mid-paragraph
		sawWhitespace = true;
	}
	return sawWhitespace;
}

/** Does the closing delimiter end its line (only \n or EOF after it)? */
function closeEndsLine(text: string, afterClose: number): boolean {
	return afterClose >= text.length || text[afterClose] === "\n";
}

/**
 * Rewrite balanced `\(...\)` → `$$...$$` and `\[...\]` → `$$\n...\n$$`.
 * Everything else passes through byte-for-byte.
 */
/** The escaped-dollar-aware inline closer (owner, 2026-10-12): micromark's
 *  mathText closer is code-span logic — ANY size-matched `$` run closes,
 *  `\$` included, so `$x = \$5$` closes at the `\$` and errors. KaTeX's
 *  own auto-render scanner skips escaped dollars, and KaTeX renders `\$`
 *  fine — the author's intent is unambiguous: an escaped dollar (odd number
 *  of backslashes before it) never closes the span. Mirrors findDollarClose's
 *  inline rules otherwise (exact size match, whole-run skip). The first bare
 *  single `$` decides: it closes only when canCloseInlineDollar allows. */
function findInlineDollarCloseEscapeAware(text: string, from: number): number {
	for (let j = from; j < text.length;) {
		if (text[j] !== "$") {
			j += 1;
			continue;
		}
		if (isEscaped(text, j)) {
			j += 1;
			continue; // `\$` never closes
		}
		const count = dollarRun(text, j);
		if (count === 1) return canCloseInlineDollar(text, j) ? j : -1;
		j += count;
	}
	return -1;
}

/** Currency is not math (owner, 2026-10-29) — Pandoc's dollar rule for
 *  single-dollar inline math: a `$` opens only when a non-space character
 *  follows it, and closes only when a non-space character precedes it and
 *  no digit follows. `$100 into a $100 pot` and `$150/($150 + $50)` stay
 *  prose; `$x$` and `$x = \$5$` stay math. Costs: `$ x $` and `$x$5` are
 *  no longer math. */
function canOpenInlineDollar(text: string, i: number, space = /\s/): boolean {
	const next = text[i + 1];
	return next !== undefined && !space.test(next);
}

function canCloseInlineDollar(text: string, j: number, space = /\s/): boolean {
	const prev = text[j - 1];
	const next = text[j + 1];
	return prev !== undefined && !space.test(prev) && !(next !== undefined && next >= "0" && next <= "9");
}

/** The debris pass's whitespace: JSON debris (`\f` of `\forall`, `\t` of
 *  `\to`, `\n` of `\nabla`) is whitespace-shaped, so only a real space
 *  counts there — `$\forall x$` must still open before it is repaired. */
const DEBRIS_PASS_SPACE_RE = / /;

/** The closer of the single-dollar inline span opening at `i`, or -1 when
 *  `i` cannot open one or no valid closer follows (currency, or mid-stream). */
function findInlineDollarSpanClose(text: string, i: number): number {
	return canOpenInlineDollar(text, i) ? findInlineDollarCloseEscapeAware(text, i + 1) : -1;
}

/** Replace `\$` (odd-backslash dollars) inside a math span with the
 *  dollar-free `\text{\textdollar}` — KaTeX-safe in math mode (bare
 *  `\textdollar` is text-mode-only there). Even-backslash dollars (`\\$`,
 *  row break + dollar) are left alone. */
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

export function transformMathDelimiters(markdown: string): string {
	const out: string[] = [];
	let i = 0;

	while (i < markdown.length) {
		const ch = markdown[i]!;

		// Fenced code blocks: copied verbatim (only detectable at line start).
		if (atLineStart(markdown, i) && FENCE_OPEN_RE.test(markdown.slice(i))) {
			i = copyFencedBlock(markdown, i, out);
			continue;
		}

		// Inline code spans: copied verbatim.
		if (ch === "`") {
			const run = backtickRun(markdown, i);
			let j = i + run;
			// Find the matching run (same length, per CommonMark).
			while (j < markdown.length) {
				const nextRun = backtickRun(markdown, j);
				if (nextRun === run) break;
				j += Math.max(nextRun, 1);
			}
			if (j < markdown.length) {
				out.push(markdown.slice(i, j + run));
				i = j + run;
			} else {
				// Unclosed run (mid-stream): literal, keep scanning after it.
				out.push(markdown.slice(i, i + run));
				i += run;
			}
			continue;
		}

		// Math delimiters.
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
							// Indented display math (inside a list item, quote, …):
							// an indented $$ flow block half-parses inside list
							// continuations (empty math, eaten items), so degrade to
							// the inline form — renders inline, stays inside the item.
							// mathText cannot span line endings, so collapse them.
							out.push(`$$${content.replace(/\s*\n\s*/g, " ")}$$`);
						} else if (isDisplay) {
							// Flow math ($$ alone on its lines) renders as display
							// KaTeX. Mid-paragraph \[...\] (or trailing text after the
							// closer) would half-parse into literal dollars + KaTeX
							// errors — pad with blank lines to force a clean block.
							// Block-positioned math passes through in place.
							const afterClose = closeAt + close.length;
							const padBefore =
									displayIsBlockPositioned(markdown, i) ? "" : "\n\n";
							const padAfter =
									closeEndsLine(markdown, afterClose) ? "" : "\n\n";
							out.push(`${padBefore}$$\n${content}\n$$${padAfter}`);
						} else {
							// Preserve the legacy reader's two-dollar inline output
							// (renders inline, not display).
							out.push(`$$${content}$$`);
						}
						i = closeAt + close.length;
						continue;
					}
				}
				// Unbalanced or empty: leave both characters untouched.
			}
		}

		// Escaped dollars inside inline math (owner, 2026-10-12): normalize
		// BEFORE tokenization — inside a balanced inline span, `\$` becomes the
		// dollar-free `\text{\textdollar}` so the scanner's closer is the one
		// the author meant (micromark would otherwise close at the `\$`, error
		// out, and cascade). Display runs are copied whole and left untouched —
		// a lone `$` can't close `$$`, so `\$` already survives there — and
		// copying the run stops its second `$` posing as an inline opener.
		// Spans without escaped dollars emit byte-identical text, copied whole
		// so their closer is never re-read as an opener; prose `\$` and code
		// are untouched. A single `$` that cannot pair (currency, or a span
		// whose closer has not streamed in yet) is escaped to a literal `\$`,
		// so micromark never pairs it (canOpenInlineDollar).
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
 * LaTeX-escape restoration (owner ruling 2026-09-26) — the JSON-debris fix.
 *
 * When a model emits LaTeX with SINGLE backslashes inside JSON tool-call
 * arguments (`\forall`, not the properly escaped `\\forall`), JSON escape
 * resolution eats the command's first letter: `\f` → form feed + "orall",
 * `\v` → vertical tab + "arphi", `\t` → tab + "o". The debris survives into
 * the persisted RAW args and renders as garbage. Inside a MATH SPAN these
 * control chars can never be legitimate content, so restoring the two-char
 * escape reconstructs the model's intent byte-perfectly. Outside spans the
 * same chars might be real prose (pasted tables, formatted text), so only
 * balanced math spans are touched. The legacy `\(…\)` / `\[…\]` pass stays
 * unchanged; the dollar reader adds `$…$` and fenced `$$…$$` recognition,
 * excluding code and escaped opening dollars. Unbalanced spans pass through.
 *
 * ASYMMETRIC NEWLINE RULE (owner ruling 2026-09-27, Option A): inline spans
 * restore all six debris chars — real newlines/tabs inside INLINE math
 * essentially never occur (options and inline math are single-line by
 * nature). Display spans restore five and KEEP real newlines — multi-line
 * display math (aligned environments, equation systems) is common, and a
 * real line break is byte-identical on the wire to sloppy `\neq`/`\nu`/
 * `\neg`/`\nabla` (JSON `\n` resolves to a newline either way). Corrupting
 * legitimate content is strictly worse than failing to repair that rarest
 * slice, so display-span n-command sloppiness stays broken by design.
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

/** Display spans keep real newlines (multi-line equations) — debris there is
 *  everything except \n (a lone real \r never occurs in authored text, and
 *  `\right`/`\rho`/`\rangle` corruption is common in display math). */
const DISPLAY_DEBRIS_RE = /[\b\t\v\f\r]/;

/** Shared display-only repair. Keep raw arguments and model history unchanged. */
export function repairMathForDisplay(text: string): string {
	return healOverescapedCommands(restoreMathEscapes(text));
}

export function restoreMathEscapes(text: string): string {
	if (!DEBRIS_RE.test(text)) return text;
	return restoreDollarMathEscapes(restoreLegacyMathEscapes(text));
}

/** Keep legacy recovery byte-for-byte; only the recognized syntax expands. */
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
 *  remains inline. A flow opener may have metadata, but never another $. */
function dollarIsDisplay(text: string, i: number, size: number): boolean {
	if (size < 2 || !displayIsBlockPositioned(text, i)) return false;
	const end = text.indexOf("\n", i + size);
	return !text.slice(i + size, end === -1 ? text.length : end).includes("$");
}

/** Match micromark's delimiter runs: exact size inline, at least the
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
			// Single dollars follow the currency rule (canOpenInlineDollar).
			return size === 1 && !canCloseInlineDollar(text, j, space) ? undefined : { at: j, after: j + count };
		}
		j += count;
	}
	return undefined;
}

/** Dollar recognition only — the same six/five-character repair maps,
 *  with no over-escaping normalization or mathematical validation. */
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
		// Legacy spans have already received their own inline/display policy.
		// Do not reinterpret dollars inside them in this second pass.
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
 * Over-escaped command heal (owner ruling 2026-10-15) — the doubled-
 * backslash fix.
 *
 * Some models stochastically emit DOUBLED backslashes inside JSON tool-call
 * arguments: the saved record holds `\\nabla` (two real backslashes) where
 * `\nabla` was meant. KaTeX reads the `\\` as a row break and then renders
 * the command name as plain letters — the learner sees "the word nabla, not
 * the symbol". Field evidence (2026-10-15, real data): xiaomi/mimo-v2.6-pro
 * doubled per-call, per-field (one probe's question doubled while its
 * explanation and options in the SAME call stayed clean — authoring, not
 * transport), and deepseek-v4.1-flash once; quadrupling appeared when the
 * in-session agent "compensated" for its own doubled first attempt.
 *
 * THE RULE. Inside a balanced math span ONLY (legacy `\(…\)`/`\[…\]` and
 * dollar `$…$`/`$$…$$`, code spans and fences excluded), an EVEN-length
 * backslash run (2, 4, …) immediately followed by a command start — a letter
 * (any command name; bare letters after a row break are never authored
 * content) or a punctuation command (`,` `;` `:` `!` `|` — thin spaces,
 * norm bars) — collapses to a single backslash. Even runs before anything
 * else (space, newline, `&`, `[`, `$`, digits) are legitimate row breaks and
 * stay; ODD runs (3, 5, …) are row break(s) plus a real command with its own
 * backslash — e.g. matrix cells written `a \\\nabla` — and stay untouched,
 * so matrix content cannot be corrupted. Outside spans nothing is touched:
 * doubled backslashes in prose or code are not ours to judge. Unbalanced
 * spans pass through, exactly like the debris passes.
 */
const COMMAND_START_CLASS = "[A-Za-z,;:!|]";

/** Collapse even backslash runs before a command start; keep odd runs. */
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
 * Over-escaped newline decode (owner ruling 2026-10-28) — the prose twin of
 * healOverescapedCommands.
 *
 * Field evidence (2026-10-28, the poker session): glm-5.3 double-escaped
 * every probe `explanation` — the saved record holds the two characters
 * `\` + `n` where a paragraph break was meant, and the learner reads a
 * literal `\n\n` in the Why block; gpt-5.6-luna copied the pattern later in
 * the same session. Authoring, not transport: the same session's plan_init
 * mermaid carried real newlines.
 *
 * THE RULE. Only a string with NO real newline is a candidate (a string that
 * already breaks lines for real meant its `\n` text literally). In it, every
 * UNESCAPED `\n` OUTSIDE balanced math spans (legacy `\(…\)`/`\[…\]`, dollar
 * `$…$`/`$$…$$`) and code spans becomes a newline; inside spans nothing is
 * touched, so `$\nabla$`/`$\neq$` survive. An escaped `\\n` (literal
 * backslash + n) stays. Callers opt in per field (argument-heal's
 * healProseEscapes) — code-bearing strings are never passed here.
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
			// No real newline means no display block: every run closes inline.
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

/** One run of a one-line preview: prose, or a math span's inner TeX. */
export type MathSpan = { math: boolean; text: string };

/**
 * Split text into prose and math runs for one-line previews (owner ruling
 * 2026-10-28 — previews render inline KaTeX). Recognizes balanced
 * `\(…\)`, `\[…\]`, `$$…$$` and `$…$` (an escaped `\$` never opens or
 * closes); code spans stay prose and are never scanned for math. Unbalanced
 * openers stay prose. Math runs carry the inner TeX without delimiters.
 */
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
