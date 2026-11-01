"use client";

import { Icon, type IconName } from "@/components/ui/icon";
import { toolHeadline, type ToolIcon } from "@/components/artifacts/tool-headline";
import type { ArtifactPartProps } from "@/src/core";

interface ToolCallPart {
	type: string;
	state: string;
	toolCallId: string;
	input?: unknown;
	output?: unknown;
	errorText?: string;
}

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

export const TOOL_ICON: Record<ToolIcon, IconName> = {
	sessions: "history",
	ideas: "path",
	file: "file",
	folder: "import",
	search: "search",
};

export function ToolRow({
	icon,
	label,
	detail,
	note,
	status,
	expandable = true,
	leading,
	trailing,
	as = "summary",
	testId,
}: {
	icon: IconName;
	label: React.ReactNode;
	detail?: string | null;
	note?: React.ReactNode;
	status: "running" | "done" | "failed" | "info";
	expandable?: boolean;
	leading?: React.ReactNode;
	trailing?: React.ReactNode;
	as?: "summary" | "div";
	testId?: string;
}) {
	const Tag = as;
	return (
		<Tag className={`ls-row${status === "failed" ? " failed" : ""}`} data-testid={testId}>
			{leading ?? <Icon name={icon} size="sm" className="ls-kind" />}
			<span className="ls-label">{label}</span>
			{detail && <span className="ls-arg" title={detail}>{detail}</span>}
			{note && <span className="ls-note">{note}</span>}
			{status === "done" && <Icon name="status-ok" size="sm" className="text-good" label="Done" />}
			{status === "failed" && <Icon name="status-error" size="sm" className="text-danger" label="Failed" />}
			{trailing}
			{expandable && <Icon name="chevron-right" size="xs" className="ls-chev" />}
		</Tag>
	);
}

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
	return <ToolRow icon={TOOL_ICON[icon]} label={label} detail={detail} status={status} />;
}

export function ToolCallCard({ part }: ArtifactPartProps) {
	const p = part as ToolCallPart;
	const tool = p.type.replace(/^tool-/, "");
	const head = toolHeadline(tool, p.input);
	const out = outputText(p.output);
	const failed = p.state === "output-error" || typeof p.errorText === "string";
	return (
		<details data-testid="tool-call-card" data-tool={tool} className="ls-tool">
			<ToolChip icon={head.icon} label={failed ? `${head.label} — failed` : head.label} detail={head.detail} status={failed ? "failed" : p.state === "output-available" ? "done" : "running"} />
			<div className="ls-tool-body">
				{p.input != null && (
					<div>
						<span className="over">
							Input · <span className="mono">{tool}</span>
						</span>
						<pre className="short">{JSON.stringify(p.input, null, 2)}</pre>
					</div>
				)}
				{typeof p.errorText === "string" ? (
					<div>
						<span className="over">Error</span>
						<pre className="err">{p.errorText}</pre>
					</div>
				) : out != null ? (
					<div>
						<span className="over">Output</span>
						<pre>{out}</pre>
					</div>
				) : (
					p.state !== "output-available" && <span className="faint">Running…</span>
				)}
			</div>
		</details>
	);
}
