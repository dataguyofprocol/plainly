"use client";

import { useEffect, useState } from "react";
import type { CustomModelEntry, CustomProviderView } from "@/src/core";
import { SettingsGroup } from "./controls.tsx";
import { ProviderMark } from "./connection-controls.tsx";
import { CustomModelsField } from "@/components/custom-models-field";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";

export function CustomProvidersGroup() {
	const [providers, setProviders] = useState<CustomProviderView[] | null>(null);
	const [openId, setOpenId] = useState<string | null>(null);

	const reload = () =>
		fetch("/api/providers/custom")
			.then((r) => r.json())
			.then((body: { providers?: CustomProviderView[] }) => setProviders(body.providers ?? []))
			.catch(() => setProviders([]));

	useEffect(() => {
		void reload();
	}, []);
	useSettingsSaved((section) => {
		if (section === "keys") void reload();
	});

	if (!providers || providers.length === 0) return null;

	return (
		<SettingsGroup
			label="OpenAI-compatible endpoints"
			description="Your own servers and gateways. Open one to change its models and what each can do."
			testid="group-custom-providers"
			bare
		>
			<div className="st-card">
				{providers.map((p) =>
					openId === p.id ? (
						<CustomProviderEditor
							key={p.id}
							provider={p}
							onClose={() => setOpenId(null)}
							onSaved={async () => {
								setOpenId(null);
								await reload();
								notifySettingsSaved("keys");
							}}
						/>
					) : (
						<button
							key={p.id}
							type="button"
							className="st-keyrow"
							aria-expanded={false}
							onClick={() => setOpenId(p.id)}
							data-testid={`custom-provider-${p.id}`}
						>
							<ProviderMark label={p.name} />
							<span className="st-text">
								<span className="st-label">{p.name}</span>
								<span className="st-mask">{p.baseUrl}</span>
							</span>
							<span className="pill muted">
								{p.models.length} {p.models.length === 1 ? "model" : "models"}
								{p.models.some((m) => m.vision) ? " · vision" : ""}
							</span>
							<span className="st-act">Edit</span>
						</button>
					),
				)}
			</div>
		</SettingsGroup>
	);
}

function CustomProviderEditor({
	provider,
	onClose,
	onSaved,
}: {
	provider: CustomProviderView;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const [name, setName] = useState(provider.name);
	const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
	const [key, setKey] = useState("");
	const [removeKey, setRemoveKey] = useState(false);
	const [models, setModels] = useState<CustomModelEntry[]>(provider.models);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [onClose]);

	const save = async () => {
		if (busy || !name.trim() || !baseUrl.trim() || models.length === 0) return;
		setBusy(true);
		setError(null);
		const res = await fetch(`/api/providers/custom/${encodeURIComponent(provider.id)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: name.trim(),
				baseUrl: baseUrl.trim(),
				models,
				...(key.trim() ? { apiKey: key.trim() } : removeKey ? { apiKey: null } : {}),
			}),
		}).catch(() => null);
		setBusy(false);
		if (!res || !res.ok) {
			const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
			setError(res ? (body?.error ?? `Couldn’t save (${res.status}).`) : "Couldn’t reach the app’s server. Try again.");
			return;
		}
		await onSaved();
	};

	const remove = async () => {
		setBusy(true);
		const res = await fetch(`/api/providers/custom/${encodeURIComponent(provider.id)}`, { method: "DELETE" }).catch(() => null);
		setBusy(false);
		if (!res || !res.ok) {
			setError("Couldn’t remove the provider. Try again.");
			return;
		}
		await onSaved();
	};

	return (
		<form
			className="su-form cp-editor"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
			data-testid={`custom-provider-${provider.id}-editor`}
		>
			<div className="su-grid">
				<label className="su-field">
					<span className="flabel">Name</span>
					<input className="finput" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
				</label>
				<label className="su-field">
					<span className="flabel">Base URL</span>
					<input className="finput mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
				</label>
			</div>
			<div className="su-field">
				<span className="flabel">
					<label htmlFor={`cp-key-${provider.id}`}>
						API key{" "}
						<span className="fopt">
							· {removeKey ? "will be removed" : provider.keyPresent ? "saved — leave blank to keep it" : "none, optional for a local server"}
						</span>
					</label>
					{provider.keyPresent && !key.trim() && (
						<button type="button" className="ghost sm" onClick={() => setRemoveKey((v) => !v)} data-testid="custom-provider-remove-key">
							{removeKey ? "Keep key" : "Remove key"}
						</button>
					)}
				</span>
				<input
					id={`cp-key-${provider.id}`}
					className="finput mono"
					type="password"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					placeholder={provider.keyPresent ? "Paste a new key" : "Paste your key"}
					autoComplete="off"
					spellCheck={false}
				/>
			</div>
			<CustomModelsField baseUrl={baseUrl} apiKey={key} providerId={provider.id} models={models} onChange={setModels} />
			{error && (
				<span role="alert" className="ferror">
					{error}
				</span>
			)}
			<div className="su-form-actions">
				{confirmDelete ? (
					<>
						<span className="cp-confirm">Remove {provider.name} and its key?</span>
						<button type="button" className="ghost sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
							Keep
						</button>
						<button type="button" className="btn sm danger" onClick={() => void remove()} disabled={busy} data-testid="custom-provider-delete-confirm">
							Remove
						</button>
					</>
				) : (
					<>
						<button type="button" className="btn sm quiet cp-delete" onClick={() => setConfirmDelete(true)} disabled={busy} data-testid="custom-provider-delete">
							Remove provider
						</button>
						<button type="button" className="ghost sm" onClick={onClose} disabled={busy}>
							Cancel
						</button>
						<button type="submit" className="btn sm" disabled={busy || !name.trim() || !baseUrl.trim() || models.length === 0} data-testid="custom-provider-save">
							{busy ? "Saving…" : "Save"}
						</button>
					</>
				)}
			</div>
		</form>
	);
}
