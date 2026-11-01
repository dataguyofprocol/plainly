"use client";

import { useCallback, useDeferredValue, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NotesImportErrors, useNotesImport } from "@/components/notes-import.tsx";
import Link from "next/link";
import { FileTextIcon, ListTreeIcon, Loader2Icon, SearchIcon, SettingsIcon, UploadIcon, WaypointsIcon } from "lucide-react";
import { incrementalLayout, propositionSessionHref, type GraphChain, type GraphCostSummary, type GraphNode, type GraphSnapshot } from "@/src/core";
import { cn } from "@/lib/utils";
import { topicColor } from "@/components/v4/data";
import { displayTopic } from "@/components/ui/format";
import { Icon } from "@/components/ui/icon";
import { planCostLabel } from "@/components/usage-format";
import { GraphCanvasRenderer, type CanvasColors, type GraphRenderSettings } from "./graph-canvas.ts";
import { useResolvedTheme } from "@/components/theme";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { useActivity } from "@/components/activity-dock";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { MenuShell } from "@/components/menu-shell.tsx";
import { DeleteNodeDialog } from "@/components/delete-node-dialog.tsx";
import { ChainTableOverlay } from "@/components/chain-table.tsx";
import { Hint } from "@/components/ui/hint";
import {
	ARROW_LENGTH_LADDER,
	CHARGE_RANGE,
	CLUSTER_LABEL_SIZE_LADDER,
	CLUSTER_PULL_RANGE,
	DEPTH_BASE_RADIUS_RANGE,
	DEPTH_SPACING_RANGE,
	DEPTH_STRENGTH_RANGE,
	DEFAULT_RENDER_SETTINGS,
	EDGE_WIDTH_LADDER,
	GRAVITY_RANGE,
	LABEL_SIZE_LADDER,
	LABEL_ZOOM_LADDER,
	LINK_DISTANCE_RANGE,
	LINK_STRENGTH_RANGE,
	NODE_SIZE_LADDER,
	REGION_BITMAP_OPTIONS,
	REGION_BLUR_LADDER,
	fromLadderPosition,
	snapToLadder,
	toLadderPosition,
	REGION_DILATION_LADDER,
	REGION_EDGE_ALPHA_LADDER,
	VELOCITY_DECAY_RANGE,
	fromOffSliderPosition,
	fromSliderPosition,
	labelZoomDisplay,
	sanitizeRenderSettings,
	toOffSliderPosition,
	toSliderPosition,
} from "@/src/core";

const NODE_COLOR_TOKEN = "--primary";

const CAMERA_STORAGE_KEY = "lh.graph.camera.v1";

type RenderSettings = GraphRenderSettings;

export function isNodeVisible(node: Pick<GraphNode, "name" | "statement">, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return node.name.toLowerCase().includes(q) || node.statement.toLowerCase().includes(q);
}

export function renameSessionsPatch(snapshot: Pick<GraphSnapshot, "sessions">, id: string, title: string): void {
	snapshot.sessions[id] = title;
}

export function seedMissingNodePositions(
	nodes: readonly { id: string }[],
	positions: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
	if (positions.size === 0 || nodes.every((n) => positions.has(n.id))) return positions;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of positions.values()) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const radius = Math.max(maxX - minX, maxY - minY, 40) * 0.7 + 20;
	const missing = nodes.filter((n) => !positions.has(n.id));
	missing.forEach((n, i) => {
		let h = 0x811c9dc5;
		for (let c = 0; c < n.id.length; c++) {
			h ^= n.id.charCodeAt(c);
			h = (h * 0x01000193) >>> 0;
		}
		const angle = ((h / 0xffffffff) * 2 * Math.PI + i * 2.39996323) % (2 * Math.PI);
		positions.set(n.id, {
			x: cx + Math.cos(angle) * radius,
			y: cy + Math.sin(angle) * radius,
		});
	});
	return positions;
}

export function ideaNeighbours(
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[],
	nodeId: string,
): { restsOn: string[]; leadsTo: string[] } {
	const restsOn = new Set<string>();
	const leadsTo = new Set<string>();
	for (const c of chains) {
		if (c.conclusion === nodeId) for (const p of c.premises) if (p !== nodeId) restsOn.add(p);
		if (c.premises.includes(nodeId) && c.conclusion !== nodeId) leadsTo.add(c.conclusion);
	}
	return { restsOn: [...restsOn], leadsTo: [...leadsTo] };
}

export interface GraphViewApi {
	zoomIn: () => void;
	zoomOut: () => void;
	fit: () => void;
	frame: (ids: readonly string[]) => void;
	zoomPercent: () => number;
	onZoom: (cb: () => void) => void;
}

const NEIGHBOUR_LIMIT = 4;

function cssColorToHex(css: string): string {
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext("2d");
	if (!ctx) return "#888888";
	ctx.fillStyle = css;
	ctx.fillRect(0, 0, 1, 1);
	const { data } = ctx.getImageData(0, 0, 1, 1);
	return `#${[data[0]!, data[1]!, data[2]!]
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")}`;
}

function tokenHex(cssVar: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
	return value ? cssColorToHex(value) : "#888888";
}

function tokenRaw(cssVar: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || "transparent";
}

function canvasInks(v4: boolean): { colors: CanvasColors; edge: string | undefined } {
	return {
		colors: {
			node: tokenHex(NODE_COLOR_TOKEN),
			edge: tokenHex("--graph-edge"),
			label: tokenHex("--muted-foreground"),
			hoverText: tokenHex("--foreground"),
			...(v4 ? { halo: tokenHex("--surface"), line: tokenRaw("--line-strong") } : {}),
		},
		edge: v4 ? `${tokenHex("--graph-edge")}8c` : undefined,
	};
}

interface Selection {
	node: GraphNode;
	sourceIds: string[];
	anchor: { x: number; y: number };
}

