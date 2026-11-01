"use client";

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
import { EmptyState } from "@/components/ui/empty-state";
import { type ProviderKeyInfo } from "@/components/settings/keys-section";
import { ConnectProviderBody } from "@/components/connect-provider";
import { ChatGPTBackgroundAccess } from "@/components/settings/chatgpt-connection";
import { NativeSubscriptionBackgroundAccess, SubscriptionConnections } from "@/components/settings/subscription-connections";
import { populateLevel, THINKING_LABEL } from "@/components/thinking-default";
import { levelName, ThinkingMenuList } from "@/components/settings/model-menu";
import { SelectTrigger } from "@/components/settings/controls";
import { Icon } from "@/components/ui/icon";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const SLOT_META: Record<ModelSlotName, { label: string; roster: string }> = {
	strong: { label: "Main model", roster: "Teaches your lessons" },
	cheap: { label: "Helper model", roster: "Researches, builds demos, grades answers" },
	vision: { label: "Vision model", roster: "Draws figures and reads PDFs" },
};
const SLOT_ORDER: readonly ModelSlotName[] = ["strong", "cheap", "vision"];

interface ModelsBody {
	models: ModelCatalogEntry[];
	providers: { id: string; keyPresent: boolean }[];
	slots?: Record<ModelSlotName, { model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel } | null>;
}

export function setupStage(
	providers: { id: string; keyPresent: boolean }[] | null,
): "keys" | "pickers" {
	if (providers === null) return "keys";
	return providers.some((p) => p.keyPresent) ? "pickers" : "keys";
}

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

export function prefillLevelFromPin(
	entry: ModelCatalogEntry,
	pin: { thinkingLevel?: ThinkingLevel } | null | undefined,
): ThinkingLevel {
	return populateLevel(pin?.thinkingLevel, entry.supportedLevels);
}

export function SetupKeysBody({
	providers,
	connected,
}: {
	providers: ProviderKeyInfo[] | undefined;
	connected: readonly string[];
}) {
	return (
		<>
			<ConnectProviderBody providers={providers} connected={connected} />
			<div className="su-or">
				<span className="flabel">Or use a plan you already pay for</span>
				<SubscriptionConnections setup />
			</div>
		</>
	);
}

