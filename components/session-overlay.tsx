"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "@/components/pan-zoom";
import { renderMermaid } from "@/components/mermaid-render";
import { useResolvedTheme } from "@/components/theme";
import { MermaidError } from "@/components/mermaid-error";
import { Hint } from "@/components/ui/hint";
import { Icon } from "@/components/ui/icon";

export const SessionMermaidContext = createContext<{
	openMermaid: (chart: string) => void;
	openFigure: (svg: string, inverted: boolean) => void;
} | null>(null);

export function useSessionMermaid() {
	return useContext(SessionMermaidContext);
}

export function chartSize(svg: string): { w: number; h: number } {
	const m = /<svg[^>]*\bviewBox="([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)"/.exec(svg);
	if (m) {
		const w = Number.parseFloat(m[3]!);
		const h = Number.parseFloat(m[4]!);
		if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
	}
	const attr = (name: string): number | null => {
		const a = new RegExp(`<svg\\b[^>]*?\\b${name}\\s*=\\s*["'](\\d+(?:\\.\d+)?)(?:px)?["']`, "i").exec(svg);
		if (!a) return null;
		const n = Number.parseFloat(a[1]!);
		return Number.isFinite(n) && n > 0 ? n : null;
	};
	const w = attr("width");
	const h = attr("height");
	if (w !== null && h !== null) return { w, h };
	return { w: 600, h: 400 };
}

export function MermaidOverlay({
	chart,
	svg: rawSvg,
	inverted = false,
	onClose,
}: {
	chart?: string;
	svg?: string;
	inverted?: boolean;
	onClose: () => void;
}) {
	const [svg, setSvg] = useState<string | null>(rawSvg ?? null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const theme = useResolvedTheme();
	useEffect(() => {
		if (rawSvg !== undefined) {
			setSvg(rawSvg);
			setError(null);
			return;
		}
		if (chart === undefined) return;
		let cancelled = false;
		setSvg(null);
		setError(null);
		renderMermaid(chart)
			.then((s) => {
				if (!cancelled) setSvg(s);
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [rawSvg, chart, attempt, theme]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const viewportRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });
	useEffect(() => {
		const el = viewportRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const box = useMemo(() => (svg ? chartSize(svg) : { w: 0, h: 0 }), [svg]);
	const fitZoom = useMemo(() => fitZoomFor(box, size), [box, size]);

	const [view, setView] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
	const userAdjustedRef = useRef(false);
	const atFloor = view.zoom <= fitZoom + 1e-9;
	const [settled, setSettled] = useState(false);
	const [panning, setPanning] = useState(false);

	useEffect(() => {
		if (atFloor) userAdjustedRef.current = false;
	}, [atFloor]);
	useEffect(() => {
		if (userAdjustedRef.current || !size.w || !size.h || !svg) return;
		setView(fitGraphView(box, size, fitZoom));
		const raf = requestAnimationFrame(() => setSettled(true));
		return () => cancelAnimationFrame(raf);
	}, [fitZoom, size, box, svg]);

	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
			const factor = Math.exp(-dy * 0.0015);
			const rect = el.getBoundingClientRect();
			setView((v) =>
				zoomedGraphView(v, factor, fitZoom, { x: e.clientX - rect.left, y: e.clientY - rect.top }, box, size),
			);
			userAdjustedRef.current = true;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [fitZoom, box, size]);

	const dragRef = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
	const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest("button")) return;
		if (atFloor) return;
		dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, moved: false };
		setPanning(true);
		e.currentTarget.classList.add("cursor-grabbing");
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		if (!d) return;
		d.moved = true;
		setView((v) =>
			v.zoom <= fitZoom + 1e-9 ? v : { ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) },
		);
	};
	const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		if (d) {
			dragRef.current = null;
			if (d.moved) userAdjustedRef.current = true;
		}
		setPanning(false);
		e.currentTarget.classList.remove("cursor-grabbing");
	};
	const stepZoom = (factor: number) => {
		userAdjustedRef.current = true;
		setView((v) => zoomedGraphView(v, factor, fitZoom, { x: size.w / 2, y: size.h / 2 }, box, size));
	};
	const fitView = () => {
		userAdjustedRef.current = false;
		if (!size.w || !size.h) return;
		setView(fitGraphView(box, size, fitZoom));
	};

	return (
		<div
			data-testid="mermaid-overlay"
			className="absolute inset-0 z-40 flex flex-col bg-background/80 px-4 pt-3 pb-4 backdrop-blur-md"
			role="dialog"
			aria-modal="true"
			aria-label="Diagram focus"
		>
			<div className="mb-3 flex items-center gap-2">
				<span className="text-sm font-semibold">Diagram</span>
				<span className="text-xs text-faint">from this lesson</span>
				<Hint label="Close" binding="escape" side="left">
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						data-testid="mermaid-overlay-close"
						className="ml-auto flex size-[30px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground active:scale-95"
					>
						<Icon name="close" size="md" />
					</button>
				</Hint>
			</div>
			<div
				ref={viewportRef}
				className={cn(
					"relative min-h-0 flex-1 touch-none overflow-hidden rounded-2xl bg-surface shadow-[inset_0_0_0_1px_var(--line),var(--e1)] select-none",
					atFloor ? "cursor-default" : "cursor-grab",
				)}
				onPointerDown={startDrag}
				onPointerMove={moveDrag}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
			>
				{error ? (
					<div className="flex h-full items-center justify-center p-4">
						<MermaidError chart={chart ?? ""} error={error} retry={() => setAttempt((a) => a + 1)} />
					</div>
				) : svg ? (
					<>
						<div
							className="absolute top-0 left-0 origin-top-left"
							style={{
								width: `${box.w}px`,
								transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
								opacity: settled ? 1 : 0,
								transition:
									panning || !settled
										? "none"
										: "transform 180ms ease-out, opacity 160ms ease-out",
							}}
						>
							<div
								data-lh-overlay-chart
								className={cn(
									"[&_svg]:h-auto [&_svg]:w-full",
									rawSvg !== undefined && "bg-[var(--figure-paper)]",
								)}
								style={rawSvg !== undefined && inverted ? { filter: "invert(1) hue-rotate(180deg)" } : undefined}
								dangerouslySetInnerHTML={{ __html: svg }}
							/>
						</div>
						<div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-2">
							<span className="text-xs text-faint">Drag to pan · scroll to zoom</span>
							<div className="pointer-events-auto flex gap-0.5 rounded-[10px] bg-surface/90 p-0.5 shadow-[inset_0_0_0_1px_var(--line-strong),var(--e2)] backdrop-blur">
								<Hint label="Zoom out" side="bottom">
<button
									type="button"
									aria-label="Zoom out"
									onClick={() => stepZoom(1 / 1.25)}
									className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground active:scale-95"
								>
									<Icon name="minus" size="sm" />
								</button>
</Hint>
								<Hint label="Fit diagram to view" side="bottom">
<button
									type="button"
									aria-label="Fit diagram to view"
									onClick={fitView}
									className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground active:scale-95"
								>
									<Icon name="expand" size="sm" />
								</button>
</Hint>
								<Hint label="Zoom in" side="bottom">
<button
									type="button"
									aria-label="Zoom in"
									onClick={() => stepZoom(1.25)}
									className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground active:scale-95"
								>
									<Icon name="plus" size="sm" />
								</button>
</Hint>
							</div>
						</div>
					</>
				) : (
					<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
						<Icon name="loading" size="md" className="animate-spin text-faint" />
						Drawing the diagram…
					</div>
				)}
			</div>
		</div>
	);
}