function sizeDisplay(v: number): string {
	return `${v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100}`;
}

function SettingSlider({
	label,
	min,
	max,
	step,
	value,
	display,
	onChange,
	disabled,
}: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	display?: string;
	onChange: (v: number) => void;
	disabled?: boolean;
}) {
	return (
		<label className={`flex flex-col gap-1${disabled ? " opacity-40" : ""}`}>
			<span className="flex items-center justify-between text-[11px] text-muted-foreground">
				{label}
				<span className="tabular-nums">{display ?? value}</span>
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(Number(e.target.value))}
				className="h-1.5 w-full accent-primary"
			/>
		</label>
	);
}

function fmtTokens(n: number | undefined): string {
	if (n === undefined) return "—";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function timeAgo(startedAt: number): string {
	const mins = Math.round((Date.now() - startedAt) / 60_000);
	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

function fmtRunCost(dollars: number | null, providers: readonly string[] = []): string {
	return planCostLabel(dollars, providers, (value) => `$${value.toFixed(3)}`);
}
function graphProviders(value: { subscriptionRuns?: number; subscriptionProviders?: string[] }): string[] {
	return value.subscriptionProviders ?? ((value.subscriptionRuns ?? 0) > 0 ? ["ChatGPT"] : []);
}
function graphUsageLabel(costs: Pick<GraphCostSummary, "stages">): string {
	const stages = [costs.stages.extraction, costs.stages.audit];
	const providers = [...new Set(stages.flatMap(graphProviders))];
	const priced = stages.some((stage) => stage.runs - stage.unpricedRuns - (stage.subscriptionRuns ?? 0) > 0);
	const dollars = displayCostTotals(costs).totalDollars;
	return planCostLabel(priced ? dollars : null, providers, (value) => `$${value.toFixed(2)}`);
}

export function displayCostTotals(costs: Pick<GraphCostSummary, "stages">): {
	totalDollars: number;
	unpricedRuns: number;
} {
	return {
		totalDollars: costs.stages.extraction.dollars + costs.stages.audit.dollars,
		unpricedRuns: costs.stages.extraction.unpricedRuns + costs.stages.audit.unpricedRuns,
	};
}

export function GraphCostControl({ costs }: { costs: GraphCostSummary }) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	return (
		<div ref={rootRef} className="relative">
			<Hint
				label="Graph costs — click for details"
				side="bottom"
			>
				<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className={`rounded-lg px-2 py-1 text-xs tabular-nums transition-colors hover:bg-accent ${
					open ? "text-foreground" : "text-muted-foreground hover:text-foreground"
				}`}
			>
				{graphUsageLabel(costs)}
			</button>
			</Hint>
			{open && (
				<div className="absolute right-0 top-full mt-2 max-h-[60vh] overflow-y-auto">
					<GraphCostPanel costs={costs} />
				</div>
			)}
		</div>
	);
}

function GraphCostPanel({ costs }: { costs: GraphCostSummary }) {
	const stageRows: [string, GraphCostSummary["stages"]["extraction"]][] = [
		["Extraction", costs.stages.extraction],
		["Audit", costs.stages.audit],
	];
	const { unpricedRuns } = displayCostTotals(costs);
	return (
		<div className="w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border bg-card/95 p-3 text-xs shadow-lg backdrop-blur">
			<div className="mb-2 flex items-baseline justify-between">
				<span className="text-[10px] font-medium text-muted-foreground">
					Graph pipeline costs
				</span>
				<span className="text-foreground tabular-nums">
					{graphUsageLabel(costs)}
					{unpricedRuns > 0 && (
						<span className="text-muted-foreground"> · {unpricedRuns} unpriced</span>
					)}
				</span>
			</div>
			<div className="flex flex-col gap-1">
				{stageRows.map(([label, stage]) => (
					<div key={label} className="flex items-baseline justify-between gap-2 text-[11px]">
						<span className="shrink-0 text-muted-foreground">{label}</span>
						<span className="min-w-0 text-right tabular-nums">
							{fmtRunCost(stage.runs - stage.unpricedRuns - (stage.subscriptionRuns ?? 0) <= 0 ? null : stage.dollars, graphProviders(stage))}
							{stage.unpricedRuns > 0 && (stage.runs - stage.unpricedRuns - (stage.subscriptionRuns ?? 0) > 0 || (stage.subscriptionRuns ?? 0) > 0) && (
								<span className="text-muted-foreground"> +{stage.unpricedRuns} unpriced</span>
							)}
							<span className="text-muted-foreground">
								{" "}
								· {fmtTokens(stage.tokens.inputTokens)} in / {fmtTokens(stage.tokens.outputTokens)} out
							</span>
						</span>
					</div>
				))}
			</div>
			<div className="mt-2 flex flex-col gap-0.5 border-t pt-2">
				{costs.runs.map((run) => (
						<div key={run.startedAt} className="flex items-baseline justify-between gap-2 text-[11px]">
							<span className="min-w-0 flex-1 truncate text-muted-foreground">
								<span className="text-foreground/70">{timeAgo(run.startedAt)}</span>{" "}
								{run.title}
								{run.merged && (
									<span className="text-muted-foreground">
										{" "}
										+{run.merged.nodes}n
									</span>
								)}
							</span>
							<span className="shrink-0 tabular-nums">{fmtRunCost(run.dollars, graphProviders(run))}{run.dollars === null && run.subscriptionRuns === 1 ? " +1 unpriced" : ""}</span>
						</div>
					))}
			</div>
		</div>
	);
}

function GraphSettingsControl({
	settings,
	changeSettings,
}: {
	settings: GraphRenderSettings;
	changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	const regionTuning = settings.regions;
	const physicsTuning = settings.physics;
	return (
		<div ref={rootRef} className="relative">
			<Hint
				label="Graph display settings"
				side="bottom"
			>
				<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className={`flex size-9 items-center justify-center rounded-xl border bg-card/85 shadow-lg backdrop-blur transition-colors hover:bg-accent ${
					open ? "text-foreground" : "text-muted-foreground hover:text-foreground"
				}`}
			>
				<SettingsIcon className="size-4" />
			</button>
			</Hint>
			{open && (
				<div className="absolute right-0 top-full mt-2 flex max-h-[60vh] w-72 flex-col rounded-xl border bg-card/85 p-2.5 shadow-lg backdrop-blur">
					<div className="flex flex-col gap-2 overflow-y-auto pr-2.5">
							<SettingSlider
								label="Node size"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.nodeSize, NODE_SIZE_LADDER)}
								display={sizeDisplay(settings.nodeSize)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, nodeSize: fromLadderPosition(p, NODE_SIZE_LADDER) }))}
							/>
							<SettingSlider
								label="Edge width"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.edgeWidth, EDGE_WIDTH_LADDER)}
								display={sizeDisplay(settings.edgeWidth)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, edgeWidth: fromLadderPosition(p, EDGE_WIDTH_LADDER) }))}
							/>
							<SettingSlider
								label="Arrowhead size"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.arrowLength, ARROW_LENGTH_LADDER)}
								display={sizeDisplay(settings.arrowLength)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, arrowLength: fromLadderPosition(p, ARROW_LENGTH_LADDER) }))}
							/>
							<SettingSlider
								label="Label size"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.labelSize, LABEL_SIZE_LADDER)}
								display={sizeDisplay(settings.labelSize)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, labelSize: fromLadderPosition(p, LABEL_SIZE_LADDER) }))}
							/>
							<SettingSlider
								label="Labels until zoom"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.labelZoom, LABEL_ZOOM_LADDER)}
								display={labelZoomDisplay(settings.labelZoom)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, labelZoom: fromLadderPosition(p, LABEL_ZOOM_LADDER) }))}
							/>
						<div className="mt-1.5 flex flex-col gap-1.5 border-t pt-1.5">
							<span className="text-[10px] font-medium text-muted-foreground">
								Regions
							</span>
							<label className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
								<span>Background colors</span>
								<input
									type="checkbox"
									checked={settings.regions.enabled}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											regions: { ...cur.regions, enabled: e.target.checked },
										}))}
										className="accent-primary"
								/>
							</label>
							<SettingSlider
								label="Dilation"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.dilation, REGION_DILATION_LADDER)}
								display={sizeDisplay(regionTuning.dilation)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, dilation: fromLadderPosition(p, REGION_DILATION_LADDER) },
									}))}
							/>
							<SettingSlider
								label="Blur"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.blur, REGION_BLUR_LADDER)}
								display={sizeDisplay(regionTuning.blur)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, blur: fromLadderPosition(p, REGION_BLUR_LADDER) },
									}))
								}
							/>
							<SettingSlider
								label="Edge alpha"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.edgeAlpha, REGION_EDGE_ALPHA_LADDER)}
								display={sizeDisplay(regionTuning.edgeAlpha)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, edgeAlpha: fromLadderPosition(p, REGION_EDGE_ALPHA_LADDER) },
									}))}
							/>
							<label
								className={`flex items-center justify-between gap-2 text-[11px] text-muted-foreground${!regionTuning.enabled ? " opacity-40" : ""}`}
							>
								<span>Bitmap resolution</span>
								<select
									disabled={!regionTuning.enabled}
									className="rounded-md border bg-background px-1.5 py-0.5 text-xs tabular-nums text-foreground"
									value={regionTuning.bitmap}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											regions: { ...cur.regions, bitmap: Number(e.target.value) },
										}))
									}
								>
									{REGION_BITMAP_OPTIONS.map((o) => (
										<option key={o} value={o}>
											{o}
										</option>
									))}
								</select>
							</label>
							<label className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
								<span>Cluster labels</span>
								<input
									type="checkbox"
									checked={settings.clusterLabels}
									onChange={(e) => changeSettings((cur) => ({ ...cur, clusterLabels: e.target.checked }))}
									className="accent-primary"
								/>
							</label>
							<SettingSlider
								label="Cluster label size"
								disabled={!settings.clusterLabels}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.clusterLabelSize, CLUSTER_LABEL_SIZE_LADDER)}
								display={sizeDisplay(settings.clusterLabelSize)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										clusterLabelSize: fromLadderPosition(p, CLUSTER_LABEL_SIZE_LADDER),
									}))}
							/>
						</div>
						<div className="mt-1.5 flex flex-col gap-1.5 border-t pt-1.5">
							<span className="text-[10px] font-medium text-muted-foreground">
								Physics
							</span>
							<SettingSlider
								label="Node repulsion"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(-physicsTuning.chargeStrength, -CHARGE_RANGE.max, -CHARGE_RANGE.min)}
								display={`-${Math.round(-physicsTuning.chargeStrength)}`}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, chargeStrength: -fromSliderPosition(p, -CHARGE_RANGE.max, -CHARGE_RANGE.min) },
									}))}
							/>
							<SettingSlider
								label="Edge attraction"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.linkStrength, LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max)}
								display={sizeDisplay(physicsTuning.linkStrength)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, linkStrength: fromSliderPosition(p, LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Edge length"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.linkDistance, LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max)}
								display={sizeDisplay(physicsTuning.linkDistance)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, linkDistance: fromSliderPosition(p, LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Central pull"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.gravity, GRAVITY_RANGE.min, GRAVITY_RANGE.max)}
								display={sizeDisplay(physicsTuning.gravity)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, gravity: fromSliderPosition(p, GRAVITY_RANGE.min, GRAVITY_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Cluster pull"
								min={0}
								max={100}
								step={5}
								value={toOffSliderPosition(physicsTuning.clusterPull, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max)}
								display={physicsTuning.clusterPull <= 0 ? "off" : sizeDisplay(physicsTuning.clusterPull)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, clusterPull: fromOffSliderPosition(p, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Friction"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.velocityDecay, VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max)}
								display={sizeDisplay(physicsTuning.velocityDecay)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, velocityDecay: fromSliderPosition(p, VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max) },
									}))}
							/>
							<label className="flex items-center justify-between gap-2 text-xs">
								Depth anchor
								<select
									className="rounded border bg-background px-1 py-0.5 text-xs"
									value={physicsTuning.depthMode}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											physics: { ...cur.physics, depthMode: e.target.value as GraphRenderSettings["physics"]["depthMode"] },
										}))
									}
								>
									<option value="off">Off</option>
									<option value="vertical">Vertical (up)</option>
									<option value="radial">Radial (outward)</option>
								</select>
							</label>
							<SettingSlider
								label="Depth strength"
								disabled={physicsTuning.depthMode === "off"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthStrength, DEPTH_STRENGTH_RANGE.min, DEPTH_STRENGTH_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthStrength)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthStrength: fromSliderPosition(p, DEPTH_STRENGTH_RANGE.min, DEPTH_STRENGTH_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Depth spacing"
								disabled={physicsTuning.depthMode === "off"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthSpacing, DEPTH_SPACING_RANGE.min, DEPTH_SPACING_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthSpacing)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthSpacing: fromSliderPosition(p, DEPTH_SPACING_RANGE.min, DEPTH_SPACING_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Base ring radius"
								disabled={physicsTuning.depthMode !== "radial"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthBaseRadius, DEPTH_BASE_RADIUS_RANGE.min, DEPTH_BASE_RADIUS_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthBaseRadius)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthBaseRadius: fromSliderPosition(p, DEPTH_BASE_RADIUS_RANGE.min, DEPTH_BASE_RADIUS_RANGE.max) },
									}))}
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export function GraphChromeRow({
	isEmpty,
	query,
	onQuery,
	noMatch,
	importing,
	searchInputRef,
	fileInputRef,
	onImportFiles,
	settings,
	changeSettings,
	onOpenChains,
}: {
	isEmpty: boolean;
	query: string;
	onQuery: (v: string) => void;
	noMatch: boolean;
	importing: boolean;
	searchInputRef: React.RefObject<HTMLInputElement | null>;
	fileInputRef: React.RefObject<HTMLInputElement | null>;
	onImportFiles: (files: FileList | null) => void;
	settings: GraphRenderSettings;
	changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
	onOpenChains: () => void;
}) {
	return (
		<>
			{!isEmpty && (
				<div className="graph-chrome-fade-in w-56 min-w-0 shrink rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
					<Hint
						label="Search nodes"
						action="find"
						side="bottom"
					>
					<div className="relative">
						<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input
							ref={searchInputRef}
							value={query}
							onChange={(e) => onQuery(e.target.value)}
							placeholder="Search nodes…"
							aria-label="Search nodes"
							spellCheck={false}
							className="h-7 w-full rounded-lg border bg-background pl-8 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
						/>
					</div>
					</Hint>
					{noMatch && (
						<div className="px-1.5 pt-1 text-[11px] text-muted-foreground">No matching nodes.</div>
					)}
				</div>
			)}
			{!isEmpty && (
				<div className="graph-chrome-fade-in shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
					<Hint label="Every reasoning chain" side="bottom">
						<button
							type="button"
							onClick={onOpenChains}
							data-testid="open-chain-table"
							className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
						>
							<ListTreeIcon className="size-3" />
							Chains
						</button>
					</Hint>
				</div>
			)}
			<div className="shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
				<input
					ref={fileInputRef}
					type="file"
					multiple
					accept=".md,.markdown,.txt"
					className="hidden"
					onChange={(e) => {
						onImportFiles(e.target.files);
						e.target.value = "";
					}}
				/>
				<Hint
					label="Import notes into the graph"
					side="bottom"
				>
					<button
						type="button"
						disabled={importing}
						onClick={() => fileInputRef.current?.click()}
						data-testid="import-notes"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
				>
						<UploadIcon className="size-3" />
						{importing ? "Importing…" : "Import notes…"}
					</button>
				</Hint>
			</div>
			{!isEmpty && (
				<div className="graph-chrome-fade-in shrink-0">
					<GraphSettingsControl settings={settings} changeSettings={changeSettings} />
				</div>
			)}
		</>
	);
}

