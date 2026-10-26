"use client";

import { useContext } from "react";
import { JobsContext } from "@/components/jobs-context";
import { ChatActionsContext } from "@/components/chat";
import { isModelsRefusal, isProviderKeyRefusal, type JobKind, type JobRecord } from "@/src/core";
import { BrailleSpinner } from "@/components/braille-spinner";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { IconName } from "@/components/ui/icon";
import { ToolRow } from "@/components/artifacts/tool-call-card";

/**
 * The dispatch card (contracts.ts "THE ASYNC PROTOCOL" §4): the tool-call
 * box for a background sub-agent. The tool part's output is the FIRE-AND-
 * FORGET ACK (a string) — never the result. Live status comes from the
 * chat-view jobs feed via JobsContext, matched by toolCallId:
 *
 *   job unknown → "dispatched" pulse (the jobs feed hasn't seen it yet)
 *   running     → live activity card (activity line + elapsed)
 *   done/error  → quiet one-liner ("delivered" / "failed") — the artifact
 *                 itself arrives in the steer message right below, so the
 *                 box must not duplicate it.
 */
const KIND_LABEL: Record<JobKind, string> = {
	research: "Research agent",
	demo: "Demo agent",
	visual: "Figure agent",
	pdf: "PDF reader",
};

/** Each job kind's glyph — shared with the steer card's delivery rows. */
export const KIND_ICON: Record<JobKind, IconName> = {
	research: "research",
	demo: "demo",
	visual: "figure",
	pdf: "pdf",
};

/** A job kind's learner-facing name ("Figure agent"); unknown kinds keep
 *  their own word. */
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
	// BYOK (owner, 2026-09-22): a job refused for missing models is INFO,
	// not scary-error — gray glyph + "needs model setup" + the deep-link
	// into the SetupDialog (the same flow the send interception uses).
	// The provider-key refusal twin (zero-keys wave): a pinned model
	// whose key is gone reads as the key being needed — the deep-link
	// lands on the SetupDialog's first-key stage on its own.
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

/** The refused card: quiet info tone — nothing red, nothing "failed". */
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

/** A job in flight: the live row — spinner, the agent's name, its latest
 *  activity in mono, and the elapsed seconds. */
function DispatchActivityCard({ job, label, icon }: { job: JobRecord | null; label: string; icon: IconName }) {
	// Elapsed from createdAt — jobs appear here only via the jobs feed (post-mount),
	// so no SSR/hydration mismatch.
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
