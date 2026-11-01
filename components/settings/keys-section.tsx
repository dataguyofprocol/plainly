"use client";

import { useEffect, useRef, useState } from "react";
import { AUTH_KEYS, type AuthKeyStatus } from "@/src/core";
import { SettingsGroup } from "./controls.tsx";
import { SubscriptionConnections } from "./subscription-connections.tsx";
import { CustomProvidersGroup } from "./custom-providers-section.tsx";
import { ProviderMark } from "./connection-controls.tsx";
import { ProviderMenuList } from "./model-menu.tsx";
import { MenuShell } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { OPEN_CONNECT_EVENT } from "@/components/connect-provider";
import { Icon } from "@/components/ui/icon";

export interface ProviderKeyInfo {
	id: string;
	envVar: string;
	label: string;
}

interface KeysResponse {
	keys: AuthKeyStatus[];
	providers?: ProviderKeyInfo[];
}

const TOOL_IDS = AUTH_KEYS.map((k) => k.id) as readonly string[];

export function classifyKeys(
	statuses: readonly AuthKeyStatus[],
	providers: readonly ProviderKeyInfo[] | undefined,
): {
	providerRows: AuthKeyStatus[];
	toolRows: AuthKeyStatus[];
	unknownRows: AuthKeyStatus[];
	addable: ProviderKeyInfo[];
} {
	const byId = new Map(statuses.map((s) => [s.id, s]));
	const isTool = (id: string) => (TOOL_IDS as readonly string[]).includes(id);
	const providerEnv = new Set((providers ?? []).map((p) => p.envVar));
	const synth = (id: string): AuthKeyStatus => ({
		id,
		info: null,
		present: false,
		masked: null,
		source: "none",
		shadowedByEnv: false,
	});
	const providerRows: AuthKeyStatus[] = [];
	const unknownRows: AuthKeyStatus[] = [];
	for (const s of statuses) {
		if (isTool(s.id)) continue;
		if (providerEnv.has(s.id) || (!s.info && providers === undefined)) providerRows.push(s);
		else if (!s.info) unknownRows.push(s);
		// (pre-interlude catalogs: a curated-but-unclassified status still
		// renders as a provider row so nothing disappears)
		else providerRows.push(s);
	}
	return {
		providerRows,
		toolRows: TOOL_IDS.map((id) => byId.get(id) ?? synth(id)),
		unknownRows,
		addable: (providers ?? []).filter((p) => !byId.has(p.envVar)),
	};
}

export function keyStatusLine(status: AuthKeyStatus): string {
	if (!status.present || !status.masked) return "not set";
	const tail = status.masked.replace(/ \((\d+) chars\)$/, "");
	const chars = status.masked.match(/\((\d+) chars\)$/)?.[1] ?? "?";
	return `${tail} · ${chars}${status.source === "env" ? " · env" : ""}`;
}

function maskedTail(status: AuthKeyStatus): string | null {
	if (!status.present || !status.masked) return null;
	return status.masked.replace(/ \((\d+) chars\)$/, "");
}

const TOOL_PURPOSE: Record<string, string> = {
	DEEPGRAM_API_KEY: "Lets you answer out loud instead of typing",
	TAVILY_API_KEY: "Lets the research assistant search the web",
	BRAVE_API_KEY: "Another web search for the research assistant",
};