export function GraphView({
	chainSelectOpen = false,
	practiceSelection,
	onPracticeSelectionChange,
	onChainSelectClose,
	focusIdeaId,
	variant = "legacy",
	query: queryProp,
	onSelectIdea,
	apiRef,
	highlight,
	topicNames,
	focusIds,
}: {
	variant?: "legacy" | "v4";
	query?: string;
	onSelectIdea?: (idea: { node: GraphNode; sourceIds: string[] } | null) => void;
	apiRef?: React.Ref<GraphViewApi>;
	highlight?: { ids: ReadonlySet<string>; selected: string | null } | null;
	topicNames?: ReadonlyMap<string, string> | null;
	focusIds?: ReadonlySet<string> | null;
	focusIdeaId?: string;
	chainSelectOpen?: boolean;
	practiceSelection?: ReadonlySet<string>;
	onPracticeSelectionChange?: (nodes: { id: string; name: string; statement: string }[]) => void;
	onChainSelectClose?: () => void;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [selected, setSelected] = useState<Selection | null>(null);
	const snapshotRef = useRef<GraphSnapshot | null>(null);
	snapshotRef.current = snapshot;
	const onSelectIdeaRef = useRef(onSelectIdea);
	onSelectIdeaRef.current = onSelectIdea;
	const v4Ref = useRef(variant === "v4");
	v4Ref.current = variant === "v4";
	const onZoomRef = useRef<(() => void) | null>(null);

	const [internalQuery, setQuery] = useState("");
	const v4 = variant === "v4";
	const query = queryProp ?? internalQuery;
	const focusAppliedRef = useRef(false);
	useEffect(() => {
		if (!focusIdeaId || focusAppliedRef.current || !snapshot) return;
		const node = snapshot.propositions.find((n) => n.id === focusIdeaId);
		focusAppliedRef.current = true;
		if (node) setQuery(node.name);
	}, [focusIdeaId, snapshot]);
	const searchInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const onFind = () => searchInputRef.current?.focus();
		window.addEventListener("lh:kbd-find", onFind);
		return () => window.removeEventListener("lh:kbd-find", onFind);
	}, []);
	const [settings, setSettings] = useState<GraphRenderSettings>(DEFAULT_RENDER_SETTINGS);
	const regionTuning = settings.regions;
	const physicsTuning = settings.physics;
	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	const userTouched = useRef(false);
	const serverLoaded = useRef(false);
	const savePending = useRef(false);
	const changeSettings = (update: (cur: RenderSettings) => RenderSettings) => {
		userTouched.current = true;
		setSettings(update);
	};
	const saveToServer = (s: RenderSettings) => {
		fetch("/api/graph/render-settings", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(s),
		}).catch((err) => console.error("[graph] settings save failed:", err));
	};
	useEffect(() => {
		fetch("/api/graph/render-settings")
			.then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
			.then((raw) => {
				if (raw !== null && !userTouched.current) setSettings(sanitizeRenderSettings(raw));
			})
			.catch(() => {
				// server unreachable → in-memory defaults keep working
			})
			.finally(() => {
				serverLoaded.current = true;
				if (savePending.current) {
					savePending.current = false;
					saveToServer(settingsRef.current);
				}
			});
	}, []);
	useEffect(() => {
		if (!userTouched.current) return;
		if (!serverLoaded.current) {
			savePending.current = true;
			return;
		}
		const id = setTimeout(() => saveToServer(settings), 400);
		return () => clearTimeout(id);
	}, [settings]);

	const rendererRef = useRef<GraphCanvasRenderer | null>(null);
	const posRef = useRef<Map<string, { x: number; y: number }> | null>(null);

	const visibleIds = useMemo(() => {
		const set = new Set<string>();
		if (snapshot)
			for (const node of snapshot.nodes) {
				if (isNodeVisible(node, query)) set.add(node.id);
			}
		return set;
	}, [snapshot, query]);

	const [refreshTick, setRefreshTick] = useState(0);
	const [chainsOpen, setChainsOpen] = useState(false);
	useEffect(() => {
		if (chainSelectOpen) setChainsOpen(true);
	}, [chainSelectOpen]);
	useEffect(() => {
		let cancelled = false;
		fetch("/api/graph")
			.then((res) => res.json() as Promise<GraphSnapshot>)
			.then((data) => {
				if (!cancelled) setSnapshot(data);
			})
			.catch((err) => console.error("[graph] fetch failed:", err));
		return () => {
			cancelled = true;
		};
	}, [refreshTick]);

	const fileInputRef = useRef<HTMLInputElement>(null);
	const refreshActivity = useActivity().refresh;
	const notesImport = useNotesImport({
		onStart: () => {
			refreshActivity();
			setTimeout(() => refreshActivity(), 600);
		},
	});
	const { importing, onImportFiles } = notesImport;

	const [pipelineRuns, setPipelineRuns] = useState<{ id: string; chatId: string; title: string; phase: string; startedAt: number }[]>([]);
	const rowIdsRef = useRef<Set<string>>(new Set());
	const readPipelineStatus = useCallback(() => {
		fetch("/api/graph/status")
			.then((res) => res.json() as Promise<{ runs: typeof pipelineRuns }>)
			.then(({ runs }) => {
				setPipelineRuns(runs);
				const ids = new Set(runs.map((r) => r.id));
				if ([...rowIdsRef.current].some((id) => !ids.has(id))) setRefreshTick((t) => t + 1);
				rowIdsRef.current = ids;
			})
			.catch(() => {});
	}, []);
	const statusDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useServerEvent("activity-changed", () => {
		if (statusDebounceRef.current) clearTimeout(statusDebounceRef.current);
		statusDebounceRef.current = setTimeout(() => {
			statusDebounceRef.current = undefined;
			readPipelineStatus();
		}, 250);
	});
	useServerResync(() => readPipelineStatus());
	useEffect(() => {
		readPipelineStatus();
		return () => {
			if (statusDebounceRef.current) clearTimeout(statusDebounceRef.current);
		};
	}, [readPipelineStatus]);

	const [costs, setCosts] = useState<GraphCostSummary | null>(null);
	const refreshCosts = useCallback(() => {
		fetch("/api/graph/costs")
			.then((res) => res.json() as Promise<GraphCostSummary>)
			.then(setCosts)
			.catch(() => {});
	}, []);
	useEffect(() => {
		refreshCosts();
	}, [refreshCosts]);
	const prevRunIds = useRef(new Set<string>());
	useEffect(() => {
		const gone = [...prevRunIds.current].some((id) => !pipelineRuns.some((r) => r.id === id));
		if (gone && prevRunIds.current.size > 0) refreshCosts();
		prevRunIds.current = new Set(pipelineRuns.map((r) => r.id));
	}, [pipelineRuns, refreshCosts]);

	useEffect(() => {
		const onRevision = () => {
			setRefreshTick((t) => t + 1);
			refreshCosts();
		};
		window.addEventListener("lh:graph-revision", onRevision);
		return () => window.removeEventListener("lh:graph-revision", onRevision);
	}, [refreshCosts]);

	const [, setLabelTick] = useState(0);
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id?: string; title?: string }>).detail ?? {};
			if (typeof id !== "string" || typeof title !== "string" || id === "" || title === "") return;
			const snap = snapshotRef.current;
			if (snap != null) renameSessionsPatch(snap, id, title);
			rendererRef.current?.setClusterLabels(new Map([[id, v4Ref.current ? displayTopic(title) : title]]));
			setLabelTick((t) => t + 1);
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, []);

	const [ctxNode, setCtxNode] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
	const ctxAnchorRef = useRef<HTMLDivElement | null>(null);
	const [deletingNode, setDeletingNode] = useState<{ id: string; name: string } | null>(null);
	useEffect(() => {
		if (ctxNode === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			setCtxNode(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setCtxNode(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [ctxNode]);

	useEffect(() => {
		if (!snapshot || snapshot.nodes.length === 0) return;
		const ledger = snapshot.positions;
		if (ledger) {
			const positions = new Map<string, { x: number; y: number }>();
			for (const node of snapshot.nodes) {
				const p = ledger[node.id];
				if (p) positions.set(node.id, { x: p.x, y: p.y });
			}
			if (positions.size > 0) {
				posRef.current = seedMissingNodePositions(snapshot.nodes, positions);
				return () => {
					posRef.current = null;
				};
			}
		}
		posRef.current = incrementalLayout(snapshot.nodes, snapshot.edges, new Map());
		return () => {
			posRef.current = null;
		};
	}, [snapshot]);

	const isEmpty = snapshot === null || snapshot.nodes.length === 0;
	useEffect(() => {
		if (isEmpty) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		let initialCamera: { k: number; x: number; y: number } | null = null;
		try {
			const stored = localStorage.getItem(CAMERA_STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored) as { k?: unknown; x?: unknown; y?: unknown };
				if (
					typeof parsed.k === "number" && Number.isFinite(parsed.k) && parsed.k > 0 &&
					typeof parsed.x === "number" && Number.isFinite(parsed.x) &&
					typeof parsed.y === "number" && Number.isFinite(parsed.y)
				)
					initialCamera = { k: parsed.k, x: parsed.x, y: parsed.y };
			}
		} catch {
			// Corrupt entry → treat as absent; the renderer fits.
		}
		let cameraTimer: ReturnType<typeof setTimeout> | null = null;
		let lastCamera: { k: number; x: number; y: number } | null = null;
		const persistCamera = (t: { k: number; x: number; y: number }) => {
			lastCamera = t;
			if (cameraTimer) clearTimeout(cameraTimer);
			cameraTimer = setTimeout(() => {
				cameraTimer = null;
				try {
					localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(t));
				} catch {
					// Storage full/blocked: camera persistence is best-effort.
				}
			}, 250);
		};
		const renderer = new GraphCanvasRenderer(
			canvas,
			{
				onSelect: (nodeId, pos) => {
					const snap = snapshotRef.current;
					const node = snap?.nodes.find((n) => n.id === nodeId);
					if (!snap || !node) return;
					setSelected({
						node,
						sourceIds: snap.nodeSessions[node.id] ?? [],
						anchor: pos,
					});
					onSelectIdeaRef.current?.({ node, sourceIds: snap.nodeSessions[node.id] ?? [] });
				},
				onStageClick: () => {
					setSelected(null);
					onSelectIdeaRef.current?.(null);
				},
				onContext: (nodeId, pos) => {
					if (nodeId === null) {
						setCtxNode(null);
						return;
					}
					const node = snapshotRef.current?.nodes.find((n) => n.id === nodeId);
					if (!node) return;
					setCtxNode({ id: node.id, name: node.name, x: pos.x, y: pos.y });
				},
				onCameraMove: (t) => {
					if (!v4Ref.current) setSelected(null);
					setCtxNode(null);
					persistCamera(t);
					onZoomRef.current?.();
				},
				onCommit: (positions) => {
					void fetch("/api/graph/positions", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(positions),
					}).catch((err) => console.error("[graph] positions commit failed", err));
				},
			},
			initialCamera,
		);
		rendererRef.current = renderer;
		return () => {
			rendererRef.current = null;
			if (cameraTimer && lastCamera) {
				clearTimeout(cameraTimer);
				cameraTimer = null;
				try {
					localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(lastCamera));
				} catch {
					// best-effort
				}
			}
			renderer.destroy();
		};
	}, [isEmpty]);

	useEffect(() => {
		const renderer = rendererRef.current;
		const positions = posRef.current;
		if (!renderer || !snapshot || snapshot.nodes.length === 0 || !positions) return;
		const colorOf = new Map<string, string>();
		if (v4) for (const c of snapshot.clusters) for (const m of c.members) colorOf.set(m, topicColor(c.id));
		const inks = canvasInks(v4);
		const clusterLabel = (c: { id: string; label: string | null }) => {
			if (!v4) return c.label;
			const name = topicNames?.get(c.id) ?? c.label;
			return name ? displayTopic(name) : null;
		};
		renderer.setData({
			nodes: snapshot.nodes.map((n) => ({
				id: n.id,
				x: positions.get(n.id)?.x ?? 0,
				y: positions.get(n.id)?.y ?? 0,
				label: n.name,
				color: v4 ? (colorOf.get(n.id) ?? "#8a918c") : undefined,
			})),
			edges: snapshot.edges.map((e) => ({
				from: e.from,
				to: e.to,
				color: inks.edge,
			})),
			logicalEdges: snapshot.logicalEdges.map((e) => ({ from: e.from, to: e.to })),
			impLinks: snapshot.impLinks,
			clusters: snapshot.clusters.map((c) => ({ id: c.id, label: clusterLabel(c), members: c.members, color: v4 ? topicColor(c.id) : undefined })),
			colors: inks.colors,
			fontFamily: getComputedStyle(document.body).fontFamily,
			style: v4 ? "v4" : undefined,
		});
		// topicNames: the page memoizes it by content, so this re-feeds only
		// when a topic is actually renamed or born.
	}, [snapshot, isEmpty, v4, topicNames]);

	const theme = useResolvedTheme();
	const inkedThemeRef = useRef(theme);
	useEffect(() => {
		if (inkedThemeRef.current === theme) return;
		inkedThemeRef.current = theme;
		const inks = canvasInks(v4);
		rendererRef.current?.setColors(inks.colors, inks.edge);
	}, [theme, v4]);


	useEffect(() => {
		rendererRef.current?.setHighlight(highlight?.ids ?? null, highlight?.selected ?? null, tokenHex("--brand"));
	}, [highlight, isEmpty, theme]);
	const searching = query.trim() !== "";
	useEffect(() => {
		rendererRef.current?.setFocus(searching ? null : (focusIds ?? null));
	}, [focusIds, isEmpty, searching]);
	useImperativeHandle(
		apiRef,
		() => ({
			zoomIn: () => rendererRef.current?.zoomBy(1.4),
			zoomOut: () => rendererRef.current?.zoomBy(1 / 1.4),
			fit: () => rendererRef.current?.fit(),
			frame: (ids: readonly string[]) => rendererRef.current?.frameNodes(ids),
			zoomPercent: () => rendererRef.current?.zoomPercent() ?? 100,
			onZoom: (cb: () => void) => {
				onZoomRef.current = cb;
			},
		}),
		[],
	);

	const deferredSettings = useDeferredValue(settings);
	useEffect(() => {
		rendererRef.current?.setSettings(v4 ? { ...deferredSettings, nodeSize: Math.max(deferredSettings.nodeSize * 3, 6) } : deferredSettings);
	}, [deferredSettings, isEmpty, v4]);

	useEffect(() => {
		rendererRef.current?.setVisible(query.trim() ? visibleIds : null);
		setSelected((sel) => (sel && visibleIds.has(sel.node.id) ? sel : null));
	}, [visibleIds, query]);

	const searchedRef = useRef(false);
	useEffect(() => {
		if (!v4) return;
		const q = query.trim();
		const t = window.setTimeout(() => {
			const r = rendererRef.current;
			if (!r) return;
			if (q && visibleIds.size > 0) r.frameNodes([...visibleIds]);
			else if (!q && searchedRef.current) {
				if (focusIds && focusIds.size > 0) r.frameNodes([...focusIds]);
				else r.fit();
			}
			searchedRef.current = q !== "";
		}, 250);
		return () => window.clearTimeout(t);
	}, [v4, visibleIds, query, focusIds]);

	useEffect(() => {
		rendererRef.current?.setRegionTuning(regionTuning);
	}, [regionTuning, isEmpty]);

	useEffect(() => {
		rendererRef.current?.setPhysicsTuning(physicsTuning);
	}, [physicsTuning, isEmpty]);

	useLayoutEffect(() => {
		const card = cardRef.current;
		const container = containerRef.current;
		if (!selected || !card || !container) return;
		const width = card.offsetWidth;
		const height = card.offsetHeight;
		const margin = 8;
		const gap = 12;
		const left = Math.min(
			Math.max(selected.anchor.x - width / 2, margin),
			Math.max(container.clientWidth - width - margin, margin),
		);
		let top = selected.anchor.y + gap;
		if (top + height > container.clientHeight - margin) {
			top = Math.max(selected.anchor.y - gap - height, margin);
		}
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
		card.style.visibility = "visible";
	}, [selected]);

	return (
		<div className="relative h-full w-full">
			{isEmpty && v4 ? null : isEmpty ? (
				<div className="flex h-full w-full items-center justify-center px-4">
					<div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
						<WaypointsIcon className="size-10 opacity-40" strokeWidth={1.25} />
						<div className="text-lg font-medium text-foreground">Knowledge graph</div>
						<p className="max-w-sm text-sm">
							Start a session or import notes to build your graph.
						</p>
					</div>
				</div>
			) : (
				<div ref={containerRef} className="relative h-full w-full">
					<canvas ref={canvasRef} className="block h-full w-full touch-none" />
					{ctxNode !== null && (
						<div
							ref={ctxAnchorRef}
							style={{ position: "absolute", left: ctxNode.x, top: ctxNode.y, width: 0, height: 0 }}
						/>
					)}
				</div>
			)}

			{ctxNode !== null && (
				<MenuShell
					anchorRef={ctxAnchorRef}
					testid="node-context-menu"
					preferredSide="down"
					menuClass={v4 ? "v4 scope kmenu" : "flex w-fit flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"}
				>
					<button
						type="button"
						data-testid="ctx-node-delete"
						onClick={() => {
							setDeletingNode({ id: ctxNode.id, name: ctxNode.name });
							setCtxNode(null);
						}}
						className={v4 ? "mrow danger" : "flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"}
					>
						{v4 && <Icon name="delete" size="sm" />}
						{v4 ? "Delete…" : "Delete"}
					</button>
				</MenuShell>
			)}

			<DeleteNodeDialog
				nodes={deletingNode ? [deletingNode] : null}
				onClose={() => setDeletingNode(null)}
				onDeleted={(nodeIds, graphRevision) => {
					setDeletingNode(null);
					if (selected && nodeIds.includes(selected.node.id)) setSelected(null);
					window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { graphRevision } }));
				}}
			/>



			{!v4 && (
			<>
			<div className="lh-no-drag lh-wco-floating absolute right-2 top-2 z-10 flex max-w-[calc(100%-5.5rem)] flex-col items-end gap-2">
			<div className="relative z-20 flex min-w-0 items-start gap-2">
				<GraphChromeRow
					isEmpty={isEmpty}
					query={query}
					onQuery={setQuery}
					noMatch={snapshot !== null && visibleIds.size === 0 && query.trim() !== ""}
					importing={importing}
					searchInputRef={searchInputRef}
					fileInputRef={fileInputRef}
					onImportFiles={onImportFiles}
					settings={settings}
					changeSettings={changeSettings}
					onOpenChains={() => setChainsOpen(true)}
				/>
			</div>

			<NotesImportErrors errors={notesImport.errors} />
			{costs && costs.runs.length > 0 && <GraphCostControl costs={costs} />}
			{pipelineRuns.map((run) => (
				<div
					key={run.id}
					className="flex items-center gap-2 rounded-full border bg-card/85 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur"
				>
					<Loader2Icon className="size-3.5 shrink-0 animate-spin" />
					<span className="capitalize">{run.phase}</span>
					<span className="max-w-48 truncate text-foreground">{run.title}</span>
					<span className="tabular-nums">{Math.max(0, Math.round((Date.now() - run.startedAt) / 1000))}s</span>
				</div>
			))}
			</div>

			</>
			)}
			{selected && !isEmpty && !v4 && (
				<div
					ref={cardRef}
					style={{ visibility: "hidden", left: 0, top: 0 }}
					className="lh-no-drag absolute z-10 w-80 max-w-[calc(100%-1rem)] rounded-xl border bg-card p-4 text-left shadow-lg"
				>
					<div className="font-prose text-[17px] font-medium leading-snug">{selected.node.name}</div>
					<div className="mt-1.5 font-prose text-sm leading-relaxed text-muted-foreground">{selected.node.statement}</div>
					{selected.sourceIds.length > 0 ? (
						<div className="mt-3 flex flex-col gap-1">
							<div className="text-xs text-muted-foreground">Sessions</div>
							{selected.sourceIds.map((sourceId) => {
								if (snapshot?.fileSources?.[sourceId] !== undefined) {
									return (
										<div key={sourceId} className="flex items-center gap-1.5">
											<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
											<span className="min-w-0 flex-1 truncate px-2 py-1.5 text-sm text-muted-foreground">
												{snapshot.fileSources[sourceId]}
											</span>
										</div>
									);
								}
								return (
									<div key={sourceId} className="flex items-center gap-1.5">
										<Link
											href={propositionSessionHref(selected.node, sourceId)}
											scroll={false}
											className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
										>
											{snapshot?.sessions[sourceId] ?? sourceId}
										</Link>
									</div>
								);
							})}
						</div>
					) : (
						<div className="mt-3 text-xs text-muted-foreground">No sessions recorded.</div>
					)}
					{(() => {
						const { restsOn, leadsTo } = ideaNeighbours(snapshot?.chains ?? [], selected.node.id);
						const name = (id: string) => snapshot?.propositions.find((n) => n.id === id)?.name ?? id;
						const list = (title: string, ids: string[], empty: string) => (
							<div className="mt-3 flex flex-col gap-0.5">
								<div className="text-xs font-semibold text-faint">
									{title} · {ids.length}
								</div>
								{ids.length === 0 ? (
									<div className="text-xs text-muted-foreground">{empty}</div>
								) : (
									<>
										{ids.slice(0, NEIGHBOUR_LIMIT).map((id) => (
											<div key={id} className="truncate font-prose text-sm">
												{name(id)}
											</div>
										))}
										{ids.length > NEIGHBOUR_LIMIT && (
											<div className="text-xs text-muted-foreground">and {ids.length - NEIGHBOUR_LIMIT} more</div>
										)}
									</>
								)}
							</div>
						);
						return (
							<>
								{list("Rests on", restsOn, "A starting point.")}
								{list("Leads to", leadsTo, "Nothing yet — a good place to go deeper.")}
							</>
						);
					})()}
					<div className="mt-4 flex gap-2">
						{onPracticeSelectionChange && (
							<button
								type="button"
								data-testid="node-card-practice"
								onClick={() => {
									const props = snapshot?.propositions ?? [];
									const ids = new Set(practiceSelection ?? []);
									if (ids.has(selected.node.id)) ids.delete(selected.node.id);
									else ids.add(selected.node.id);
									onPracticeSelectionChange(
										props.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, name: n.name, statement: n.statement })),
									);
								}}
								className={cn(
									"flex h-8 items-center rounded-lg border px-3 text-xs font-semibold transition-colors",
									practiceSelection?.has(selected.node.id)
										? "border-brand bg-brand-soft text-brand"
										: "border-border bg-popover hover:bg-accent",
								)}
							>
								{practiceSelection?.has(selected.node.id) ? "In practice set" : "Add to practice"}
							</button>
						)}
						<button
							type="button"
							data-testid="node-card-deeper"
							onClick={() => window.dispatchEvent(new CustomEvent("lh:open-omnibar", { detail: { query: selected.node.name } }))}
							className="flex h-8 items-center rounded-lg border border-border bg-popover px-3 text-xs font-semibold transition-colors hover:bg-accent"
						>
							Go deeper
						</button>
					</div>
				</div>
			)}
			{/* Last child of the root on purpose: Electron app-region subtraction
			   resolves by DOM order, not z-index, so a full-bleed surface covering a
			   drag band must paint after everything it covers. */}
			<ChainTableOverlay
				open={chainsOpen && !isEmpty && !v4}
				nodes={snapshot?.propositions ?? []}
				chains={snapshot?.chains ?? []}
				sessions={snapshot?.sessions ?? {}}
				fileSources={snapshot?.fileSources ?? {}}
				onClose={() => {
					setChainsOpen(false);
					onChainSelectClose?.();
				}}
				selectMode={chainSelectOpen}
				controlledSelection={practiceSelection}
				onSelectionChange={(ids) => {
					const props = snapshot?.propositions ?? [];
					const picked: { id: string; name: string; statement: string }[] = [];
					for (const id of ids) {
						const n = props.find((node) => node.id === id);
						if (n) picked.push({ id: n.id, name: n.name, statement: n.statement });
					}
					onPracticeSelectionChange?.(picked);
				}}
			/>		</div>
	);
}
