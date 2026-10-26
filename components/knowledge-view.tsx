"use client";

/**
 * KNOWLEDGE — Knowledge4 of the v4 canvas, built to the artboard (rebuild,
 * 2026-10-26). The sidebar card lists the topics (click one to zoom to
 * it); the canvas is the graph engine (graph-view.tsx, v4 mode) in topic
 * colours; clicking an idea opens its card — what it rests on, what it
 * leads to, where it was learned — and lights its chain; ideas collect in
 * the practice tray and leave as one practice set.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GraphView, ideaNeighbours, type GraphViewApi } from "@/components/graph-view";
import { NotesImportErrors, useNotesImport } from "@/components/notes-import";
import { SetupDialog } from "@/components/setup-dialog";
import { createSession, useStartReadiness, type StartPick } from "@/components/start-session";
import { ago, chainNeighbourhood, topicColor, useGraphSnapshot, useTopics } from "@/components/v4/data";
import { SearchIcon } from "@/components/v4/icons";
import { Field, SidebarCard } from "@/components/v4/shell";
import type { GraphNode } from "@/src/core";

/** How many related ideas the card names before "and N more". */
const NEIGHBOUR_LIMIT = 4;

export function KnowledgeView({ initialConfigured, focusIdeaId }: { initialConfigured: boolean; rendering?: boolean; focusIdeaId?: string }) {
	const router = useRouter();
	const snapshot = useGraphSnapshot();
	const topics = useTopics();
	const readiness = useStartReadiness(initialConfigured);
	const [setupOpen, setSetupOpen] = useState(false);
	const api = useRef<GraphViewApi | null>(null);
	const [zoomPct, setZoomPct] = useState(100);
	const [q, setQ] = useState("");
	const [topic, setTopic] = useState<string | null>(null);
	const [sel, setSel] = useState<GraphNode | null>(null);
	const [tray, setTray] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const notesImport = useNotesImport();
	const fileRef = useRef<HTMLInputElement>(null);
	const [now, setNow] = useState<Date | null>(null);
	useEffect(() => setNow(new Date()), []);

	const props = useMemo(() => snapshot?.propositions ?? [], [snapshot]);
	const byId = useMemo(() => new Map(props.map((n) => [n.id, n])), [props]);
	const topicOf = useMemo(() => {
		const m = new Map<string, { id: string; name: string }>();
		for (const t of topics ?? []) for (const id of t.ideaIds) m.set(id, { id: t.id, name: t.name });
		return m;
	}, [topics]);

	// Arrival focus (/knowledge?idea=…): select and frame it once known.
	const focusDone = useRef(false);
	useEffect(() => {
		if (!focusIdeaId || focusDone.current || !byId.has(focusIdeaId)) return;
		focusDone.current = true;
		setSel(byId.get(focusIdeaId)!);
		window.setTimeout(() => api.current?.frame([focusIdeaId]), 300);
	}, [focusIdeaId, byId]);

	// Keep the zoom readout live.
	useEffect(() => {
		const t = window.setInterval(() => api.current && setZoomPct(api.current.zoomPercent()), 400);
		return () => window.clearInterval(t);
	}, []);

	const highlight = useMemo(
		() => (sel && snapshot ? { ids: chainNeighbourhood(snapshot.edges, sel.id), selected: sel.id } : null),
		[sel, snapshot],
	);
	const neighbours = useMemo(() => (sel && snapshot ? ideaNeighbours(snapshot.chains, sel.id) : null), [sel, snapshot]);
	const matches = useMemo(() => {
		const t = q.trim().toLowerCase();
		if (!t) return null;
		return props.filter((n) => n.name.toLowerCase().includes(t) || n.statement.toLowerCase().includes(t)).length;
	}, [q, props]);

	const lessons = snapshot ? Object.keys(snapshot.sessions).filter((id) => !id.startsWith("src_")).length : 0;
	const notes = snapshot ? Object.keys(snapshot.fileSources ?? {}).length : 0;

	const pick = (id: string) => {
		const n = byId.get(id);
		if (!n) return;
		setSel(n);
		api.current?.frame([id]);
	};
	const selTopic = sel ? topicOf.get(sel.id) : undefined;
	const firstSource = sel?.provenance[0]?.chatId;
	const learnedIn = firstSource ? (snapshot?.sessions[firstSource] ?? snapshot?.fileSources?.[firstSource] ?? null) : null;
	const concludes = sel && snapshot ? snapshot.chains.some((c) => c.conclusion === sel.id) : false;
	const topicPracticed = selTopic ? topics?.find((t) => t.id === selTopic.id)?.lastPracticedAt : null;
	const inTray = sel ? tray.includes(sel.id) : false;

	const practiceTray = async () => {
		if (busy || tray.length === 0) return;
		if (!readiness.ready) return setSetupOpen(true);
		setBusy(true);
		const picks: StartPick[] = tray.flatMap((id) => {
			const n = byId.get(id);
			return n ? [{ id: n.id, name: n.name, statement: n.statement }] : [];
		});
		const title = `Practice: ${picks.map((p) => p.name).slice(0, 3).join(", ")}${picks.length > 3 ? ` and ${picks.length - 3} more` : ""}`;
		try {
			router.push(await createSession(title, "practice", picks));
		} catch {
			setBusy(false);
		}
	};

	const relList = (title: string, ids: string[], empty: string) => (
		<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
			<span style={{ fontSize: 11, fontWeight: 700, color: "var(--faint)" }}>
				{title} · {ids.length}
			</span>
			{ids.length === 0 && <span style={{ fontSize: 12.5, color: "var(--v-muted)" }}>{empty}</span>}
			{ids.slice(0, NEIGHBOUR_LIMIT).map((id) => (
				<button key={id} type="button" className="nlink" onClick={() => pick(id)}>
					{byId.get(id)?.name ?? id}
				</button>
			))}
			{ids.length > NEIGHBOUR_LIMIT && (
				<span style={{ fontSize: 12, color: "var(--v-muted)" }}>and {ids.length - NEIGHBOUR_LIMIT} more</span>
			)}
		</div>
	);

	return (
		<div className="v4" style={{ height: "100vh", overflow: "hidden" }}>
			<Field variant="knowledge" />
			<div className="shell k">
				<SidebarCard
					knowledgeCount={props.length || null}
					footer={
						<>
							<input
								ref={fileRef}
								type="file"
								multiple
								accept=".md,.markdown,.txt"
								hidden
								onChange={(e) => {
									notesImport.onImportFiles(e.target.files);
									e.target.value = "";
								}}
							/>
							<button type="button" className="ghost" style={{ justifyContent: "center", width: "100%" }} disabled={notesImport.importing} onClick={() => fileRef.current?.click()}>
								{notesImport.importing ? "Importing…" : "Import notes"}
							</button>
						</>
					}
				>
					<div style={{ display: "flex", justifyContent: "space-between", padding: "10px 10px 4px", fontSize: 11, fontWeight: 700, color: "var(--faint)" }}>
						<span>Topics</span>
						<span>{props.length}</span>
					</div>
					<button
						type="button"
						className={`trow ${topic === null ? "on" : ""}`}
						onClick={() => {
							setTopic(null);
							api.current?.fit();
						}}
					>
						<span className="sw" style={{ background: "conic-gradient(#2f8f7f 0 25%, #4a78b5 0 50%, #b07a2e 0 75%, #b4566b 0)" }} />
						<span style={{ flex: 1 }}>All topics</span>
					</button>
					{(topics ?? []).map((t) => (
						<button
							key={t.id}
							type="button"
							className={`trow ${topic === t.id ? "on" : ""}`}
							onClick={() => {
								setTopic(t.id);
								api.current?.frame(t.ideaIds);
							}}
						>
							<span className="sw" style={{ background: topicColor(t.id) }} />
							<span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
							<span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
								{t.ideaIds.length}
							</span>
						</button>
					))}
				</SidebarCard>

				<main className="kmain">
					<div className="lh-drag" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", flex: "none" }}>
						<div style={{ display: "flex", flexDirection: "column" }}>
							<h1 className="serif" style={{ margin: 0, fontSize: 22, lineHeight: "28px", fontWeight: 500 }}>
								Knowledge graph
							</h1>
							<span style={{ fontSize: 12, color: "var(--v-muted)" }}>
								{snapshot ? `${props.length} ideas · ${snapshot.chains.length} chains · ${lessons} lessons · ${notes} notes` : "Loading…"}
							</span>
						</div>
						<label className="glass" style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, height: 34, padding: "0 10px", borderRadius: 10, color: "var(--v-muted)" }}>
							<SearchIcon />
							<input
								type="search"
								aria-label="Search ideas"
								placeholder="Search ideas"
								value={q}
								onChange={(e) => setQ(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										e.stopPropagation();
										setQ("");
									}
								}}
								style={{ width: 180, border: 0, background: "transparent", outline: "none", fontSize: 13 }}
							/>
							{matches !== null && (
								<span className="mono" style={{ fontSize: 11 }}>
									{matches} found
								</span>
							)}
						</label>
					</div>
					<NotesImportErrors errors={notesImport.errors} />

					<section className="canvas glass" aria-label={`Graph of ${props.length} ideas`}>
						<div style={{ position: "absolute", inset: 0 }}>
							<GraphView
								variant="v4"
								query={q}
								apiRef={api}
								highlight={highlight}
								onSelectIdea={(s) => setSel(s?.node ?? null)}
							/>
						</div>

						{sel && (
							<aside className="detail pop settle" aria-labelledby="idea">
								<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
									<span className="sw" style={{ background: selTopic ? topicColor(selTopic.id) : "var(--faint)" }} />
									<span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--v-muted)" }}>
										{selTopic?.name ?? "Idea"}
										{concludes ? " · conclusion" : ""}
									</span>
									<button type="button" className="ib" aria-label="Close" onClick={() => setSel(null)} style={{ marginLeft: "auto", width: 26, height: 26 }}>
										×
									</button>
								</div>
								<h2 id="idea" className="serif" style={{ margin: 0, fontSize: 17, lineHeight: "24px", fontWeight: 500 }}>
									{sel.name}
								</h2>
								<p className="serif" style={{ margin: 0, fontSize: 13.5, lineHeight: "20px", color: "var(--v-muted)" }}>
									{sel.statement}
								</p>
								{neighbours && relList("Rests on", neighbours.restsOn, "A starting point.")}
								{neighbours && relList("Leads to", neighbours.leadsTo, "Nothing yet: a good place to go deeper.")}
								<dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12 }}>
									<dt style={{ color: "var(--v-muted)" }}>Learned</dt>
									<dd style={{ margin: 0, textAlign: "right" }}>
										{[learnedIn, now ? ago(sel.createdAt, now) : null].filter(Boolean).join(" · ")}
									</dd>
									<dt style={{ color: "var(--v-muted)" }}>Practice</dt>
									<dd style={{ margin: 0, textAlign: "right" }}>{topicPracticed && now ? `Topic practised ${ago(topicPracticed, now)}` : "Not yet"}</dd>
								</dl>
								<div style={{ display: "flex", gap: 6 }}>
									<button
										type="button"
										className={`ghost ${inTray ? "on" : ""}`}
										onClick={() => setTray((t) => (inTray ? t.filter((x) => x !== sel.id) : [...t, sel.id]))}
									>
										{inTray ? "In practice tray" : "Add to practice"}
									</button>
									<button
										type="button"
										className="ghost"
										onClick={() => window.dispatchEvent(new CustomEvent("lh:open-omnibar", { detail: { query: sel.name } }))}
									>
										Go deeper
									</button>
								</div>
							</aside>
						)}

						<div className="maphint glass hide-sm">Click a topic to zoom · click an idea for its chain</div>
						<div className="ctrl glass" role="group" aria-label="Zoom">
							<button type="button" className="ib" aria-label="Zoom out" onClick={() => api.current?.zoomOut()}>
								−
							</button>
							<span className="mono" style={{ width: 44, textAlign: "center", fontSize: 11.5, color: "var(--v-muted)" }}>
								{zoomPct}%
							</span>
							<button type="button" className="ib" aria-label="Zoom in" onClick={() => api.current?.zoomIn()}>
								+
							</button>
							<button
								type="button"
								className="ghost"
								style={{ height: 28, marginLeft: 4 }}
								onClick={() => {
									setTopic(null);
									api.current?.fit();
								}}
							>
								Fit
							</button>
						</div>

						{tray.length > 0 && (
							<div className="tray pop settle" role="region" aria-label="Practice tray">
								<b style={{ whiteSpace: "nowrap" }}>{tray.length === 1 ? "1 idea to practice" : `${tray.length} ideas to practice`}</b>
								<button type="button" className="ib" aria-label="Clear" onClick={() => setTray([])} style={{ width: 26, height: 26 }}>
									×
								</button>
								<button type="button" className="btn" disabled={busy} onClick={() => void practiceTray()}>
									Practice them
								</button>
							</div>
						)}
					</section>
				</main>
			</div>
			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					readiness.markConfigured();
					setSetupOpen(false);
				}}
			/>
		</div>
	);
}
