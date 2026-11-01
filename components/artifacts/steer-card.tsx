"use client";

import type { PdfResult, ResearchResult, SubagentArtifactData } from "@/src/core";
import type { LhViewMessage } from "@/src/core";
import { isSubagentFailure } from "@/src/core";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { PdfBriefCard, ResearchBriefCard } from "@/components/artifacts/job-card";
import { VisualOutputCard } from "@/components/artifacts/visual-card";
import { ToolRow } from "@/components/artifacts/tool-call-card";
import { KIND_ICON, jobLabel } from "@/components/artifacts/dispatch-card";
import { Icon } from "@/components/ui/icon";

export function SubagentSteerCard({ message }: { message: LhViewMessage }) {
	const artifactPart = message.parts.find((p) => p.type === "data-subagent-artifact");
	const data = artifactPart?.data as SubagentArtifactData | undefined;
	if (!data) {
		const aborted = message.parts.find((p) => p.type === "data-subagent-aborted") as
			| { data?: { kind?: string } }
			| undefined;
		if (aborted?.data) return <AbortedBadge kind={aborted.data.kind ?? "job"} />;
		return (
			<div className="ls-card">
				<div className="ls-card-b">A helper finished, but its result could not be displayed.</div>
			</div>
		);
	}
	switch (data.kind) {
		case "research":
			return isSubagentFailure("research", data.result as ResearchResult) ? (
				<ResearchBriefCard output={data.result} />
			) : (
				<ResearchCompleteBadge result={data.result as ResearchResult} />
			);
		case "pdf":
			return isSubagentFailure("pdf", data.result as PdfResult) ? (
				<PdfBriefCard output={data.result} />
			) : (
				<PdfCompleteBadge result={data.result as PdfResult} />
			);
		case "demo":
			return <DemoOutputCard output={data.result} messageId={message.id} initialInverted={data.ui?.inverted ?? false} />;
		case "visual":
			return <VisualOutputCard output={data.result} messageId={message.id} initialInverted={data.ui?.inverted ?? false} />;
	}
}

function AbortedBadge({ kind }: { kind: string }) {
	return (
		<div data-testid="job-aborted-badge" data-kind={kind} className="ls-tool">
			<ToolRow
				as="div"
				icon={KIND_ICON[kind as keyof typeof KIND_ICON] ?? "agent"}
				label={jobLabel(kind)}
				note="stopped by you"
				status="info"
				expandable={false}
				trailing={<Icon name="status-paused" size="sm" className="ls-kind" />}
			/>
		</div>
	);
}

function PdfCompleteBadge({ result }: { result: PdfResult }) {
	const readPages = result.pagesRead ?? result.pagesConsulted;
	return (
		<details data-testid="pdf-complete-badge" className="ls-tool">
			<ToolRow
				icon="pdf"
				label="PDF"
				note={`reading complete${readPages.length > 0 ? ` · read ${readPages.length} page${readPages.length === 1 ? "" : "s"}` : ""}`}
				status="done"
			/>
			<div className="ls-tool-body">
				<PdfBriefCard output={result} />
			</div>
		</details>
	);
}

function ResearchCompleteBadge({ result }: { result: ResearchResult }) {
	return (
		<details data-testid="research-complete-badge" className="ls-tool">
			<ToolRow
				icon="research"
				label="Research"
				note={`complete${result.sources.length > 0 ? ` · ${result.sources.length} sources` : ""}`}
				status="done"
			/>
			<div className="ls-tool-body">
				<ResearchBriefCard output={result} />
			</div>
		</details>
	);
}
