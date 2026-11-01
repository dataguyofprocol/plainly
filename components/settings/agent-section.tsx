"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MenuShell } from "@/components/menu-shell";
import { useSettingsSaved } from "@/components/settings-signal";
import { defaultOrderLevel, populateLevel } from "@/components/thinking-default";
import type React from "react";
import {
	COMPACTION_THRESHOLD_FLOOR,
	MODEL_SLOTS,
	resolveSettings,
	type AgentSettings,
	type CompactionSettings,
	type GraphSettings,
	type ModelCatalogEntry,
	type ModelSlotName,
	type ModelsSettings,
} from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { prettyModel } from "@/components/usage-format";
import { SettingsGroup, SettingsRow, Toggle, CommitInput, SelectTrigger } from "./controls.tsx";
import { Icon } from "@/components/ui/icon";
import { ModelMenuList, ThinkingMenuList } from "./model-menu";
import { ChatGPTBackgroundAccess } from "./chatgpt-connection";
import { NativeSubscriptionBackgroundAccess } from "./subscription-connections";

const SLOT_META: Record<ModelSlotName, { label: string; roster: string }> = {
	strong: { label: "Main model", roster: "Teaches your lessons" },
	cheap: { label: "Helper model", roster: "Researches, builds demos, grades answers" },
	vision: { label: "Vision model", roster: "Draws figures and reads PDFs" },
};

const TOOL_META: Record<(typeof TOGGLE_TOOLS)[number], { label: string; hint: string }> = {
	research: { label: "Research assistant", hint: "Looks things up while preparing a lesson" },
	demo: { label: "Demo builder", hint: "Builds small interactive demos you can play with" },
	visual: { label: "Figure maker", hint: "Draws diagrams and figures" },
	pdf: { label: "PDF reader", hint: "Reads the PDFs you attach" },
};

const SEARCH_ENGINES = ["tavily", "brave"] as const;

export const TOGGLE_TOOLS = ["research", "demo", "visual", "pdf"] as const;

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface SegmentInfo {
	path: string;
	sourceText: string;
	overrideText: string | null;
	enabled: boolean;
	shared: boolean;
}

interface ModelsBody {
	models: ModelCatalogEntry[];
	slots: Record<ModelSlotName, { model: { provider: string; id: string }; thinkingLevel?: string } | null>;
}

export function composeTool(agent: AgentSettings | undefined, id: string, on: boolean): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, [id]: on } };
}

export function composeQuizMechanics(agent: AgentSettings | undefined, mechanics: "choice" | "free"): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, explain: mechanics === "free" } };
}

export function composeGraphTools(agent: AgentSettings | undefined, on: boolean): AgentSettings {
	return { ...agent, graphTools: { enabled: on } };
}

export function composeSlotModel(
	models: ModelsSettings | undefined,
	slot: ModelSlotName,
	provider: string,
	id: string,
	thinking: string,
): ModelsSettings {
	const prev = models?.[slot];
	const next = { ...models };
	if (!provider && !id && !thinking) {
		delete next[slot];
		return next;
	}
	next[slot] = {
		...(provider && id ? { model: { provider, id } } : prev?.model ? { model: prev.model } : {}),
		...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
	};
	return next;
}

export function composeSearchEngine(
	agent: AgentSettings | undefined,
	engine: (typeof SEARCH_ENGINES)[number] | null,
): AgentSettings {
	if (engine === null) {
		if (!agent?.search) return { ...agent };
		const { search: _drop, ...rest } = agent;
		return { ...rest } as AgentSettings;
	}
	return { ...agent, search: { engine } };
}

export const PROMPT_IN_USE_HINT = "Your version is in use";

export interface PromptSection {
	id: "teacher" | "prober" | "shared";
	label: string;
	hint?: string;
	segments: SegmentInfo[];
}

export function sectionedSegments(view: { prober: SegmentInfo[]; teacher: SegmentInfo[] }): PromptSection[] {
	const own = (who: "prober" | "teacher") => view[who].filter((s) => !s.shared);
	return [
		{ id: "teacher", label: "Teacher", segments: own("teacher") },
		{ id: "prober", label: "Prober", segments: own("prober") },
		{
			id: "shared",
			label: "Shared",
			hint: "Used by both agents",
			segments: view.teacher.filter((s) => s.shared),
		},
	];
}

