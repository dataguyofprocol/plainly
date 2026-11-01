"use client";

import { useContext } from "react";
import { JobsContext } from "@/components/jobs-context";
import { ChatActionsContext } from "@/components/chat";
import { isModelsRefusal, isProviderKeyRefusal, type JobKind, type JobRecord } from "@/src/core";
import { BrailleSpinner } from "@/components/braille-spinner";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { IconName } from "@/components/ui/icon";
import { ToolRow } from "@/components/artifacts/tool-call-card";

const KIND_LABEL: Record<JobKind, string> = {
	research: "Research agent",
	demo: "Demo agent",
	visual: "Figure agent",
	pdf: "PDF reader",
};

export const KIND_ICON: Record<JobKind, IconName> = {
	research: "research",
	demo: "demo",
	visual: "figure",
	pdf: "pdf",
};

export function jobLabel(kind: string): string {
	return KIND_LABEL[kind as JobKind] ?? kind;
}

export function DispatchCard({ toolCallId, kind }: { toolCallId: string; kind: JobKind }) {
	const jobs = useContext(JobsContext);
	const job = jobs.find((j) => j.toolCallId === toolCallId) ?? null;
	const label = KIND_LABEL[kind];

	if (!job || job.status === "running") {
		return <DispatchActivityCard job={job} label={label} icon={KIND_ICON[kind]} />;
	}
	if (isModelsRefusal(job.error)) {
		return <DispatchRefusedCard label={label} icon={KIND_ICON[kind]} line="needs model setup" button="Set up models" />;
	}
	if (isProviderKeyRefusal(job.error)) {
		return <DispatchRefusedCard label={label} icon={KIND_ICON[kind]} line="needs a provider key" button="Add a key" />;
	}
	const failed = job.status === "error";
	return (
		<div className="ls-tool">
			<ToolRow
				as="div"
				testId="dispatch-settled"
				icon={KIND_ICON[kind]}
				label={label}
				note={failed ? "failed" : "delivered"}
				status={failed ? "failed" : "done"}
				expandable={false}
			/>
		</div>
	);
}

function DispatchRefusedCard({ label, icon, line, button }: { label: string; icon: IconName; line: string; button: string }) {
	const ctx = useContext(ChatActionsContext);
	return (
		<div className="ls-tool">
			<ToolRow
				as="div"
				testId="dispatch-refused"
				icon={icon}
				label={label}
				note={line}
				status="info"
				expandable={false}
				trailing={
					ctx && (
						<button type="button" data-testid="dispatch-setup-link" onClick={ctx.openSetup} className="ls-mini">
							{button}
						</button>
					)
				}
			/>
		</div>
	);
}

function DispatchActivityCard({ job, label, icon }: { job: JobRecord | null; label: string; icon: IconName }) {
	const elapsed =
		job && job.createdAt ? Math.max(0, Math.round((Date.now() - Date.parse(job.createdAt)) / 1000)) : null;
	return (
		<div className="ls-tool" data-testid="dispatch-card">
			<ToolRow
				as="div"
				icon={icon}
				status="running"
				expandable={false}
				leading={<BrailleSpinner label={`${label} running`} />}
				label={<Shimmer duration={1} as="span">{label}</Shimmer>}
				note={
					job?.activity ? (
						<span className="mono" data-testid="dispatch-activity-line">{job.activity}</span>
					) : !job ? (
						<span data-testid="dispatch-pending">Dispatched…</span>
					) : null
				}
				trailing={elapsed !== null && <span className="ls-time">{elapsed}s</span>}
			/>
		</div>
	);
}
