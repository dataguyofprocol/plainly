"use client";

import { useEffect, useRef, useState } from "react";
import {
	EXTRACTION_CHUNK_TOKENS_FLOOR,
	FACTORY_SETTINGS,
	resolveSettings,
	type AppearanceSettings,
	type GraphSettings,
	type ThemeMode,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { useAppearance } from "./appearance.tsx";
import { FontMenuList } from "./model-menu";
import { CommitInput, SelectTrigger, SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

const THEME_OPTIONS: ReadonlyArray<{ mode: ThemeMode; label: string }> = [
	{ mode: "system", label: "System" },
	{ mode: "light", label: "Light" },
	{ mode: "dark", label: "Dark" },
];

export const DEFAULT_READING_FONT = "Literata";

export const CURATED_FALLBACK_FONTS: readonly string[] = [
	"Arial",
	"CMU Serif",
	"Courier New",
	"Georgia",
	"Helvetica",
	"Helvetica Neue",
	"Menlo",
	"Times New Roman",
	"Trebuchet MS",
	"Verdana",
];

/** window.queryLocalFonts' shape as this section consumes it (family is
 *  the only field used; the API returns one FontData per FACE — the
 *  caller dedupes). */
type LocalFontsApi = () => Promise<Array<{ family: string }>>;

function localFontsApi(): LocalFontsApi | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { queryLocalFonts?: LocalFontsApi }).queryLocalFonts ?? null;
}

export function composeFontFamily(
	appearance: AppearanceSettings | undefined,
	family: string | null,
): AppearanceSettings {
	const value = family?.trim() ?? "";
	return { ...appearance, fontFamily: value === "" ? null : value };
}