export function SetupDialog({
	open,
	onClose,
	onDone,
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
	const [levels, setLevels] = useState<Partial<Record<ModelSlotName, ThinkingLevel>>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [openMenu, setOpenMenu] = useState<{ slot: ModelSlotName; kind: "model" | "thinking" } | null>(null);
	const [keyProviders, setKeyProviders] = useState<ProviderKeyInfo[] | undefined>(undefined);
	const [addingProvider, setAddingProvider] = useState(false);

	const [keysTick, setKeysTick] = useState(0);
	const [justConnected, setJustConnected] = useState(false);
	useSettingsSaved((section) => {
		if (section === "keys") {
			setKeysTick((t) => t + 1);
			setAddingProvider(false);
			setJustConnected(true);
		}
	});

	useEffect(() => {
		if (open) {
			setAddingProvider(connect);
			setJustConnected(false);
		}
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
				const pre = prefillFromSlots(b.models, b.slots);
				setPicked(pre);
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

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
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

	const steps = (
		<div className="su-steps" aria-label={stage === "keys" ? "Step 1 of 2" : "Step 2 of 2"}>
			<span className={stage === "keys" ? "su-step on" : "su-step done"}>
				<i>{stage === "keys" ? "1" : <Icon name="check" size="xs" />}</i>
				Connect
			</span>
			<span className="bar" />
			<span className={stage === "keys" ? "su-step" : "su-step on"}>
				<i>2</i>
				Choose models
			</span>
		</div>
	);

	return createPortal(
		<div className="v4 scope">
			<div className="overlay" data-testid="setup-backdrop" {...backdropDismiss}>
				<div
					role="dialog"
					aria-modal="true"
					aria-label={stage === "keys" ? "Connect a provider" : "Pick your models"}
					data-testid="setup-dialog"
					className="dialog su"
					onClick={(e) => e.stopPropagation()}
				>
					<header className="su-head">
						<div>
							{steps}
							<h2 className="t-title">{stage === "keys" ? "Connect a provider" : "Choose your models"}</h2>
							<p>
								{stage === "keys"
									? "Your tutor runs on your own model account. You’ll pick models next."
									: "Each job gets its own model. You can change them any time in Settings."}
							</p>
						</div>
						<Hint label="Close" binding="escape" side="left">
							<button type="button" aria-label="Close setup" data-testid="setup-close" onClick={onClose} className="ib">
								<Icon name="close" size="md" />
							</button>
						</Hint>
					</header>

					{stage === "keys" ? (
						<div className="su-body">
							{failed ? (
								<EmptyState icon="status-warn" title="Couldn’t load your models">
									Model catalog could not be loaded. Check the connection and retry.
								</EmptyState>
							) : (
								<SetupKeysBody providers={keyProviders} connected={connected} />
							)}
						</div>
					) : (
						<>
							<div className="su-body" data-testid="setup-stage-pickers">
								{justConnected && (
									<span className="su-done settle" role="status">
										<Icon name="status-ok" size="sm" />
										Provider connected. Now choose a model for each job.
									</span>
								)}
								<p className="fhint">Pick the model for each tier. All three are required before chats can start.</p>
								<div className="su-slots">
									{SLOT_ORDER.map((slot) => {
										const entry = picked[slot];
										const level = levels[slot];
										const levelsForEntry = entry?.supportedLevels ?? [];
										const catalog =
											slot === "vision" ? body?.models.filter((m) => m.input.includes("image")) : body?.models;
										const modelOpen = openMenu?.slot === slot && openMenu.kind === "model";
										const thinkingOpen = openMenu?.slot === slot && openMenu.kind === "thinking";
										return (
											<div key={slot} data-testid={`setup-slot-${slot}`} className="su-slot">
												<span className="st-text">
													<span className="st-label">
														{SLOT_META[slot].label}
														{!body?.slots?.[slot]?.model && !picked[slot] && (
															<span data-testid={`setup-needed-${slot}`} className="pill muted">
																Required
															</span>
														)}
													</span>
													<span className="st-desc">{SLOT_META[slot].roster}</span>
													{slot !== "strong" && <><ChatGPTBackgroundAccess provider={entry?.provider} /><NativeSubscriptionBackgroundAccess provider={entry?.provider} /></>}
												</span>
												<SelectTrigger
													value={entry ? prettyModel(entry.id) : ""}
													emptyLabel="Choose…"
													ariaLabel={`${SLOT_META[slot].label}`}
													testid={`setup-trigger-${slot}`}
													title={entry ? `${entry.provider} · ${entry.id}` : undefined}
													open={modelOpen}
													onClick={() => setOpenMenu(modelOpen ? null : { slot, kind: "model" })}
												/>
												{/* Anchor by TESTID, not a ref (the settings-section pattern):
												    React attaches a host element's ref AFTER its descendants'
												    layout effects run, so a ref freshly attached in this same
												    commit is still null when MenuShell measures — the menu
												    stayed invisible until a window resize (owner, 2026-10-09). */}
												{modelOpen && (
													<MenuShell
														anchorTestid={`setup-trigger-${slot}`}
														testid={`setup-menu-${slot}`}
														preferredSide="down"
														menuClass="pop lh-menu mm"
													>
														<ModelMenuList
															models={catalog}
															effectiveId={entry?.id}
															effectiveProvider={entry?.provider}
															onPick={(m) => {
																setPicked((prev) => ({ ...prev, [slot]: m }));
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
												<button
													type="button"
													aria-label={`${SLOT_META[slot].label} thinking`}
													data-testid={`setup-thinking-${slot}`}
													aria-expanded={thinkingOpen}
													disabled={!entry}
													onClick={() => setOpenMenu(thinkingOpen ? null : { slot, kind: "thinking" })}
													className="selectbtn st-select narrow disabled:cursor-not-allowed disabled:opacity-40"
												>
													<span className={entry ? undefined : "ph"}>
														{entry ? (level ? levelName(THINKING_LABEL[level] ?? level) : "…") : "—"}
													</span>
													<Icon name="chevrons-up-down" size="sm" />
												</button>
												{thinkingOpen && (
													<MenuShell
														anchorTestid={`setup-thinking-${slot}`}
														testid={`setup-thinking-menu-${slot}`}
														preferredSide="down"
														menuClass="pop lh-menu mm narrow"
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
										);
									})}
								</div>
							</div>
							<footer className="su-foot">
								<button type="button" data-testid="setup-add-provider" onClick={() => setAddingProvider(true)} className="btn sm quiet">
									<Icon name="plus" size="sm" />
									Connect another provider
								</button>
								<span className="grow">{error && <span className="su-err" role="alert">{error}</span>}</span>
								<button
									type="button"
									data-testid="setup-save"
									disabled={!allPicked || saving}
									onClick={() => void save()}
									className="btn brand"
								>
									{saving ? "Saving…" : "Save models"}
								</button>
							</footer>
						</>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
