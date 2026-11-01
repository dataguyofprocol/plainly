import katex from "katex";
import { splitMathSpans } from "@/src/core";

const cache = new Map<string, string>();

export function latexGlyphHtml(cmd: string): string {
	let html = cache.get(cmd);
	if (html === undefined) {
		html = katex.renderToString(cmd, { throwOnError: false, output: "html" });
		cache.set(cmd, html);
	}
	return html;
}

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

function inlineMathHtml(tex: string): string {
	return katex.renderToString(tex, { throwOnError: false });
}

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
