import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isHexColor, type ChatSettings } from "../core";
import type {
	AgentSettings,
	AppearanceSettings,
	BackgroundModelRole,
	CompactionSettings,
	GeneralSettings,
	GraphSettings,
	ModelsSettings,
	RoleModelOverride,
} from "../core/settings.ts";
import { BACKGROUND_MODEL_ROLES, COMPACTION_THRESHOLD_FLOOR, DAILY_GOAL_MAX, DAILY_GOAL_MIN, EXTRACTION_CHUNK_TOKENS_FLOOR, MODEL_SLOTS } from "../core/settings.ts";
import { WRITABLE_TOOL_KEYS } from "../core/pending.ts";

export type SettingsBodyResult<T> =
	| { ok: true; settings: T }
	| { ok: false; error: string };

export function parseSettingsBody(body: unknown): SettingsBodyResult<ChatSettings> {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "Invalid JSON body" };
	}
	const raw = body as {
		model?: { provider?: unknown; id?: unknown };
		thinkingLevel?: unknown;
	};
	const settings: ChatSettings = {};
	if (raw.model !== undefined) {
		if (
			typeof raw.model !== "object" ||
			raw.model === null ||
			typeof raw.model.provider !== "string" ||
			typeof raw.model.id !== "string"
		) {
			return { ok: false, error: "model must be {provider, id}" };
		}
		settings.model = { provider: raw.model.provider, id: raw.model.id };
	}
	if (raw.thinkingLevel !== undefined) {
		if (typeof raw.thinkingLevel !== "string") {
			return { ok: false, error: "thinkingLevel must be a string" };
		}
		settings.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}
	return { ok: true, settings };
}

function asRecord(body: unknown): Record<string, unknown> | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

export function parseGeneralSettingsBody(body: unknown): SettingsBodyResult<GeneralSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: GeneralSettings = {};
	if (raw.dailyGoalMinutes !== undefined) {
		const goal = raw.dailyGoalMinutes;
		if (typeof goal !== "number" || !Number.isInteger(goal) || goal < DAILY_GOAL_MIN || goal > DAILY_GOAL_MAX) {
			return { ok: false, error: `dailyGoalMinutes must be an integer from ${DAILY_GOAL_MIN} to ${DAILY_GOAL_MAX}` };
		}
		settings.dailyGoalMinutes = goal;
	}
	return { ok: true, settings };
}

function parseRoleOverride(value: unknown, role: string): { ok: true; override: RoleModelOverride } | { ok: false; error: string } {
	const raw = asRecord(value);
	if (!raw) return { ok: false, error: `${role} must be an object` };
	const override: RoleModelOverride = {};
	if (raw.model !== undefined) {
		if (
			typeof raw.model !== "object" ||
			raw.model === null ||
			typeof (raw.model as Record<string, unknown>).provider !== "string" ||
			typeof (raw.model as Record<string, unknown>).id !== "string"
		) {
			return { ok: false, error: `${role}.model must be {provider, id}` };
		}
		override.model = {
			provider: (raw.model as { provider: string }).provider,
			id: (raw.model as { id: string }).id,
		};
	}
	if (raw.thinkingLevel !== undefined) {
		if (typeof raw.thinkingLevel !== "string") {
			return { ok: false, error: `${role}.thinkingLevel must be a string` };
		}
		override.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}
	return { ok: true, override };
}

function parseBooleanMap(value: unknown, field: string): { map?: Record<string, boolean>; error?: string } {
	if (value === undefined) return {};
	const raw = asRecord(value);
	if (!raw) return { error: `${field} must be an object` };
	const out: Record<string, boolean> = {};
	for (const [key, entry] of Object.entries(raw)) {
		if (typeof entry !== "boolean") return { error: `${field}.${key} must be a boolean` };
		out[key] = entry;
	}
	return { map: out };
}

