"use client";

/**
 * THE V4 SHELL (rebuild, 2026-10-26) — the pieces every screen frames
 * itself with, as drawn in Home4 / Knowledge4 / Lesson4 / Practice4:
 *
 *   Field        the drifting gradient behind everything (paused when the
 *                window is in the background; still under reduced motion)
 *   SidebarCard  the inset glass card: wordmark, Home / Knowledge /
 *                Practice, a screen-owned middle (sessions on Home, topics
 *                on Knowledge), a footer (Settings, or Import notes)
 *   SessionGroups  Waiting on you / Today / Earlier, with the right-click
 *                menu (rename, export, delete, extraction coverage)
 *   Rail         the 60px icon column of Lesson and Practice, with the
 *                sessions flyout (hover, focus, or ⌘B)
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { CoverageMenuBlock } from "@/components/extraction-coverage";
import { MenuShell } from "@/components/menu-shell";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { kbdEventForAction, type ChatDeleteMode } from "@/src/core";
import { dotColor, groupChats, sessionLine, sessionState, useChats, type V4Chat } from "@/components/v4/data";
import { HomeIcon, KnowledgeIcon, LogoMark, PlusIcon, PracticeIcon, SessionsIcon, SettingsIcon } from "@/components/v4/icons";

// ─── Field ─────────────────────────────────────────────────────────────────

export function Field({ variant = "home" }: { variant?: "home" | "knowledge" | "warm" }) {
	// Pause the drift while the window is hidden — no GPU work nobody sees.
	const [still, setStill] = useState(false);
	useEffect(() => {
		const on = () => setStill(document.visibilityState !== "visible");
		on();
		document.addEventListener("visibilitychange", on);
		return () => document.removeEventListener("visibilitychange", on);
	}, []);
	return (
		<div className={`field ${variant === "home" ? "" : variant} ${still ? "still" : ""}`} aria-hidden="true">
			<div className="blob k1" />
			<div className="blob k2" />
			{variant !== "knowledge" && <div className="blob k3" />}
		</div>
	);
}

// ─── Sidebar card ──────────────────────────────────────────────────────────

export function SidebarCard({
	children,
	footer,
	knowledgeCount,
}: {
	children?: ReactNode;
	footer?: ReactNode;
	knowledgeCount?: number | null;
}) {
	const pathname = usePathname();
	const { open: openSettings } = useSettingsDialog();
	const nav = [
		{ href: "/", label: "Home", icon: <HomeIcon />, on: pathname === "/" },
		{ href: "/knowledge", label: "Knowledge", icon: <KnowledgeIcon />, on: pathname === "/knowledge", count: knowledgeCount },
		{ href: "/practice", label: "Practice", icon: <PracticeIcon />, on: pathname === "/practice" },
	];
	return (
		<aside className="side" aria-label="Navigation">
			<div className="sidein glass">
				<div className="brand lh-drag" style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 6px" }}>
					<LogoMark />
					<b style={{ fontSize: 14 }}>LearnHarness</b>
				</div>
				<nav style={{ display: "flex", flexDirection: "column", gap: 1 }}>
					{nav.map((n) => (
						<Link key={n.href} className={`srow ${n.on ? "on" : ""}`} href={n.href} aria-current={n.on ? "page" : undefined}>
							{n.icon}
							{n.label}
							{n.count != null && (
								<span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--faint)" }}>
									{n.count}
								</span>
							)}
						</Link>
					))}
				</nav>
				<div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", margin: "0 -2px" }}>{children}</div>
				{footer ?? (
					<button type="button" className="srow" onClick={() => openSettings()} data-testid="settings-entry" style={{ border: 0, background: "transparent", width: "100%" }}>
						<SettingsIcon />
						Settings
					</button>
				)}
			</div>
		</aside>
	);
}

// ─── Session groups (+ the session context menu) ───────────────────────────

/** The session rows of the sidebar card and the rail flyout. Right-click a
 *  row for Rename / Export as Markdown / Delete, with the extraction
 *  coverage block below (the management menu the old sidebar carried). */
