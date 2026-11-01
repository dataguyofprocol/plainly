/** pi-ai openai-completions `compat.thinkingFormat` values that need no
 *  further configuration (chat-template, baseten and ant-ling need extra
 *  kwargs or a level map). */
export const CUSTOM_THINKING_FORMATS = ["openai", "openrouter", "deepseek", "qwen", "qwen-chat-template", "zai", "together", "string-thinking"] as const;
export type CustomThinkingFormat = (typeof CUSTOM_THINKING_FORMATS)[number];

/** OpenAI-style /models answers carry no capabilities, so unset fields
 *  take CUSTOM_MODEL_DEFAULTS. */
export interface CustomModelEntry {
	id: string;
	vision: boolean;
	thinking: boolean;
	/** Present exactly when `thinking`; defaults to "openai". */
	thinkingFormat?: CustomThinkingFormat;
	contextWindow: number;
	maxTokens: number;
}

export const CUSTOM_MODEL_DEFAULTS = { vision: true, thinking: true, contextWindow: 128_000, maxTokens: 8192 } as const;
export const CUSTOM_CONTEXT_MIN = 1_024;
export const CUSTOM_CONTEXT_MAX = 10_000_000;

export interface CustomProviderEntry {
	/** "custom-<slug>", minted once and stable across renames. */
	id: string;
	/** 1..60 chars. */
	name: string;
	/** http(s) URL without a trailing slash (…/v1). */
	baseUrl: string;
	/** 1..50, unique non-empty ids. */
	models: CustomModelEntry[];
}

export interface CustomProviderView extends CustomProviderEntry {
	keyPresent: boolean;
}

/** Only the fields the server's metadata actually reported. */
export type CustomModelDetected = Partial<Pick<CustomModelEntry, "vision" | "thinking" | "contextWindow" | "maxTokens">>;

/** Always HTTP 200; `ok` carries the verdict. */
export type CustomProviderProbeResult =
	| { ok: true; models: string[]; detected: Record<string, CustomModelDetected> }
	| { ok: false; error: string };

export const CUSTOM_PROVIDER_PREFIX = "custom-";
export const CUSTOM_PROVIDER_ID_RE = /^custom-[a-z0-9-]{1,40}$/;
export const CUSTOM_PROVIDER_NAME_MAX = 60;
export const CUSTOM_PROVIDER_MODELS_MAX = 50;
const SLUG_MAX = 40;

export function isCustomProviderId(id: string): boolean {
	return CUSTOM_PROVIDER_ID_RE.test(id);
}

