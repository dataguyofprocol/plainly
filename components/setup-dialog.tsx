"use client";
/**
 * The first-run setup flow (model-slots wave, 2026-09-20, owner design
 * "A — composer CTA + send interception"): chats cannot start until the
 * user has picked all three model slots — there are no defaults for 33
 * providers. The graph view's new-session dock (the app's home, where
 * chats start) shows a "Set up your models" CTA while unconfigured;
 * submitting a topic — or sending on /chat/new — opens THIS dialog with
 * the draft preserved; Save stores the slots — the draft WAITS in the
 * composer, the learner sends it themselves (owner ruling 2026-10-09:
 * saving models must never send the message).
 *
 * STAGED BY DEPENDENCY (owner, 2026-09-20: "first keys, then models —
 * there's no point presenting the model picker before the user has set a
 * key because there are no models to pick then"):
 *   Stage 1 — no keyed provider: a SELF-CONTAINED first-key screen
 *     (zero-keys wave, owner 2026-09-25): provider picker + one key
 *     input + save via PUT /api/keys/:id. The dialog STAYS MOUNTED —
 *     saving dispatches the "keys" signal, the fetch effect re-runs on
 *     it, and the stage flips to the pickers on its own. No Settings
 *     round-trip anymore; the draft lives in the caller's state,
 *     untouched throughout.
 *   Stage 2 — Strong → Cheap → Vision pickers over the FEDERATED catalog
 *     (keyed providers only), the vision slot filtered to image-capable
 *     models, in the app's shared dropdown language (ModelMenuList).
 *     All three required (owner: no skip, no defaults); Save PUTs the
 *     models section and reports onDone(models).
 *
 * Closable without configuring (Esc/backdrop/✕) — browsing the app stays
 * possible; the GATE is the send interception, not the dialog. The
 * settings-dialog visual language: dim backdrop, border rounded-md card,
 * CMU title, z-50.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import type React from "react";
import { type ModelCatalogEntry, type ModelSlotName, type ModelsSettings } from "@/src/core";
import { prettyModel } from "@/components/usage-format";
import { ModelMenuList } from "@/components/settings/model-menu";
import { MenuShell } from "@/components/menu-shell";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { Hint } from "@/components/ui/hint";
import { type ProviderKeyInfo } from "@/components/settings/keys-section";
import { ConnectProviderBody } from "@/components/connect-provider";
import { ChatGPTBackgroundAccess } from "@/components/settings/chatgpt-connection";
import { NativeSubscriptionBackgroundAccess, SubscriptionConnections } from "@/components/settings/subscription-connections";
import { defaultOrderLevel, populateLevel, THINKING_LABEL } from "@/components/thinking-default";
import { ThinkingMenuList } from "@/components/settings/model-menu";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** The pickers' slot identity — same roster language as the Agent
 *  section's slot rows. */
const SLOT_META: Record<ModelSlotName, { label: string; roster: string }> = {
	strong: { label: "Strong", roster: "Prober, teacher" },
	cheap: { label: "Cheap", roster: "Researcher, demo builder, extractor, auditor" },
	vision: { label: "Vision", roster: "Visual maker + PDF reader" },
};
const SLOT_ORDER: readonly ModelSlotName[] = ["strong", "cheap", "vision"];

/** The GET /api/models response fields the flow consumes. */
interface ModelsBody {
	models: ModelCatalogEntry[];
	providers: { id: string; keyPresent: boolean }[];
	/** The three tiers' RESOLVED pins (BYOK: NULL per unset tier) — the
	 *  PREFILL + "needed" marks (owner, 2026-09-22): pinned tiers open
	 *  with their pick, unpinned tiers carry the mark. */
	slots?: Record<ModelSlotName, { model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel } | null>;
}

/** Pure: which stage the flow opens at — no keyed provider = keys first
 *  (owner's dependency ordering). Exported for tests. */
