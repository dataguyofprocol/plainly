import {
	CHARGE_STRENGTH,
	CLUSTER_PULL_STRENGTH,
	INCREMENTAL_GRAVITY,
	LINK_DISTANCE,
	type DepthAnchorMode,
} from "./layout.ts";

export interface GraphRenderSettings {
	/** Absent (pre-world-unit files) makes the sanitizer reset nodeSize,
	 *  labelSize, arrowLength and regions.dilation to defaults. */
	sizeUnits: "world";
	nodeSize: number;
	edgeWidth: number;
	arrowLength: number;
	/** Camera ratio (1 = fit zoom, smaller = zoomed in); node labels show at
	 *  ratio <= labelZoom. */
	labelZoom: number;
	/** World units. nodeSize, arrowLength and regions.dilation are world units too. */
	labelSize: number;
	clusterLabels: boolean;
	/** Screen px, constant at any zoom. */
	clusterLabelSize: number;
	regions: RegionTuning;
	physics: PhysicsTuning;
}


const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** Never throws: missing keys fall back to defaults, out-of-range values
 *  snap or clamp, wrong types reset. */
export function sanitizeRenderSettings(raw: unknown): GraphRenderSettings {
	const r = (raw ?? {}) as Partial<GraphRenderSettings>;
	const ladd = (v: unknown, ladder: readonly number[], dflt: number) =>
		typeof v === "number" && Number.isFinite(v) ? snapToLadder(v, ladder) : dflt;
	const legacySizes = r.sizeUnits !== "world";
	return {
		sizeUnits: "world",
		nodeSize: legacySizes ? DEFAULT_RENDER_SETTINGS.nodeSize : ladd(r.nodeSize, NODE_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.nodeSize),
		edgeWidth: ladd(r.edgeWidth, EDGE_WIDTH_LADDER, DEFAULT_RENDER_SETTINGS.edgeWidth),
		arrowLength: legacySizes ? DEFAULT_RENDER_SETTINGS.arrowLength : ladd(r.arrowLength, ARROW_LENGTH_LADDER, DEFAULT_RENDER_SETTINGS.arrowLength),
		labelZoom: ladd(r.labelZoom, LABEL_ZOOM_LADDER, DEFAULT_RENDER_SETTINGS.labelZoom),
		labelSize: legacySizes ? DEFAULT_RENDER_SETTINGS.labelSize : ladd(r.labelSize, LABEL_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.labelSize),
		clusterLabels:
			typeof r.clusterLabels === "boolean" ? r.clusterLabels : DEFAULT_RENDER_SETTINGS.clusterLabels,
		clusterLabelSize: ladd(
			r.clusterLabelSize,
			CLUSTER_LABEL_SIZE_LADDER,
			DEFAULT_RENDER_SETTINGS.clusterLabelSize,
		),
		regions: legacySizes
			? { ...sanitizeRegionTuning(r.regions), dilation: DEFAULT_REGION_TUNING.dilation }
			: sanitizeRegionTuning(r.regions),
		physics: sanitizePhysicsTuning(r.physics),
	};
}

export interface RegionTuning {
	/** World units. */
	dilation: number;
	/** World units. */
	blur: number;
	/** Max bitmap dimension; one of REGION_BITMAP_OPTIONS. */
	bitmap: number;
	/** Applied once after the blur, so overlaps never stack. */
	edgeAlpha: number;
	/** false skips the region build entirely. Cluster labels follow
	 *  `clusterLabels` instead. */
	enabled: boolean;
}

export const REGION_BITMAP_OPTIONS = [128, 192, 256, 384, 512] as const;
export const DEFAULT_REGION_TUNING: RegionTuning = {
	dilation: 20,
	blur: 40,
	bitmap: 256,
	edgeAlpha: 0.2,
	enabled: true,
};

function snapToOption(value: number, options: readonly number[]): number {
	return options.reduce((best, o) => (Math.abs(o - value) < Math.abs(best - value) ? o : best), options[0] as number);
}

