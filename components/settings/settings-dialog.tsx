"use client";
/**
 * THE SETTINGS DIALOG (settings-app wave, 2026-09-20): the thin settings
 * page graduated into the designed surface — a centered modal over
 * everything, left section nav + one scrolling content column.
 *
 * Owner decisions this wave:
 * - Dialog, not a page: opens over whatever screen you're on (the payoff:
 *   appearance edits restyle the chat LIVE behind the dialog). Escape,
 *   backdrop, and the close button all close. Modal-only — /settings
 *   redirects, so nothing links into a dead surface.
 * - v4 frame (finesse pass, 2026-10-26): a tinted left nav with icons
 *   (active = raised surface), each section a titled page of grouped
 *   rows. Styles: app/ui/settings.css.
 * - The dialog is surface-agnostic by construction: the sections talk to
 *   /api/settings* and localStorage only, so this shell can be re-mounted
 *   as a true OS window in the Electron round with near-zero churn.
 *
 * The record + the single `write` seam moved here from the thin page:
 * one record instance for the whole dialog, sections write through it,
 * switching sections never refetches.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { OPEN_CONNECT_EVENT } from "@/components/connect-provider";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import {
	CURRENT_SETTINGS_VERSION,
	type AgentSettings,
	type AppearanceSettings,
	type CompactionSettings,
	type GraphSettings,
	type UserSettings,
} from "@/src/core";
import { useAppearance } from "./appearance.tsx";
import { SettingsGroup, SettingsSection, SettingsRow, Toggle } from "./controls.tsx";
import { Icon, type IconName } from "@/components/ui/icon";
import { AgentSection } from "./agent-section.tsx";
import type { ModelsSettings } from "@/src/core";
import { MENU_CLOSE_EVENT, MENU_OPEN_EVENT } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { KeysSection } from "./keys-section.tsx";
import { Hint } from "@/components/ui/hint";
import { EmptyState } from "@/components/ui/empty-state";
import { AppearanceSection, GraphSection } from "./appearance-section.tsx";
import { KeyboardSection } from "./keyboard-section.tsx";
import { ChatGPTUIProvider } from "./chatgpt-connection.tsx";
import { NativeSubscriptionUIProvider } from "./subscription-connections.tsx";

/** The sections, in nav order. `title` + `hint` head each page (PM copy,
 *  finesse pass); `label` is the nav's short name. */
const SECTIONS = [
	{ id: "keys", label: "Providers", icon: "provider", title: "Providers", hint: "The model accounts your tutor runs on, plus voice and web search." },
	{ id: "agent", label: "Tutor", icon: "model", title: "Tutor", hint: "Which models teach you, and what your tutor is allowed to do." },
	{ id: "appearance", label: "Appearance", icon: "appearance", title: "Appearance", hint: "How lessons read on this device." },
	{ id: "graph", label: "Knowledge graph", icon: "knowledge", title: "Knowledge graph", hint: "How your graph grows from the lessons you take." },
	{ id: "keyboard", label: "Keyboard", icon: "keyboard", title: "Keyboard", hint: "Shortcuts, saved on this device." },
	{ id: "general", label: "General", icon: "tune", title: "General", hint: "App-wide preferences." },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconName; title: string; hint: string }>;
type SectionId = (typeof SECTIONS)[number]["id"];

/** `open(section?, row?)` — the optional ROW deep-links into the Keys
 *  section with that row unfolded (zero-keys wave: the dictation error's
 *  click lands on the Deepgram row). `row` is the KEY ID (the env-var
 *  name, e.g. DEEPGRAM_API_KEY — KeysSection's openRow state), not the
 *  row's testid. */
const DialogContext = createContext<{ open: (section?: string, row?: string) => void }>({ open: () => {} });

/** AppShell-level mount: the sidebar row and the mod+, chord call this.
 *  `open(section)` lands the dialog on a specific section (the first-run
 *  setup flow deep-links to Keys when no provider key exists yet). */
/** The auto-update row's hint (tooltip wave): honest user language — no
 *  stream vocabulary. Exported for the copy pin (tooltip-mechanism test). */
export const AUTO_UPDATE_HINT = "Automatic updates arrive in an upcoming release";

export function SettingsDialogProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [show, setShow] = useState(false);
	const [landOn, setLandOn] = useState<SectionId>("keys");
	const [landOnRow, setLandOnRow] = useState<string | null>(null);
	const open = useCallback((section?: string, row?: string) => {
		setLandOn(section ? section as SectionId : "keys");
		setLandOnRow(row ?? null);
		setShow(true);
	}, []);
	// The connect screen replaces Settings rather than stacking on it.
	useEffect(() => {
		const onConnect = () => setShow(false);
		window.addEventListener(OPEN_CONNECT_EVENT, onConnect);
		return () => window.removeEventListener(OPEN_CONNECT_EVENT, onConnect);
	}, []);
	return (
		<ChatGPTUIProvider><NativeSubscriptionUIProvider><DialogContext.Provider value={{ open }}>
			{children}
			{show && (
				<SettingsDialog onClose={() => setShow(false)} initialSection={landOn} initialRow={landOnRow} />
			)}
		</DialogContext.Provider></NativeSubscriptionUIProvider></ChatGPTUIProvider>
	);
}

