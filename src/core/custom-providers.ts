/**
 * CUSTOM OPENAI-COMPATIBLE PROVIDERS (custom-endpoint wave, 2026-10-26):
 * the user points the app at any server that speaks OpenAI's chat
 * completions dialect — a self-hosted vLLM, LM Studio, Ollama's /v1, a
 * Together-style gateway — and its models join the strong/cheap/vision
 * pickers like any built-in provider's.
 *
 * THE RECORD: settings.providers.custom (non-secret — id, name, base URL,
 * the model ids the user typed or probed). THE KEY: optional (local
 * servers need none), stored in the SAME auth.json map as every other
 * provider key under LH_CUSTOM_<SLUG>_API_KEY — written only through
 * /api/providers/custom, never through the generic /api/keys gate.
 *
 * PURE, browser-safe — the shapes, the read-side sanitizer, the write-side
 * parsers, and the id minting. The engine wiring lives in agent/models.ts,
 * the CRUD + probe in server/custom-providers.ts.
 */

/** One custom provider as stored in the settings record. */
export interface CustomProviderEntry {
	/** "custom-<slug>" — minted once from the first name, stable across renames. */
	id: string;
	/** Display name (1..60 chars). */
	name: string;
	/** http(s) URL WITHOUT a trailing slash — the OpenAI base (…/v1). */
	baseUrl: string;
	/** The model ids this endpoint serves (1..50, unique, non-empty). */
	models: string[];
}

/** The GET/POST/PUT view: the stored entry + whether a key is stored. */
export interface CustomProviderView extends CustomProviderEntry {
	keyPresent: boolean;
}

/** The probe route's answer — always HTTP 200; `ok` carries the verdict. */
export type CustomProviderProbeResult = { ok: true; models: string[] } | { ok: false; error: string };

export const CUSTOM_PROVIDER_PREFIX = "custom-";
export const CUSTOM_PROVIDER_ID_RE = /^custom-[a-z0-9-]{1,40}$/;
export const CUSTOM_PROVIDER_NAME_MAX = 60;
export const CUSTOM_PROVIDER_MODELS_MAX = 50;
/** The slug's budget inside the id (the regex's {1,40}). */
const SLUG_MAX = 40;

export function isCustomProviderId(id: string): boolean {
	return CUSTOM_PROVIDER_ID_RE.test(id);
}

/** custom-my-vllm → LH_CUSTOM_MY_VLLM_API_KEY. Slugs are [a-z0-9-], so the
 *  mapping is injective — no two providers can share a key slot. */
export function customProviderEnvVar(id: string): string {
	const slug = id.slice(CUSTOM_PROVIDER_PREFIX.length);
	return `LH_CUSTOM_${slug.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/** Is this env var a custom provider's key slot? Such vars are managed by
 *  the custom routes only — the generic keys API neither lists nor writes
 *  them. */
export function isCustomProviderEnvVar(envVar: string): boolean {
	return /^LH_CUSTOM_[A-Z0-9_]+_API_KEY$/.test(envVar);
}

/** Lowercase, diacritics folded, every other run of non-[a-z0-9] collapsed
 *  to one dash, edges trimmed. Empty (an all-symbol or non-Latin name)
 *  falls back to "provider" — the id is plumbing, the name is what shows. */
export function slugifyProviderName(name: string): string {
	const slug = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "provider";
}

/** "custom-" + the slugified name, de-duplicated against `taken` with
 *  -2, -3, … — the base is cut so the suffixed slug still fits 40 chars. */
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

/** Trimmed, de-duplicated (first wins), blanks dropped; null when anything
 *  is not a string. */
function cleanModelIds(raw: unknown): string[] | null {
	if (!Array.isArray(raw) || raw.some((m) => typeof m !== "string")) return null;
	return [...new Set((raw as string[]).map((m) => m.trim()).filter(Boolean))];
}

// ─── Read side: the settings sanitizer ─────────────────────────────────────

/** Lenient (the sanitizer discipline): an invalid entry DROPS, a duplicate
 *  id keeps the first, a model list over the cap truncates — never throws,
 *  and nothing that would fail the write-side rules survives into use. */
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
		const models = cleanModelIds(r.models)?.slice(0, CUSTOM_PROVIDER_MODELS_MAX);
		if (!models?.length) continue;
		out.push({ id: r.id, name, baseUrl, models });
	}
	return out;
}

// ─── Write side: the route parsers (strict, 400-ready messages) ────────────

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

function parseModels(raw: unknown): CustomProviderParse<string[]> {
	const models = cleanModelIds(raw);
	if (!models) return { ok: false, error: "Models must be a list of model ids" };
	if (models.length === 0) return { ok: false, error: "Add at least one model id" };
	if (models.length > CUSTOM_PROVIDER_MODELS_MAX) {
		return { ok: false, error: `At most ${CUSTOM_PROVIDER_MODELS_MAX} models per provider` };
	}
	return { ok: true, value: models };
}

/** A custom key's paste hygiene: trimmed, non-empty, no whitespace. NO
 *  length floor — self-hosted servers accept whatever token their operator
 *  chose (vLLM's --api-key, a gateway's short secret), so the 12-char
 *  provider floor would reject real keys. */
export function parseCustomProviderKey(raw: unknown): CustomProviderParse<string> {
	const key = typeof raw === "string" ? raw.trim() : "";
	if (!key || /\s/.test(key)) return { ok: false, error: "The API key must be non-empty with no whitespace" };
	return { ok: true, value: key };
}

export interface CustomProviderCreate {
	name: string;
	baseUrl: string;
	models: string[];
	/** Absent = keyless (an empty string counts as absent). */
	apiKey?: string;
}

/** POST body: {name, baseUrl, apiKey?, models}. */
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
	models?: string[];
	/** string = replace the key, null = remove it, absent = untouched. */
	apiKey?: string | null;
}

/** PUT body: any subset of {name, baseUrl, apiKey (string | null), models}. */
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

/** Probe body: {baseUrl, apiKey?}. */
export function parseCustomProviderProbe(body: unknown): CustomProviderParse<{ baseUrl: string; apiKey?: string }> {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "body must be {baseUrl, apiKey?}" };
	}
	const b = body as Record<string, unknown>;
	const baseUrl = parseBaseUrl(b.baseUrl);
	if (!baseUrl.ok) return baseUrl;
	const apiKey = typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : undefined;
	return { ok: true, value: apiKey ? { baseUrl: baseUrl.value, apiKey } : { baseUrl: baseUrl.value } };
}
