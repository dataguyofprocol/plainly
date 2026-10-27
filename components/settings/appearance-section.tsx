"use client";
/**
 * The Appearance + Graph sections (thin settings wave).
 *
 * Appearance controls resolve against the factory in the provider; writes
 * PUT the whole appearance section and hand the delta back so the CSS
 * variables move IMMEDIATELY (the section's whole point — it must DO
 * something). Theme (dark mode wave, owner 2026-10-27): System · Light ·
 * Dark, first group; the switch itself is components/theme.ts.
 *
 * Graph graying (owner, 2026-09-20) follows the graph viewer's render-panel
 * convention: the whole row dims when a parent is off (stored values
 * persist but resolve inert — the switch shows stored, the dim effective).
 *
 * Reading font (appearance wave, 2026-09-26, owner ruling): a searchable
 * dropdown of the user's INSTALLED fonts (FontMenuList over model-menu's
 * machine) fed by window.queryLocalFonts() in the desktop shell — the
 * enumeration is click-bound (the API requires user activation), deduped
 * to unique families, the factory family excluded (the DEFAULT row is
 * it). In a plain dev browser the API is absent → a small curated list
 * + a footer that says exactly that — never a fabricated system list.
 * The custom-family input inside the menu is the manual escape path.
 * Empty/unset keeps meaning Source Sans 3.
 *
 * Emphasis inks (same wave): the factory tokens default to the regular
 * text color now (globals.css); the rows' empty-state labels say "same
 * as text".
 */

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

/** The theme choices, in the control's order (owner, 2026-10-27). */
const THEME_OPTIONS: ReadonlyArray<{ mode: ThemeMode; label: string }> = [
	{ mode: "system", label: "System" },
	{ mode: "light", label: "Light" },
	{ mode: "dark", label: "Dark" },
];

/** The factory reading family — the DEFAULT row's identity (unset =
 *  this). Exported for tests. */
export const DEFAULT_READING_FONT = "Literata";

/** The dev-browser fallback list (queryLocalFonts is absent there):
 *  the app's own knowns plus a handful of ubiquitous macOS families,
 *  honestly LABELED as common — never presented as the system's real
 *  list. The factory family is absent: the DEFAULT row is it. Exported
 *  for tests. */
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

/** The Local Font Access seam — read lazily (SSR has no window, and
 *  render-time access would evaluate the API on the server). */
function localFontsApi(): LocalFontsApi | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { queryLocalFonts?: LocalFontsApi }).queryLocalFonts ?? null;
}

/** Compose the reading-font pick: null (or blank) = the factory
 *  Source Sans 3; otherwise the family verbatim (trimmed — the
 *  sanitizer trims again server-side). Pure — exported for tests. */
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
	/** The record's appearance delta (absent = factory). */
	appearance: AppearanceSettings | undefined;
	/** PUT the whole appearance section; the page re-applies on success. */
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

	// The dropdown contract (agent-section's, mirrored): any click
	// outside the open menu — or an Esc — closes it. Esc is CLAIMED with
	// stopPropagation so the settings dialog behind does NOT also close.
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
						{/* The tooltip rides the CLOSED button ONLY (owner ruling
						    2026-09-26: never while the dropdown is out). */}
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
							// Empty = factory default (owner, fix wave): omit the key so the record
							// UNSETS and the field stays empty (absence, not null, is the
							// unset for numbers). Number("") is 0, so the old clamp wrote 12.
							if (v === "") {
								onSectionChange({ ...appearance, proseFontSize: undefined });
								return;
							}
							const n = Number(v);
							if (!Number.isFinite(n)) return; // bad input: no write, factory stays
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
							// Empty = factory default (owner, fix wave): Number("") is 0, so
							// Absence is the unset representation — the old clamp wrote 100.
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
	// Wave 7 collapse (owner ruling 2026-09-23): the section is the MASTER
	// SWITCH — the embedding/clustering/labeling rungs are gone; clustering
	// is the free birth-session partition derived on read, labels ARE session
	// names. The chunk budget (2026-10-02) joined it as the section's second
	// and only other control: it denominates the coverage ring AND gates the
	// auto-extraction trigger (turn settle ≥ budget fires the run).
	//
	// Resolved through the SAME core resolver the server's effective
	// settings use (one source of truth, the 4096-fallback fix 2026-10-02):
	// the hint and placeholder report exactly the number the trigger waits
	// for — never a second hand-rolled default.
	const resolved = resolveSettings(graph === undefined ? null : { version: 1, graph }).graph;
	return (
		<>
			{/* EXTRACTION (renamed, owner 2026-10-06): this switch is the DATA
			    channel — the pipeline, the auditor, the prober's graph tools. It
			    was born labeled "Graph" and that label lied once the rendering
			    switch below arrived: off ≠ no graph, off = the graph stops
			    growing. The testid keeps the old name's shape (row-enabled) so
			    this stays one rename, not a test re-pin. */}
			<SettingsGroup label="Graph">
				<SettingsRow label="Extraction" hint="Adds the ideas from each lesson to your graph. Off, the graph stops growing." testid="graph-row-enabled">
					<Toggle
						checked={graph?.enabled ?? true}
						label="extraction enabled"
						onChange={(on) =>
							// Compose, never replace-whole (the section PUT is, but the
						// row must not drop its sibling field — fixed with the budget
						// row's arrival: the old { enabled: on } wiped a stored budget).
							onSectionChange({ ...graph, enabled: on })
						}
					/>
				</SettingsRow>
				{/* GRAPH RENDERING (owner, 2026-10-06 — the release graph-controls
				    round): display-only. Off = the home shows the chains view
				    instead of the canvas. The ledgers, the pipeline, everything
				    data keeps working — that is the extraction switch above. */}
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
							// Empty = factory default (the fix-wave discipline): absence is
							// the unset for numbers — Number("") is 0, so clamping would
							// write the floor instead of unsetting.
							if (v === "") {
								onSectionChange({ ...graph, extractionChunkTokens: undefined });
								return;
							}
							const n = Number(v);
							if (!Number.isFinite(n) || n <= 0) return; // bad input: no write
							// Mirror the server sanitize exactly: floor only (cost
							// protection), no ceiling — a big budget is the user's call.
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