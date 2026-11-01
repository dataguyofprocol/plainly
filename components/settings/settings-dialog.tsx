"use client";

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
import { SettingsSection } from "./controls.tsx";
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

const SECTIONS = [
	{ id: "keys", label: "Providers", icon: "provider", title: "Providers", hint: "The model accounts your tutor runs on, plus voice and web search." },
	{ id: "agent", label: "Tutor", icon: "model", title: "Tutor", hint: "Which models teach you, and what your tutor is allowed to do." },
	{ id: "appearance", label: "Appearance", icon: "appearance", title: "Appearance", hint: "How lessons read on this device." },
	{ id: "graph", label: "Knowledge graph", icon: "knowledge", title: "Knowledge graph", hint: "How your graph grows from the lessons you take." },
	{ id: "keyboard", label: "Keyboard", icon: "keyboard", title: "Keyboard", hint: "Shortcuts, saved on this device." },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconName; title: string; hint: string }>;
type SectionId = (typeof SECTIONS)[number]["id"];

const DialogContext = createContext<{ open: (section?: string, row?: string) => void }>({ open: () => {} });

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
	initialRow: string | null;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	return createPortal(
		<div className="v4 scope">
			<div className="overlay" data-testid="settings-backdrop" {...backdropDismiss}>
				<SettingsDialogBody onClose={onClose} initialSection={initialSection} initialRow={initialRow} />
			</div>
		</div>,
		document.body,
	);
}

export function SettingsDialogBody({
	onClose,
	initialSection = "keys",
	initialRow = null,
}: {
	onClose: () => void;
	initialSection?: SectionId;
	initialRow?: string | null;
}) {
	const { onAppearanceChange } = useAppearance();
	const [record, setRecord] = useState<UserSettings | null | undefined>(
		undefined,
	);
	const [error, setError] = useState<string | null>(null);
	const [openMenus, setOpenMenus] = useState(0);
	const contentRef = useRef<HTMLDivElement | null>(null);
	// React attaches synthetic wheel/touch listeners passively at the root,
	// so the scroll lock needs native non-passive listeners through this ref.
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
	useEffect(() => {
		setActive(initialSection);
	}, [initialSection]);

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

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

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
