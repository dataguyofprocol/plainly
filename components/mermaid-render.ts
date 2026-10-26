/**
 * The app's ONE mermaid renderer (the chrome-melt wave, 2026-09-19): both the
 * in-chat block (components/md-blocks.tsx) and the session-scoped focus
 * overlay (components/session-overlay.tsx) render charts through this module
 * — one light-theme config, one plugin instance, unique render ids. This
 * REPLACES streamdown's internal mermaid path entirely: its fullscreen portal
 * was hard-wired `fixed inset-0` (covering the window-drag bar, X landing in
 * drag territory) with no styling hook, which is what drove the custom
 * component in the first place.
 */

import { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";

/** The chart's base font size (px) — mermaid sizes ALL text relative to
 *  this, so it's the number the display-width cap (md-blocks) divides by:
 *  a chart shown at its natural width renders text at exactly this size.
 *  Pinned explicitly so a mermaid default change can't silently shift the
 *  cap (owner rule, chrome-melt tweaks wave, 2026-09-19: chart text must
 *  never render larger than the session's own text). */
export const MERMAID_FONT_SIZE = 16;

// v4 is light: diagrams render in mermaid's "base" theme, recoloured to the
// app's tokens (app/globals.css). Mermaid derives tints from these values in
// JS, so they are literals, not var() — keep them in step with the tokens.
export const mermaidTheme: MermaidConfig = {
	fontFamily: "ui-sans-serif, system-ui, sans-serif",
	fontSize: MERMAID_FONT_SIZE,
	securityLevel: "strict",
	theme: "base",
	themeVariables: {
		background: "#ffffff",
		primaryColor: "#ffffff",
		primaryTextColor: "#191c1a",
		primaryBorderColor: "#c9ccc7",
		secondaryColor: "#eef5f3",
		tertiaryColor: "#f4f5f2",
		lineColor: "#a3a8a3",
		textColor: "#191c1a",
		mainBkg: "#ffffff",
		nodeBorder: "#c9ccc7",
		clusterBkg: "#f7f8f6",
		clusterBorder: "#dcded9",
		edgeLabelBackground: "#f4f5f2",
		noteBkgColor: "#fbf3e6",
		noteBorderColor: "#e6cfa8",
		actorBkg: "#ffffff",
		actorBorder: "#c9ccc7",
		signalColor: "#565c57",
		labelBoxBkgColor: "#ffffff",
	},
};

const plugin = createMermaidPlugin();

/** Render one chart source to an svg string. The id is unique per call —
 *  mermaid caches rendered ids, and a repeated id across charts/renders
 *  returns the stale svg (the bug streamdown's own id minting avoids). */
export async function renderMermaid(chart: string): Promise<string> {
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await plugin.getMermaid(mermaidTheme).render(id, chart);
	return svg;
}
