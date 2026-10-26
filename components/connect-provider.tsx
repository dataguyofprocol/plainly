"use client";

/**
 * CONNECT A PROVIDER (v4 polish, 2026-10-26) — the first step of setup, in
 * the onboarding artboard's language: "Where should your models run?" as
 * chips, one key field, Connect. Six featured choices (owner pick):
 * OpenAI, OpenRouter, Anthropic, DeepSeek, the Z.AI Coding Plan, and any
 * OpenAI-compatible endpoint (a base URL of the learner's own); every
 * other provider the engine knows sits behind "30+ more".
 *
 * Saving a key dispatches the "keys" settings signal — the setup dialog
 * re-reads the catalog on it and moves on to the model pickers by itself.
 */

import { useEffect, useMemo, useState } from "react";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ProviderMenuList } from "@/components/settings/model-menu";
import type { ProviderKeyInfo } from "@/components/settings/keys-section";

/** Opens setup on the connect screen from anywhere (the ⌘K command,
 *  Settings → Keys). The AppShell's CommandPalette listens. */
export const OPEN_CONNECT_EVENT = "lh:open-connect";

/** The featured providers, in chip order; ids are the engine's. */
export const FEATURED_PROVIDERS: ReadonlyArray<{ id: string; label: string; keyUrl: string }> = [
	{ id: "openai", label: "OpenAI", keyUrl: "https://platform.openai.com/api-keys" },
	{ id: "openrouter", label: "OpenRouter", keyUrl: "https://openrouter.ai/keys" },
	{ id: "anthropic", label: "Anthropic", keyUrl: "https://console.anthropic.com/settings/keys" },
	{ id: "deepseek", label: "DeepSeek", keyUrl: "https://platform.deepseek.com/api_keys" },
	{ id: "zai", label: "Z.AI Coding Plan", keyUrl: "https://z.ai/manage-apikey/apikey-list" },
];

type Choice = { kind: "key"; provider: ProviderKeyInfo; keyUrl: string | null } | { kind: "custom" } | { kind: "more" } | null;

