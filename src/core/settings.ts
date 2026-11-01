/**
 * Delta semantics: the record stores explicit user choices only; absent keys
 * resolve to FACTORY_SETTINGS. Models are the exception: no factory pins
 * exist, so an absent model key resolves to empty. Adding a knob needs no
 * migration. `version` is a schema counter for breaking shape changes only,
 * unrelated to the app release version; migrations live in the adapter.
 *
 * Sanitizer contract: whatever arrives from disk or the network passes
 * through sanitizeUserSettings before use. Strict on known fields, preserves
 * unknown keys verbatim (a newer record must survive an older app reading
 * it). Invalid known values degrade: out-of-range numbers clamp,
 * wrong-typed/invalid fields drop (resolve to factory default), never throw.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { AUTH_PROVIDER_KEYS } from "./auth-keys.ts";
import { sanitizeCustomProviders, type CustomProviderEntry } from "./custom-providers.ts";
import type { ModelRole } from "../../config.ts";
import type { ChatSettings } from "./contracts/chat.ts";
import type { SearchEngineId } from "./search.ts";

/** Bump only for breaking shape changes; pure additions never bump. */
export const CURRENT_SETTINGS_VERSION = 1;

/** Excludes prober/teacher: those follow the strong slot. */
export const BACKGROUND_MODEL_ROLES = [
	"researcher",
	"demoBuilder",
	"visualMaker",
	"extractor",
	"auditor",
] as const;

export type BackgroundModelRole = (typeof BACKGROUND_MODEL_ROLES)[number];

/** Every field independent; an absent field falls back to the next tier. */
export interface RoleModelOverride {
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
}

/** Resolution per role: role override → slot (ROLE_SLOT) → factory pin. */
export const MODEL_SLOTS = ["strong", "cheap", "vision"] as const;
export type ModelSlotName = (typeof MODEL_SLOTS)[number];

/** For UNSET levels only: a model with no thinking level resolves to the
 *  first entry here that the model supports; a non-reasoning model resolves
 *  "off" (pi reports exactly ["off"]). Explicitly set levels never consult
 *  this list; pi's clampThinkingLevel clamps them on model switches. */