export function parseAgentSettingsBody(body: unknown): SettingsBodyResult<AgentSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: AgentSettings = {};
	if (raw.models !== undefined) {
		const models = asRecord(raw.models);
		if (!models) return { ok: false, error: "models must be an object" };
		const known = BACKGROUND_MODEL_ROLES as readonly string[];
		const parsed: NonNullable<AgentSettings["models"]> = {};
		for (const [role, value] of Object.entries(models)) {
			if (!known.includes(role)) {
				return { ok: false, error: `unknown role "${role}" (supported: ${known.join(", ")})` };
			}
			const override = parseRoleOverride(value, role);
			if (!override.ok) return { ok: false, error: override.error };
			if (Object.keys(override.override).length) parsed[role as BackgroundModelRole] = override.override;
		}
		if (Object.keys(parsed).length) settings.models = parsed;
	}
	const tools = parseBooleanMap(raw.tools, "tools");
	if (tools.error) return { ok: false, error: tools.error };
	if (tools.map) {
		const supported = WRITABLE_TOOL_KEYS as readonly string[];
		for (const key of Object.keys(tools.map)) {
			if (!supported.includes(key)) {
				return { ok: false, error: `unknown tool "${key}" (supported: ${supported.join(", ")})` };
			}
		}
		settings.tools = tools.map;
	}
	const prompts = parseBooleanMap(raw.prompts, "prompts");
	if (prompts.error) return { ok: false, error: prompts.error };
	if (prompts.map) settings.prompts = prompts.map;
	if (raw.search !== undefined) {
		const search = asRecord(raw.search);
		if (!search) return { ok: false, error: "search must be an object" };
		if (search.engine !== undefined) {
			if (search.engine !== "tavily" && search.engine !== "brave") {
				return { ok: false, error: 'search.engine must be "tavily" or "brave"' };
			}
			settings.search = { engine: search.engine };
		}
	}
	if (raw.graphTools !== undefined) {
		const graphTools = asRecord(raw.graphTools);
		if (!graphTools) return { ok: false, error: "graphTools must be an object" };
		if (graphTools.enabled !== undefined && typeof graphTools.enabled !== "boolean") {
			return { ok: false, error: "graphTools.enabled must be a boolean" };
		}
		settings.graphTools = graphTools.enabled === undefined ? {} : { enabled: graphTools.enabled };
	}
	return { ok: true, settings };
}

function parseHexOrNull(value: unknown, field: string): { color?: string | null; error?: string } {
	if (value === null) return { color: null };
	if (typeof value !== "string" || !isHexColor(value)) {
		return { error: `${field} must be a #hex color or null` };
	}
	return { color: value };
}

export function parseAppearanceSettingsBody(body: unknown): SettingsBodyResult<AppearanceSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: AppearanceSettings = {};
	if (raw.mode !== undefined) {
		if (raw.mode !== "system" && raw.mode !== "light" && raw.mode !== "dark") {
			return { ok: false, error: "mode must be \"system\", \"light\" or \"dark\"" };
		}
		settings.mode = raw.mode;
	}
	if (raw.background !== undefined) {
		const parsed = parseHexOrNull(raw.background, "background");
		if (parsed.error) return { ok: false, error: parsed.error };
		settings.background = parsed.color ?? null;
	}
	if (raw.fontFamily !== undefined) {
		if (raw.fontFamily !== null && (typeof raw.fontFamily !== "string" || !raw.fontFamily.trim())) {
			return { ok: false, error: "fontFamily must be a non-empty string or null" };
		}
		settings.fontFamily = raw.fontFamily as string | null;
	}
	if (raw.proseFontSize !== undefined) {
		if (
			typeof raw.proseFontSize !== "number" ||
			!Number.isInteger(raw.proseFontSize) ||
			raw.proseFontSize < 12 ||
			raw.proseFontSize > 24
		) {
			return { ok: false, error: "proseFontSize must be an integer between 12 and 24" };
		}
		settings.proseFontSize = raw.proseFontSize;
	}
	if (raw.sessionNameSerif !== undefined) {
		if (typeof raw.sessionNameSerif !== "boolean") {
			return { ok: false, error: "sessionNameSerif must be a boolean" };
		}
		settings.sessionNameSerif = raw.sessionNameSerif;
	}
	if (raw.mdRendering !== undefined) {
		const md = asRecord(raw.mdRendering);
		if (!md) return { ok: false, error: "mdRendering must be an object" };
		const rendering: NonNullable<AppearanceSettings["mdRendering"]> = {};
		if (md.headingWeight !== undefined) {
			if (
				typeof md.headingWeight !== "number" ||
				!Number.isInteger(md.headingWeight) ||
				md.headingWeight < 100 ||
				md.headingWeight > 900
			) {
				return { ok: false, error: "mdRendering.headingWeight must be an integer between 100 and 900" };
			}
			rendering.headingWeight = md.headingWeight;
		}
		if (md.boldColor !== undefined) {
			const parsed = parseHexOrNull(md.boldColor, "mdRendering.boldColor");
			if (parsed.error) return { ok: false, error: parsed.error };
			rendering.boldColor = parsed.color ?? null;
		}
		if (md.italicColor !== undefined) {
			const parsed = parseHexOrNull(md.italicColor, "mdRendering.italicColor");
			if (parsed.error) return { ok: false, error: parsed.error };
			rendering.italicColor = parsed.color ?? null;
		}
		if (Object.keys(rendering).length) settings.mdRendering = rendering;
	}
	return { ok: true, settings };
}

