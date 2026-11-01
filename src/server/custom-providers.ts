import {
	CUSTOM_CONTEXT_MAX,
	CUSTOM_CONTEXT_MIN,
	CUSTOM_PROVIDER_MODELS_MAX,
	customProviderEnvVar,
	mintCustomProviderId,
	type CustomModelDetected,
	type CustomProviderCreate,
	type CustomProviderEntry,
	type CustomProviderProbeInput,
	type CustomProviderProbeResult,
	type CustomProviderUpdate,
	type CustomProviderView,
} from "../core/custom-providers.ts";
import { setCustomProviderSource, syncCustomProviders } from "../agent/models.ts";
import { settingsStore } from "../store/settings.ts";
import { deleteCustomProviderKey, keyValue, saveCustomProviderKey } from "./keys.ts";

export function customProviderEntries(): CustomProviderEntry[] {
	const custom = settingsStore.readSettings()?.providers?.custom;
	return Array.isArray(custom) ? custom : [];
}

setCustomProviderSource(customProviderEntries);

export function customProviderKeyPresent(id: string): boolean {
	return keyValue(customProviderEnvVar(id)) !== undefined;
}

function view(entry: CustomProviderEntry): CustomProviderView {
	return { ...entry, keyPresent: customProviderKeyPresent(entry.id) };
}

function writeEntries(entries: CustomProviderEntry[]): void {
	const record = settingsStore.readSettings() ?? { version: 1 };
	const providers = record.providers && typeof record.providers === "object" ? record.providers : {};
	settingsStore.writeSettings({ ...record, providers: { ...providers, custom: entries } });
	syncCustomProviders();
}

export function listCustomProviders(): CustomProviderView[] {
	return customProviderEntries().map(view);
}

export function createCustomProvider(input: CustomProviderCreate): CustomProviderView {
	const entries = customProviderEntries();
	const id = mintCustomProviderId(input.name, entries.map((e) => e.id));
	const entry: CustomProviderEntry = { id, name: input.name, baseUrl: input.baseUrl, models: input.models };
	writeEntries([...entries, entry]);
	const envVar = customProviderEnvVar(id);
	if (input.apiKey !== undefined) saveCustomProviderKey(envVar, input.apiKey);
	else deleteCustomProviderKey(envVar);
	return view(entry);
}

export function updateCustomProvider(id: string, patch: CustomProviderUpdate): CustomProviderView | null {
	const entries = customProviderEntries();
	const current = entries.find((e) => e.id === id);
	if (!current) return null;
	const entry: CustomProviderEntry = {
		...current,
		...(patch.name !== undefined ? { name: patch.name } : {}),
		...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
		...(patch.models !== undefined ? { models: patch.models } : {}),
	};
	writeEntries(entries.map((e) => (e.id === id ? entry : e)));
	const envVar = customProviderEnvVar(id);
	if (patch.apiKey === null) deleteCustomProviderKey(envVar);
	else if (patch.apiKey !== undefined) saveCustomProviderKey(envVar, patch.apiKey);
	return view(entry);
}

export function deleteCustomProvider(id: string): boolean {
	const entries = customProviderEntries();
	if (!entries.some((e) => e.id === id)) return false;
	writeEntries(entries.filter((e) => e.id !== id));
	deleteCustomProviderKey(customProviderEnvVar(id));
	return true;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const customProviderProbe: { fetch: FetchLike } = {
	fetch: (input, init) => fetch(input, init),
};

export const CUSTOM_PROBE_TIMEOUT_MS = 8_000;

/** GET {baseUrl}/models in OpenAI's list format ({data: [{id}]}). Never
 *  throws: every failure is a user-facing reason — unreachable, rejected
 *  key, or not OpenAI-compatible. Capabilities are read where the server
 *  describes them (detectCapabilities below); nothing is guessed. */
export async function probeCustomProvider(
	input: CustomProviderProbeInput,
	fetchFn: FetchLike = customProviderProbe.fetch,
): Promise<CustomProviderProbeResult> {
	const apiKey = input.apiKey ?? (input.providerId ? keyValue(customProviderEnvVar(input.providerId)) : undefined);
	const headers = { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
	let resp: Response;
	try {
		resp = await fetchFn(`${input.baseUrl}/models`, {
			headers,
			signal: AbortSignal.timeout(CUSTOM_PROBE_TIMEOUT_MS),
		});
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return {
			ok: false,
			error: timedOut
				? `No answer from ${input.baseUrl} within ${CUSTOM_PROBE_TIMEOUT_MS / 1000}s — is the server running?`
				: `Could not reach ${input.baseUrl} — is the server running and the URL right?`,
		};
	}
	if (resp.status === 401 || resp.status === 403) {
		return { ok: false, error: `The server refused the request (${resp.status} unauthorized) — check the API key` };
	}
	if (!resp.ok) {
		return { ok: false, error: `The server answered ${resp.status} on /models — it does not look OpenAI-compatible (the base URL usually ends in /v1)` };
	}
	let body: unknown;
	try {
		body = await resp.json();
	} catch {
		return { ok: false, error: "The server's /models answer is not JSON — it does not look OpenAI-compatible (the base URL usually ends in /v1)" };
	}
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) {
		return { ok: false, error: "The server's /models answer has no model list — it does not look OpenAI-compatible" };
	}
	const models = [...new Set(data.flatMap((m) => (typeof m?.id === "string" && m.id.trim() ? [m.id.trim()] : [])))];
	return { ok: true, models, detected: await detectCapabilities(input.baseUrl, data, models, headers, fetchFn) };
}

type Fields = Record<string, unknown>;

function asFields(raw: unknown): Fields | null {
	return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Fields) : null;
}