export function setupStage(
	providers: { id: string; keyPresent: boolean }[] | null,
): "keys" | "pickers" {
	if (providers === null) return "keys"; // fetch failed → the honest fallback
	return providers.some((p) => p.keyPresent) ? "pickers" : "keys";
}

/** Prefill (owner, BYOK wave 2026-09-22): each pinned tier opens with its
 *  pick — matched in the FEDERATED catalog (a lapsed key's pin does not
 *  prefill); unpinned tiers stay empty and carry the "needed" mark.
 *  First-run = nothing pinned → all three empty + marked. Exported pure
 *  for tests. */
export function prefillFromSlots(
	models: ModelCatalogEntry[],
	slots: Record<ModelSlotName, { model: { provider: string; id: string } } | null> | undefined,
): Partial<Record<ModelSlotName, ModelCatalogEntry>> {
	const pre: Partial<Record<ModelSlotName, ModelCatalogEntry>> = {};
	for (const slot of SLOT_ORDER) {
		const pin = slots?.[slot];
		const entry = pin?.model
			? models.find((m) => m.provider === pin.model!.provider && m.id === pin.model!.id)
			: undefined;
		if (entry) pre[slot] = entry;
	}
	return pre;
}

/** Level prefill (chunk 2): a pinned tier opens with its STORED level
 *  as-is (Save clamps server-side if the ladder lapsed), else the
 *  ordering's level for that model — the level a fresh pick would
 *  populate (owner: the ordering's only purpose is first assignment).
 *  Exported pure for tests. */
export function prefillLevelFromPin(
	entry: ModelCatalogEntry,
	pin: { thinkingLevel?: ThinkingLevel } | null | undefined,
): ThinkingLevel {
	return populateLevel(pin?.thinkingLevel, entry.supportedLevels);
}

/** Stage 1's pure body — exported for SSR pins. The connect screen
 *  (v4, 2026-10-26: featured chips + "more" + OpenAI-compatible), with
 *  subscriptions as the secondary route below it. */
export function SetupKeysBody({
	providers,
	connected,
}: {
	/** The full provider roster (GET /api/keys providers) — undefined
	 *  while it loads. */
	providers: ProviderKeyInfo[] | undefined;
	/** Provider ids that already have a key. */
	connected: readonly string[];
}) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
			<ConnectProviderBody providers={providers} connected={connected} />
			<div style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
				<span className="flabel" style={{ display: "block", marginBottom: 10 }}>Or use a subscription</span>
				<SubscriptionConnections setup />
			</div>
		</div>
	);
}

