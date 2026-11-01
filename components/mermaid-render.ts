import { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";

/** The chart's base font size (px) — mermaid sizes ALL text relative to
 *  this, so it's the number the display-width cap (md-blocks) divides by:
 *  a chart shown at its natural width renders text at exactly this size.
 *  Pinned explicitly so a mermaid default change can't silently shift the
 *  cap (owner rule, chrome-melt tweaks wave, 2026-09-19: chart text must
 *  never render larger than the session's own text). */
export const MERMAID_FONT_SIZE = 16;

// Diagrams render in mermaid's "base" theme, recoloured to the app's tokens
// (app/globals.css). Mermaid derives tints from these values in JS, so they
// must be literal colors, not var(): each render reads the tokens' CURRENT
// values off <html>, so a chart drawn in dark gets the dark set. A chart
// already on screen keeps the colors it was drawn with.
export function mermaidTheme(): MermaidConfig {
	const css = getComputedStyle(document.documentElement);
	const token = (name: string) => css.getPropertyValue(name).trim();
	const paper = token("--surface");
	const ink = token("--foreground");
	const border = token("--chart-border");
	return {
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
		fontSize: MERMAID_FONT_SIZE,
		securityLevel: "strict",
		theme: "base",
		themeVariables: {
			background: paper,
			primaryColor: paper,
			primaryTextColor: ink,
			primaryBorderColor: border,
			secondaryColor: token("--chart-secondary"),
			tertiaryColor: token("--background"),
			lineColor: token("--graph-edge"),
			textColor: ink,
			mainBkg: paper,
			nodeBorder: border,
			clusterBkg: token("--chart-cluster"),
			clusterBorder: token("--border"),
			edgeLabelBackground: token("--background"),
			noteBkgColor: token("--chart-note"),
			noteBorderColor: token("--chart-note-border"),
			actorBkg: paper,
			actorBorder: border,
			signalColor: token("--muted-foreground"),
			labelBoxBkgColor: paper,
		},
	};
}

const plugin = createMermaidPlugin();

/** Render one chart source to an svg string. The id is unique per call —
 *  mermaid caches rendered ids, and a repeated id across charts/renders
 *  returns the stale svg (the bug streamdown's own id minting avoids). */
export async function renderMermaid(chart: string): Promise<string> {
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await plugin.getMermaid(mermaidTheme()).render(id, chart);
	return svg;
}
