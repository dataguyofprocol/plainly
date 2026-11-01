"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSettings, ModelCatalogEntry, ModelCatalogResponse, ModelsSettings, UserSettings } from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { prettyModel } from "@/components/usage-format";
import { levelName, ModelMenuList, ThinkingMenuList } from "@/components/settings/model-menu";
import { Icon } from "@/components/ui/icon";
import { composeSlotModel } from "@/components/settings/agent-section";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { notifySettingsSaved, onSettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { defaultOrderLevel, populateLevel, THINKING_LABEL } from "@/components/thinking-default";

const SHORT_LEVEL: Record<string, string> = { minimal: "Min", medium: "Med", xhigh: "X-high" };

let catalogCache: ModelCatalogResponse | undefined;
let catalogInflight: Promise<void> | undefined;
let catalogGeneration = 0;
let stopCatalogSignals: (() => void) | undefined;
const catalogReaders = new Set<() => void>();
const publishCatalog = () => { for (const reader of catalogReaders) reader(); };
function fetchCatalog(revalidate = false): void {
	if (revalidate) { catalogGeneration++; catalogInflight = undefined; }
	if (catalogInflight) return;
	const generation = catalogGeneration;
	catalogInflight = fetch("/api/models")
		.then((r) => { if (!r.ok) throw new Error(`catalog request failed: ${r.status}`); return r.json() as Promise<ModelCatalogResponse>; })
		.then((c) => { if (generation === catalogGeneration) { catalogCache = c; publishCatalog(); } })
		.catch(() => { /* existing unavailable/usage-only posture, no retry timer */ })
		.finally(() => { if (generation === catalogGeneration) catalogInflight = undefined; });
}
export function useModelCatalog(): { catalog: ModelCatalogResponse | undefined; refresh: () => void } {
	const [catalog, setCatalog] = useState(catalogCache);
	useEffect(() => {
		const first = catalogReaders.size === 0;
		const read = () => setCatalog(catalogCache);
		catalogReaders.add(read);
		if (first) {
			stopCatalogSignals = onSettingsSaved((section) => {
				if (section === "keys") {
					catalogGeneration++; catalogInflight = undefined; catalogCache = undefined;
					publishCatalog(); fetchCatalog();
				} else if (section === "models") fetchCatalog(true);
			});
			fetchCatalog(true);
		} else fetchCatalog();
		read();
		return () => { catalogReaders.delete(read); if (!catalogReaders.size) { stopCatalogSignals?.(); stopCatalogSignals = undefined; } };
	}, []);
	const refresh = useCallback(() => fetchCatalog(true), []);
	return { catalog, refresh };
}

export function catalogLimits(catalog: Pick<ModelCatalogResponse, "models">): Map<string, number> {
	return new Map(catalog.models.map((m) => [`${m.provider}:${m.id}`, m.contextWindow]));
}

export function ModelControl({
	chatId,
	onModelChange,
	variant = "pills",
	className,
}: {
	chatId?: string;
	onModelChange?: (model: string | undefined) => void;
	variant?: "pills" | "chip";
	className?: string;
}) {
	const { catalog, refresh } = useModelCatalog();
	const [models, setModels] = useState<ModelsSettings | undefined>();
	const [session, setSession] = useState<ChatSettings | undefined>();
	const [open, setOpen] = useState<"model" | "thinking" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const readRecord = useCallback(() => {
		if (chatId) {
			fetch(`/api/chats/${chatId}`)
				.then((r) => r.json() as Promise<{ settings?: ChatSettings }>)
				.then((body) => setSession(body.settings))
				.catch(() => {
					/* same read-only posture as a models-section failure */
				});
		}
		fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings: { models?: ModelsSettings } | null }>)
			.then((body) => setModels(body.settings?.models ?? undefined))
			.catch(() => {
				/* the record fetch failing leaves the control read-only
				   ("—" triggers, closed menus) — same posture as a
				   catalog failure */
			});
	}, [chatId]);

	useEffect(() => {
		readRecord();
	}, [readRecord]);

	useSettingsSaved((section) => {
		if (section === "models") readRecord();
	});

	const strong = models?.strong;
	const override: ChatSettings | undefined = chatId
		? {
				model: session?.model ?? strong?.model,
				thinkingLevel: session?.thinkingLevel ?? strong?.thinkingLevel,
			}
		: strong;
	const effectiveId = override?.model?.id;
	const effectiveProvider = override?.model?.provider;
	useEffect(() => {
		onModelChange?.(effectiveProvider && effectiveId ? `${effectiveProvider}:${effectiveId}` : undefined);
	}, [effectiveProvider, effectiveId, onModelChange]);
	const storedLevel = override?.thinkingLevel;
	const entry = catalog?.models.find(
		(m) => m.id === effectiveId && m.provider === effectiveProvider,
	);
	const levels = entry?.supportedLevels ?? [];
	const effectiveLevel = storedLevel ?? (entry ? defaultOrderLevel(levels) : undefined);

	useEffect(() => {
		if (open === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const t = e.target as Element;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (containerRef.current && !containerRef.current.contains(t)) {
				setOpen(null);
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const save = useCallback(
		async (next: ModelsSettings) => {
			setError(null);
			try {
				const res = await fetch("/api/settings/models", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setError(body.error ?? `settings rejected (${res.status})`);
					return;
				}
				const stored = (
					(await res.json().catch(() => null)) as { settings?: UserSettings } | null
				)?.settings?.models;
				setModels(stored ?? next);
				setOpen(null);
				notifySettingsSaved("models");
			} catch {
				setError("Could not reach the server — try again.");
			}
		},
		[],
	);

	const saveChat = useCallback(
		async (next: ChatSettings) => {
			setError(null);
			try {
				const res = await fetch(`/api/chats/${chatId}/settings`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setError(body.error ?? `settings rejected (${res.status})`);
					return;
				}
				const stored = (await res.json().catch(() => null)) as { settings?: ChatSettings } | null;
				setSession(stored?.settings ?? next);
				setOpen(null);
			} catch {
				setError("Could not reach the server — try again.");
			}
		},
		[chatId],
	);

	const apply = useCallback(
		(provider: string, id: string, level: ThinkingLevel | undefined) => {
			if (chatId) {
				void saveChat({ model: { provider, id }, thinkingLevel: level });
			} else {
				void save(composeSlotModel(models, "strong", provider, id, level ?? ""));
			}
		},
		[chatId, models, save, saveChat],
	);

	useEffect(() => {
		const onOpenPicker = () => {
			setOpen("model");
			setError(null);
			refresh();
		};
		window.addEventListener("lh:kbd-open-model-picker", onOpenPicker);
		return () => window.removeEventListener("lh:kbd-open-model-picker", onOpenPicker);
	}, [refresh]);

	useEffect(() => {
		const onCycleThinking = () => {
			if (levels.length === 0) return;
			const idx = effectiveLevel === undefined ? -1 : levels.indexOf(effectiveLevel);
			const next = levels[(idx + 1) % levels.length];
			if (next === undefined) return;
			apply(effectiveProvider ?? "", effectiveId ?? "", next);
		};
		window.addEventListener("lh:kbd-cycle-thinking", onCycleThinking);
		return () => window.removeEventListener("lh:kbd-cycle-thinking", onCycleThinking);
	}, [levels, effectiveLevel, effectiveProvider, effectiveId, apply]);

	const pickModel = (m: ModelCatalogEntry) => {
		const nextLevel = populateLevel(storedLevel, m.supportedLevels);
		apply(m.provider, m.id, nextLevel);
	};

	const openMenu = (kind: "model" | "thinking") => {
		setOpen((o) => (o === kind ? null : kind));
		setError(null);
		if (kind === "model") refresh();
	};

	const menuFooter =
		catalog && catalog.models.length === 0
			? "No models yet. Add a provider key in Settings."
			: chatId
				? "Changes the model for this session only"
				: "The default for new sessions";

	if (variant === "chip") {
		const levelLabel = effectiveLevel === undefined ? null : levelName(THINKING_LABEL[effectiveLevel] ?? effectiveLevel);
		const name = effectiveId ? prettyModel(effectiveId) : "Choose a model";
		return (
			<div ref={containerRef} className="relative" data-testid="model-control">
				<Hint
					label={effectiveId ? `${effectiveProvider} · ${effectiveId}${levelLabel ? ` · ${levelLabel} thinking` : ""}` : "Model and thinking"}
					action="open-model-picker"
					side="bottom"
				>
					<button
						type="button"
						data-testid="stats-model"
						className={className ?? "mini"}
						aria-haspopup="true"
						aria-expanded={open === "model"}
						onClick={() => openMenu("model")}
					>
						<span className={effectiveId ? "mchip-dot" : "mchip-dot off"} aria-hidden />
						<span className="mchip-t">{name}</span>
						{levelLabel && <span className="mchip-l">· {levelLabel}</span>}
						<Icon name="chevron-down" size="xs" />
					</button>
				</Hint>
				{open === "model" && (
					<MenuShell anchorRef={containerRef} testid="model-menu" preferredSide="down" menuClass="pop lh-menu mm">
						{error && <div className="mm-err">{error}</div>}
						<ModelMenuList
							models={catalog?.models}
							effectiveId={effectiveId}
							effectiveProvider={effectiveProvider}
							onPick={pickModel}
							footer={levels.length > 0 ? undefined : menuFooter}
						/>
						{levels.length > 0 && (
							<div className="mm-think">
								<span className="over">Thinking</span>
								<div className="seg sm" data-testid="thinking-seg">
									{levels.map((level) => (
										<button
											key={level}
											type="button"
											className={level === effectiveLevel ? "on" : ""}
											title={levelName(level)}
											onClick={() => apply(effectiveProvider ?? "", effectiveId ?? "", level as ThinkingLevel)}
										>
											{SHORT_LEVEL[level] ?? levelName(level)}
										</button>
									))}
								</div>
								<div className="mm-foot">{menuFooter}</div>
							</div>
						)}
					</MenuShell>
				)}
			</div>
		);
	}

	return (
		<div ref={containerRef} className="relative flex items-center gap-1.5" data-testid="model-control">
			<Hint
				label="Model selector"
				action="open-model-picker"
				side="bottom"
			>
				<button
				type="button"
				data-testid="stats-model"
				onClick={() => openMenu("model")}
				aria-expanded={open === "model"}
				title={effectiveId ? `${effectiveProvider} · ${effectiveId}` : undefined}
				className="flex h-7 max-w-56 items-center gap-1.5 rounded-full bg-surface/90 px-2.5 text-xs font-semibold whitespace-nowrap text-foreground shadow-[inset_0_0_0_1px_var(--line-strong),var(--e1)] backdrop-blur transition-shadow hover:shadow-[inset_0_0_0_1px_var(--line-hover),var(--e1)]"
			>
				<span className="truncate">{effectiveId ? prettyModel(effectiveId) : "—"}</span>
				<Icon name="chevron-down" size="xs" className="text-faint" />
			</button>
			</Hint>
			<Hint
				label="Thinking"
				action="cycle-thinking"
				side="bottom"
			>
				<button
				type="button"
				data-testid="stats-thinking"
				onClick={() => {
					if (entry === undefined) return;
					openMenu("thinking");
				}}
				aria-expanded={open === "thinking"}
				className="flex h-7 items-center gap-1.5 rounded-full bg-surface/90 px-2.5 text-xs font-semibold whitespace-nowrap text-foreground shadow-[inset_0_0_0_1px_var(--line-strong),var(--e1)] backdrop-blur transition-shadow hover:shadow-[inset_0_0_0_1px_var(--line-hover),var(--e1)]"
			>
				<span>{effectiveLevel === undefined ? "—" : levelName(THINKING_LABEL[effectiveLevel] ?? effectiveLevel)}</span>
				<Icon name="chevron-down" size="xs" className="text-faint" />
			</button>
			</Hint>

			{open === "model" && (
				<MenuShell
					anchorRef={containerRef}
					testid="model-menu"
					preferredSide="up"
					menuClass="pop lh-menu mm"
				>
					{error && <div className="mm-err">{error}</div>}
					<ModelMenuList
						models={catalog?.models}
						effectiveId={effectiveId}
						effectiveProvider={effectiveProvider}
						onPick={pickModel}
						footer={menuFooter}
					/>
				</MenuShell>
			)}

			{open === "thinking" && (
				<MenuShell
					anchorRef={containerRef}
					testid="thinking-menu"
					preferredSide="up"
					menuClass="pop lh-menu mm narrow"
				>
					<ThinkingMenuList
						levels={catalog ? levels : []}
						effectiveLevel={effectiveLevel}
						onPick={(level) => apply(effectiveProvider ?? "", effectiveId ?? "", level as ThinkingLevel)}
						empty={catalog ? (effectiveId ? `${prettyModel(effectiveId)} has no thinking levels.` : "Pick a model first.") : "Loading…"}
						footer="Levels this model supports"
					/>
					{error && <div className="mm-err">{error}</div>}
				</MenuShell>
			)}
		</div>
	);
}