/** custom-my-vllm → LH_CUSTOM_MY_VLLM_API_KEY. */
export function customProviderEnvVar(id: string): string {
	const slug = id.slice(CUSTOM_PROVIDER_PREFIX.length);
	return `LH_CUSTOM_${slug.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

export function isCustomProviderEnvVar(envVar: string): boolean {
	return /^LH_CUSTOM_[A-Z0-9_]+_API_KEY$/.test(envVar);
}

/** Falls back to "provider" when nothing slug-safe remains. */
export function slugifyProviderName(name: string): string {
	const slug = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "provider";
}

/** De-duplicates against `taken` with -2, -3, …, keeping the slug within
 *  40 chars. */
export function mintCustomProviderId(name: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	const base = slugifyProviderName(name);
	for (let n = 1; ; n++) {
		const suffix = n === 1 ? "" : `-${n}`;
		const head = base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "") || "provider";
		const id = `${CUSTOM_PROVIDER_PREFIX}${head}${suffix}`;
		if (!used.has(id)) return id;
	}
}

/** http(s) only, trimmed, trailing slashes dropped; null when not a URL. */
export function normalizeBaseUrl(raw: string): string | null {
	const value = raw.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	return value;
}

function boundedInt(raw: unknown, min: number, max: number): number | null {
	return typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null;
}

function isThinkingFormat(raw: unknown): raw is CustomThinkingFormat {
	return (CUSTOM_THINKING_FORMATS as readonly unknown[]).includes(raw);
}

export function defaultCustomModel(id: string): CustomModelEntry {
	return settleModel({ id, ...CUSTOM_MODEL_DEFAULTS });
}

function settleModel(m: CustomModelEntry): CustomModelEntry {
	const { thinkingFormat, ...rest } = m;
	return {
		...rest,
		maxTokens: Math.min(m.maxTokens, m.contextWindow),
		...(m.thinking ? { thinkingFormat: thinkingFormat ?? "openai" } : {}),
	};
}

function sanitizeModel(raw: unknown): CustomModelEntry | null {
	if (typeof raw === "string") return raw.trim() ? defaultCustomModel(raw.trim()) : null;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const id = typeof r.id === "string" ? r.id.trim() : "";
	if (!id) return null;
	return settleModel({
		id,
		vision: typeof r.vision === "boolean" ? r.vision : CUSTOM_MODEL_DEFAULTS.vision,
		thinking: typeof r.thinking === "boolean" ? r.thinking : CUSTOM_MODEL_DEFAULTS.thinking,
		...(isThinkingFormat(r.thinkingFormat) ? { thinkingFormat: r.thinkingFormat } : {}),
		contextWindow: boundedInt(r.contextWindow, CUSTOM_CONTEXT_MIN, CUSTOM_CONTEXT_MAX) ?? CUSTOM_MODEL_DEFAULTS.contextWindow,
		maxTokens: boundedInt(r.maxTokens, 1, CUSTOM_CONTEXT_MAX) ?? CUSTOM_MODEL_DEFAULTS.maxTokens,
	});
}

function cleanModels(raw: unknown): CustomModelEntry[] | null {
	if (!Array.isArray(raw)) return null;
	const out: CustomModelEntry[] = [];
	for (const item of raw) {
		const model = sanitizeModel(item);
		if (model && !out.some((m) => m.id === model.id)) out.push(model);
	}
	return out;
}

/** Never throws: invalid entries drop, duplicate ids keep the first, and
 *  model lists over the cap truncate. */
export function sanitizeCustomProviders(raw: unknown): CustomProviderEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: CustomProviderEntry[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
		const r = item as Record<string, unknown>;
		if (typeof r.id !== "string" || !isCustomProviderId(r.id) || out.some((e) => e.id === r.id)) continue;
		if (typeof r.name !== "string") continue;
		const name = r.name.trim();
		if (!name || name.length > CUSTOM_PROVIDER_NAME_MAX) continue;
		const baseUrl = typeof r.baseUrl === "string" ? normalizeBaseUrl(r.baseUrl) : null;
		if (!baseUrl) continue;
		const models = cleanModels(r.models)?.slice(0, CUSTOM_PROVIDER_MODELS_MAX);
		if (!models?.length) continue;
		out.push({ id: r.id, name, baseUrl, models });
	}
	return out;
}

export type CustomProviderParse<T> = { ok: true; value: T } | { ok: false; error: string };

function parseName(raw: unknown): CustomProviderParse<string> {
	const name = typeof raw === "string" ? raw.trim() : "";
	if (!name) return { ok: false, error: "Give the provider a name" };
	if (name.length > CUSTOM_PROVIDER_NAME_MAX) {
		return { ok: false, error: `The name can be at most ${CUSTOM_PROVIDER_NAME_MAX} characters` };
	}
	return { ok: true, value: name };
}

function parseBaseUrl(raw: unknown): CustomProviderParse<string> {
	const baseUrl = typeof raw === "string" ? normalizeBaseUrl(raw) : null;
	return baseUrl
		? { ok: true, value: baseUrl }
		: { ok: false, error: "The base URL must be an http:// or https:// URL, e.g. http://localhost:11434/v1" };
}

function parseModel(raw: unknown): CustomProviderParse<CustomModelEntry> {
	if (typeof raw === "string") return { ok: true, value: defaultCustomModel(raw.trim()) };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as { id?: unknown }).id !== "string") {
		return { ok: false, error: "Models must be a list of model ids" };
	}
	const r = raw as Record<string, unknown>;
	const id = (r.id as string).trim();
	for (const field of ["vision", "thinking"] as const) {
		if (r[field] !== undefined && typeof r[field] !== "boolean") return { ok: false, error: `${id}: ${field} must be true or false` };
	}
	if (r.thinkingFormat !== undefined && !isThinkingFormat(r.thinkingFormat)) {
		return { ok: false, error: `${id}: unknown thinking format "${String(r.thinkingFormat)}"` };
	}
	const contextWindow = r.contextWindow === undefined ? CUSTOM_MODEL_DEFAULTS.contextWindow : boundedInt(r.contextWindow, CUSTOM_CONTEXT_MIN, CUSTOM_CONTEXT_MAX);
	if (contextWindow === null) {
		return { ok: false, error: `${id}: the context window must be a whole number from ${CUSTOM_CONTEXT_MIN.toLocaleString("en-US")} to ${CUSTOM_CONTEXT_MAX.toLocaleString("en-US")} tokens` };
	}
	const maxTokens = r.maxTokens === undefined ? Math.min(CUSTOM_MODEL_DEFAULTS.maxTokens, contextWindow) : boundedInt(r.maxTokens, 1, contextWindow);
	if (maxTokens === null) return { ok: false, error: `${id}: max output must be a whole number from 1 to the context window` };
	return {
		ok: true,
		value: settleModel({
			id,
			vision: (r.vision as boolean | undefined) ?? CUSTOM_MODEL_DEFAULTS.vision,
			thinking: (r.thinking as boolean | undefined) ?? CUSTOM_MODEL_DEFAULTS.thinking,
			...(r.thinkingFormat !== undefined ? { thinkingFormat: r.thinkingFormat as CustomThinkingFormat } : {}),
			contextWindow,
			maxTokens,
		}),
	};
}

function parseModels(raw: unknown): CustomProviderParse<CustomModelEntry[]> {
	if (!Array.isArray(raw)) return { ok: false, error: "Models must be a list of model ids" };
	const models: CustomModelEntry[] = [];
	for (const item of raw) {
		const model = parseModel(item);
		if (!model.ok) return model;
		if (model.value.id && !models.some((m) => m.id === model.value.id)) models.push(model.value);
	}
	if (models.length === 0) return { ok: false, error: "Add at least one model id" };
	if (models.length > CUSTOM_PROVIDER_MODELS_MAX) {
		return { ok: false, error: `At most ${CUSTOM_PROVIDER_MODELS_MAX} models per provider` };
	}
	return { ok: true, value: models };
}

/** No length floor: self-hosted servers accept any operator-chosen token. */
export function parseCustomProviderKey(raw: unknown): CustomProviderParse<string> {
	const key = typeof raw === "string" ? raw.trim() : "";
	if (!key || /\s/.test(key)) return { ok: false, error: "The API key must be non-empty with no whitespace" };
	return { ok: true, value: key };
}

export interface CustomProviderCreate {
	name: string;
	baseUrl: string;
	models: CustomModelEntry[];
	/** Absent = keyless. */
	apiKey?: string;
}

export function parseCustomProviderCreate(body: unknown): CustomProviderParse<CustomProviderCreate> {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "body must be {name, baseUrl, apiKey?, models}" };
	}
	const b = body as Record<string, unknown>;
	const name = parseName(b.name);
	if (!name.ok) return name;
	const baseUrl = parseBaseUrl(b.baseUrl);
	if (!baseUrl.ok) return baseUrl;
	const models = parseModels(b.models);
	if (!models.ok) return models;
	const out: CustomProviderCreate = { name: name.value, baseUrl: baseUrl.value, models: models.value };
	if (b.apiKey !== undefined && b.apiKey !== null && !(typeof b.apiKey === "string" && b.apiKey.trim() === "")) {
		const key = parseCustomProviderKey(b.apiKey);
		if (!key.ok) return key;
		out.apiKey = key.value;
	}
	return { ok: true, value: out };
}

export interface CustomProviderUpdate {
	name?: string;
	baseUrl?: string;
	models?: CustomModelEntry[];
	/** string = replace the key, null = remove it, absent = untouched. */
	apiKey?: string | null;
}

export function parseCustomProviderUpdate(body: unknown): CustomProviderParse<CustomProviderUpdate> {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "body must be {name?, baseUrl?, apiKey?, models?}" };
	}
	const b = body as Record<string, unknown>;
	const out: CustomProviderUpdate = {};
	if (b.name !== undefined) {
		const name = parseName(b.name);
		if (!name.ok) return name;
		out.name = name.value;
	}
	if (b.baseUrl !== undefined) {
		const baseUrl = parseBaseUrl(b.baseUrl);
		if (!baseUrl.ok) return baseUrl;
		out.baseUrl = baseUrl.value;
	}
	if (b.models !== undefined) {
		const models = parseModels(b.models);
		if (!models.ok) return models;
		out.models = models.value;
	}
	if (b.apiKey === null) out.apiKey = null;
	else if (b.apiKey !== undefined) {
		const key = parseCustomProviderKey(b.apiKey);
		if (!key.ok) return key;
		out.apiKey = key.value;
	}
	return { ok: true, value: out };
}

export interface CustomProviderProbeInput {
	baseUrl: string;
	apiKey?: string;
	/** A saved provider whose stored key is sent when no apiKey is given. */
	providerId?: string;
}

export function parseCustomProviderProbe(body: unknown): CustomProviderParse<CustomProviderProbeInput> {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "body must be {baseUrl, apiKey?, providerId?}" };
	}
	const b = body as Record<string, unknown>;
	const baseUrl = parseBaseUrl(b.baseUrl);
	if (!baseUrl.ok) return baseUrl;
	const apiKey = typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : undefined;
	const providerId = typeof b.providerId === "string" && isCustomProviderId(b.providerId) ? b.providerId : undefined;
	return { ok: true, value: { baseUrl: baseUrl.value, ...(apiKey ? { apiKey } : {}), ...(providerId ? { providerId } : {}) } };
}