export function SessionGroups({ chats, compact = false }: { chats: V4Chat[] | null; compact?: boolean }) {
	const pathname = usePathname();
	const router = useRouter();
	const groups = useMemo(() => groupChats(chats ?? []), [chats]);
	const [ctx, setCtx] = useState<string | null>(null);
	const anchorRef = useRef<HTMLElement | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<V4Chat | null>(null);

	useEffect(() => {
		if (ctx === null) return;
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (anchorRef.current?.contains(t)) return;
			setCtx(null);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setCtx(null);
			}
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [ctx]);

	const commitRename = useCallback(async (id: string, next: string) => {
		setRenaming(null);
		const t = next.trim();
		if (!t) return;
		const res = await fetch(`/api/chats/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: t }),
		}).catch(() => null);
		if (res?.ok) window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id, title: t } }));
	}, []);

	const onDeleted = useCallback(
		(id: string, _mode: ChatDeleteMode, graphRevision: number) => {
			setDeleting(null);
			if (pathname === `/chat/${id}`) router.push("/");
			window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id } }));
			window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: graphRevision } }));
		},
		[pathname, router],
	);

	if (chats === null) return <div className="gl">Loading…</div>;
	if (groups.length === 0) {
		return <p style={{ margin: 0, padding: "10px 10px", fontSize: 12.5, color: "var(--v-muted)" }}>Your lessons will be listed here.</p>;
	}
	return (
		<>
			{groups.map((g) => (
				<div key={g.name} style={{ display: "flex", flexDirection: "column" }}>
					<div className="gl" style={compact ? { padding: "8px 10px 2px", fontSize: 11.5 } : undefined}>
						<span>{g.name}</span>
						<span>{g.chats.length}</span>
					</div>
					{g.chats.map((c) =>
						renaming === c.id ? (
							<RenameRow key={c.id} chat={c} onCommit={(t) => void commitRename(c.id, t)} onCancel={() => setRenaming(null)} />
						) : (
							<button
								key={c.id}
								type="button"
								className={`sess ${pathname === `/chat/${c.id}` ? "on" : ""}`}
								data-testid="session-row"
								onClick={() => router.push(`/chat/${c.id}`)}
								onContextMenu={(e) => {
									e.preventDefault();
									anchorRef.current = e.currentTarget;
									setCtx(c.id);
								}}
							>
								<b>
									<span className="dot" style={{ background: dotColor(c, g.name) }} />
									<span>{c.title}</span>
								</b>
								<span>{sessionLine(c)}</span>
							</button>
						),
					)}
				</div>
			))}
			{ctx !== null && (
				<MenuShell
					anchorRef={anchorRef}
					testid="session-context-menu"
					preferredSide="down"
					menuClass="pop flex w-52 flex-col gap-0.5 rounded-[14px] p-2 text-[12.5px]"
				>
					<button type="button" className="mrow" data-testid="ctx-rename" onClick={() => (setRenaming(ctx), setCtx(null))}>
						Rename
					</button>
					<button
						type="button"
						className="mrow"
						data-testid="ctx-export-md"
						onClick={() => {
							const id = ctx;
							setCtx(null);
							const a = document.createElement("a");
							a.href = `/api/chats/${id}/markdown`;
							a.download = "";
							document.body.appendChild(a);
							a.click();
							a.remove();
						}}
					>
						Export as Markdown…
					</button>
					<button
						type="button"
						className="mrow"
						data-testid="ctx-delete"
						style={{ color: "var(--v-muted)" }}
						onClick={() => {
							setDeleting(chats.find((c) => c.id === ctx) ?? null);
							setCtx(null);
						}}
					>
						Delete…
					</button>
					<div style={{ margin: "2px 0", borderTop: "1px solid var(--line)" }} aria-hidden="true" />
					<CoverageMenuBlock chatId={ctx} />
				</MenuShell>
			)}
			<DeleteSessionDialog chat={deleting} onClose={() => setDeleting(null)} onDeleted={onDeleted} />
		</>
	);
}

function RenameRow({ chat, onCommit, onCancel }: { chat: V4Chat; onCommit: (t: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(chat.title);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	return (
		<div className="sess on" data-testid="session-rename-row">
			<input
				ref={ref}
				value={draft}
				aria-label="Rename session"
				data-testid="session-rename-input"
				spellCheck={false}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => onCommit(draft)}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") {
						e.stopPropagation();
						onCancel();
					}
				}}
				style={{ border: 0, borderBottom: "1px solid var(--line2)", background: "transparent", outline: "none", fontWeight: 600, fontSize: 12.5, padding: "0 0 0 15px" }}
			/>
			<span>{sessionLine(chat)}</span>
		</div>
	);
}

// ─── Rail ──────────────────────────────────────────────────────────────────

export function Rail({ active }: { active?: "home" | "knowledge" | "practice" }) {
	const chats = useChats();
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const waiting = (chats ?? []).filter((c) => sessionState(c) === "waiting").length;
	const [fly, setFly] = useState(false);

	// ⌘B toggles the sessions flyout on rail screens.
	useEffect(() => {
		const event = kbdEventForAction("toggle-sidebar");
		const on = () => setFly((v) => !v);
		window.addEventListener(event, on);
		return () => window.removeEventListener(event, on);
	}, []);

	return (
		<nav className="rail" aria-label="App">
			<div className="rail-lights lh-drag" aria-hidden="true" />
			<Link className="ri" href="/" aria-label="LearnHarness home" style={{ marginBottom: 8 }}>
				<LogoMark size={22} />
			</Link>
			<Link className={`ri ${active === "home" ? "on" : ""}`} href="/" aria-label="Home">
				<HomeIcon size={18} />
				<span className="tip">Home</span>
			</Link>
			<div style={{ position: "relative" }} onMouseEnter={() => setFly(true)} onMouseLeave={() => setFly(false)} onFocus={() => setFly(true)} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setFly(false)}>
				<button type="button" className={`ri ${fly ? "on" : ""}`} aria-label={waiting ? `Sessions, ${waiting} waiting on you` : "Sessions"} aria-haspopup="true" aria-expanded={fly} onClick={() => setFly((v) => !v)}>
					<SessionsIcon />
					{waiting > 0 && <span className="badge" aria-hidden="true" />}
				</button>
				{fly && (
					<nav className="fly pop settle" aria-label="Sessions">
						<SessionGroups chats={chats} compact />
					</nav>
				)}
			</div>
			<Link className={`ri ${active === "knowledge" ? "on" : ""}`} href="/knowledge" aria-label="Knowledge">
				<KnowledgeIcon size={18} />
				<span className="tip">Knowledge</span>
			</Link>
			<Link className={`ri ${active === "practice" ? "on" : ""}`} href="/practice" aria-label="Practice">
				<PracticeIcon size={18} />
				<span className="tip">Practice</span>
			</Link>
			<button type="button" className="ri ink" aria-label="New lesson" onClick={() => {
					router.push("/");
					window.setTimeout(() => window.dispatchEvent(new CustomEvent("lh:focus-omnibar")), 150);
				}} style={{ marginTop: 8 }}>
				<PlusIcon />
				<span className="tip">New lesson ⌘N</span>
			</button>
			<button type="button" className="ri" aria-label="Settings" onClick={() => openSettings()} style={{ marginTop: "auto" }} data-testid="settings-entry">
				<SettingsIcon size={18} />
				<span className="tip">Settings</span>
			</button>
		</nav>
	);
}