function KeyTableRow({
	label,
	docsUrl,
	status,
	expanded,
	onToggle,
	onSave,
	onDelete,
	onCancel,
	testid,
	purpose,
}: {
	label: string;
	purpose?: string;
	docsUrl?: string;
	status: AuthKeyStatus;
	expanded: boolean;
	onToggle: () => void;
	onSave: (value: string) => Promise<string | null>;
	onDelete?: () => Promise<void>;
	onCancel: () => void;
	testid: string;
}) {
	const envOwned = status.source === "env";
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function save() {
		if (!value.trim() || busy) return;
		setBusy(true);
		setError(null);
		const err = await onSave(value);
		if (err) setError(err);
		else setValue("");
		setBusy(false);
	}

	if (expanded && !envOwned) {
		return (
			<div data-testid={testid}>
				<div className="st-editor" data-testid={`${testid}-editor`}>
					<ProviderMark label={label} />
					<span className="st-editor-name">{label}</span>
					<input
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void save();
						}}
						placeholder={status.present ? "Paste a new key" : "Paste your key"}
						aria-label={`${label} key`}
						data-testid={`${testid}-input`}
						disabled={busy}
						autoFocus
						spellCheck={false}
						autoComplete="off"
						className="finput sm"
					/>
					{status.present && status.source === "file" && onDelete && (
						<button
							type="button"
							onClick={() => void onDelete()}
							disabled={busy}
							data-testid={`${testid}-delete`}
							className="btn sm quiet"
						>
							Remove
						</button>
					)}
					<button type="button" onClick={onCancel} disabled={busy} data-testid={`${testid}-cancel`} className="ghost sm">
						Cancel
					</button>
					<button
						type="button"
						onClick={() => void save()}
						disabled={busy || !value.trim()}
						data-testid={`${testid}-save`}
						className="btn sm"
					>
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
				{error && (
					<p role="alert" data-testid={`${testid}-error`} className="st-rowerr">
						{error}
					</p>
				)}
			</div>
		);
	}

	const tail = maskedTail(status);
	return (
		<div data-testid={testid} className={envOwned ? "st-envrow" : undefined}>
			<button
				type="button"
				aria-expanded={expanded}
				data-testid={`${testid}-row`}
				onClick={() => !envOwned && onToggle()}
				className={envOwned ? "st-keyrow ro" : "st-keyrow"}
				title={envOwned ? "Set by an environment variable — change it where it is defined" : undefined}
			>
				<ProviderMark label={label} />
				<span className="st-text">
					<span className="st-label">{label}</span>
					{purpose ? (
						<span className="st-desc">{purpose}</span>
					) : (
						tail && (
							<span className="st-mask" data-testid={`${testid}-status`}>
								{tail}
							</span>
						)
					)}
				</span>
				{purpose && tail && (
					<span className="st-mask" data-testid={`${testid}-status`}>
						{tail}
					</span>
				)}
				{!status.present ? (
					<>
						<span className="pill muted">Not set</span>
						{docsUrl && (
							<a
								href={docsUrl}
								target="_blank"
								rel="noreferrer"
								onClick={(e) => e.stopPropagation()}
								className="link st-docs"
							>
								Get a key
								<Icon name="external" size="xs" />
							</a>
						)}
						<span className="st-act">
							<Icon name="plus" size="xs" />
							Add key
						</span>
					</>
				) : envOwned ? (
					<span className="pill muted">From environment</span>
				) : (
					<>
						<span className="pill good">Saved</span>
						<span className="st-act">Replace</span>
					</>
				)}
			</button>
			{error && (
				<p role="alert" data-testid={`${testid}-error`} className="st-rowerr">
					{error}
				</p>
			)}
		</div>
	);
}

function AddProviderRow({
	addable,
	onPick,
}: {
	addable: ProviderKeyInfo[];
	onPick: (p: ProviderKeyInfo) => void;
}) {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (anchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div ref={anchorRef} className="st-actions">
			<button
				type="button"
				aria-expanded={open}
				data-testid="add-provider"
				onClick={() => setOpen((v) => !v)}
				className="ghost sm"
			>
				<Icon name="plus" size="sm" />
				Add provider key
			</button>
			<button
				type="button"
				data-testid="add-custom-provider"
				onClick={() => window.dispatchEvent(new Event(OPEN_CONNECT_EVENT))}
				className="btn sm quiet"
			>
				<Icon name="link" size="sm" />
				Connect an OpenAI-compatible endpoint
			</button>
			{addable.length > 0 && <span className="meta">{addable.length} more providers available</span>}
			{open && (
				<MenuShell
					anchorRef={anchorRef}
					testid="add-provider-menu"
					preferredSide="down"
					align="left"
					menuClass="pop lh-menu mm mid"
				>
					<ProviderMenuList
						providers={addable}
						onPick={(p) => {
							setOpen(false);
							onPick(p);
						}}
					/>
				</MenuShell>
			)}
		</div>
	);
}

