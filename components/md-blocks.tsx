"use client";

import { cloneElement, isValidElement, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
	CodeBlock,
	extractTableDataFromElement,
	tableDataToMarkdown,
	useIsCodeFenceIncomplete,
} from "streamdown";
import type { ExtraProps } from "streamdown";
import { MERMAID_FONT_SIZE, renderMermaid } from "@/components/mermaid-render";
import { useResolvedTheme } from "@/components/theme";
import { MermaidError } from "@/components/mermaid-error";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { chartSize, useSessionMermaid } from "@/components/session-overlay";
import { Hint } from "@/components/ui/hint";

/** Clipboard write with a fallback: navigator.clipboard needs the
 *  `clipboard-sanitized-write` permission, which Electron's deny-by-default
 *  handler (electron/main.cjs) must grant from the loopback origin — and
 *  browsers with a stale/absent API reject too. The hidden-textarea
 *  execCommand path is the belt under that: a failed write would otherwise
 *  be a silent no-op, which is exactly what the owner saw. Returns whether
 *  the copy landed (drives the Copied pill). */
async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		/* fall through to the legacy path */
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}

export function CopyCorner({
	getText,
	label,
	className,
}: {
	getText: () => string;
	label: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timerRef.current), []);
	return (
		<span className={cn("relative inline-flex", className)}>
			<button
				type="button"
				aria-label={label}
				data-testid="md-copy"
				className="ls-corner opacity-0 focus-visible:opacity-100 group-hover/md:opacity-100"
				onClick={(e) => {
					blurAfterPointerClick(e);
					void copyText(getText()).then((ok) => {
						if (!ok) return;
						setCopied(true);
						window.clearTimeout(timerRef.current);
						timerRef.current = window.setTimeout(() => setCopied(false), 1500);
					});
				}}
			>
				{copied ? <Icon name="check" size="sm" className="text-good" /> : <Icon name="copy" size="sm" />}
			</button>
		</span>
	);
}

/** The fence source from a code element's children — a bare string in the
 *  common case; an element wrapping a string when rehype nests it. Pure. */
export function codeSource(children: ReactNode): string {
	if (typeof children === "string") return children;
	if (typeof children === "number") return String(children);
	if (isValidElement(children)) {
		const inner = (children.props as { children?: ReactNode }).children;
		if (typeof inner === "string") return inner;
	}
	return "";
}

