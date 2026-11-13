import { Hint } from "@/components/ui/hint";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function CanvasHint({ children, onDismiss, className }: { children: React.ReactNode; onDismiss?: () => void; className?: string }) {
	return (
		<div className={cn("cv-hint pop", !onDismiss && "pointer-events-none", className)}>
			<Icon name="info" size="sm" className="cv-hint-ic" />
			<span>{children}</span>
			{onDismiss && (
				<button type="button" className="ib sm" aria-label="Dismiss hint" onClick={onDismiss}>
					<Icon name="close" size="xs" />
				</button>
			)}
		</div>
	);
}

export function CanvasZoom({
	pct,
	onZoomOut,
	onZoomIn,
	onFit,
	fitLabel,
	fitTestId,
}: {
	pct: number;
	onZoomOut: () => void;
	onZoomIn: () => void;
	onFit: () => void;
	fitLabel: string;
	fitTestId?: string;
}) {
	return (
		<div className="cv-ctrl pop" role="group" aria-label="Zoom">
			<Hint label="Zoom out" side="top">
				<button type="button" className="ib sm" aria-label="Zoom out" onClick={onZoomOut}>
					<Icon name="minus" size="sm" />
				</button>
			</Hint>
			<span className="cv-zoom mono num" aria-label={`Zoom ${pct}%`}>
				{pct}%
			</span>
			<Hint label="Zoom in" side="top">
				<button type="button" className="ib sm" aria-label="Zoom in" onClick={onZoomIn}>
					<Icon name="plus" size="sm" />
				</button>
			</Hint>
			<span className="cv-sep" aria-hidden="true" />
			<Hint label={fitLabel} side="top">
				<button type="button" className="ib sm" aria-label={fitLabel} onClick={onFit} data-testid={fitTestId}>
					<Icon name="fit" size="sm" />
				</button>
			</Hint>
		</div>
	);
}
