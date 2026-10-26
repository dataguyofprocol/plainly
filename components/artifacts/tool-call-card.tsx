"use client";

import { Check, ChevronRight, FileText, FolderOpen, History, Search, Waypoints } from "lucide-react";
import { toolHeadline, type ToolIcon } from "@/components/artifacts/tool-headline";
import type { ArtifactPartProps } from "@/src/core";

/**
 * The generic tool-call card (sources v1, 2026-09-19; v4 chip 2026-10-26):
 * a quiet, collapsed chip per synchronous tool call — what it did, in
 * plain words (tool-headline.ts), plus its subject — expandable to the
 * tool's name and the full input and output. The user's spec:
 * "at least the tool name; for read, the file name; everything collapsed
 * by default; not distracting — background stuff." Unregistered tools
 * still render nothing (chat.tsx's registry default); this card is only
 * for the learner-filesystem set (read/ls/find/grep) where the call IS
 * worth a trace in the transcript.
 */

interface ToolCallPart {
	type: string;
	state: string;
	toolCallId: string;
	input?: unknown;
	output?: unknown;
	errorText?: string;
}

/** Render a tool result body: plain strings verbatim, image-bearing read
 *  results show their text + an attachment note (the image itself is the
 *  model's — the learner sees only that it happened). */
function outputText(output: unknown): string | null {
	if (output == null) return null;
	if (typeof output === "string") return output;
	if (typeof output === "object" && "text" in (output as Record<string, unknown>)) {
		const o = output as { text?: unknown; images?: unknown[] };
		const text = typeof o.text === "string" ? o.text : null;
		const n = Array.isArray(o.images) ? o.images.length : 0;
		return n > 0 ? `${text ?? ""}\n[${n} image${n > 1 ? "s" : ""} attached to the model]`.trim() : text;
	}
	try {
		return JSON.stringify(output, null, 2);
	} catch {
		return String(output);
	}
}

const ICONS: Record<ToolIcon, typeof FileText> = {
	sessions: History,
	ideas: Waypoints,
	file: FileText,
	folder: FolderOpen,
	search: Search,
};

/** The chip's shell — shared with the live card so a call reads the same
 *  while it runs and once it settles. */
export function ToolChip({
	icon,
	label,
	detail,
	status,
}: {
	icon: ToolIcon;
	label: React.ReactNode;
	detail: string | null;
	status: "running" | "done" | "failed";
}) {
	const Icon = ICONS[icon];
	return (
		<summary
			className="inline-flex max-w-full cursor-pointer list-none items-center gap-2 rounded-lg border border-border bg-card/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-card hover:text-foreground [&::-webkit-details-marker]:hidden"
		>
			<Icon className={`size-3.5 shrink-0 ${status === "failed" ? "text-danger" : "text-brand"}`} aria-hidden />
			<span className={`shrink-0 font-medium ${status === "failed" ? "text-danger" : "text-foreground/80"}`}>{label}</span>
			{detail && <span className="min-w-0 truncate font-mono text-[11px]">{detail}</span>}
			{status === "done" && <Check className="size-3 shrink-0 text-good" aria-label="Done" />}
			<ChevronRight className="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" aria-hidden />
		</summary>
	);
}

export function ToolCallCard({ part }: ArtifactPartProps) {
	const p = part as ToolCallPart;
	const tool = p.type.replace(/^tool-/, "");
	const head = toolHeadline(tool, p.input);
	const out = outputText(p.output);
	const failed = p.state === "output-error" || typeof p.errorText === "string";
	return (
		<details data-testid="tool-call-card" data-tool={tool} className="group my-0.5 w-full max-w-2xl select-none">
			<ToolChip icon={head.icon} label={failed ? `${head.label} — failed` : head.label} detail={head.detail} status={failed ? "failed" : p.state === "output-available" ? "done" : "running"} />
			<div className="mt-1.5 space-y-2 rounded-xl border bg-card p-3 text-xs">
				<div className="text-[11px] text-muted-foreground">
					Tool <span className="font-mono">{tool}</span>
				</div>
				{p.input != null && (
					<div>
						<div className="mb-1 font-medium text-muted-foreground">Input</div>
						<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
							{JSON.stringify(p.input, null, 2)}
						</pre>
					</div>
				)}
				{typeof p.errorText === "string" ? (
					<div>
						<div className="mb-1 font-medium text-muted-foreground">Error</div>
						<pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-danger">{p.errorText}</pre>
					</div>
				) : out != null ? (
					<div>
						<div className="mb-1 font-medium text-muted-foreground">Output</div>
						<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">{out}</pre>
					</div>
				) : (
					p.state !== "output-available" && <div className="text-muted-foreground italic">running…</div>
				)}
			</div>
		</details>
	);
}
