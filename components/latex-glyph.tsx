import katex from "katex";
import { splitMathSpans } from "@/src/core";

/**
 * THE LaTeX glyph seam (owner ruling, 2026-09-30): UI connectors that
 * want math symbols render the REAL LaTeX glyphs through KaTeX — the
 * app's math engine, already shipped (app/layout.tsx carries the
 * katex stylesheet) — never hand-rolled SVGs or font-dependent
 * unicode. Born for the chain table's logical connectives: premises
 * join with \land (∧), the conclusion separates with \implies (⟹) —
 * `A ∧ B ⟹ C`, not the misleading `A → B → C`.
 *
 * Prominent by the same ruling: the connectives render in the
 * theme's FOREGROUND (white in the dark theme) — the chain line's
 * logic is the payload, not decoration. Callers pass the class.
 */

/** Cached katex HTML per command — the glyph set is tiny and
 *  renderToString is pure; one render per command per process. */
const cache = new Map<string, string>();

/** The raw katex HTML for a LaTeX command (pure, sync — SSR-safe). */
export function latexGlyphHtml(cmd: string): string {
	let html = cache.get(cmd);
	if (html === undefined) {
		html = katex.renderToString(cmd, { throwOnError: false, output: "html" });
		cache.set(cmd, html);
	}
	return html;
}

/** One rendered LaTeX glyph. `cmd` is the LaTeX command ("\land",
 *  "\implies"); the output is aria-hidden — callers carry the textual
 *  aria-label (formatChainLine keeps the plain-text form). */
export function LatexGlyph({
	cmd,
	testid,
	className,
}: {
	cmd: string;
	testid?: string;
	className?: string;
}) {
	return (
		<span
			data-testid={testid}
			aria-hidden="true"
			className={className}
			// katex.renderToString is the library's own trusted output
			// (the same thing rehype-katex injects for markdown math).
			dangerouslySetInnerHTML={{ __html: latexGlyphHtml(cmd) }}
		/>
	);
}

/** The KaTeX HTML for one preview math run (pure, sync — SSR-safe). A bad
 *  expression renders KaTeX's own red source text, never throws. */
function inlineMathHtml(tex: string): string {
	return katex.renderToString(tex, { throwOnError: false });
}

/**
 * One preview line with inline math (owner ruling 2026-10-28): the
 * one-line previews — the home "Waiting on you" title, the dock's
 * question teaser — render `$…$` spans as real KaTeX glyphs (the same
 * seam ruling as LatexGlyph: never font-dependent unicode). Input is
 * plainText's output: Markdown already stripped, math normalized to
 * single dollars. Prose runs render as text, an escaped `\$` as `$`.
 */
export function MathLine({ text }: { text: string }) {
	return (
		<>
			{splitMathSpans(text).map((span, i) =>
				span.math ? (
					<span
						key={i}
						// katex.renderToString is the library's own trusted output
						// (the same thing rehype-katex injects for markdown math).
						dangerouslySetInnerHTML={{ __html: inlineMathHtml(span.text) }}
					/>
				) : (
					span.text.replace(/\\\$/g, "$")
				),
			)}
		</>
	);
}
