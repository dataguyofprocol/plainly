import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { BackgroundModelRole, ModelSlotName } from "../settings.ts";

/** Costs are USD per 1M tokens. */
export interface ModelCatalogEntry {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	/** The thinking levels this model accepts; the picker lists exactly these. */
	supportedLevels: ThinkingLevel[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	/** Price unknown: `cost` is an all-zero placeholder and must render as unknown, never $0. */
	unpriced?: true;
}

/** Unset thinkingLevel resolves from DEFAULT_THINKING_ORDER at engine build. */
export interface CatalogDefaults {
	model: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
}

/** Role override, then tier slot. Null = no model configured for the role. */
export type RolePins = Record<
	BackgroundModelRole,
	{ model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel } | null
>;

/** Null = the tier holds no model. */
export type SlotPins = Record<
	ModelSlotName,
	{ model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel } | null
>;

export interface ModelCatalogResponse {
	models: ModelCatalogEntry[];
	/** Null when no conversation model is configured. */
	defaults: CatalogDefaults | null;
	rolePins: RolePins;
	slots: SlotPins;
	/** The picker lists models from these providers only. */
	providers: CatalogProvider[];
}

export interface CatalogProvider {
	id: string;
	envVar: string;
	/** Present in env or the auth file. Custom providers are always usable. */
	keyPresent: boolean;
	/** Custom providers only (id "custom-…"). */
	name?: string;
	/** Custom providers only: no key stored, so the endpoint is called without one. */
	keyless?: boolean;
}