export function AppearanceSection({
	appearance,
	onSectionChange,
}: {
	appearance: AppearanceSettings | undefined;
	onSectionChange: (next: AppearanceSettings) => void;
}) {
	const { appearance: resolved } = useAppearance();
	const md = appearance?.mdRendering;
	const themeMode = appearance?.mode ?? FACTORY_SETTINGS.appearance.mode;

	// The font dropdown's open state + its enumeration cache. undefined =
	// not enumerated yet (desktop: click-bound queryLocalFonts pending);
	// null = enumeration UNAVAILABLE (the API is absent in a plain
	// browser, rejected, or resolved EMPTY — Electron 44's local-fonts
	// grant passes and the enumeration still yields zero fonts,
	// reproduced 2026-09-26) → the curated fallback; a list = the deduped
	// families. enumEmpty distinguishes WHY it fell back, for the footer.
	const [fontMenuOpen, setFontMenuOpen] = useState(false);
	const [localFonts, setLocalFonts] = useState<string[] | null | undefined>(undefined);
	const [enumEmpty, setEnumEmpty] = useState(false);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);

	// The enumeration runs INSIDE the trigger click — queryLocalFonts
	// requires user activation, so it cannot be a mount effect. First
	// open only: the families are cached for the section's life (font
	// installs mid-dialog are not a case); ANY unavailable enumeration
	// (absent / rejected / empty) falls back to the curated list rather
	// than an empty picker.
	const openFontMenu = () => {
		setFontMenuOpen((open) => {
			if (!open && localFonts === undefined) {
				const api = localFontsApi();
				if (api === null) {
					setLocalFonts(null);
					setEnumEmpty(false);
				} else {
					void api()
						.then((fonts) => {
							const families = [...new Set(fonts.map((f) => f.family))]
								.filter((f) => f !== DEFAULT_READING_FONT)
								.sort((a, b) => a.localeCompare(b));
							if (families.length === 0) {
								// Resolved-but-empty: not a failure the catch sees —
								// an honest unavailable (this Electron 44 build
								// enumerates nothing even granted).
								setLocalFonts(null);
								setEnumEmpty(true);
							} else {
								setLocalFonts(families);
							}
						})
						.catch(() => {
							setLocalFonts(null);
							setEnumEmpty(false);
						});
				}
			}
			return !open;
		});
	};

	const pickFont = (family: string | null) => {
		setFontMenuOpen(false);
		onSectionChange(composeFontFamily(appearance, family));
	};

	useEffect(() => {
		if (!fontMenuOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (menuAnchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) {
				setFontMenuOpen(false);
			}
			// else: outside the dialog — the dialog's own close handles it.
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setFontMenuOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [fontMenuOpen]);

	return (
		<>
			<SettingsGroup label="Theme">
				<SettingsRow label="Theme" hint="Follows your Mac when set to System" testid="row-theme">
					<div role="radiogroup" aria-label="Theme" className="seg sm">
						{THEME_OPTIONS.map(({ mode, label }) => (
							<button
								key={mode}
								type="button"
								role="radio"
								aria-checked={themeMode === mode}
								data-testid={`theme-${mode}`}
								onClick={() => onSectionChange({ ...appearance, mode })}
								className={themeMode === mode ? "on" : undefined}
							>
								{label}
							</button>
						))}
					</div>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label="Reading" description="Lesson text — changes apply as you make them.">
				<SettingsRow label="Reading font" hint="Used for lesson text" testid="row-font">
					<span ref={fontMenuOpen ? menuAnchorRef : undefined} className="st-ctl">
						{(() => {
							const trigger = (
								<SelectTrigger
									value={appearance?.fontFamily || DEFAULT_READING_FONT}
									emptyLabel={DEFAULT_READING_FONT}
									ariaLabel="Reading font"
									testid="font-trigger"
									open={fontMenuOpen}
									onClick={openFontMenu}
								/>
							);
							return fontMenuOpen ? (
								trigger
							) : (
								<Hint label="Choose from your installed fonts" side="left">
									{trigger}
								</Hint>
							);
						})()}
						{fontMenuOpen && (
							<MenuShell
								preferredSide="down"
								anchorTestid="font-trigger"
								testid="font-menu"
								menuClass="pop lh-menu mm mid"
							>
								<FontMenuList
									families={localFonts === undefined ? undefined : (localFonts ?? [...CURATED_FALLBACK_FONTS])}
									effectiveFamily={appearance?.fontFamily ?? null}
									onPick={pickFont}
									footer={
										localFonts === undefined
											? undefined
											: localFonts === null
												? enumEmpty
													? "Common fonts — your installed fonts could not be read"
													: "Common fonts — the desktop app lists your installed ones"
												: "Your installed fonts"
									}
								/>
							</MenuShell>
						)}
					</span>
				</SettingsRow>
				<SettingsRow label="Text size" hint={<>From 12 to 24 · <span className="num">{resolved.proseFontSize}px</span></>} testid="row-prose-size">
					<CommitInput
						type="number"
						value={String(appearance?.proseFontSize ?? "")}
						placeholder="17"
						ariaLabel="prose font size"
						testid="input-prose-size"
						onCommit={(v) => {
							if (v === "") {
								onSectionChange({ ...appearance, proseFontSize: undefined });
								return;
							}
							const n = Number(v);
							if (!Number.isFinite(n)) return;
							onSectionChange({ ...appearance, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
						}}
					/>
				</SettingsRow>
				<SettingsRow label="Heading weight" hint={<>How bold lesson headings are, 100 to 900 · <span className="num">{resolved.mdRendering.headingWeight}</span></>} testid="row-heading-weight">
					<CommitInput
						type="number"
						value={String(md?.headingWeight ?? "")}
						placeholder="600"
						ariaLabel="heading weight"
						testid="input-heading-weight"
						onCommit={(v) => {
							if (v === "") {
								onSectionChange({ ...appearance, mdRendering: { ...md, headingWeight: undefined } });
								return;
							}
							const n = Number(v);
							if (!Number.isFinite(n)) return;
							onSectionChange({
								...appearance,
								mdRendering: { ...md, headingWeight: Math.min(900, Math.max(100, Math.round(n))) },
							});
						}}
					/>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label="Sessions">
				<SettingsRow label="Serif session titles" hint="Show session names in Literata" testid="row-session-serif">
					<Toggle
						checked={appearance?.sessionNameSerif ?? true}
						label="session names serif"
						onChange={(on) => onSectionChange({ ...appearance, sessionNameSerif: on })}
					/>
				</SettingsRow>
			</SettingsGroup>
		</>
	);
}

export function GraphSection({
	graph,
	onSectionChange,
}: {
	graph: GraphSettings | undefined;
	onSectionChange: (next: GraphSettings) => void;
}) {
	const resolved = resolveSettings(graph === undefined ? null : { version: 1, graph }).graph;
	return (
		<>
			<SettingsGroup label="Graph">
				<SettingsRow label="Extraction" hint="Adds the ideas from each lesson to your graph. Off, the graph stops growing." testid="graph-row-enabled">
					<Toggle
						checked={graph?.enabled ?? true}
						label="extraction enabled"
						onChange={(on) =>
							onSectionChange({ ...graph, enabled: on })
						}
					/>
				</SettingsRow>
				<SettingsRow label="Graph rendering" hint="Draw the graph canvas. Off, Knowledge shows the chains view instead." testid="graph-row-rendering">
					<Toggle
						checked={graph?.rendering ?? true}
						label="graph rendering enabled"
						onChange={(on) => onSectionChange({ ...graph, rendering: on })}
					/>
				</SettingsRow>
				<SettingsRow
					label="Extraction chunk size"
					hint={<>How much lesson text each extraction pass reads · <span className="num">{resolved.extractionChunkTokens} tok</span></>}
					testid="graph-row-chunk-tokens"
				>
					<CommitInput
						type="number"
						value={String(graph?.extractionChunkTokens ?? "")}
						placeholder={String(resolved.extractionChunkTokens)}
						ariaLabel="extraction chunk budget"
						testid="input-chunk-tokens"
						onCommit={(v) => {
							if (v === "") {
								onSectionChange({ ...graph, extractionChunkTokens: undefined });
								return;
							}
							const n = Number(v);
							if (!Number.isFinite(n) || n <= 0) return;
							onSectionChange({
								...graph,
								extractionChunkTokens: Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.round(n)),
							});
						}}
					/>
				</SettingsRow>
			</SettingsGroup>
		</>
	);
}