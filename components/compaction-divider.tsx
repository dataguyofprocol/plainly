"use client";

import type { CompactionDetails } from "@/src/core";
import { Icon } from "@/components/ui/icon";

export interface CompactionDividerData {
	content: string;
	details: CompactionDetails;
}

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