export function parseGraphSettingsBody(body: unknown): SettingsBodyResult<GraphSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: GraphSettings = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
		settings.enabled = raw.enabled;
	}
	if (raw.rendering !== undefined) {
		if (typeof raw.rendering !== "boolean") return { ok: false, error: "rendering must be a boolean" };
		settings.rendering = raw.rendering;
	}
	if (raw.extractionChunkTokens !== undefined) {
		if (typeof raw.extractionChunkTokens !== "number" || !Number.isFinite(raw.extractionChunkTokens)) {
			return { ok: false, error: "extractionChunkTokens must be a number" };
		}
		const floored = Math.floor(raw.extractionChunkTokens);
		if (floored < EXTRACTION_CHUNK_TOKENS_FLOOR) {
			return {
				ok: false,
				error: `extractionChunkTokens must be at least ${EXTRACTION_CHUNK_TOKENS_FLOOR} (smaller batches waste the per-run graph overhead)`,
			};
		}
		settings.extractionChunkTokens = floored;
	}
	return { ok: true, settings };
}

export function parseModelsSettingsBody(body: unknown): SettingsBodyResult<ModelsSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: ModelsSettings = {};
	for (const key of Object.keys(raw)) {
		const known = MODEL_SLOTS as readonly string[];
		if (!known.includes(key)) {
			return { ok: false, error: `unknown slot "${key}" (supported: ${known.join(", ")})` };
		}
		const parsed = parseRoleOverride(raw[key], key);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		if (!parsed.override.model) {
			return { ok: false, error: `slot "${key}" must set a model (thinkingLevel alone cannot run — absent slot = unset)` };
		}
		settings[key as (typeof MODEL_SLOTS)[number]] = parsed.override;
	}
	return { ok: true, settings };
}

export function parseCompactionSettingsBody(body: unknown): SettingsBodyResult<CompactionSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: CompactionSettings = {};
	if (raw.thresholdTokens !== undefined) {
		if (typeof raw.thresholdTokens !== "number" || !Number.isFinite(raw.thresholdTokens)) {
			return { ok: false, error: "thresholdTokens must be a number" };
		}
		const floored = Math.floor(raw.thresholdTokens);
		if (floored < COMPACTION_THRESHOLD_FLOOR) {
			return {
				ok: false,
				error: `thresholdTokens must be at least ${COMPACTION_THRESHOLD_FLOOR} (compaction keeps a ~20k-token recent tail — smaller budgets would churn it)`,
			};
		}
		settings.thresholdTokens = floored;
	}
	return { ok: true, settings };
}

export const SETTINGS_SECTIONS = {
	general: parseGeneralSettingsBody,
	chat: parseSettingsBody,
	agent: parseAgentSettingsBody,
	appearance: parseAppearanceSettingsBody,
	graph: parseGraphSettingsBody,
	compaction: parseCompactionSettingsBody,
	models: parseModelsSettingsBody,
} as const;

export type SettingsSectionName = keyof typeof SETTINGS_SECTIONS;