export const DEFAULT_THINKING_ORDER = [
	"medium",
	"low",
	"high",
	"minimal",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

/** Refusal envelope for every per-need gate. HTTP callers get 503 + this
 *  JSON; in-band consumers carry only the `error` line. */
export const MODELS_NOT_CONFIGURED_CODE = "models_not_configured" as const;
export interface ModelsNotConfigured {
	/** Safe to render as-is. */
	error: string;
	code: typeof MODELS_NOT_CONFIGURED_CODE;
	/** Slot tiers the refused action needs and found unset. */
	missing: ModelSlotName[];
}
export function modelsNotConfigured(missing: ModelSlotName[]): ModelsNotConfigured {
	return {
		error: "No model configured — set up your models first",
		code: MODELS_NOT_CONFIGURED_CODE,
		missing,
	};
}

export function isModelsRefusal(error: string | undefined): boolean {
	return !!error && error.startsWith(modelsNotConfigured([]).error);
}
export class ModelsNotConfiguredError extends Error {
	readonly envelope: ModelsNotConfigured;
	constructor(missing: ModelSlotName[]) {
		super(modelsNotConfigured(missing).error);
		this.name = "ModelsNotConfiguredError";
		this.envelope = modelsNotConfigured(missing);
	}
}

/** Refusal envelope when a pinned model's provider key is missing. HTTP
 * callers get 503 + this JSON; in-band consumers carry only the `error`
 * line. */
export const PROVIDER_KEY_MISSING_CODE = "provider_key_missing" as const;
export interface ProviderKeyMissing {
	/** Safe to render as-is. */
	error: string;
	code: typeof PROVIDER_KEY_MISSING_CODE;
	provider: string;
	/** Slot tiers the refused action resolves to that provider. */
	slots: ModelSlotName[];
}
const PROVIDER_KEY_MISSING_TAIL = "key is set — add one in Settings → Keys";
export function providerKeyMissing(provider: string, slots: ModelSlotName[]): ProviderKeyMissing {
	const label = AUTH_PROVIDER_KEYS.find((p) => p.id === provider)?.label ?? provider;
	return {
		error: `No ${label} ${PROVIDER_KEY_MISSING_TAIL}`,
		code: PROVIDER_KEY_MISSING_CODE,
		provider,
		slots,
	};
}
export function isProviderKeyRefusal(error: string | undefined): boolean {
	return !!error && error.endsWith(PROVIDER_KEY_MISSING_TAIL);
}
export class ProviderKeyMissingError extends Error {
	readonly envelope: ProviderKeyMissing;
	constructor(provider: string, slots: ModelSlotName[]) {
		const envelope = providerKeyMissing(provider, slots);
		super(envelope.error);
		this.name = "ProviderKeyMissingError";
		this.envelope = envelope;
	}
}

/** Resolution treats a slot without a model as unset (its level is inert). */
export interface ModelSlot {
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
}

export interface ModelsSettings {
	strong?: ModelSlot;
	cheap?: ModelSlot;
	vision?: ModelSlot;
}

export function slotsConfigured(models: ModelsSettings | undefined): boolean {
	return Boolean(models?.strong?.model && models?.cheap?.model && models?.vision?.model);
}

export const ROLE_SLOT: Readonly<Record<ModelRole, ModelSlotName>> = {
	prober: "strong",
	teacher: "strong",
	researcher: "cheap",
	demoBuilder: "cheap",
	extractor: "cheap",
	auditor: "cheap",
	visualMaker: "vision",
	pdfReader: "vision",
};

export interface GeneralSettings {
	/** A day counts as met at >= this. Integer DAILY_GOAL_MIN..DAILY_GOAL_MAX. */
	dailyGoalMinutes?: number;
}

export interface AgentSettings {
	/** Absent role = config pin. */
	models?: Partial<Record<BackgroundModelRole, RoleModelOverride>>;
	/** Keyed by tool id; absent key = enabled. */
	tools?: Record<string, boolean>;
	/** Optional: a present key auto-activates its engine. An explicit choice
	 *  only pins the preference; the chosen engine must still have its key,
	 *  else search is unavailable. Absent + no key = unavailable. */
	search?: { engine?: SearchEngineId };
	/** Absent = enabled. The effective gate is graph.enabled AND this. */
	graphTools?: { enabled?: boolean };
	/** Keyed by segment path; absent key = off. Switch-on requires the
	 *  override file to exist. */
	prompts?: Record<string, boolean>;
}

export interface MdRenderingSettings {
	/** 100–900. */
	headingWeight?: number;
	boldColor?: string | null;
	italicColor?: string | null;
}

export type ThemeMode = "system" | "light" | "dark";

export interface AppearanceSettings {
	/** "system" follows the OS preference. */
	mode?: ThemeMode;
	/** null = the mode's default background. */
	background?: string | null;
	/** Font name; null = the default prose font. */
	fontFamily?: string | null;
	/** px, PROSE_FONT_MIN..PROSE_FONT_MAX. Headings scale from this. */
	proseFontSize?: number;
	sessionNameSerif?: boolean;
	mdRendering?: MdRenderingSettings;
}

export interface GraphSettings {
	/** Off = no extraction, no auditor. Stored data is kept either way. */
	enabled?: boolean;
	/** Display switch only: off = the home shows the chains view instead of
	 *  the canvas. Does not affect extraction or any write path. */
	rendering?: boolean;
	/** Extraction fires when a chat's uncovered transcript tokens reach this,
	 *  batching the oldest uncovered messages into runs of <= this many
	 *  tokens. Floor EXTRACTION_CHUNK_TOKENS_FLOOR (each run pays the
	 *  graph-carrying prompt overhead); no ceiling. */
	extractionChunkTokens?: number;
}

/**
 * The compaction trigger, in context tokens. The effective trigger is
 * min(this, model contextWindow − 16k reserve). Floor
 * COMPACTION_THRESHOLD_FLOOR (below the kept tail + a summary the chat would
 * re-compact every turn); no ceiling.
 */
export interface CompactionSettings {
	thresholdTokens?: number;
}

/** Written only by /api/providers/custom, never by PUT
 *  /api/settings/[section]. Unknown keys are preserved. */
export interface ProvidersSettings {
	custom?: CustomProviderEntry[];
	[key: string]: unknown;
}

export interface UserSettings {
	version: number;
	general?: GeneralSettings;
	agent?: AgentSettings;
	models?: ModelsSettings;
	appearance?: AppearanceSettings;
	graph?: GraphSettings;
	compaction?: CompactionSettings;
	providers?: ProvidersSettings;
	[key: string]: unknown;
}

/** No factory models exist; tools default on and prompts default off,
 *  hence their absence here. */
export interface FactorySettings {
	version: number;
	general: Required<GeneralSettings>;
	appearance: {
		mode: ThemeMode;
		background: string | null;
		fontFamily: string | null;
		proseFontSize: number;
		sessionNameSerif: boolean;
		mdRendering: {
			headingWeight: number;
			boldColor: string | null;
			italicColor: string | null;
		};
	};
	graph: Required<GraphSettings>;
	compaction: Required<CompactionSettings>;
}

export const FACTORY_SETTINGS: FactorySettings = {
	version: CURRENT_SETTINGS_VERSION,
	general: { dailyGoalMinutes: 30 },
	appearance: {
		mode: "system",
		background: null,
		fontFamily: null,
		proseFontSize: 17,
		sessionNameSerif: true,
		mdRendering: { headingWeight: 600, boldColor: null, italicColor: null },
	},
	graph: { enabled: true, rendering: true, extractionChunkTokens: 4096 },
	compaction: { thresholdTokens: 150_000 },
};

/** The sanitizer clamps to this; the settings PUT rejects below it. */
export const EXTRACTION_CHUNK_TOKENS_FLOOR = 500;

const PROSE_FONT_MIN = 12;
const PROSE_FONT_MAX = 24;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** #rgb / #rrggbb only. */
export function isHexColor(value: string): boolean {
	return /^#[0-9a-fA-F]{3}$/.test(value) || /^#[0-9a-fA-F]{6}$/.test(value);
}

function sanitizeHexOrNull(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value === "string" && isHexColor(value)) return value;
	return null;
}