/** Pure: a model-id list from free text (commas, spaces or newlines). */
export function parseModelIds(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

export function ConnectProviderBody({
	providers,
	connected,
}: {
	/** Every provider that takes a plain key (GET /api/keys). */
	providers: ProviderKeyInfo[] | undefined;
	/** Ids of providers already connected (a key or a subscription). */
	connected: readonly string[];
}) {
	const [choice, setChoice] = useState<Choice>(null);
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The OpenAI-compatible form.
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [modelText, setModelText] = useState("");
	const [found, setFound] = useState<string[] | null>(null);
	const [probing, setProbing] = useState(false);

	const byId = useMemo(() => new Map((providers ?? []).map((p) => [p.id, p])), [providers]);
	const featuredIds = new Set(FEATURED_PROVIDERS.map((f) => f.id));
	const more = (providers ?? []).filter((p) => !featuredIds.has(p.id));

	useEffect(() => {
		setError(null);
		setKey("");
	}, [choice]);

	const saveKey = async () => {
		if (choice?.kind !== "key" || !key.trim() || busy) return;
		setBusy(true);
		setError(null);
		const res = await fetch(`/api/keys/${encodeURIComponent(choice.provider.envVar)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: key.trim() }),
		}).catch(() => null);
		setBusy(false);
		if (!res || !res.ok) {
			const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
			setError(res ? (body?.error ?? `Couldn’t save the key (${res.status}).`) : "Couldn’t reach the app’s server. Try again.");
			return;
		}
		setKey("");
		setChoice(null);
		notifySettingsSaved("keys");
	};

	const probe = async () => {
		if (!baseUrl.trim() || probing) return;
		setProbing(true);
		setError(null);
		const res = await fetch("/api/providers/custom/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ baseUrl: baseUrl.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) }),
		}).catch(() => null);
		setProbing(false);
		const body = (await res?.json().catch(() => null)) as { ok?: boolean; models?: string[]; error?: string } | null;
		if (!body?.ok) {
			setFound(null);
			setError(body?.error ?? "Couldn’t reach that endpoint.");
			return;
		}
		setFound(body.models ?? []);
		if (!modelText.trim() && body.models?.length) setModelText(body.models.slice(0, 3).join(", "));
	};

	const saveCustom = async () => {
		const models = parseModelIds(modelText);
		if (!name.trim() || !baseUrl.trim() || models.length === 0 || busy) return;
		setBusy(true);
		setError(null);
		const res = await fetch("/api/providers/custom", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: name.trim(), baseUrl: baseUrl.trim(), models, ...(key.trim() ? { apiKey: key.trim() } : {}) }),
		}).catch(() => null);
		setBusy(false);
		if (!res || !res.ok) {
			const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
			setError(res ? (body?.error ?? `Couldn’t add the provider (${res.status}).`) : "Couldn’t reach the app’s server. Try again.");
			return;
		}
		setName("");
		setBaseUrl("");
		setModelText("");
		setFound(null);
		setChoice(null);
		notifySettingsSaved("keys");
	};

	const chip = (id: string, label: string, on: boolean, onClick: () => void) => (
		<button key={id} type="button" className={`chipbtn ${on ? "on" : ""}`} onClick={onClick} data-testid={`connect-chip-${id}`}>
			{label}
			{connected.includes(id) && <span style={{ marginLeft: 6, color: "var(--good)" }}>✓</span>}
		</button>
	);

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 18 }} data-testid="setup-stage-keys">
			<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
				<span className="flabel">Where should your models run?</span>
				<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
					{FEATURED_PROVIDERS.map((f) => {
						const p = byId.get(f.id);
						if (!p) return null;
						return chip(f.id, f.label, choice?.kind === "key" && choice.provider.id === f.id, () => setChoice({ kind: "key", provider: { ...p, label: f.label }, keyUrl: f.keyUrl }));
					})}
					{chip("custom", "OpenAI-compatible", choice?.kind === "custom", () => setChoice({ kind: "custom" }))}
					{more.length > 0 && chip("more", `${more.length}+ more`, choice?.kind === "more" || (choice?.kind === "key" && !featuredIds.has(choice.provider.id)), () => setChoice({ kind: "more" }))}
				</div>
				<span className="fhint">One key is enough to start. It stays on this Mac and goes only to your provider.</span>
			</div>

			{choice?.kind === "more" && (
				<div className="pop" style={{ borderRadius: 14, padding: 8, maxHeight: 280, overflow: "auto", fontSize: 12.5 }}>
					<ProviderMenuList providers={more} onPick={(p) => setChoice({ kind: "key", provider: p, keyUrl: null })} />
				</div>
			)}

			{choice?.kind === "key" && (
				<form
					style={{ display: "flex", flexDirection: "column", gap: 8 }}
					onSubmit={(e) => {
						e.preventDefault();
						void saveKey();
					}}
				>
					<label className="flabel" htmlFor="connect-key" style={{ display: "flex", justifyContent: "space-between" }}>
						<span>{choice.provider.label} API key</span>
						{choice.keyUrl && (
							<a href={choice.keyUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 500, color: "var(--v-accent)" }}>
								Get a key ↗
							</a>
						)}
					</label>
					<input
						id="connect-key"
						className="finput mono"
						type="password"
						autoFocus
						autoComplete="off"
						spellCheck={false}
						value={key}
						onChange={(e) => setKey(e.target.value)}
						placeholder="Paste your key"
						data-testid="setup-key-input"
						disabled={busy}
					/>
					<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<button type="submit" className="btn tall" disabled={busy || !key.trim()} data-testid="setup-key-save" style={{ borderRadius: 999 }}>
							{busy ? "Connecting…" : "Connect"}
						</button>
						{error && (
							<span role="alert" data-testid="setup-key-error" style={{ fontSize: 12.5, color: "#b3261e" }}>
								{error}
							</span>
						)}
					</div>
				</form>
			)}

			{choice?.kind === "custom" && (
				<form
					style={{ display: "flex", flexDirection: "column", gap: 12 }}
					onSubmit={(e) => {
						e.preventDefault();
						void saveCustom();
					}}
					data-testid="connect-custom"
				>
					<span className="fhint">
						Any server that speaks the OpenAI chat API: a gateway, vLLM, LM Studio, or Ollama’s <span className="mono">/v1</span>.
					</span>
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 10 }}>
						<label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							<span className="flabel">Name</span>
							<input className="finput" value={name} onChange={(e) => setName(e.target.value)} placeholder="My server" autoFocus />
						</label>
						<label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							<span className="flabel">Base URL</span>
							<input className="finput mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} />
						</label>
					</div>
					<label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
						<span className="flabel">
							API key <span style={{ fontWeight: 400, color: "var(--v-muted)" }}>(leave empty for a local server)</span>
						</span>
						<input className="finput mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your key" autoComplete="off" spellCheck={false} />
					</label>
					<label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
						<span className="flabel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
							<span>Models</span>
							<button type="button" className="ghost" style={{ height: 26, fontSize: 12 }} disabled={!baseUrl.trim() || probing} onClick={() => void probe()}>
								{probing ? "Looking…" : "Find models"}
							</button>
						</span>
						<input className="finput mono" value={modelText} onChange={(e) => setModelText(e.target.value)} placeholder="model-id, another-model" spellCheck={false} />
						{found && found.length > 0 && (
							<span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
								{found.slice(0, 24).map((m) => {
									const on = parseModelIds(modelText).includes(m);
									return (
										<button
											key={m}
											type="button"
											className={`chipbtn ${on ? "on" : ""}`}
											style={{ height: 28, fontSize: 12, padding: "0 10px" }}
											onClick={() => {
												const ids = parseModelIds(modelText);
												setModelText((on ? ids.filter((x) => x !== m) : [...ids, m]).join(", "));
											}}
										>
											{m}
										</button>
									);
								})}
							</span>
						)}
						{found && found.length === 0 && <span className="fhint">The server answered but listed no models — type their ids above.</span>}
					</label>
					<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<button type="submit" className="btn tall" style={{ borderRadius: 999 }} disabled={busy || !name.trim() || !baseUrl.trim() || parseModelIds(modelText).length === 0}>
							{busy ? "Adding…" : "Add provider"}
						</button>
						{error && (
							<span role="alert" style={{ fontSize: 12.5, color: "#b3261e" }}>
								{error}
							</span>
						)}
					</div>
				</form>
			)}
		</div>
	);
}
