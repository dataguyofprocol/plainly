"use client";

import type { CompactionDetails } from "@/src/core";
import { Icon } from "@/components/ui/icon";

/** What one divider carries: the marker's full model-facing content (the
 *  [SESSION HISTORY COMPACTED] header + the summary) and its details.
 *  The content is deliberately UNRENDERED (owner, release polish
 *  2026-10-06): the compaction summary is model-facing plumbing — anyone
 *  who wants to inspect it reads their provider logs. The dividers mark
 *  WHERE the cut landed and how big it was; nothing opens. */
export interface CompactionDividerData {
	content: string;
	details: CompactionDetails;
}

/** The moment divider (owner round 14): a quiet centered note where the
 *  learner currently is — no rule; the cut divider below carries the
 *  seam. Inert — plain text, no affordance. */
export function CompactionMomentDivider({ data: _data }: { data: CompactionDividerData }) {
	return (
		<div className="ls-sys">
			<span data-testid="compaction-divider" className="ls-divider-note">
				<Icon name="history" size="xs" />
				Context compacted
			</span>
		</div>
	);
}

/** The cut divider (owner round 14): the hairline seam where verbatim
 *  history ends and the kept recent tail begins — the phase divider's
 *  geometry, so it reads as a transcript boundary, not a message. Inert;
 *  the token count stays, the summary lives only in provider logs. */
export function CompactionCutDivider({ data }: { data: CompactionDividerData }) {
	const kTok = data.details.tokensBefore > 0 ? ` · ${Math.round(data.details.tokensBefore / 1000)}k tokens` : "";
	return (
		<div data-testid="compaction-cut-divider" className="ls-divider">
			<i aria-hidden />
			<span>
				<Icon name="history" size="xs" />
				History compacted{kTok}
			</span>
			<i aria-hidden />
		</div>
	);
}