const boolOrDrop = (value: unknown): boolean | undefined =>
	typeof value === "boolean" ? value : undefined;

/** The sanitizer clamps; the PUT rejects outside them. */
export const DAILY_GOAL_MIN = 5;
export const DAILY_GOAL_MAX = 240;

function sanitizeGeneral(raw: Record<string, unknown>): GeneralSettings {
	const out: GeneralSettings = {};
	if (typeof raw.dailyGoalMinutes === "number" && Number.isFinite(raw.dailyGoalMinutes)) {
		out.dailyGoalMinutes = clamp(Math.round(raw.dailyGoalMinutes), DAILY_GOAL_MIN, DAILY_GOAL_MAX);
	}
	return out;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function sanitizeRoleOverride(raw: unknown): RoleModelOverride | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const out: RoleModelOverride = {};
	if (
		typeof r.model === "object" &&
		r.model !== null &&
		!Array.isArray(r.model) &&
		typeof (r.model as Record<string, unknown>).provider === "string" &&
		typeof (r.model as Record<string, unknown>).id === "string"
	) {
		out.model = {
			provider: (r.model as { provider: string }).provider,
			id: (r.model as { id: string }).id,
		};
	}
	if (typeof r.thinkingLevel === "string" && THINKING_LEVELS.includes(r.thinkingLevel as ThinkingLevel)) {
		out.thinkingLevel = r.thinkingLevel as ThinkingLevel;
	}
	return Object.keys(out).length ? out : undefined;
}

function sanitizeModels(raw: Record<string, unknown>): ModelsSettings {
	const out: ModelsSettings = {};
	for (const slot of MODEL_SLOTS) {
		const cleaned = sanitizeRoleOverride(raw[slot]);
		if (cleaned) out[slot] = cleaned;
	}
	return out;
}

function sanitizeBooleanMap(raw: unknown): Record<string, boolean> | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "boolean") out[key] = value;
	}
	return Object.keys(out).length ? out : undefined;
}

function sanitizeAgent(raw: Record<string, unknown>): AgentSettings {
	const out: AgentSettings = {};
	if (raw.models !== null && typeof raw.models === "object" && !Array.isArray(raw.models)) {
		const models: Partial<Record<BackgroundModelRole, RoleModelOverride>> = {};
		for (const [role, override] of Object.entries(raw.models as Record<string, unknown>)) {
			if ((BACKGROUND_MODEL_ROLES as readonly string[]).includes(role)) {
				const cleaned = sanitizeRoleOverride(override);
				if (cleaned) models[role as BackgroundModelRole] = cleaned;
			}
		}
		if (Object.keys(models).length) out.models = models;
	}
	const tools = sanitizeBooleanMap(raw.tools);
	if (tools) out.tools = tools;
	const prompts = sanitizeBooleanMap(raw.prompts);
	if (prompts) out.prompts = prompts;
	// Lenient read side: an unknown engine id drops; the write-side parser is strict.
	if (raw.search !== null && typeof raw.search === "object" && !Array.isArray(raw.search)) {
		const engine = (raw.search as Record<string, unknown>).engine;
		if (engine === "tavily" || engine === "brave") out.search = { engine };
	}
	// Lenient read side: a bad shape drops the key; the write-side parser is strict.
	if (raw.graphTools !== null && typeof raw.graphTools === "object" && !Array.isArray(raw.graphTools)) {
		const enabled = (raw.graphTools as Record<string, unknown>).enabled;
		if (enabled === undefined) out.graphTools = {};
		else if (typeof enabled === "boolean") out.graphTools = { enabled };
	}
	return out;
}

