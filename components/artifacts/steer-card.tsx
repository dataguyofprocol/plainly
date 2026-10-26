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

/**
 * The sub-agent result delivery card (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * When a background job completes, the wake pipeline injects a STEER message
 * into the transcript: a user-role UIMessage whose data part
 * ("data-subagent-artifact") carries the result. It renders as an artifact —
 * NEVER a learner bubble, never wrapped in a message container:
 *
 *   research — a quiet "Research complete" one-liner that expands on demand
 *     (native <details>) to the full persisted brief + sources: the brief is
 *     too long to inline by default and the teacher's wake turn weaves it
 *     into the lesson anyway. Failures keep the failure card (the brief
 *     explains what went wrong).
 *   demo / visual — the artifact itself (sandboxed iframe / sanitized SVG).
 *     The sub-agent's verification notes are model-facing glue and do NOT
 *     render; only a failure note does.
 */
export function SubagentSteerCard({ message }: { message: LhViewMessage }) {
	const artifactPart = message.parts.find((p) => p.type === "data-subagent-artifact");
	const data = artifactPart?.data as SubagentArtifactData | undefined;
	// The abort steer (2026-09 dock semantics): its message-type part is
	// data-subagent-aborted (the custom-message scheme — the part, not
	// metadata, is the marker) — a quiet chip, mirroring the complete-badge.
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

/** The aborted-job row: the teacher's wake turn acknowledges the abort in
 * the lesson itself — this just marks what happened. */
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

/** The PDF delivery row: the brief is too long to inline and the
 * teacher's wake turn weaves it in; the row marks delivery, the collapsed
 * details carries the full text + read pages. */
function PdfCompleteBadge({ result }: { result: PdfResult }) {
	// The honest count is READ pages (extract/render — sources v1 split);
	// the ?? is runtime tolerance for pre-split persisted steers.
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

/** The research delivery row: the lesson lives in the teacher's wake
 * turn; the row marks delivery. The persisted brief rides along in a
 * collapsed <details> — full markdown + sources, one click away, no extra
 * fetch (the artifact part in the record is the single source of truth). */
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
