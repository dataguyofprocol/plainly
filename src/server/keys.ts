import {
	AUTH_KEYS,
	AUTH_PROVIDER_KEYS,
	AUTH_PROVIDER_ENV_VARS,
	type AuthKeyInfo,
	type AuthKeyStatus,
	genericProviderKeyGuard,
	isKnownAuthKey,
	isProviderEnvVar,
	maskKey,
	validateKeyShape,
} from "../core/auth-keys.ts";
import { isCustomProviderEnvVar, parseCustomProviderKey } from "../core/custom-providers.ts";
import { authStore } from "../store/auth.ts";
import { isSubscriptionProvider, subscriptionConnected } from "../agent/subscription-connections.ts";

// The once-per-process boot record — globalThis anchor (HMR re-imports the
// module; the snapshot must not re-run and misread fill-gapped vars as real
// env). Same pattern as globalThis.__lhExtractionRuns.
interface AuthBoot {
	realEnv: Set<string>;
	fillGap: Set<string>;
}
const BOOT_KEY = Symbol.for("lh.authBoot");

function boot(): AuthBoot {
	const g = globalThis as Record<symbol, AuthBoot | undefined>;
	if (!g[BOOT_KEY]) g[BOOT_KEY] = { realEnv: new Set(), fillGap: new Set() };
	return g[BOOT_KEY];
}

export function isWritableAuthKey(id: string): boolean {
	return isKnownAuthKey(id) || isProviderEnvVar(id);
}

export function providerKeyList() {
	return [...AUTH_PROVIDER_KEYS].sort((a, b) => a.id.localeCompare(b.id));
}

export function envKeysIgnored(): boolean {
	return process.env.LH_IGNORE_ENV_KEYS === "1";
}

export function initAuthEnv(): void {
	const record = boot();
	const fileVars = authStore.authVars();
	const managed = new Set<string>([
		...Object.keys(fileVars),
		...AUTH_KEYS.map((k) => k.id),
		...AUTH_PROVIDER_KEYS.map((p) => p.envVar),
	]);
	if (envKeysIgnored()) {
		// pi-ai reads provider keys from live process.env at every request, so
		// deleting managed env vars is the only way to hide them from engines.
		for (const name of managed) {
			delete process.env[name];
		}
	} else if (record.realEnv.size === 0 && record.fillGap.size === 0) {
		for (const name of managed) {
			if (process.env[name] !== undefined) record.realEnv.add(name);
		}
	}
	for (const [name, value] of Object.entries(fileVars)) {
		if (!isManagedName(name)) continue;
		if (process.env[name] === undefined) {
			process.env[name] = value;
			record.fillGap.add(name);
		}
	}
}

function isManagedName(name: string): boolean {
	return isWritableAuthKey(name) || name in authStore.authVars();
}

export function resolveKeyStatuses(
	fileVars: Record<string, string>,
	env: Record<string, string | undefined>,
	realEnv: ReadonlySet<string>,
	providerEnvVars: ReadonlySet<string> = new Set(),
): AuthKeyStatus[] {
	const ids = new Set<string>([...AUTH_KEYS.map((k) => k.id), ...Object.keys(fileVars).filter((id) => !isCustomProviderEnvVar(id))]);
	for (const envVar of providerEnvVars) {
		if (env[envVar] !== undefined || fileVars[envVar] !== undefined) ids.add(envVar);
	}
	const rows: AuthKeyStatus[] = [];
	for (const id of ids) {
		const envValue = env[id];
		const fileValue = fileVars[id];
		const isRealEnv = realEnv.has(id);
		const live = envValue !== undefined ? envValue : fileValue;
		rows.push({
			id,
			info: AUTH_KEYS.find((k) => k.id === id) ?? null,
			present: live !== undefined,
			masked: live !== undefined ? `${maskKey(live)} (${live.trim().length} chars)` : null,
			source: isRealEnv ? "env" : live !== undefined ? "file" : "none",
			shadowedByEnv: isRealEnv && fileValue !== undefined && envValue !== fileValue,
		});
	}
	return rows;
}

export function keyStatuses(): AuthKeyStatus[] {
	return resolveKeyStatuses(authStore.authVars(), process.env, boot().realEnv, AUTH_PROVIDER_ENV_VARS);
}

export function keyValue(id: string): string | undefined {
	if (envKeysIgnored()) return authStore.authVars()[id];
	return process.env[id] ?? authStore.authVars()[id];
}

export function providerKeyPresent(provider: string): boolean {
	if (isSubscriptionProvider(provider)) return subscriptionConnected(provider);
	const info = AUTH_PROVIDER_KEYS.find((p) => p.id === provider);
	return info ? keyValue(info.envVar) !== undefined : true;
}

export function saveKey(id: string, value: string): { ok: true; status: AuthKeyStatus } | { ok: false; error: string } {
	const shape = isProviderEnvVar(id) ? genericProviderKeyGuard(id, value) : validateKeyShape(id, value);
	if (!shape.ok) return { ok: false, error: shape.error };
	writeKey(id, value.trim());
	return { ok: true, status: keyStatuses().find((s) => s.id === id)! };
}

function writeKey(id: string, trimmed: string): void {
	authStore.setAuthVar(id, trimmed);
	const record = boot();
	if (!record.realEnv.has(id)) {
		process.env[id] = trimmed;
		record.fillGap.add(id);
	}
}

export function saveCustomProviderKey(envVar: string, value: string): { ok: true } | { ok: false; error: string } {
	if (!isCustomProviderEnvVar(envVar)) return { ok: false, error: `"${envVar}" is not a custom provider key` };
	const key = parseCustomProviderKey(value);
	if (!key.ok) return key;
	writeKey(envVar, key.value);
	return { ok: true };
}

export function deleteKey(id: string): AuthKeyStatus {
	removeKey(id);
	return keyStatuses().find((s) => s.id === id)!;
}

function removeKey(id: string): void {
	authStore.deleteAuthVar(id);
	const record = boot();
	if (record.fillGap.has(id) && !record.realEnv.has(id)) {
		delete process.env[id];
		record.fillGap.delete(id);
	}
}

export function deleteCustomProviderKey(envVar: string): void {
	if (isCustomProviderEnvVar(envVar)) removeKey(envVar);
}

initAuthEnv();
