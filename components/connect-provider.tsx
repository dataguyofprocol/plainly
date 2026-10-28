"use client";

/**
 * CONNECT A PROVIDER (v4 polish, 2026-10-26) — the first step of setup, in
 * the onboarding artboard's language: "Where should your models run?" as
 * chips, one key field, Connect. Six featured choices (owner pick):
 * OpenAI, OpenRouter, Anthropic, DeepSeek, the Z.AI Coding Plan, and any
 * OpenAI-compatible endpoint (a base URL of the learner's own); every
 * other provider the engine knows sits behind "N more".
 *
 * Saving a key dispatches the "keys" settings signal — the setup dialog
 * re-reads the catalog on it and moves on to the model pickers by itself.
 */

import { useEffect, useMemo, useState } from "react";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ProviderMenuList } from "@/components/settings/model-menu";
import type { ProviderKeyInfo } from "@/components/settings/keys-section";
import { ProviderMark } from "@/components/settings/connection-controls";
import { Icon } from "@/components/ui/icon";
import { CustomModelsField } from "@/components/custom-models-field";
import type { CustomModelEntry } from "@/src/core";

export { parseModelIds } from "@/components/custom-models-field";

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
	const [models, setModels] = useState<CustomModelEntry[]>([]);

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

	const saveCustom = async () => {
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
		setModels([]);
		setChoice(null);
		notifySettingsSaved("keys");
	};

	const chip = (id: string, label: string, on: boolean, onClick: () => void, mark?: React.ReactNode) => (
		<button key={id} type="button" className={on ? "su-tile on" : "su-tile"} onClick={onClick} aria-pressed={on} data-testid={`connect-chip-${id}`}>
			{mark ?? <ProviderMark label={label} />}
			<span>{label}</span>
			{connected.includes(id) && (
				<span className="ok" title="Connected">
					<Icon name="check" size="xs" />
				</span>
			)}
		</button>
	);
	const otherPicked = choice?.kind === "key" && !featuredIds.has(choice.provider.id);

	return (
		<div className="su-stage" data-testid="setup-stage-keys">
			<div className="su-field">
				<span className="flabel">Where should your models run?</span>
				<div className="su-tiles">
					{FEATURED_PROVIDERS.map((f) => {
						const p = byId.get(f.id);
						if (!p) return null;
						return chip(f.id, f.label, choice?.kind === "key" && choice.provider.id === f.id, () => setChoice({ kind: "key", provider: { ...p, label: f.label }, keyUrl: f.keyUrl }));
					})}
					{chip("custom", "OpenAI-compatible", choice?.kind === "custom", () => setChoice({ kind: "custom" }), (
						<span aria-hidden className="st-avatar">
							<Icon name="link" size="sm" />
						</span>
					))}
					{more.length > 0 &&
						chip("more", otherPicked && choice?.kind === "key" ? choice.provider.label : `${more.length} more`, choice?.kind === "more" || otherPicked, () => setChoice({ kind: "more" }), (
							<span aria-hidden className="st-avatar">
								<Icon name="more" size="sm" />
							</span>
						))}
				</div>
				<span className="fhint">One key is enough to start. It stays on this device and goes only to your provider.</span>
			</div>

			{choice?.kind === "more" && (
				<div className="pop lh-menu su-more settle">
					<ProviderMenuList providers={more} onPick={(p) => setChoice({ kind: "key", provider: p, keyUrl: null })} />
				</div>
			)}

			{choice?.kind === "key" && (
				<form
					className="su-form"
					onSubmit={(e) => {
						e.preventDefault();
						void saveKey();
					}}
				>
					<div className="su-field">
						<label className="flabel" htmlFor="connect-key">
							<span>{choice.provider.label} API key</span>
							{choice.keyUrl && (
								<a href={choice.keyUrl} target="_blank" rel="noreferrer" className="link">
									Get a key
									<Icon name="external" size="xs" />
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
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? "connect-key-error" : undefined}
						/>
						{error ? (
							<span role="alert" id="connect-key-error" data-testid="setup-key-error" className="ferror">
								{error}
							</span>
						) : (
							<span className="fhint">Saved on this device. Your models appear as soon as it connects.</span>
						)}
					</div>
					<div className="su-form-actions">
						<button type="submit" className="btn brand" disabled={busy || !key.trim()} data-testid="setup-key-save">
							{busy ? "Connecting…" : "Connect"}
						</button>
					</div>
				</form>
			)}

			{choice?.kind === "custom" && (
				<form
					className="su-form"
					onSubmit={(e) => {
						e.preventDefault();
						void saveCustom();
					}}
					data-testid="connect-custom"
				>
					<span className="fhint">
						Any server that speaks the OpenAI chat API: a gateway, vLLM, LM Studio, or Ollama’s <span className="mono">/v1</span>.
					</span>
					<div className="su-grid">
						<label className="su-field">
							<span className="flabel">Name</span>
							<input className="finput" value={name} onChange={(e) => setName(e.target.value)} placeholder="My server" autoFocus />
						</label>
						<label className="su-field">
							<span className="flabel">Base URL</span>
							<input className="finput mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} />
						</label>
					</div>
					<label className="su-field">
						<span className="flabel">
							<span>
								API key <span className="fopt">· optional for a local server</span>
							</span>
						</span>
						<input className="finput mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your key" autoComplete="off" spellCheck={false} />
					</label>
					<CustomModelsField baseUrl={baseUrl} apiKey={key} models={models} onChange={setModels} autoFill />
					{error && (
						<span role="alert" className="ferror">
							{error}
						</span>
					)}
					<div className="su-form-actions">
						<button type="submit" className="btn brand" disabled={busy || !name.trim() || !baseUrl.trim() || models.length === 0}>
							{busy ? "Adding…" : "Add provider"}
						</button>
					</div>
				</form>
			)}
		</div>
	);
}
