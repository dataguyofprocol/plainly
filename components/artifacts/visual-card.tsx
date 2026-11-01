"use client";

import { useContext, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import { Icon } from "@/components/ui/icon";
import { Hint } from "@/components/ui/hint";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { Toggle } from "@/components/settings/controls";
import { useSessionMermaid } from "@/components/session-overlay";
import { downloadFile } from "@/components/artifacts/download";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import type { ArtifactPartProps, VisualResult } from "@/src/core";

/**
 * Cheap SVG hygiene, NOT a full sanitizer: it strips only the obvious exec
 * vectors (<script>, on* handlers, javascript:/data:text/html hrefs). The
 * output still goes into dangerouslySetInnerHTML, which is acceptable only
 * because the SVG is model-authored for the learner's own machine. Do not
 * reuse this for untrusted input.
 */
export function sanitizeSvg(svg: string): string {
	return svg
		.replace(/<script[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<script[^>]*\/?>/gi, "")
		.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/(href|xlink:href)\s*=\s*(?:"\s*(?:javascript|data:text\/html)[^"]*"|'\s*(?:javascript|data:text\/html)[^']*'|(?:javascript|data:text\/html)[^\s>]*)/gi, "");
}

export function svgNaturalWidth(svg: string): number | null {
	const m = /<svg\b[^>]*?\bwidth\s*=\s*["']([^"']+)["'][^>]*>/i.exec(svg);
	if (!m) return null;
	const value = m[1]!.trim();
	const px = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value);
	if (!px) return null;
	const n = Number.parseFloat(px[1]!);
	return Number.isFinite(n) && n > 0 ? n : null;
}

export function VisualCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="visual" />;
}

export function VisualOutputCard({
	output,
	messageId,
	initialInverted = false,
}: {
	output: unknown;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const result = output as VisualResult | undefined;
	const overlay = useSessionMermaid();
	const actions = useContext(ChatActionsContext);
	const [inverted, setInverted] = useState(initialInverted);
	const toggleInverted = (next: boolean) => {
		setInverted(next);
		if (!actions?.chatId || !messageId) return;
		void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	};
	const natural = result && typeof result.svg === "string" ? svgNaturalWidth(result.svg) : null;
	if (!result || typeof result.svg !== "string") {
		return (
			<div className="ls-card">
				<div className="ls-card-b">The figure was drawn, but it could not be displayed.</div>
			</div>
		);
	}
	const failed = result.svg.length === 0;
	if (failed) {
		return (
			<div className="ls-card" data-testid="visual-card-failed">
				<div className="ls-card-h">
					<Icon name="figure" size="sm" />
					<span className="ls-card-t">Figure</span>
					<span className="pill danger">failed</span>
				</div>
				<p className="ls-card-b">{result.notes ?? "The figure could not be drawn."}</p>
			</div>
		);
	}
	return (
		<div className={natural !== null ? "ls-figure hug w-fit" : "ls-figure"} data-testid="visual-card">
			<div
				className={
					natural !== null
						? "ls-figure-img w-fit max-w-full [&_svg]:h-auto [&_svg]:max-w-full"
						: "ls-figure-img w-full [&_svg]:h-auto [&_svg]:w-full"
				}
				style={{ filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }}
				dangerouslySetInnerHTML={{ __html: sanitizeSvg(result.svg) }}
				data-testid="visual-svg"
			/>
			<div className="ls-figure-cap">
				<Icon name="figure" size="xs" />
				<span>Figure</span>
				<span className="ls-card-x">
					<Toggle
						checked={inverted}
						onChange={toggleInverted}
						label="Invert figure brightness"
						title="Invert colors"
						discIcon={<InvertDiscIcon className="size-3" />}
					/>
					<Hint label="Download as SVG" side="bottom">
						<button
							type="button"
							aria-label="Download figure as SVG"
							onClick={() => downloadFile("figure.svg", result.svg, "image/svg+xml")}
							data-testid="visual-download"
							className="ib sm"
						>
							<Icon name="download" size="sm" />
						</button>
					</Hint>
					{overlay && (
						<Hint label="Open full-screen" side="bottom">
							<button
								type="button"
								aria-label="Open figure fullscreen"
								onClick={() => overlay.openFigure(result.svg, inverted)}
								data-testid="visual-open"
								className="ib sm"
							>
								<Icon name="expand" size="sm" />
							</button>
						</Hint>
					)}
				</span>
			</div>
		</div>
	);
}