function MermaidInline({ chart }: { chart: string }) {
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const overlay = useSessionMermaid();
	const incomplete = useIsCodeFenceIncomplete();
	const theme = useResolvedTheme();
	const holderRef = useRef<HTMLDivElement>(null);
	const [capW, setCapW] = useState<number | null>(null);
	useEffect(() => {
		if (!svg || !holderRef.current) return;
		const fs = Number.parseFloat(getComputedStyle(holderRef.current).fontSize);
		if (!Number.isFinite(fs) || fs <= 0) return;
		const { w } = chartSize(svg);
		setCapW((w * fs) / MERMAID_FONT_SIZE);
	}, [svg]);

	useEffect(() => {
		if (incomplete) return;
		let cancelled = false;
		setSvg(null);
		setError(null);
		renderMermaid(chart)
			.then((s) => {
				if (!cancelled) setSvg(s);
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [chart, attempt, incomplete, theme]);

	if (incomplete || (svg === null && error === null)) {
		return (
			<div data-testid="md-mermaid" className="ls-mermaid-wait" aria-busy="true">
				<span className="skel" />
			</div>
		);
	}
	if (error !== null) {
		return <MermaidError chart={chart} error={error} retry={() => setAttempt((a) => a + 1)} />;
	}
	return (
		<div data-testid="md-mermaid" data-streamdown="mermaid" className="group/md relative my-4">
			<div
				ref={holderRef}
				className="mx-auto flex w-full justify-center"
				style={capW === null ? undefined : { maxWidth: `${capW}px` }}
				dangerouslySetInnerHTML={{ __html: svg ?? "" }}
			/>
			<div className="absolute top-0 right-0 flex items-start gap-1">
				<CopyCorner getText={() => chart} label="Copy diagram source" />
				{overlay && (
					<Hint
					label="Open full-screen"
					side="bottom"
				>
<button
						type="button"
						aria-label="Expand diagram"
						data-testid="md-mermaid-expand"
						className="ls-corner opacity-0 focus-visible:opacity-100 group-hover/md:opacity-100"
						onClick={(e) => {
							blurAfterPointerClick(e);
							overlay.openMermaid(chart);
						}}
					>
						<Icon name="expand" size="sm" />
					</button>
				</Hint>
				)}
			</div>
		</div>
	);
}

export function MarkdownCode(props: ComponentProps<"code"> & ExtraProps) {
	const incomplete = useIsCodeFenceIncomplete();
	const { children, className, node, ...rest } = props;

	if (!("data-block" in props)) {
		return (
			<code className={cn("lh-icode", className)} data-streamdown="inline-code" {...rest}>
				{children}
			</code>
		);
	}

	const language = /language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";
	const meta = (node?.properties?.metastring as string | undefined) ?? "";
	const source = codeSource(children);

	if (language === "mermaid") return <MermaidInline chart={source} />;

	const startMatch = /startLine=(\d+)/.exec(meta);
	const startLine = startMatch ? Number.parseInt(startMatch[1]!, 10) : undefined;
	const lineNumbers = !/\bnoLineNumbers\b/.test(meta);
	return (
		<div className="group/md relative" data-testid="md-code">
			<CopyCorner className="absolute top-2 right-2 z-10" getText={() => source} label="Copy code" />
			<CodeBlock
				code={source}
				language={language}
				className={className}
				isIncomplete={incomplete}
				startLine={startLine !== undefined && startLine >= 1 ? startLine : undefined}
				lineNumbers={lineNumbers}
			/>
		</div>
	);
}

const ALERT_MARKER_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

export interface ParsedAlert {
	kind: string;
	children: ReactNode;
}

const significant = (c: ReactNode) => c !== null && c !== undefined && c !== "" && !(typeof c === "string" && c.trim() === "");

/** The element's markdown tag — Streamdown wraps every block in its own
 *  styled component (MarkdownParagraph, …), so the React type is rarely
 *  the raw "p": the hast node carried in props tells the truth. */
function markdownTag(el: React.ReactElement): string | null {
	if (typeof el.type === "string") return el.type;
	const node = (el.props as { node?: { tagName?: string } }).node;
	return node?.tagName ?? null;
}

export function parseAlertMarker(children: ReactNode): ParsedAlert | null {
	const list = Array.isArray(children) ? children : [children];
	const para = list.find(significant);
	if (!isValidElement(para) || markdownTag(para) !== "p") return null;
	const inner = (para.props as { children?: ReactNode }).children;
	const innerList = Array.isArray(inner) ? inner : [inner];
	const lead = innerList.find(significant);
	if (typeof lead !== "string") return null;
	const match = ALERT_MARKER_RE.exec(lead);
	if (!match) return null;
	const kind = match[1]!.toLowerCase();
	const stripped = lead.slice(match[0].length);
	const leadIdxInner = innerList.indexOf(lead);
	const hasFollowing = innerList.some((c, i) => i > leadIdxInner && significant(c));
	let rebuiltPara: ReactNode = null;
	if (stripped.trim() !== "" || hasFollowing) {
		let rest = innerList.map((c) => (c === lead ? (stripped === "" ? null : stripped) : c));
		if (stripped === "") {
			while (rest.length && (rest[0] === null || (isValidElement(rest[0]) && markdownTag(rest[0]) === "br"))) rest = rest.slice(1);
		}
		rebuiltPara = cloneElement(para, {}, ...rest);
	}
	const leadIdx = list.indexOf(para);
	const restChildren = [...list.slice(0, leadIdx), ...(rebuiltPara ? [rebuiltPara] : []), ...list.slice(leadIdx + 1)];
	return { kind, children: restChildren };
}

export function MarkdownBlockquote(props: ComponentProps<"blockquote"> & ExtraProps) {
	const { children, node, ...rest } = props;
	const alert = parseAlertMarker(children);
	if (!alert) {
		// Plain quote — Streamdown's own styling, restored by hand: overriding
		// `blockquote` displaced its styled component (the classes below are
		// its verbatim defaults), and bare <blockquote> rendered unstyled
		// (owner report, 2026-10-07).
		return (
			<blockquote
				{...rest}
				className="my-4 border-l-4 border-muted-foreground/30 pl-4 text-muted-foreground italic"
				data-streamdown="blockquote"
			>
				{children}
			</blockquote>
		);
	}
	return (
		<div
			data-testid="md-callout"
			data-alert-kind={alert.kind}
			className="lh-callout w-fit max-w-full"
		>
			{alert.children}
		</div>
	);
}

export function MarkdownTable(props: ComponentProps<"table"> & ExtraProps) {
	const { children, node, ...rest } = props;
	const ref = useRef<HTMLTableElement>(null);
	return (
		<div className="group/md ls-table" data-testid="md-table">
			<CopyCorner
				className="absolute top-1 right-1 z-10"
				label="Copy table"
				getText={() => (ref.current ? tableDataToMarkdown(extractTableDataFromElement(ref.current)) : "")}
			/>
			<div className="ls-table-x">
				<table
					ref={ref}
					className="w-full border-collapse"
					data-streamdown="table"
					{...rest}
				>
					{children}
				</table>
			</div>
		</div>
	);
}

/** KaTeX display equations are wrapped in a SPAN.katex-display (rehype-katex
 *  renders them as spans with display:block CSS — NOT divs; verified in the
 *  static render). They gain the corner copy (the raw TeX — KaTeX embeds it
 *  in the MathML <annotation>; read from the DOM on click, no re-parse).
 *  Every other span passes through untouched. */
export function MathDisplay(props: ComponentProps<"span"> & ExtraProps) {
	const { children, className, node, ...rest } = props;
	const ref = useRef<HTMLSpanElement>(null);
	if (!className?.includes("katex-display")) {
		return (
			<span className={className} {...rest}>
				{children}
			</span>
		);
	}
	return (
		// BLOCK, not inline: the katex-display child is itself display:block
		// (KaTeX's CSS), and an inline wrapper around a block child gets
		// FRAGMENTED by the anonymous-block rules — the absolutely positioned
		// corner then has no clean containing block and pointer events never
		// land on it (owner report: the math corner neither highlights on hover
		// nor copies; everything else works). display:block gives the corner a
		// real box; z-10 keeps it above the equation spans it overlays.
		<span className="group/md relative block z-0" data-testid="md-math">
			<CopyCorner
				className="absolute top-0 right-0 z-10"
				label="Copy equation source"
				getText={() => ref.current?.querySelector("annotation")?.textContent ?? ""}
			/>
			<span ref={ref} className={className} {...rest}>
				{children}
			</span>
		</span>
	);
}

// Module identity matters: Streamdown is memoized.

/** Bold as the REAL element (appearance fix, 2026-09-23): streamdown's
 *  default `strong` renders `<span class="font-semibold" data-streamdown=
 *  "strong">` — and `.lh-prose :where(strong, b)` matches strong/b
 *  ELEMENTS, so neither the factory ink (#ee928c) nor a settings
 *  boldColor ever landed on bold text (italic worked: streamdown leaves
 *  `em` native). Rendering the semantic element restores screen-reader
 *  emphasis AND lets the designed token rule apply unmodified — color
 *  --lh-ink-strong, weight 700 (beating the old 600 utility). */
export function MarkdownStrong(props: ComponentProps<"strong"> & ExtraProps) {
	const { children, className, node, ...rest } = props;
	return (
		<strong data-streamdown="strong" className={className} {...rest}>
			{children}
		</strong>
	);
}

export const mdComponents = {
	code: MarkdownCode,
	table: MarkdownTable,
	span: MathDisplay,
	strong: MarkdownStrong,
	blockquote: MarkdownBlockquote,
};