export function composePromptSwitch(agent: AgentSettings | undefined, path: string, on: boolean): AgentSettings {
	const prompts = { ...agent?.prompts };
	if (on) prompts[path] = true;
	else delete prompts[path];
	return { ...agent, prompts };
}

export function AgentSection({
	agent,
	models,
	graph,
	compaction,
	onSectionChange,
	onModelsChange,
	onCompactionChange,
}: {
	agent: AgentSettings | undefined;
	models: ModelsSettings | undefined;
	graph: GraphSettings | undefined;
	compaction: CompactionSettings | undefined;
	onSectionChange: (next: AgentSettings) => void;
	onModelsChange: (next: ModelsSettings) => void;
	onCompactionChange: (next: CompactionSettings) => void;
}) {
	const [catalog, setCatalog] = useState<ModelCatalogEntry[] | null>(null);
	const [slots, setSlots] = useState<ModelsBody["slots"] | null>(null);
	const [search, setSearch] = useState<{ available: boolean; engine: string | null; reason: string } | null>(null);
	const [engineKeys, setEngineKeys] = useState<Partial<Record<(typeof SEARCH_ENGINES)[number], boolean>>>({});
	const [prompts, setPrompts] = useState<{ prober: SegmentInfo[]; teacher: SegmentInfo[] } | null>(null);
	const [openSegment, setOpenSegment] = useState<string | null>(null);
	const [segmentDraft, setSegmentDraft] = useState<Record<string, string>>({});
	const [segmentStatus, setSegmentStatus] = useState<string | null>(null);
	const [openMenu, setOpenMenu] = useState<{ target: ModelSlotName | "search"; kind: "model" | "thinking" | "engine" } | null>(null);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);

	const refreshSearch = () =>
		fetch("/api/search")
			.then((r) => r.json())
			.then((body: { available: boolean; engine: string | null; reason: string }) => setSearch(body))
			.catch(() => setSearch(null));

	const readPrompts = useCallback(() => {
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { prober: SegmentInfo[]; teacher: SegmentInfo[] }) => setPrompts(body))
			.catch(() => {});
	}, []);

	const modelsRequest = useRef(0);
	const modelsMounted = useRef(false);
	const readModels = useCallback((connectionChanged = false) => {
		const request = ++modelsRequest.current;
		if (connectionChanged) setCatalog(null);
		fetch("/api/models")
			.then((r) => { if (!r.ok) throw new Error("Catalog unavailable"); return r.json(); })
			.then((body: ModelsBody) => {
				if (!modelsMounted.current || request !== modelsRequest.current) return;
				setCatalog(body.models);
				setSlots(body.slots);
			})
			.catch(() => { if (modelsMounted.current && request === modelsRequest.current) setCatalog(null); });
	}, []);

	useSettingsSaved((section) => {
		if (section === "models" || section === "keys") readModels(section === "keys");
		if (section === "agent") readPrompts();
	});

	useEffect(() => {
		modelsMounted.current = true;
		readModels();
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { prober: SegmentInfo[]; teacher: SegmentInfo[] }) => setPrompts(body))
			.catch(() => setPrompts(null));
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: { keys: { id: string; present: boolean }[] }) => {
				const present: Partial<Record<(typeof SEARCH_ENGINES)[number], boolean>> = {};
				for (const id of SEARCH_ENGINES) {
					const envVar = id === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY";
					present[id] = body.keys.some((k) => k.id === envVar && k.present);
				}
				setEngineKeys(present);
			})
			.catch(() => {});
		return () => { modelsMounted.current = false; modelsRequest.current++; };
	}, []);

	useEffect(() => {
		refreshSearch();
	}, [agent?.search?.engine]);

	useEffect(() => {
		if (openMenu === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (menuAnchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) {
				setOpenMenu(null);
			}
			// else: outside the dialog — the dialog's own close handles it.
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpenMenu(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [openMenu]);

	async function saveSegment(path: string, text: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!res.ok) {
			setSegmentStatus(`Save failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
			return;
		}
		readPrompts();
		setSegmentStatus("Saved");
		if (agent?.prompts?.[path] !== true) {
			onSectionChange(composePromptSwitch(agent, path, true));
		}
	}

	async function deleteSegment(path: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, { method: "DELETE" });
		if (!res.ok) {
			setSegmentStatus(`Delete failed: ${res.status}`);
			return;
		}
		if (agent?.prompts?.[path] === true) {
			onSectionChange(composePromptSwitch(agent, path, false));
		}
		readPrompts();
		setSegmentStatus("Deleted");
	}

	const engineOption = (
		id: (typeof SEARCH_ENGINES)[number] | "auto",
		label: string,
		active: boolean,
		live: boolean | null,
		onPick: () => void,
	) => (
		<button
			key={id}
			type="button"
			data-testid={`engine-option-${id}`}
			onClick={onPick}
			className={active ? "mm-row on" : "mm-row"}
		>
			<span className="flex-1">{label}</span>
			{live !== null && <span className="mm-meta">{live ? "Key added" : "No key"}</span>}
			{active && <Icon name="check" size="sm" className="tick" />}
		</button>
	);

	const segmentRow = (info: SegmentInfo) => {
		const fileExists = info.overrideText !== null;
		const open = openSegment === info.path;
		const draft = segmentDraft[info.path] ?? info.overrideText ?? "";
		const dirty = draft !== (info.overrideText ?? "");
		return (
			<div key={info.path} data-testid={`prompt-segment-${info.path}`}>
				<SettingsRow
					label={info.path}
					mono
					hint={info.enabled ? PROMPT_IN_USE_HINT : undefined}
					testid={`prompt-row-${info.path}`}
				>
					<button
						type="button"
						aria-expanded={open}
						onClick={() => {
							setOpenSegment(open ? null : info.path);
							setSegmentStatus(null);
						}}
						className="btn sm quiet"
					>
						{open ? "Hide text" : "Show text"}
						<Icon name={open ? "chevron-up" : "chevron-down"} size="xs" />
					</button>
					<span className={fileExists ? undefined : "opacity-40"} title={fileExists ? undefined : "Save your own version first"}>
						<Toggle
							checked={info.enabled}
							disabled={!fileExists}
							label={`prompt ${info.path}`}
							onChange={(on) => onSectionChange(composePromptSwitch(agent, info.path, on))}
						/>
					</span>
				</SettingsRow>
				{open && (
					<div className="st-seg-editor settle">
						<label className="su-field">
							<span className="flabel">Original</span>
							<textarea readOnly value={info.sourceText} aria-label="The original instructions" className="ftext" />
						</label>
						<label className="su-field">
							<span className="flabel">Your version</span>
							<textarea
								value={segmentDraft[info.path] ?? info.overrideText ?? ""}
								onChange={(e) => setSegmentDraft({ ...segmentDraft, [info.path]: e.target.value })}
								aria-label="Your version of the instructions"
								placeholder="Write your own instructions…"
								className="ftext"
							/>
						</label>
						<div className="st-seg-actions">
							<button
								type="button"
								disabled={!dirty}
								onClick={() => void saveSegment(info.path, segmentDraft[info.path] ?? "")}
								className="btn sm"
							>
								Save
							</button>
							{fileExists && (
								<button type="button" onClick={() => void deleteSegment(info.path)} className="btn sm quiet">
									Delete my version
								</button>
							)}
							{segmentStatus && (
								<p className="meta" data-testid="segment-status">
									<Icon name="check" size="xs" />
									{segmentStatus}
								</p>
							)}
						</div>
					</div>
				)}
			</div>
		);
	};

	const resolvedCompaction = resolveSettings(
		compaction === undefined ? null : { version: 1, compaction },
	).compaction;

	return (
		<>
			<SettingsGroup
				label="Models"
				description="A model for each job. They run on the providers you’ve connected."
				testid="group-models"
			>
				{MODEL_SLOTS.map((slot) => {
					const override = models?.[slot];
					const modelId = override?.model?.id ?? "";
					const provider = override?.model?.provider ?? "";
					const thinking = override?.thinkingLevel ?? "";
					const pin = slots?.[slot];
					const coord = override?.model ?? pin?.model;
					const chosen = coord ? catalog?.find((m) => m.id === coord.id && m.provider === coord.provider) : undefined;
					const levels = chosen ? chosen.supportedLevels : THINKING_LEVELS;
					const thisMenuOpen = openMenu?.target === slot ? openMenu.kind : null;
					const slotCatalog =
						slot === "vision" ? catalog?.filter((m) => m.input.includes("image")) : catalog;
					const shown = modelId ? prettyModel(modelId) : "";
					return (
						<SettingsRow
							key={slot}
							label={SLOT_META[slot].label}
							hint={SLOT_META[slot].roster}
							testid={`slot-row-${slot}`}
						>
							<span ref={thisMenuOpen ? menuAnchorRef : undefined} className="st-ctl">
								{slot !== "strong" && <><ChatGPTBackgroundAccess provider={coord?.provider} /><NativeSubscriptionBackgroundAccess provider={coord?.provider} /></>}
								<SelectTrigger
									value={shown}
									emptyLabel="—"
									ariaLabel={SLOT_META[slot].label}
									testid={`slot-model-${slot}`}
									title={modelId ? `${provider} · ${modelId}` : undefined}
									open={thisMenuOpen === "model"}
									onClick={() => setOpenMenu(thisMenuOpen === "model" ? null : { target: slot, kind: "model" })}
								/>
								<SelectTrigger
									value={thinkingDisplay(thinking || (chosen ? defaultOrderLevel(levels) : ""))}
									emptyLabel="—"
									ariaLabel={`${SLOT_META[slot].label} thinking`}
									testid={`slot-thinking-${slot}`}
									open={thisMenuOpen === "thinking"}
									onClick={() => setOpenMenu(thisMenuOpen === "thinking" ? null : { target: slot, kind: "thinking" })}
									narrow
								/>
								{thisMenuOpen === "model" && (
									<MenuShell
										preferredSide="down"
										anchorTestid={`slot-model-${slot}`}
										testid={`slot-model-menu-${slot}`}
										menuClass="pop lh-menu mm"
									>
										<ModelMenuList
											models={slotCatalog ?? undefined}
											effectiveId={modelId}
											effectiveProvider={provider}
											onPick={(entry) => {
												const next = populateLevel(thinking || undefined, entry.supportedLevels);
												onModelsChange(composeSlotModel(models, slot, entry.provider, entry.id, next));
												setOpenMenu(null);
											}}
											footer={
												catalog && catalog.length === 0
													? "No models yet. Add a provider key under Providers."
													: undefined
											}
										/>
									</MenuShell>
								)}
								{thisMenuOpen === "thinking" && (
									<MenuShell
										preferredSide="down"
										anchorTestid={`slot-thinking-${slot}`}
										testid={`slot-thinking-menu-${slot}`}
										menuClass="pop lh-menu mm narrow"
									>
										<ThinkingMenuList
											levels={levels.map(String)}
											effectiveLevel={thinking || (chosen ? defaultOrderLevel(levels) : undefined)}
											onPick={(level) => {
												onModelsChange(composeSlotModel(models, slot, provider, modelId, level));
												setOpenMenu(null);
											}}
										/>
									</MenuShell>
								)}
							</span>
						</SettingsRow>
					);
				})}
			</SettingsGroup>

			<SettingsGroup label="Tools" description="What your tutor can use while it teaches." testid="group-tools">
				{(() => {
					const graphOn = graph?.enabled ?? true;
					return (
						<SettingsRow
							label="Use your knowledge graph"
							hint={graphOn ? "Lets the tutor consult your knowledge map between sessions" : "Graph is disabled — turn on Extraction under Knowledge graph"}
							testid="graph-tools-row"
							dimmed={!graphOn}
						>
							<Toggle
								checked={agent?.graphTools?.enabled ?? true}
								disabled={!graphOn}
								label="graph tools"
								onChange={(on) => onSectionChange(composeGraphTools(agent, on))}
							/>
						</SettingsRow>
					);
				})()}
				{(() => {
					const free = agent?.tools?.explain === true;
					return (
						<SettingsRow label="Check style" hint="How your tutor checks what you understood" testid="quiz-mechanics-row">
							<div role="radiogroup" aria-label="Quizzing mechanics" className="seg sm">
								{(["choice", "free"] as const).map((m) => {
									const active = m === "free" ? free : !free;
									return (
										<button
											key={m}
											type="button"
											role="radio"
											aria-checked={active}
											data-testid={`quiz-mechanics-${m}`}
											onClick={() => onSectionChange(composeQuizMechanics(agent, m))}
											className={active ? "on" : undefined}
										>
											{m === "choice" ? "Multiple choice" : "Free recall"}
										</button>
									);
								})}
							</div>
						</SettingsRow>
					);
				})()}
				{TOGGLE_TOOLS.map((id) => (
					<SettingsRow key={id} label={TOOL_META[id].label} hint={TOOL_META[id].hint} testid={`tool-row-${id}`}>
						<Toggle
							checked={agent?.tools?.[id] ?? true}
							label={`tool ${id}`}
							onChange={(on) => onSectionChange(composeTool(agent, id, on))}
						/>
					</SettingsRow>
				))}
				{(() => {
					const engine = agent?.search?.engine ?? null;
					const anyKey = engineKeys.tavily === true || engineKeys.brave === true;
					const open = openMenu?.target === "search";
					return (
						<SettingsRow
							label="Web search"
							hint={search?.reason ?? (anyKey ? undefined : "Add a Tavily or Brave key under Providers")}
							testid="search-engine-row"
							dimmed={!anyKey}
						>
							<span ref={open ? menuAnchorRef : undefined} className="st-ctl">
								<SelectTrigger
									value={engine === "tavily" ? "Tavily" : engine === "brave" ? "Brave" : "Automatic"}
									emptyLabel="Automatic"
									ariaLabel="Search engine"
									testid="search-engine-trigger"
									open={open}
									onClick={() => setOpenMenu(open ? null : { target: "search", kind: "engine" })}
									disabled={!anyKey}
								/>
								{open && (
									<MenuShell
										preferredSide="down"
										anchorTestid="search-engine-trigger"
										testid="search-engine-menu"
										menuClass="pop lh-menu mm narrow"
									>
										{engineOption("auto", "Automatic", engine === null, null, () => {
											onSectionChange(composeSearchEngine(agent, null));
											setOpenMenu(null);
										})}
										{SEARCH_ENGINES.map((id) =>
											engineOption(id, id === "tavily" ? "Tavily" : "Brave", engine === id, engineKeys[id] ?? false, () => {
												onSectionChange(composeSearchEngine(agent, id));
												setOpenMenu(null);
											}),
										)}
									</MenuShell>
								)}
							</span>
						</SettingsRow>
					);
				})()}
			</SettingsGroup>

			<SettingsGroup label="Long lessons" testid="group-context">
				<SettingsRow
					label="Condense after"
					hint={<>Older turns are summarized once a lesson grows past this · <span className="num">{resolvedCompaction.thresholdTokens} tokens</span></>}
					testid="compaction-row-threshold"
				>
					<CommitInput
						type="number"
						value={String(compaction?.thresholdTokens ?? "")}
						placeholder={String(resolvedCompaction.thresholdTokens)}
						ariaLabel="compaction threshold"
						testid="input-compaction-threshold"
						onCommit={(v) => {
							if (v === "") {
								onCompactionChange({ ...compaction, thresholdTokens: undefined });
								return;
							}
							const n = Number(v);
							if (!Number.isFinite(n) || n <= 0) return;
							onCompactionChange({
								...compaction,
								thresholdTokens: Math.max(COMPACTION_THRESHOLD_FLOOR, Math.round(n)),
							});
						}}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup
				label="System prompts"
				description="Swap parts of your tutor’s instructions for your own. Switch a part on to use your version."
				testid="group-prompts"
				bare
			>
				{prompts === null ? (
					<div className="st-skel" aria-busy="true">
						<span className="sr">Loading prompt segments…</span>
						<span className="skel c2" aria-hidden />
					</div>
				) : (
					sectionedSegments(prompts).map((section) => (
						<div key={section.id} className="st-subgroup" data-testid={`prompt-section-${section.id}`}>
							<span className="over st-sub">
								{section.label}
								{section.hint && <span className="faint"> · {section.hint}</span>}
							</span>
							<div className="st-card">{section.segments.map((info) => segmentRow(info))}</div>
						</div>
					))
				)}
			</SettingsGroup>
		</>
	);
}

function thinkingDisplay(level: string): string {
	if (!level) return "";
	if (level === "xhigh") return "Extra high";
	return level.charAt(0).toUpperCase() + level.slice(1);
}