export function useSettingsDialog() {
	return useContext(DialogContext);
}

function SettingsDialog({
	onClose,
	initialSection,
	initialRow,
}: {
	onClose: () => void;
	initialSection: SectionId;
	/** The keys-section row to unfold (see DialogContext above). */
	initialRow: string | null;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	// A genuine backdrop click closes; the dialog body stops propagation.
	return createPortal(
		<div className="v4 scope">
			<div className="overlay" data-testid="settings-backdrop" {...backdropDismiss}>
				<SettingsDialogBody onClose={onClose} initialSection={initialSection} initialRow={initialRow} />
			</div>
		</div>,
		document.body,
	);
}

/** The dialog without the portal/backdrop — the SSR-testable frame
 *  (portals render nothing under renderToStaticMarkup). */
export function SettingsDialogBody({
	onClose,
	initialSection = "keys",
	initialRow = null,
}: {
	onClose: () => void;
	initialSection?: SectionId;
	/** The keys row to unfold on arrival (null = none). While-open
	 *  retargets follow it exactly like initialSection below. */
	initialRow?: string | null;
}) {
	const { onAppearanceChange } = useAppearance();
	const [record, setRecord] = useState<UserSettings | null | undefined>(
		undefined,
	);
	const [error, setError] = useState<string | null>(null);
	// MenuShell open-count — drives the content column's scroll lock.
	const [openMenus, setOpenMenus] = useState(0);
	const contentRef = useRef<HTMLDivElement | null>(null);
	// Scroll-lock (fix wave, owner ruling: the scrollbar MAY stay,
	// scrolling must NOT happen, nothing may move): the content column
	// keeps overflow-y-auto — the scrollbar and every width stay exactly
	// as they are — and while any MenuShell is open, non-passive wheel +
	// touchmove listeners on the column preventDefault. React attaches
	// synthetic wheel/touch passively at the root, so this needs the
	// native-listener ref seam.
	useEffect(() => {
		const el = contentRef.current;
		if (!el || openMenus === 0) return;
		const block = (e: Event) => e.preventDefault();
		el.addEventListener("wheel", block, { passive: false });
		el.addEventListener("touchmove", block, { passive: false });
		return () => {
			el.removeEventListener("wheel", block);
			el.removeEventListener("touchmove", block);
		};
	}, [openMenus]);

	useEffect(() => {
		const onOpen = () => setOpenMenus((n) => n + 1);
		const onClose = () => setOpenMenus((n) => Math.max(0, n - 1));
		window.addEventListener(MENU_OPEN_EVENT, onOpen);
		window.addEventListener(MENU_CLOSE_EVENT, onClose);
		return () => {
			window.removeEventListener(MENU_OPEN_EVENT, onOpen);
			window.removeEventListener(MENU_CLOSE_EVENT, onClose);
		};
	}, []);
	const [active, setActive] = useState<SectionId>(initialSection);
	// A deep-link fired while the dialog is ALREADY open (first exercised by
	// the wave-6 embedding picker's "Add a provider key first…" link — the
	// picker itself died with wave 7, the mechanism is general) changes
	// initialSection under our feet — follow it, or the link silently does
	// nothing.
	useEffect(() => {
		setActive(initialSection);
	}, [initialSection]);

	// Fetch once per dialog mount. 200 {settings: null} is FIRST BOOT
	// (no record = factory everything), not a failure — the error state is
	// a non-200 or a network throw only.
	useEffect(() => {
		fetch("/api/settings")
			.then((r) =>
				r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)),
			)
			.then((body: { settings: UserSettings | null }) =>
				setRecord(body.settings ?? { version: CURRENT_SETTINGS_VERSION }),
			)
			.catch(() => setRecord(null));
	}, []);

	// Escape closes — the layered-dismiss convention (Esc is dead for the
	// sections' own editors while they hold focus; this listener is the
	// dialog's outer layer).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// THE ONE-ESC LAW (owner, keyboard round 2026-10-06): claim
				// at the document level — the window chain (dictation →
				// abort) must not also act. One Esc, one action.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	/** ONE writer for the whole dialog: PUT the whole section, keep the
	 *  record mirror in sync, surface route errors inline (a 400 is a
	 *  schema mistake caught by the validation surface). */
	const write = useCallback(
		async (
			section: "general" | "agent" | "models" | "appearance" | "graph" | "compaction",
			body: object,
		) => {
			setError(null);
			const res = await fetch(`/api/settings/${section}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				setError(`${section}: ${detail.error ?? res.status}`);
				return;
			}
			// Server truth, never the request body (fix wave, owner repro):
			// the models section clamps pinned thinking levels on write
			// (bd68486) — a swap that rides an unsupported level lands
			// CLAMPED in the record, and the writing surface must show the
			// stored value in this same interaction, not the optimistic one.
			const stored = (
				(await res.json().catch(() => null)) as { settings?: UserSettings } | null
			)?.settings;
			setRecord(
				(prev) =>
					stored ?? ({ ...(prev ?? {}), [section]: body }) as UserSettings,
			);
			notifySettingsSaved(section);
			if (section === "appearance")
				onAppearanceChange(body as AppearanceSettings);
		},
		[onAppearanceChange],
	);

	const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];
	const page = (children: React.ReactNode) => (
		<SettingsSection title={section.title} hint={section.hint} testid={`section-${section.id}`}>
			{children}
		</SettingsSection>
	);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Settings"
			data-testid="settings-dialog"
			className="dialog sd"
			onClick={(e) => e.stopPropagation()}
		>
			<nav aria-label="Settings sections" data-testid="settings-nav" className="sd-nav">
				<div className="sd-navt">Settings</div>
				{SECTIONS.map((s) => (
					<button
						key={s.id}
						type="button"
						data-testid={`settings-nav-${s.id}`}
						aria-current={active === s.id}
						className={active === s.id ? "sd-navi on" : "sd-navi"}
						onClick={() => setActive(s.id)}
					>
						<Icon name={s.icon} size="md" />
						{s.label}
					</button>
				))}
				<div className="sd-navfoot">
					<Icon name="check" size="xs" />
					Saves as you go
				</div>
			</nav>

			<Hint label="Close" binding="escape" side="left">
				<button
					type="button"
					aria-label="Close settings"
					data-testid="settings-close"
					className="ib sd-close"
					onClick={onClose}
				>
					<Icon name="close" size="md" />
				</button>
			</Hint>

			{/* Content column — one section at a time, this scrolls — and
			    LOCKS while any MenuShell is open (owner ruling: no
			    scrolling with a dropdown down; MenuShell announces
			    open/close, the count keeps overlap honest). The lock
			    intercepts wheel/touch instead of hiding the scrollbar —
			    nothing may shift when the lock engages. */}
			<div ref={contentRef} className="sd-main" data-testid="settings-content">
				{record === undefined ? (
					<div className="sd-page" aria-busy="true">
						<span className="sr">Loading settings…</span>
						<div className="sd-head" aria-hidden>
							<span className="skel sd-skel-t" />
							<span className="skel sd-skel-d" />
						</div>
						<div className="st-skel" aria-hidden>
							<span className="skel t" />
							<span className="skel c" />
							<span className="skel c2" />
						</div>
					</div>
				) : record === null ? (
					<div className="sd-page">
						<EmptyState
							icon="status-warn"
							title="Settings could not be loaded"
						>
							Close this window and open Settings again to retry.
						</EmptyState>
					</div>
				) : (
					<>
						{error && (
							<div className="sd-page sd-errwrap">
								<p role="alert" className="sd-error" data-testid="settings-error">
									<Icon name="status-warn" size="sm" />
									{error}
								</p>
							</div>
						)}
						{active === "general" &&
							page(
								<SettingsGroup label="Updates">
									<SettingsRow label="Automatic updates" hint={AUTO_UPDATE_HINT} testid="row-auto-update">
										<Toggle
											checked={record.general?.autoUpdate ?? true}
											label="auto update"
											onChange={(on) => void write("general", { autoUpdate: on })}
										/>
									</SettingsRow>
								</SettingsGroup>,
							)}
						{active === "keys" && page(<KeysSection initialRow={initialRow ?? undefined} />)}
						{active === "agent" &&
							page(
								<AgentSection
									agent={record.agent}
									models={record.models}
									graph={record.graph}
									compaction={record.compaction}
									onModelsChange={(next: ModelsSettings) => void write("models", next)}
									onSectionChange={(next: AgentSettings) => void write("agent", next)}
									onCompactionChange={(next: CompactionSettings) => void write("compaction", next)}
								/>,
							)}
						{active === "appearance" &&
							page(
								<AppearanceSection
									appearance={record.appearance}
									onSectionChange={(next: AppearanceSettings) => void write("appearance", next)}
								/>,
							)}
						{active === "graph" &&
							page(
								<GraphSection graph={record.graph} onSectionChange={(next: GraphSettings) => void write("graph", next)} />,
							)}
						{active === "keyboard" && page(<KeyboardSection />)}
					</>
				)}
			</div>
		</div>
	);
}