export function SetupDialog({
	open,
	onClose,
	/** Saved: the models section landed; the caller marks configured (the
	 *  draft stays put — save never sends). */
	onDone,
	/** Open on the connect screen even when a provider is keyed. */
	connect = false,
}: {
	open: boolean;
	connect?: boolean;
	onClose: () => void;
	onDone: (models: ModelsSettings) => void;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	const [body, setBody] = useState<ModelsBody | null>(null);
	const [failed, setFailed] = useState(false);
	const [picked, setPicked] = useState<Partial<Record<ModelSlotName, ModelCatalogEntry>>>({});
	/** Per-slot thinking level (chunk 2): populated from the ordering on
	 *  every fresh model pick, editable — an explicit pick always wins. */
	const [levels, setLevels] = useState<Partial<Record<ModelSlotName, ThinkingLevel>>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [openMenu, setOpenMenu] = useState<{ slot: ModelSlotName; kind: "model" | "thinking" } | null>(null);
	// Stage 1's provider roster (the connect screen owns its own form state).
	const [keyProviders, setKeyProviders] = useState<ProviderKeyInfo[] | undefined>(undefined);
	// "Connect another provider" from the pickers: back to stage 1 until
	// the next key lands (the keys signal clears it).
	const [addingProvider, setAddingProvider] = useState(false);

	// The keys signal (zero-keys wave): keys-section saves/deletes AND
	// THIS dialog's own first-key save dispatch it; the fetch effect below
	// re-runs on it, so saving a key flips the stage to the pickers with
	// the widened catalog — no restart, no Settings round-trip.
	const [keysTick, setKeysTick] = useState(0);
	useSettingsSaved((section) => {
		if (section === "keys") {
			setKeysTick((t) => t + 1);
			setAddingProvider(false);
		}
	});

	// Fresh /api/models per open AND per keys change — a key saved a
	// moment ago (stage 1's own screen) widens the pickers immediately.
	useEffect(() => {
		if (open) setAddingProvider(connect);
	}, [open, connect]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setBody(null);
		setPicked({});
		setLevels({});
		setError(null);
		fetch("/api/keys")
			.then((r) => r.json())
			.then((b: { providers?: ProviderKeyInfo[] }) => { if (!cancelled) setKeyProviders(b.providers ?? []); })
			.catch(() => { if (!cancelled) setKeyProviders([]); });
		fetch("/api/models")
			.then((r) => { if (!r.ok) throw new Error("Catalog unavailable"); return r.json(); })
			.then((b: ModelsBody) => {
				if (cancelled) return;
				setBody(b);
				setFailed(false);
				// Prefill (owner, 2026-09-22): each pinned tier opens with its
				// pick (matched in the FEDERATED catalog — a lapsed key's pin
				// does not prefill); unpinned tiers stay empty and carry the
				// "needed" mark. First-run = nothing pinned → all three marked.
				const pre = prefillFromSlots(b.models, b.slots);
				setPicked(pre);
				// Levels prefill with the pins (chunk 2): stored level if still
				// supported, else the ordering's level for the pinned model.
				const preLevels: Partial<Record<ModelSlotName, ThinkingLevel>> = {};
				for (const slot of SLOT_ORDER) {
					const entry = pre[slot];
					if (entry) preLevels[slot] = prefillLevelFromPin(entry, b.slots?.[slot]);
				}
				setLevels(preLevels);
			})
			.catch(() => { if (!cancelled) setFailed(true); });
		return () => { cancelled = true; };
	}, [open, keysTick]);

	// Esc + outside-click — layered dismissal, closable WITHOUT
	// configuring (browsing stays possible; the gate is the send
	// interception, not this dialog). An open slot menu eats Esc first
	// (and any click outside it); only a bare Esc closes the dialog.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			// THE ONE-ESC LAW (owner, keyboard round 2026-10-06): claim at
			// the document level before the layered dismissal — every branch
			// below acts, so the window chain (dictation → abort) must
			// never also fire. One Esc, one action.
			e.preventDefault();
			e.stopPropagation();
			if (openMenu !== null) setOpenMenu(null);
			else onClose();
		};
		const onPointerDown = (e: PointerEvent) => {
			if (!(e.target instanceof Element)) return;
			const t = e.target;
			if (openMenu === null) return;
			const triggerTestid =
				openMenu.kind === "model" ? `setup-trigger-${openMenu.slot}` : `setup-thinking-${openMenu.slot}`;
			if (t.closest("[data-lh-menu]") || t.closest(`[data-testid="${triggerTestid}"]`)) return;
			setOpenMenu(null);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [open, onClose, openMenu]);

	if (!open) return null;

	const stage = failed || addingProvider ? "keys" : setupStage(body ? body.providers : null);
	const connected = (body?.providers ?? []).filter((p) => p.keyPresent).map((p) => p.id);
	const allPicked = SLOT_ORDER.every((s) => picked[s]);

	async function save() {
		if (!allPicked || saving) return;
		setSaving(true);
		setError(null);
		const models: ModelsSettings = {};
		for (const slot of SLOT_ORDER) {
			const level = levels[slot];
			models[slot] = {
				model: { provider: picked[slot]!.provider, id: picked[slot]!.id },
				...(level ? { thinkingLevel: level } : {}),
			};
		}
		const res = await fetch("/api/settings/models", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(models),
		}).catch(() => null);
		if (!res || !res.ok) {
			setSaving(false);
			setError(res ? `Save failed: ${(await res.json().catch(() => ({}))).error ?? res.status}` : "Save failed. Check your connection and try again.");
			return;
		}
		notifySettingsSaved("models");
		onDone(models);
	}

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center lh-scrim"
			data-testid="setup-backdrop"
			{...backdropDismiss}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={stage === "keys" ? "Connect a provider" : "Pick your models"}
				data-testid="setup-dialog"
				className="v4 scope settings-dialog-pop flex max-h-[85vh] w-[600px] max-w-[92vw] flex-col overflow-hidden rounded-[22px] border border-border shadow-[0_24px_60px_var(--shadow)]"
				style={{ background: "#fff" }}
				onClick={(e) => e.stopPropagation()}
			>
				<header className="flex shrink-0 items-start gap-3 px-7 pt-6 pb-1">
					<div className="flex min-w-0 flex-col gap-1">
						<h2 className="serif text-[26px] leading-tight tracking-tight">
							{stage === "keys" ? "Connect a provider" : "Pick your models"}
						</h2>
						{stage === "keys" && (
							<p className="text-[13px] text-muted-foreground">Your tutor runs on your own model account. You’ll pick models next.</p>
						)}
					</div>
					<Hint label="Close" binding="escape" side="left">
						<button
							type="button"
							aria-label="Close setup"
							data-testid="setup-close"
							onClick={onClose}
							className="ib ml-auto shrink-0"
						>
							✕
						</button>
					</Hint>
				</header>

				{stage === "keys" ? (
					<div className="flex flex-col overflow-y-auto px-7 pt-4 pb-6">
						{failed ? (
							<p className="text-sm text-foreground">
								Model catalog could not be loaded. Check the connection and retry.
							</p>
						) : (
							<SetupKeysBody providers={keyProviders} connected={connected} />
						)}
					</div>
				) : (
					<div className="flex flex-col gap-4 overflow-y-auto px-7 pt-4 pb-6" data-testid="setup-stage-pickers">
						<p className="text-[13px] text-muted-foreground">
							Pick the model for each tier. All three are required before chats can start.
						</p>
						{SLOT_ORDER.map((slot) => {
							const entry = picked[slot];
							const level = levels[slot];
							const levelsForEntry = entry?.supportedLevels ?? [];
							const catalog =
								slot === "vision" ? body?.models.filter((m) => m.input.includes("image")) : body?.models;
							return (
								<div key={slot} data-testid={`setup-slot-${slot}`} className="flex flex-col gap-1.5">
									<span className="flex items-center gap-1.5">
										<span className="font-ui text-sm text-foreground">{SLOT_META[slot].label}</span>
										{!body?.slots?.[slot]?.model && !picked[slot] && (
											<span
												data-testid={`setup-needed-${slot}`}
												className="rounded-sm border border-border px-1 py-0.5 text-[10px] font-normal text-muted-foreground"
											>
												needed
											</span>
										)}
									</span>
									<span className="text-xs text-muted-foreground/70">{SLOT_META[slot].roster}</span>
									{slot !== "strong" && <><ChatGPTBackgroundAccess provider={entry?.provider} /><NativeSubscriptionBackgroundAccess provider={entry?.provider} /></>}
									<div className="flex items-center gap-2">
										<div className="relative flex-1">
											<button
												type="button"
												aria-label={`${SLOT_META[slot].label} model`}
												data-testid={`setup-trigger-${slot}`}
												aria-expanded={openMenu?.slot === slot && openMenu.kind === "model"}
												onClick={() => setOpenMenu(openMenu?.slot === slot && openMenu.kind === "model" ? null : { slot, kind: "model" })}
												className="flex h-7 min-w-40 w-full items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
											>
												<span className="min-w-0 flex-1 truncate">{entry ? prettyModel(entry.id) : "Pick a model…"}</span>
												<span aria-hidden className="text-muted-foreground">
													▾
												</span>
											</button>
											{/* Anchor by TESTID, not a ref (the settings-section pattern):
											    React attaches a host element's ref AFTER its descendants'
											    layout effects run, so a ref freshly attached in this same
											    commit (menu opening = the ref condition turning true) is
											    still null when MenuShell measures — place() gives up, the
											    menu stays invisible, and only a window resize (which re-runs
											    place()) shows it. querySelector at place time has no such
											    ordering hazard. Live-caught by the owner 2026-10-09: every
											    setup picker opened dead until a window resize. */}
											{openMenu?.slot === slot && openMenu.kind === "model" && (
												<MenuShell
													anchorTestid={`setup-trigger-${slot}`}
													testid={`setup-menu-${slot}`}
													preferredSide="down"
													align="left"
													menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
												>
													<ModelMenuList
														models={catalog}
														effectiveId={entry?.id}
														effectiveProvider={entry?.provider}
														onPick={(m) => {
															setPicked((prev) => ({ ...prev, [slot]: m }));
															// Auto-populate (chunk 2, owner: "populate
															// everywhere"): no explicit level → the
															// ordering's level for the fresh pick; an
															// explicit one rides (Save clamps server-side).
															setLevels((prev) => ({
																...prev,
																[slot]: populateLevel(prev[slot], m.supportedLevels),
															}));
															setOpenMenu(null);
														}}
														footer={catalog && catalog.length === 0 ? "No image-capable models. Add a provider key with access to a vision model." : undefined}
													/>
												</MenuShell>
											)}
										</div>
										{/* Thinking selector (chunk 2): editable, pre-populated from
										    the ordering per picked model — no model, no levels. */}
										<div className="relative">
											<button
												type="button"
												aria-label={`${SLOT_META[slot].label} thinking`}
												data-testid={`setup-thinking-${slot}`}
												aria-expanded={openMenu?.slot === slot && openMenu.kind === "thinking"}
												disabled={!entry}
												onClick={() => setOpenMenu(openMenu?.slot === slot && openMenu.kind === "thinking" ? null : { slot, kind: "thinking" })}
												className="flex h-7 w-24 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40"
											>
												<span className="min-w-0 flex-1 truncate text-left">
													{entry ? (level ? THINKING_LABEL[level] ?? level : "…") : "—"}
												</span>
												<span aria-hidden className="text-muted-foreground">
													▾
												</span>
											</button>
											{openMenu?.slot === slot && openMenu.kind === "thinking" && (
												<MenuShell
													anchorTestid={`setup-thinking-${slot}`}
													testid={`setup-thinking-menu-${slot}`}
													preferredSide="down"
													align="left"
													menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
												>
													<ThinkingMenuList
														levels={levelsForEntry.map(String)}
														effectiveLevel={level}
														onPick={(lv) => {
															setLevels((prev) => ({ ...prev, [slot]: lv as ThinkingLevel }));
															setOpenMenu(null);
														}}
													/>
												</MenuShell>
											)}
										</div>
									</div>
								</div>
							);
						})}
						<div className="flex items-center gap-3">
							<button
								type="button"
								data-testid="setup-save"
								disabled={!allPicked || saving}
								onClick={() => void save()}
								className="btn tall"
								style={{ borderRadius: 999 }}
							>
								{saving ? "Saving…" : "Save models"}
							</button>
							{error && <p className="text-xs text-danger">{error}</p>}
							<button
								type="button"
								data-testid="setup-add-provider"
								onClick={() => setAddingProvider(true)}
								className="ml-auto text-[12.5px] font-semibold text-[var(--v-accent)] hover:underline"
							>
								Connect another provider
							</button>
						</div>
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