function sanitizeMdRendering(raw: unknown): MdRenderingSettings {
	const out: MdRenderingSettings = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
	const r = raw as Record<string, unknown>;
	if (typeof r.headingWeight === "number" && Number.isFinite(r.headingWeight)) {
		out.headingWeight = clamp(Math.round(r.headingWeight), 100, 900);
	}
	if (r.boldColor !== undefined) out.boldColor = sanitizeHexOrNull(r.boldColor);
	if (r.italicColor !== undefined) out.italicColor = sanitizeHexOrNull(r.italicColor);
	return out;
}

function sanitizeAppearance(raw: Record<string, unknown>): AppearanceSettings {
	const out: AppearanceSettings = {};
	if (raw.mode === "system" || raw.mode === "light" || raw.mode === "dark") out.mode = raw.mode;
	if (raw.background !== undefined) out.background = sanitizeHexOrNull(raw.background);
	if (raw.fontFamily !== undefined) {
		out.fontFamily = typeof raw.fontFamily === "string" && raw.fontFamily.trim() ? raw.fontFamily : null;
	}
	if (typeof raw.proseFontSize === "number" && Number.isFinite(raw.proseFontSize)) {
		out.proseFontSize = clamp(Math.round(raw.proseFontSize), PROSE_FONT_MIN, PROSE_FONT_MAX);
	}
	const sessionNameSerif = boolOrDrop(raw.sessionNameSerif);
	if (sessionNameSerif !== undefined) out.sessionNameSerif = sessionNameSerif;
	if (raw.mdRendering !== undefined) out.mdRendering = sanitizeMdRendering(raw.mdRendering);
	return out;
}

function sanitizeGraph(raw: Record<string, unknown>): GraphSettings {
	// Unknown graph keys are dropped by this reconstruction. A stored
	// extractionChunkTokens below the floor clamps up: the floor is a cost
	// protection, not data to honor.
	const out: GraphSettings = {};
	const enabled = boolOrDrop(raw.enabled);
	if (enabled !== undefined) out.enabled = enabled;
	const rendering = boolOrDrop(raw.rendering);
	if (rendering !== undefined) out.rendering = rendering;
	const rawTokens = raw.extractionChunkTokens;
	if (typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens > 0) {
		out.extractionChunkTokens = Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.floor(rawTokens));
	}
	return out;
}

/** The sanitizer clamps to this; the settings PUT rejects below it. */
export const COMPACTION_THRESHOLD_FLOOR = 32_000;

function sanitizeCompaction(raw: Record<string, unknown>): CompactionSettings {
	const out: CompactionSettings = {};
	const rawTokens = raw.thresholdTokens;
	if (typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens > 0) {
		out.thresholdTokens = Math.max(COMPACTION_THRESHOLD_FLOOR, Math.floor(rawTokens));
	}
	return out;
}

function sanitizeProviders(raw: Record<string, unknown>): ProvidersSettings {
	const out: ProvidersSettings = { ...raw };
	delete out.custom;
	const custom = sanitizeCustomProviders(raw.custom);
	if (custom.length) out.custom = custom;
	return out;
}

/** Never throws. Non-objects → null. See the module doc for the contract. */
export function sanitizeUserSettings(raw: unknown): UserSettings | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const out: UserSettings = {
		version: typeof r.version === "number" && Number.isInteger(r.version) && r.version >= 1 ? r.version : CURRENT_SETTINGS_VERSION,
	};
	if (r.general !== null && typeof r.general === "object" && !Array.isArray(r.general)) {
		out.general = sanitizeGeneral(r.general as Record<string, unknown>);
	}
	if (r.agent !== null && typeof r.agent === "object" && !Array.isArray(r.agent)) {
		out.agent = sanitizeAgent(r.agent as Record<string, unknown>);
	}
	if (r.appearance !== null && typeof r.appearance === "object" && !Array.isArray(r.appearance)) {
		out.appearance = sanitizeAppearance(r.appearance as Record<string, unknown>);
	}
	if (r.models !== null && typeof r.models === "object" && !Array.isArray(r.models)) {
		const models = sanitizeModels(r.models as Record<string, unknown>);
		if (Object.keys(models).length) out.models = models;
	}
	if (r.graph !== null && typeof r.graph === "object" && !Array.isArray(r.graph)) {
		out.graph = sanitizeGraph(r.graph as Record<string, unknown>);
		if (r.compaction !== undefined && r.compaction !== null && typeof r.compaction === "object") {
			out.compaction = sanitizeCompaction(r.compaction as Record<string, unknown>);
		}
	}
	if (r.providers !== null && typeof r.providers === "object" && !Array.isArray(r.providers)) {
		out.providers = sanitizeProviders(r.providers as Record<string, unknown>);
	}
	// Unknown top-level keys are preserved, except the retired `chat` section.
	for (const [key, value] of Object.entries(r)) {
		if (key === "chat") continue;
		if (!(key in out)) out[key] = value;
	}
	return out;
}
