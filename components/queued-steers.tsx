import { Icon } from "@/components/ui/icon";
import { attachmentName, splitAttachments } from "@/src/core";

export interface QueuedSteerLine {
	id: string;
	text: string;
}

export function QueuedSteersBody({ steers }: { steers: QueuedSteerLine[] }) {
	if (steers.length === 0) return null;
	return (
		<div className="ls-queued" data-testid="queued-steers" aria-label="Queued for after this step">
			{steers.map((s) => {
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
