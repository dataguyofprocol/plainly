/**
 * Custom OpenAI-compatible providers' server surface (custom-endpoint wave,
 * 2026-10-26): the CRUD behind /api/providers/custom and the /models probe.
 *
 * Entries live in the settings record (providers.custom — non-secret);
 * keys live in the auth store under LH_CUSTOM_<SLUG>_API_KEY, written only
 * through here (server/keys.ts saveCustomProviderKey — the generic keys
 * API refuses them). Every write re-syncs the engine registry
 * (agent/models.ts syncCustomProviders), so a new endpoint federates into
 * the pickers with no restart.
 *
 * Importing this module registers the settings record as the registry's
 * source — model-catalog.ts imports it, so every catalog/engine path sees
 * custom providers.
 */

import {
	customProviderEnvVar,
	mintCustomProviderId,
	type CustomProviderCreate,
	type CustomProviderEntry,
	type CustomProviderProbeResult,
	type CustomProviderUpdate,
	type CustomProviderView,
} from "../core/custom-providers.ts";
import { setCustomProviderSource, syncCustomProviders } from "../agent/models.ts";
import { settingsStore } from "../store/settings.ts";
import { deleteCustomProviderKey, keyValue, saveCustomProviderKey } from "./keys.ts";

/** The stored entries (sanitized on read by the settings adapter). */
export function customProviderEntries(): CustomProviderEntry[] {
	const custom = settingsStore.readSettings()?.providers?.custom;
	return Array.isArray(custom) ? custom : [];
}

setCustomProviderSource(customProviderEntries);

/** Whether a key is stored (env-first, the keys seam's own lookup). */
export function customProviderKeyPresent(id: string): boolean {
	return keyValue(customProviderEnvVar(id)) !== undefined;
}

function view(entry: CustomProviderEntry): CustomProviderView {
	return { ...entry, keyPresent: customProviderKeyPresent(entry.id) };
}

/** Read-modify-write the providers section; every other key rides along.
 *  Then patch the live registry. */
function writeEntries(entries: CustomProviderEntry[]): void {
	const record = settingsStore.readSettings() ?? { version: 1 };
	const providers = record.providers && typeof record.providers === "object" ? record.providers : {};
	settingsStore.writeSettings({ ...record, providers: { ...providers, custom: entries } });
	syncCustomProviders();
}

export function listCustomProviders(): CustomProviderView[] {
	return customProviderEntries().map(view);
}

/** Mint the id from the name, store the entry, then the key (or clear a
 *  stale one left under the same slot by a hand edit). */
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

/** Partial update — the id never changes (a rename keeps every pin
 *  working). null = unknown id. */
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

/** Remove the entry and its key. Slots pinned to it are left as they are
 *  — the lapsed-pin handling downstream reports them. false = unknown id. */
export function deleteCustomProvider(id: string): boolean {
	const entries = customProviderEntries();
	if (!entries.some((e) => e.id === id)) return false;
	writeEntries(entries.filter((e) => e.id !== id));
	deleteCustomProviderKey(customProviderEnvVar(id));
	return true;
}

// ─── The /models probe ─────────────────────────────────────────────────────

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The probe's network seam — tests swap `fetch` so they never touch the
 *  network (the extraction.importNotes precedent). */
export const customProviderProbe: { fetch: FetchLike } = {
	fetch: (input, init) => fetch(input, init),
};

export const CUSTOM_PROBE_TIMEOUT_MS = 8_000;

/** GET {baseUrl}/models in OpenAI's list format ({data: [{id}]}). Never
 *  throws: every failure is a user-facing reason — unreachable, rejected
 *  key, or not OpenAI-compatible. */
export async function probeCustomProvider(
	input: { baseUrl: string; apiKey?: string },
	fetchFn: FetchLike = customProviderProbe.fetch,
): Promise<CustomProviderProbeResult> {
	let resp: Response;
	try {
		resp = await fetchFn(`${input.baseUrl}/models`, {
			headers: { accept: "application/json", ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}) },
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
	return { ok: true, models };
}