export function sanitizeRegionTuning(input: Partial<RegionTuning> | null | undefined): RegionTuning {
	const d = DEFAULT_REGION_TUNING;
	const num = (v: unknown, fallback: number): number =>
		typeof v === "number" && Number.isFinite(v) ? v : fallback;
	const bitmap = num(input?.bitmap, d.bitmap);
	const ladd = (v: unknown, ladder: readonly number[], dflt: number) =>
		typeof v === "number" && Number.isFinite(v) ? snapToLadder(v, ladder) : dflt;
	return {
		dilation: ladd(input?.dilation, REGION_DILATION_LADDER, d.dilation),
		blur: ladd(input?.blur, REGION_BLUR_LADDER, d.blur),
		bitmap: snapToOption(bitmap, REGION_BITMAP_OPTIONS),
		edgeAlpha: ladd(input?.edgeAlpha, REGION_EDGE_ALPHA_LADDER, d.edgeAlpha),
		// Missing means on; only an explicit false turns regions off.
		enabled: typeof input?.enabled === "boolean" ? input.enabled : true,
	};
}

export interface PhysicsTuning {
	/** Negative = push apart. */
	chargeStrength: number;
	/** Multiplier; 1 = d3 default. */
	linkStrength: number;
	/** World units. */
	linkDistance: number;
	gravity: number;
	/** 0 = off. */
	clusterPull: number;
	velocityDecay: number;
	depthMode: DepthAnchorMode;
	depthStrength: number;
	/** World units. */
	depthSpacing: number;
	/** Radial mode inner ring radius, world units. */
	depthBaseRadius: number;
}

export const DEFAULT_PHYSICS_TUNING: PhysicsTuning = {
	chargeStrength: CHARGE_STRENGTH,
	linkStrength: 1,
	linkDistance: LINK_DISTANCE,
	gravity: INCREMENTAL_GRAVITY,
	clusterPull: CLUSTER_PULL_STRENGTH,
	velocityDecay: 0.4,
	depthMode: "off",
	depthStrength: 0.8,
	depthSpacing: 60,
	depthBaseRadius: 220,
};

export function sanitizePhysicsTuning(input: Partial<PhysicsTuning> | null | undefined): PhysicsTuning {
	const d = DEFAULT_PHYSICS_TUNING;
	const num = (v: unknown, fallback: number): number =>
		typeof v === "number" && Number.isFinite(v) ? v : fallback;
	return {
		chargeStrength: Math.min(Math.max(num(input?.chargeStrength, d.chargeStrength), CHARGE_RANGE.min), CHARGE_RANGE.max),
		linkStrength: Math.min(Math.max(num(input?.linkStrength, d.linkStrength), LINK_STRENGTH_RANGE.min), LINK_STRENGTH_RANGE.max),
		linkDistance: Math.min(Math.max(num(input?.linkDistance, d.linkDistance), LINK_DISTANCE_RANGE.min), LINK_DISTANCE_RANGE.max),
		gravity: Math.min(Math.max(num(input?.gravity, d.gravity), GRAVITY_RANGE.min), GRAVITY_RANGE.max),
		clusterPull: Math.min(Math.max(num(input?.clusterPull, d.clusterPull), 0), CLUSTER_PULL_RANGE.max),
		velocityDecay: Math.min(Math.max(num(input?.velocityDecay, d.velocityDecay), VELOCITY_DECAY_RANGE.min), VELOCITY_DECAY_RANGE.max),
		depthMode: input?.depthMode === "vertical" || input?.depthMode === "radial" ? input.depthMode : "off",
		depthStrength: Math.min(Math.max(num(input?.depthStrength, d.depthStrength), DEPTH_STRENGTH_RANGE.min), DEPTH_STRENGTH_RANGE.max),
		depthSpacing: Math.min(Math.max(num(input?.depthSpacing, d.depthSpacing), DEPTH_SPACING_RANGE.min), DEPTH_SPACING_RANGE.max),
		depthBaseRadius: Math.min(Math.max(num(input?.depthBaseRadius, d.depthBaseRadius), DEPTH_BASE_RADIUS_RANGE.min), DEPTH_BASE_RADIUS_RANGE.max),
	};
}

export const DEFAULT_RENDER_SETTINGS: GraphRenderSettings = {
	sizeUnits: "world",
	nodeSize: 2,
	edgeWidth: 1,
	arrowLength: 2,
	// Displays as 1× on the slider (labelZoomDisplay).
	labelZoom: 0.5,
	labelSize: 3,
	clusterLabels: true,
	clusterLabelSize: 14,
	regions: DEFAULT_REGION_TUNING,
	physics: DEFAULT_PHYSICS_TUNING,
};

