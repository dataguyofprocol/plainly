import { Icon } from "@/components/ui/icon";
import { attachmentName, splitAttachments } from "@/src/core";

/**
 * THE QUEUED-STEER INDICATOR (owner spec 2026-10-03; chips in the
 * finesse pass 2026-10-26): steers sent but not yet drained render as
 * small right-aligned chips ABOVE the composer — a clock glyph and the
 * text, truncated with an ellipsis. Visible but quiet.
 *
 * A line dies the moment its card lands in the transcript: the drain's
 * verbatim message events upsert the real user card by the client-minted
 * id, and visibleQueuedSteers (session-core, pure) filters the queue
 * against the message ids. A steer parked server-side (stranded behind a
 * question) keeps its line — an honest "waiting for the next run".
 */
export interface QueuedSteerLine {
	id: string;
	text: string;
}

/** The pure body (SSR-pinnable): one right-aligned truncated chip per
 *  queued steer, stacked. */
export function QueuedSteersBody({ steers }: { steers: QueuedSteerLine[] }) {
	if (steers.length === 0) return null;
	return (
		<div className="ls-queued" data-testid="queued-steers" aria-label="Queued for after this step">
			{steers.map((s) => {
				// Attached files show by name, not as raw marker lines.
				const { text, paths } = splitAttachments(s.text);
				const shown = [text, ...paths.map(attachmentName)].filter(Boolean).join(" · ");
				return (
					<span key={s.id} title={shown}>
						<Icon name="time" size="xs" />
						<em>{shown}</em>
					</span>
				);
			})}
		</div>
	);
}