export function KeysSection({
	initialRow,
}: {
	initialRow?: string;
}) {
	const [statuses, setStatuses] = useState<AuthKeyStatus[] | null>(null);
	const [providers, setProviders] = useState<ProviderKeyInfo[] | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [openRow, setOpenRow] = useState<string | null>(initialRow ?? null);
	const [adding, setAdding] = useState<ProviderKeyInfo | null>(null);
	const [addError, setAddError] = useState<string | null>(null);

	useEffect(() => {
		if (openRow === null && adding === null) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpenRow(null);
			setAdding(null);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [openRow, adding]);

	const reload = () =>
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: KeysResponse) => {
				setStatuses(body.keys ?? []);
				if (body.providers) setProviders(body.providers);
			})
			.catch(() => setStatuses([]))
			.finally(() => setLoading(false));

	useEffect(() => {
		void reload();
	}, []);

	useEffect(() => {
		if (initialRow !== undefined) setOpenRow(initialRow);
	}, [initialRow]);

	async function saveKey(id: string, value: string): Promise<string | null> {
		const res = await fetch(`/api/keys/${id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			return body.error ?? `Save failed (${res.status})`;
		}
		await reload();
		notifySettingsSaved("keys");
		return null;
	}

	async function deleteKey(id: string): Promise<void> {
		await fetch(`/api/keys/${id}`, { method: "DELETE" }).catch(() => undefined);
		await reload();
		notifySettingsSaved("keys");
	}

	if (loading || statuses === null) {
		return (
			<div className="st-skel" aria-busy="true">
				<span className="sr">Loading keys…</span>
				<span className="skel t" aria-hidden />
				<span className="skel c" aria-hidden />
				<span className="skel c2" aria-hidden />
			</div>
		);
	}

	const { providerRows, toolRows, unknownRows, addable } = classifyKeys(statuses, providers);

	async function saveNewProvider(p: ProviderKeyInfo, value: string) {
		const err = await saveKey(p.envVar, value);
		if (err) setAddError(err);
		else {
			setAdding(null);
			setAddError(null);
		}
	}

	const labelFor = (status: AuthKeyStatus) =>
		providers?.find((p) => p.envVar === status.id)?.label ?? status.info?.label ?? status.id;

	return (
		<>
			<SettingsGroup
				label="Model API keys"
				description="One key is enough to start. Keys stay on this device and go only to that provider."
				testid="group-provider-keys"
				bare
			>
				<div className="st-card">
				{providerRows.length === 0 && !adding && (
					<p className="st-empty">No provider keys yet. Add one to start learning.</p>
				)}
				{providerRows.map((status) => (
					<KeyTableRow
						key={status.id}
						label={labelFor(status)}
						docsUrl={status.info?.docsUrl}
						status={status}
						expanded={openRow === status.id}
						onToggle={() => setOpenRow(openRow === status.id ? null : status.id)}
						onSave={async (v) => {
							const err = await saveKey(status.id, v);
							if (!err) setOpenRow(null);
							return err;
						}}
						onCancel={() => setOpenRow(null)}
						onDelete={() => deleteKey(status.id)}
						testid={`key-${status.id.toLowerCase()}`}
					/>
				))}
				{adding && (
					<div>
						<div className="st-editor" data-testid={`key-${adding.id}-editor`}>
							<ProviderMark label={adding.label} />
							<span className="st-editor-name">{adding.label}</span>
							<AddProviderEditor provider={adding} onSave={(v) => void saveNewProvider(adding, v)} onCancel={() => setAdding(null)} />
						</div>
						{addError && (
							<p role="alert" className="st-rowerr" data-testid={`key-${adding.id}-error`}>
								{addError}
							</p>
						)}
					</div>
				)}
				{unknownRows.length > 0 && <div data-testid="group-unknown-keys">
					{unknownRows.map((status) => <div key={status.id} data-testid={`unknown-${status.id}`} className="st-unknown" title="Not a provider Plainly recognises — kept as is">
						<span>{status.id}</span>
						<span className="st-mask">{status.masked}</span>
					</div>)}
				</div>}
				</div>
				{providers !== undefined && (
					<AddProviderRow
						addable={addable}
						onPick={(p) => {
							setAdding(p);
							setAddError(null);
						}}
					/>
				)}
			</SettingsGroup>

			<CustomProvidersGroup />

			<SettingsGroup
				label="Subscriptions"
				description="Use a plan you already pay for instead of an API key."
				testid="group-subscriptions"
				bare
			>
				<SubscriptionConnections />
			</SettingsGroup>

			{(["Dictation", "Search"] as const).map((label) => <SettingsGroup key={label} label={label} testid={label === "Dictation" ? "group-dictation" : "group-search"}>
				{toolRows.filter((status) => label === "Dictation" ? status.id === "DEEPGRAM_API_KEY" : status.id !== "DEEPGRAM_API_KEY").map((status) => (
					<KeyTableRow
						key={status.id}
						label={status.info?.label ?? status.id}
						purpose={TOOL_PURPOSE[status.id]}
						docsUrl={status.info?.docsUrl}
						status={status}
						expanded={openRow === status.id}
						onToggle={() => setOpenRow(openRow === status.id ? null : status.id)}
						onSave={async (v) => {
							const err = await saveKey(status.id, v);
							if (!err) setOpenRow(null);
							return err;
						}}
						onCancel={() => setOpenRow(null)}
						onDelete={() => deleteKey(status.id)}
						testid={`key-${status.id.toLowerCase()}`}
					/>
				))}
			</SettingsGroup>)}

		</>
	);
}

function AddProviderEditor({
	provider,
	onSave,
	onCancel,
}: {
	provider: ProviderKeyInfo;
	onSave: (value: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState("");
	return (
		<>
			<input
				type="text"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && value.trim()) onSave(value);
				}}
				placeholder="Paste your key"
				aria-label={`${provider.label} key`}
				data-testid={`key-${provider.id}-input`}
				autoFocus
				spellCheck={false}
				autoComplete="off"
				className="finput sm"
			/>
			<button type="button" onClick={onCancel} data-testid={`key-${provider.id}-cancel`} className="ghost sm">
				Cancel
			</button>
			<button
				type="button"
				onClick={() => value.trim() && onSave(value)}
				disabled={!value.trim()}
				data-testid={`key-${provider.id}-save`}
				className="btn sm"
			>
				Save
			</button>
		</>
	);
}