// Ladders have 11 stops with the default at index 5; slider position is
// index × 10.
export const NODE_SIZE_LADDER = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12] as const;
export const EDGE_WIDTH_LADDER = [0.1, 0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4, 6] as const;
export const ARROW_LENGTH_LADDER = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12] as const;
export const LABEL_SIZE_LADDER = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16] as const;
// Screen px at any zoom.
export const CLUSTER_LABEL_SIZE_LADDER = [7, 8, 9, 10, 12, 14, 16, 18, 20, 24, 28] as const;
export const LABEL_ZOOM_LADDER = [0.125, 0.175, 0.25, 0.35, 0.45, 0.5, 0.75, 1, 1.5, 2, 3] as const;

export const REGION_DILATION_LADDER = [4, 5, 7.5, 10, 15, 20, 30, 40, 60, 80, 120] as const; // world units
export const REGION_BLUR_LADDER = [10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120] as const; // world units
export const REGION_EDGE_ALPHA_LADDER = [0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1] as const;

// These ranges are sweep-validated against the d3 simulation:
// linkStrength >= 8 explodes the layout, velocityDecay 0 never damps, and
// gravity 0 or charge -1000 sprawl.
export const CHARGE_RANGE = { min: -480, max: -120 } as const;
export const LINK_STRENGTH_RANGE = { min: 0.25, max: 4 } as const;
export const LINK_DISTANCE_RANGE = { min: 10, max: 160 } as const;
export const GRAVITY_RANGE = { min: 0.03, max: 0.48 } as const;
export const CLUSTER_PULL_RANGE = { min: 0.0225, max: 1 } as const; // 0 = off
export const VELOCITY_DECAY_RANGE = { min: 0.18, max: 0.9 } as const;
export const DEPTH_STRENGTH_RANGE = { min: 0.2, max: 3.2 } as const;
export const DEPTH_SPACING_RANGE = { min: 15, max: 240 } as const;
export const DEPTH_BASE_RADIUS_RANGE = { min: 55, max: 880 } as const;

/** Ties break low. */
export function snapToLadder(value: number, ladder: readonly number[]): number {
	return ladder.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), ladder[0] as number);
}

/** Nearest; ties break low. */
export function ladderIndex(value: number, ladder: readonly number[]): number {
	let best = 0;
	for (let i = 1; i < ladder.length; i++)
		if (Math.abs(ladder[i] as number - value) < Math.abs(ladder[best] as number - value)) best = i;
	return best;
}

/** Slider position is in [0, 100]. */
export function toLadderPosition(value: number, ladder: readonly number[]): number {
	return ladderIndex(clampToLadder(value, ladder), ladder) * 10;
}

export function fromLadderPosition(position: number, ladder: readonly number[]): number {
	const i = Math.min(Math.max(Math.round(position / 10), 0), ladder.length - 1);
	return ladder[i] as number;
}

function clampToLadder(value: number, ladder: readonly number[]): number {
	return clamp(value, ladder[0] as number, ladder[ladder.length - 1] as number);
}

/** Position 0 means value 0 (off); the log range starts one step in. */
export function toOffSliderPosition(value: number, min: number, max: number): number {
	if (value <= 0) return 0;
	return toSliderPosition(value, min, max);
}

export function fromOffSliderPosition(position: number, min: number, max: number): number {
	if (position <= 0) return 0;
	return fromSliderPosition(position, min, max);
}

/** Log scale; position is in [0, 100]. */
export function toSliderPosition(value: number, min: number, max: number): number {
	const v = clamp(value, min, max);
	const logSpan = Math.log(max / min);
	return (100 * Math.log(v / min)) / logSpan;
}

export function fromSliderPosition(position: number, min: number, max: number): number {
	const p = clamp(position, 0, 100) / 100;
	const logSpan = Math.log(max / min);
	return min * Math.exp(p * logSpan);
}

export function labelZoomDisplay(labelZoom: number): string {
	const v = Math.round((labelZoom / 0.5) * 100) / 100;
	return `${v}×`;
}