function tokenCount(raw: unknown, min = 1): number | undefined {
	return typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= CUSTOM_CONTEXT_MAX ? raw : undefined;
}

function strings(raw: unknown): string[] | undefined {
	return Array.isArray(raw) && raw.every((s) => typeof s === "string") ? (raw as string[]) : undefined;
}

function found(d: CustomModelDetected): CustomModelDetected | null {
	const out = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) as CustomModelDetected;
	return Object.keys(out).length ? out : null;
}

/** Extra fields on one /models entry: OpenRouter's architecture.input_modalities,
 *  context_length, top_provider.max_completion_tokens and
 *  supported_parameters; vLLM's max_model_len. */
export function detectFromListEntry(entry: unknown): CustomModelDetected | null {
	const e = asFields(entry);
	if (!e) return null;
	const architecture = asFields(e.architecture);
	const topProvider = asFields(e.top_provider);
	const modalities = strings(architecture?.input_modalities) ?? strings(e.input_modalities);
	const params = strings(e.supported_parameters);
	return found({
		vision: modalities ? modalities.includes("image") : undefined,
		thinking: params ? params.includes("reasoning") || params.includes("include_reasoning") : undefined,
		contextWindow: tokenCount(e.context_length, CUSTOM_CONTEXT_MIN) ?? tokenCount(e.max_model_len, CUSTOM_CONTEXT_MIN) ?? tokenCount(topProvider?.context_length, CUSTOM_CONTEXT_MIN),
		maxTokens: tokenCount(topProvider?.max_completion_tokens) ?? tokenCount(e.max_completion_tokens),
	});
}

/** Ollama's /api/show answer: capabilities ["vision", "thinking", …] and
 *  model_info["<arch>.context_length"]. */
export function detectFromOllamaShow(body: unknown): CustomModelDetected | null {
	const b = asFields(body);
	const capabilities = strings(b?.capabilities);
	const info = asFields(b?.model_info);
	const contextKey = info ? Object.keys(info).find((k) => k.endsWith(".context_length")) : undefined;
	return found({
		vision: capabilities ? capabilities.includes("vision") : undefined,
		thinking: capabilities ? capabilities.includes("thinking") : undefined,
		contextWindow: contextKey ? tokenCount(info![contextKey], CUSTOM_CONTEXT_MIN) : undefined,
	});
}

/** One LM Studio /api/v0/models entry: type "vlm" is a vision model;
 *  the loaded context length when loaded, else the model's maximum. */
export function detectFromLmStudioEntry(entry: unknown): CustomModelDetected | null {
	const e = asFields(entry);
	if (!e) return null;
	return found({
		vision: typeof e.type === "string" ? e.type === "vlm" : undefined,
		contextWindow: tokenCount(e.loaded_context_length, CUSTOM_CONTEXT_MIN) ?? tokenCount(e.max_context_length, CUSTOM_CONTEXT_MIN),
	});
}

async function getJson(fetchFn: FetchLike, url: string, init: RequestInit): Promise<unknown> {
	try {
		const resp = await fetchFn(url, { ...init, signal: AbortSignal.timeout(CUSTOM_PROBE_TIMEOUT_MS) });
		return resp.ok ? await resp.json() : null;
	} catch {
		return null;
	}
}

async function detectCapabilities(
	baseUrl: string,
	data: unknown[],
	models: string[],
	headers: Record<string, string>,
	fetchFn: FetchLike,
): Promise<Record<string, CustomModelDetected>> {
	const out: Record<string, CustomModelDetected> = {};
	const merge = (id: string, d: CustomModelDetected | null) => {
		if (d && models.includes(id)) out[id] = { ...out[id], ...d };
	};
	for (const entry of data) {
		const id = asFields(entry)?.id;
		if (typeof id === "string") merge(id.trim(), detectFromListEntry(entry));
	}
	// The native APIs live at the server root, beside the /v1 base.
	const root = baseUrl.replace(/\/v1$/, "");
	if (root === baseUrl) return out;
	const listed = models.slice(0, CUSTOM_PROVIDER_MODELS_MAX);
	await Promise.all([
		(async () => {
			const version = asFields(await getJson(fetchFn, `${root}/api/version`, { headers }));
			if (typeof version?.version !== "string") return;
			await Promise.all(
				listed.map(async (id) => {
					const show = await getJson(fetchFn, `${root}/api/show`, {
						method: "POST",
						headers: { ...headers, "content-type": "application/json" },
						body: JSON.stringify({ model: id }),
					});
					merge(id, detectFromOllamaShow(show));
				}),
			);
		})(),
		(async () => {
			const list = asFields(await getJson(fetchFn, `${root}/api/v0/models`, { headers }));
			if (!Array.isArray(list?.data)) return;
			for (const entry of list.data) {
				const id = asFields(entry)?.id;
				if (typeof id === "string") merge(id, detectFromLmStudioEntry(entry));
			}
		})(),
	]);
	return out;
}
