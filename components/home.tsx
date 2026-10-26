"use client";

/**
 * HOME (Home4 of the v4 canvas; finesse pass): the greeting and the
 * omnibar, "Next from your graph", the learning strip (week / month),
 * Continue with the sessions waiting on you, this week's minutes against
 * the daily goal, Ready to practice (pick topics to mix), and what was
 * just added to the graph. Every number on the page is the server's
 * (components/v4/data.ts). Styles: app/ui/home.css.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { paletteResults, type PaletteRow } from "@/components/command-palette";
import { joinDictation, useDictation } from "@/components/dictation";
import { useGraphIndex, type IndexedIdea } from "@/components/graph-index";
import { ModelControl } from "@/components/model-picker";
import { NotesImportErrors, useNotesImport } from "@/components/notes-import";
import { SetupDialog } from "@/components/setup-dialog";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { OPEN_CONNECT_EVENT } from "@/components/connect-provider";
import { createSession, useStartReadiness, type StartPick } from "@/components/start-session";
import { EmptyState } from "@/components/ui/empty-state";
import { displayTitle, displayTopic } from "@/components/ui/format";
import { Icon, type IconName } from "@/components/ui/icon";
import {
	ago,
	fmtDuration,
	fmtTokens,
	isPractice,
	sessionLine,
	sessionState,
	topicColor,
	useChats,
	useDaily,
	useStats,
	useSuggestions,
	useTopics,
	type SessionState,
	type StatsPeriod,
	type V4Chat,
	type V4Daily,
	type V4Stats,
	type V4Topic,
} from "@/components/v4/data";
import { Field, SidebarCard } from "@/components/v4/shell";

type Mode = "teach" | "practice";

/** Picks ride the practice create as graph context; a cap keeps the
 *  opening prompt bounded however many topics are mixed. */
const PICK_CAP = 40;

/** Pure: the time-of-day greeting. Exported for tests. */
export function greeting(now: Date): string {
	const h = now.getHours();
	return h < 5 ? "Good evening." : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}

/** Pure: Continue's hero (the first session waiting on you, else the most
 *  recent) and the other waiting sessions. Exported for tests. */
export function continueModel(chats: readonly V4Chat[]): { hero: V4Chat | null; waiting: V4Chat[] } {
	const waiting = chats.filter((c) => sessionState(c) === "waiting");
	const hero = waiting[0] ?? chats[0] ?? null;
	return { hero, waiting: waiting.filter((c) => c !== hero).slice(0, 3) };
}

/** Pure: the five strip cells (Home4's KPI strip). Exported for tests.
 *  The strip shows the first four as learner stats; the fifth (tokens)
 *  becomes the quiet cost footnote under the period switch. */
export function kpiCells(s: V4Stats): Array<{ label: string; value: string; delta: string; up: boolean; sub: string }> {
	const deltaSec = s.time.seconds - s.time.prevSeconds;
	const prev = s.period === "week" ? "vs last week" : "vs last month";
	return [
		{
			label: "Time learning",
			value: fmtDuration(s.time.seconds),
			delta: deltaSec === 0 ? "" : `${deltaSec > 0 ? "+" : "−"}${fmtDuration(Math.abs(deltaSec))}`,
			up: deltaSec > 0,
			sub: prev,
		},
		{ label: "Lessons", value: String(s.lessons.active), delta: "", up: false, sub: `active · ${s.lessons.waiting} waiting on you` },
		{ label: "Ideas learned", value: `+${s.ideas.added}`, delta: "", up: false, sub: `${s.ideas.total} in your graph` },
		{ label: "Practice", value: String(s.practice.problems), delta: "", up: false, sub: `problems · ${s.practice.solid} solid` },
		{
			label: "Tokens",
			value: fmtTokens(s.tokens.total),
			delta: "",
			up: false,
			sub: s.tokens.dollars === null ? "cost unknown" : `≈ $${s.tokens.dollars.toFixed(2)}`,
		},
	];
}

/** Pure: the ideas a topic mix practises (newest first, capped). */
export function mixPicks(topics: readonly V4Topic[], picked: readonly string[], ideas: readonly IndexedIdea[]): StartPick[] {
	const ids = new Set(topics.filter((t) => picked.includes(t.id)).flatMap((t) => t.ideaIds));
	return ideas
		.filter((i) => ids.has(i.id))
		.slice(0, PICK_CAP)
		.map((i) => ({ id: i.id, name: i.name, statement: i.statement }));
}

export function Home({ initialConfigured, initialMode = "teach" }: { initialConfigured: boolean; initialMode?: Mode }) {
	const chats = useChats();
	const ideas = useGraphIndex();
	const readiness = useStartReadiness(initialConfigured);
	const [setupOpen, setSetupOpen] = useState(false);
	const [now, setNow] = useState<Date | null>(null);
	useEffect(() => setNow(new Date()), []);
	const needSetup = useCallback(() => setSetupOpen(true), []);

	return (
		<div className="v4">
			<Field />
			<div className="shell">
				<SidebarCard knowledgeCount={ideas?.length ?? null} />
				<main className="main">
					<div className="home">
						<HomeOmni chats={chats} now={now} initialMode={initialMode} ready={readiness.ready} onNeedSetup={needSetup} />
						{readiness.configured !== null && !readiness.ready && (
							<section className="home-setup glass rise" data-testid="home-setup">
								<span className="home-setup-ic" aria-hidden="true">
									<Icon name="provider" size="lg" />
								</span>
								<span className="home-setup-t">
									<b>{readiness.zeroKeys ? "Connect a provider to start" : "Choose your models to start"}</b>
									<span>LearnHarness runs on your own key: you pay the provider directly, and the key stays on this Mac.</span>
								</span>
								<button type="button" className="btn" data-testid="setup-cta" onClick={needSetup}>
									{readiness.zeroKeys ? "Add a provider key" : "Set up models"}
									<Icon name="arrow-right" size="sm" />
								</button>
							</section>
						)}
						<StatsStrip />
						<div className="home-grid">
							<ContinueCard chats={chats} now={now} />
							<WeekCard />
							<ReadyToPractice ideas={ideas} ready={readiness.ready} onNeedSetup={needSetup} now={now} />
							<JustAdded ideas={ideas} now={now} />
						</div>
					</div>
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

/** Focus the omnibar from anywhere on Home (empty states point at it). */
const focusOmnibar = () => window.dispatchEvent(new CustomEvent("lh:focus-omnibar"));

// ─── The omnibar ──────────────────────────────────────────────────────────

const ROW_ICON: Record<PaletteRow["icon"], IconName> = {
	learn: "learn",
	practice: "practice",
	session: "lesson",
	idea: "idea",
	graph: "knowledge",
	settings: "settings",
	connect: "provider",
};

function HomeOmni({
	chats,
	now,
	initialMode,
	ready,
	onNeedSetup,
}: {
	chats: V4Chat[] | null;
	now: Date | null;
	initialMode: Mode;
	ready: boolean;
	onNeedSetup: () => void;
}) {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const ideas = useGraphIndex();
	const suggestions = useSuggestions();
	const [q, setQ] = useState("");
	const qRef = useRef("");
	const [mode, setMode] = useState<Mode>(initialMode);
	const [walk, setWalk] = useState(0);
	const [focused, setFocused] = useState(false);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const notesImport = useNotesImport();
	const setQuery = useCallback((v: string) => {
		qRef.current = v;
		setQ(v);
		setWalk(0);
	}, []);
	const dictation = useDictation({ append: (t) => setQuery(joinDictation(qRef.current, t)) });

	// Query → results: the same model as ⌘K, minus the empty-query lists.
	const groups = useMemo(
		() => (q.trim() ? paletteResults(q, mode, chats ?? [], ideas ?? []) : []),
		[q, mode, chats, ideas],
	);
	const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
	const open = focused && rows.length > 0;
	const active = Math.min(walk, Math.max(0, rows.length - 1));

	// ⌘N (new lesson) and the rail's "+" land here: focus the field.
	useEffect(() => {
		const on = () => inputRef.current?.focus();
		window.addEventListener("lh:focus-omnibar", on);
		return () => window.removeEventListener("lh:focus-omnibar", on);
	}, []);

	const start = async (text: string, as: Mode) => {
		if (!text.trim() || busy) return;
		if (!ready) return onNeedSetup();
		setBusy(true);
		try {
			router.push(await createSession(text, as));
		} catch {
			setBusy(false);
		}
	};
	const run = (row: PaletteRow | undefined) => {
		if (!row) return;
		const a = row.action;
		if (a.kind === "start") void start(a.text, a.mode);
		else if (a.kind === "open-session") router.push(`/chat/${a.id}`);
		else if (a.kind === "open-idea") router.push(`/knowledge?idea=${encodeURIComponent(a.id)}`);
		else if (a.kind === "route") router.push(a.href);
		else if (a.kind === "connect") window.dispatchEvent(new Event(OPEN_CONNECT_EVENT));
		else openSettings();
	};
	const submit = () => {
		const go = () => (open ? run(rows[active]) : void start(qRef.current, mode));
		if (dictation.active) void dictation.finish().then(go);
		else go();
	};

	let index = -1;
	return (
		<section className="home-omni rise" aria-labelledby="greet">
			<h1 id="greet" className="home-greet serif" suppressHydrationWarning>
				{now ? greeting(now) : " "} <span>What shall we learn?</span>
			</h1>
			<form
				className="omni"
				role="search"
				aria-label="Learn, practice or search"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<label htmlFor="omni" className="sr">Learn, practice or search</label>
				<input
					ref={inputRef}
					id="omni"
					type="text"
					className="omni-input serif"
					autoComplete="off"
					spellCheck={false}
					value={q}
					data-testid="home-omnibar"
					onChange={(e) => setQuery(e.target.value)}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					onKeyDown={(e) => {
						if ((e.key === "ArrowDown" || e.key === "ArrowUp") && open) {
							e.preventDefault();
							const n = rows.length;
							setWalk((i) => (Math.min(i, n - 1) + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
						} else if (e.key === "Escape") {
							e.stopPropagation();
							if (dictation.active) dictation.cancel();
							else if (q) setQuery("");
							else e.currentTarget.blur();
						}
					}}
					placeholder={mode === "teach" ? "Learn anything, or search your sessions and ideas…" : "Practice a topic, or leave it blank for a mix…"}
				/>
				<div className="omni-bar">
					<div className="seg" role="radiogroup" aria-label="Mode">
						{(["teach", "practice"] as const).map((m) => (
							<button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)} data-testid={`omnibar-mode-${m}`}>
								<Icon name={m === "teach" ? "learn" : "practice"} size="sm" />
								{m === "teach" ? "Learn" : "Practice"}
							</button>
						))}
					</div>
					<span className="omni-sep" aria-hidden="true" />
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
					<button type="button" className="ib tipb" aria-label="Import notes (Markdown or text)" data-tip="Import notes" disabled={notesImport.importing} onClick={() => fileRef.current?.click()}>
						<Icon name="attach" size="md" />
					</button>
					<button
						type="button"
						className={`ib tipb ${dictation.active ? "on" : ""}`}
						aria-label={dictation.active ? "Stop dictation" : "Dictate"}
						data-tip={dictation.active ? "Stop dictation" : "Dictate"}
						aria-pressed={dictation.active}
						onClick={() => (dictation.active ? void dictation.finish() : dictation.toggle())}
					>
						{dictation.active ? (
							<span className="wave" aria-hidden="true"><i /><i /><i /><i /></span>
						) : (
							<Icon name="mic" size="md" />
						)}
					</button>
					<span className="hide-sm">
						<ModelControl variant="chip" className="mini" />
					</span>
					<span className="omni-fill" aria-hidden="true" />
					<span className="omni-hint hide-md">
						<span className="kbd">⌘K</span> from anywhere
					</span>
					<button type="submit" className="btn omni-go" disabled={busy}>
						{mode === "teach" ? "Learn" : "Practice"}
						<Icon name="arrow-right" size="sm" />
					</button>
				</div>
				{open && (
					<div className="drop pop settle" role="listbox" aria-label="Suggestions">
						{groups.map((g) => (
							<div key={g.name} className="drop-g">
								<div className="drop-h">{g.name}</div>
								{g.rows.map((row) => {
									index += 1;
									const i = index;
									const session = row.action.kind === "open-session";
									return (
										<button
											key={row.key}
											type="button"
											role="option"
											aria-selected={i === active}
											className={`prow ${i === active ? "first" : ""} k-${row.icon}`}
											onMouseDown={(e) => e.preventDefault()}
											onMouseMove={() => setWalk(i)}
											onClick={() => run(row)}
										>
											<Icon name={ROW_ICON[row.icon]} size="md" />
											<span className={`prow-l trunc ${row.icon === "idea" ? "serif" : ""}`}>{session ? displayTitle(row.label) : row.label}</span>
											{row.hint === "waiting on you" ? (
												<span className="pill warn">Waiting on you</span>
											) : (
												<span className="prow-h">{row.icon === "idea" ? displayTopic(row.hint) : row.hint}</span>
											)}
										</button>
									);
								})}
							</div>
						))}
						<div className="drop-foot" aria-hidden="true">
							<span><span className="kbd">↑</span><span className="kbd">↓</span> to move</span>
							<span><span className="kbd">↵</span> to open</span>
							<span><span className="kbd">esc</span> to clear</span>
						</div>
					</div>
				)}
			</form>
			<NotesImportErrors errors={notesImport.errors} />
			{suggestions.length > 0 && (
				<div className="home-next">
					<span className="home-next-l">
						<Icon name="hint" size="sm" />
						Next from your graph
					</span>
					{suggestions.slice(0, 3).map((s, i) => (
						<button
							key={s.title}
							type="button"
							className={`chip ${i === 2 ? "hide-md" : ""}`}
							title={s.reason}
							onClick={() => {
								setQuery(s.title);
								setMode("teach");
								inputRef.current?.focus();
							}}
						>
							{s.title}
						</button>
					))}
				</div>
			)}
		</section>
	);
}

// ─── The learning strip ───────────────────────────────────────────────────

interface StripCell {
	icon: IconName;
	label: string;
	value: string;
	delta: { up: boolean; text: string } | null;
	sub: string;
}

/** The four learner stats, from kpiCells' numbers with Home's copy: a zero
 *  never headlines as "+0", it says what would move it. */
function stripCells(s: V4Stats): StripCell[] {
	const k = kpiCells(s);
	const span = s.period === "week" ? "this week" : "this month";
	const deltaSec = s.time.seconds - s.time.prevSeconds;
	return [
		{
			icon: "time",
			label: "Time learning",
			value: k[0]!.value,
			delta: deltaSec === 0 ? null : { up: deltaSec > 0, text: fmtDuration(Math.abs(deltaSec)) },
			sub: deltaSec !== 0 ? k[0]!.sub : s.time.seconds > 0 ? `Same as last ${s.period}` : `Nothing yet ${span}`,
		},
		{
			icon: "lesson",
			label: "Lessons",
			value: k[1]!.value,
			delta: null,
			sub: s.lessons.waiting > 0 ? `${s.lessons.waiting} waiting on you` : s.lessons.active > 0 ? "In progress" : "Start one above",
		},
		{
			icon: "idea",
			label: "Ideas learned",
			value: String(s.ideas.added),
			delta: null,
			sub: s.ideas.total > 0 ? `${s.ideas.total} in your graph` : "Grows as you learn",
		},
		{
			icon: "practice",
			label: "Practice",
			value: k[3]!.value,
			delta: null,
			sub: s.practice.problems > 0 ? `${s.practice.solid} solid` : "Mix topics below to start",
		},
	];
}

function StatsStrip() {
	const [period, setPeriod] = useState<StatsPeriod>("week");
	const stats = useStats(period);
	const cells = stats ? stripCells(stats) : null;
	const tokens = stats ? kpiCells(stats)[4]! : null;
	return (
		<section className="strip glass rise" aria-labelledby="usage">
			<h2 id="usage" className="sr">Your learning</h2>
			<div className="strip-cells">
				{cells
					? cells.map((k) => (
							<div key={`${period}-${k.label}`} className="kpi swap">
								<span className="kpi-l">
									<Icon name={k.icon} size="sm" />
									{k.label}
								</span>
								<span className="kpi-v num">{k.value}</span>
								<span className="kpi-s">
									{k.delta && (
										<span className={k.delta.up ? "kpi-up" : "kpi-down"}>
											<Icon name={k.delta.up ? "arrow-up" : "arrow-down"} size="xs" />
											{k.delta.text}
										</span>
									)}
									<span className="trunc">{k.sub}</span>
								</span>
							</div>
						))
					: [0, 1, 2, 3].map((i) => (
							<div key={i} className="kpi" aria-hidden="true">
								<i className="skel kpi-sk-l" />
								<i className="skel kpi-sk-v" />
								<i className="skel kpi-sk-s" />
							</div>
						))}
			</div>
			<div className="strip-side">
				<div className="seg sm" role="radiogroup" aria-label="Period">
					{(["week", "month"] as const).map((p) => (
						<button key={p} type="button" role="radio" aria-checked={period === p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)}>
							{p === "week" ? "Week" : "Month"}
						</button>
					))}
				</div>
				<span className="strip-foot num" title="Model usage on your own provider key">
					{tokens ? `${tokens.value} tokens · ${tokens.sub}` : " "}
				</span>
			</div>
		</section>
	);
}

// ─── Continue ─────────────────────────────────────────────────────────────

function Ticks({ total, current, visited, size }: { total: number; current: number | null; visited: number; size?: "lg" }) {
	return (
		<span className={`ticks ${size ?? ""}`} role="img" aria-label={`${visited} of ${total} steps visited`}>
			{Array.from({ length: total }, (_, i) => (
				<i key={i} className={current !== null && i + 1 === current ? "c" : i < visited ? "d" : ""} />
			))}
		</span>
	);
}

const STATE_PILL: Record<SessionState, { tone: string; label: string }> = {
	waiting: { tone: "warn", label: "Waiting on you" },
	working: { tone: "brand", label: "Working" },
	paused: { tone: "muted", label: "Paused" },
	finished: { tone: "good", label: "Finished" },
};

/** "Step 6 of 14" / "Problem 1 of 5", or null when the session has no map. */
function position(c: V4Chat): string | null {
	if (c.plan && c.plan.current !== null) return `Step ${c.plan.current} of ${c.plan.total}`;
	if (c.practiceSet) return `Problem ${Math.min(c.practiceSet.done + 1, c.practiceSet.size)} of ${c.practiceSet.size}`;
	return null;
}

function ContinueCard({ chats, now }: { chats: V4Chat[] | null; now: Date | null }) {
	const { hero, waiting } = useMemo(() => continueModel(chats ?? []), [chats]);
	const state = hero ? sessionState(hero) : null;
	const pill = state ? STATE_PILL[state] : null;
	const practice = hero ? isPractice(hero) : false;
	const question = hero?.pendingQuestionText ?? null;
	const where = hero ? position(hero) : null;
	const stats = hero
		? [
				hero.minutes ? `${hero.minutes} min in` : null,
				hero.answers && hero.answers.total > 0 ? `${hero.answers.firstTry} of ${hero.answers.total} right first time` : null,
			].filter(Boolean)
		: [];
	return (
		<section className="cont glass rise" aria-labelledby="cont">
			<h2 id="cont" className="sr">Continue</h2>
			{chats === null ? (
				<div className="cont-hero" aria-hidden="true">
					<i className="skel cont-sk-a" />
					<i className="skel cont-sk-b" />
					<i className="skel cont-sk-c" />
					<i className="skel cont-sk-d" />
				</div>
			) : !hero || !pill ? (
				<EmptyState
					icon="lesson"
					title="Your first lesson starts above"
					className="cont-empty"
					action={
						<button type="button" className="btn secondary" onClick={focusOmnibar}>
							<Icon name="plus" size="sm" />
							Start a lesson
						</button>
					}
				>
					Ask about anything you want to understand. Lessons wait here for you between visits.
				</EmptyState>
			) : (
				<>
					<Link className="cont-hero" href={`/chat/${hero.id}`} data-testid="home-continue">
						<span className="cont-over">
							<span className={`pill ${pill.tone}`}>
								{state === "waiting" && <span className="ping" aria-hidden="true" />}
								{pill.label}
							</span>
							<span className="cont-kind">
								<Icon name={practice ? "practice" : "lesson"} size="xs" />
								{practice ? "Practice" : "Lesson"}
							</span>
							<span className="cont-ago">{now ? ago(hero.updatedAt, now) : ""}</span>
						</span>
						<span className="cont-q serif">{question ?? displayTitle(hero.title)}</span>
						{(question || where) && (
							<span className="cont-meta">
								{question && <span className="trunc">{displayTitle(hero.title)}</span>}
								{question && where && <span aria-hidden="true">·</span>}
								{where && <span className="cont-where">{where}</span>}
							</span>
						)}
						<span className="cont-foot">
							{hero.plan ? (
								<Ticks total={hero.plan.total} current={hero.plan.current} visited={hero.plan.visited} />
							) : hero.practiceSet ? (
								<Ticks total={hero.practiceSet.size} current={Math.min(hero.practiceSet.done + 1, hero.practiceSet.size)} visited={hero.practiceSet.done} />
							) : null}
							{stats.length > 0 && <span className="cont-stats hide-sm">{stats.join(" · ")}</span>}
							<span className="btn cont-go">
								Continue
								<Icon name="arrow-right" size="sm" />
							</span>
						</span>
					</Link>
					{waiting.length > 0 && (
						<div className="cont-more">
							<span className="over">Also waiting on you</span>
							{waiting.map((c) => (
								<Link key={c.id} className="wrow" href={`/chat/${c.id}`}>
									<Icon name={isPractice(c) ? "practice" : "lesson"} size="sm" />
									<span className="wrow-t trunc">{displayTitle(c.title)}</span>
									<span className="wrow-m">{sessionLine(c)}</span>
									<Icon name="chevron-right" size="sm" className="wrow-go" />
								</Link>
							))}
						</div>
					)}
				</>
			)}
		</section>
	);
}

// ─── This week ────────────────────────────────────────────────────────────

/** Pure: bar heights as % of the week's busiest day (min 100 minutes or
 *  the goal, so a light week doesn't fill the chart). Exported for tests. */
export function barHeights(daily: V4Daily): number[] {
	const top = Math.max(...daily.days.map((d) => d.minutes), daily.goalMinutes * 1.5, 1);
	return daily.days.map((d) => Math.round((d.minutes / top) * 100));
}

function fmtMinutes(m: number): string {
	return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function WeekCard() {
	const daily = useDaily();
	const heights = daily ? barHeights(daily) : null;
	const goalPct = daily ? Math.round((daily.goalMinutes / Math.max(...daily.days.map((d) => d.minutes), daily.goalMinutes * 1.5, 1)) * 100) : 0;
	const todayIdx = daily?.days.findIndex((d) => d.today) ?? -1;
	const soFar = todayIdx === -1 ? (daily?.days.length ?? 7) : todayIdx + 1;
	const total = daily?.days.reduce((n, d) => n + d.minutes, 0) ?? 0;
	const label = daily
		? `Minutes learning per day this week: ${daily.days.map((d) => `${d.label} ${d.minutes}`).join(", ")}. Goal ${daily.goalMinutes} a day, met on ${daily.metDays} days.`
		: "Minutes learning this week";
	return (
		<section className="week glass card rise" aria-labelledby="mins">
			<div className="card-head">
				<h2 id="mins" className="h">This week</h2>
				{daily && (
					<span className="card-meta">
						Goal {daily.goalMinutes} min a day · met {daily.metDays} of {soFar} {soFar === 1 ? "day" : "days"}
					</span>
				)}
			</div>
			{daily ? (
				<>
					<div className="week-sum">
						<span className="num">{fmtMinutes(total)}</span>
						<span>{total > 0 ? "learning so far" : "A few minutes a day adds up"}</span>
					</div>
					<div className="bars" role="img" aria-label={label}>
						<span className="goal" aria-hidden="true" style={{ bottom: `${goalPct}%` }}>
							<span>{daily.goalMinutes} min</span>
						</span>
						{daily.days.map((d, i) => {
							const future = todayIdx !== -1 && i > todayIdx;
							const h = future ? goalPct : Math.max(heights?.[i] ?? 0, d.minutes > 0 ? 4 : 2);
							return (
								<div key={d.date} className={`bar ${d.today ? "today" : ""} ${future ? "future" : ""} ${d.minutes === 0 ? "none" : ""}`}>
									{!future && d.minutes > 0 && <b className="num">{d.minutes}</b>}
									<i style={{ height: `${h}%`, animationDelay: `${200 + i * 40}ms` }} />
								</div>
							);
						})}
					</div>
					<div className="days" aria-hidden="true">
						{daily.days.map((d) => (
							<span key={d.date} className={d.today ? "today" : ""}>
								{d.today ? "Today" : d.label}
							</span>
						))}
					</div>
				</>
			) : (
				<div className="week-sk" aria-hidden="true">
					<i className="skel" />
					<span>
						{[40, 64, 28, 52, 18, 46, 34].map((h, i) => (
							<i key={i} className="skel" style={{ height: `${h}%` }} />
						))}
					</span>
				</div>
			)}
		</section>
	);
}

// ─── Ready to practice ────────────────────────────────────────────────────

function ReadyToPractice({ ideas, ready, onNeedSetup, now }: { ideas: IndexedIdea[] | null; ready: boolean; onNeedSetup: () => void; now: Date | null }) {
	const router = useRouter();
	const topics = useTopics();
	const [picked, setPicked] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	// The four topics that most want practice: never practised first, then
	// the longest since practice.
	const shown = useMemo(
		() =>
			[...(topics ?? [])]
				.sort((a, b) => (a.lastPracticedAt ?? "").localeCompare(b.lastPracticedAt ?? ""))
				.slice(0, 4),
		[topics],
	);
	const picks = useMemo(() => mixPicks(shown, picked, ideas ?? []), [shown, picked, ideas]);
	const ideaCount = shown.filter((t) => picked.includes(t.id)).reduce((n, t) => n + t.ideaIds.length, 0);
	const note =
		picked.length === 0 ? "Nothing picked: a mix of everything" : `${picked.length} picked · about ${Math.max(10, Math.round(ideaCount * 0.8))} min`;

	const start = async () => {
		if (busy) return;
		if (!ready) return onNeedSetup();
		setBusy(true);
		const names = shown.filter((t) => picked.includes(t.id)).map((t) => t.name);
		const title = names.length ? `Practice: ${names.join(", ")}` : "Practice: a mix of everything";
		try {
			router.push(await createSession(title, "practice", picks));
		} catch {
			setBusy(false);
		}
	};

	return (
		<section className="ready glass card rise" aria-labelledby="ready">
			<div className="card-head">
				<h2 id="ready" className="h">Ready to practice</h2>
				{shown.length > 0 && <span className="card-meta">Pick topics to mix</span>}
			</div>
			{topics === null ? (
				<div className="picks" aria-hidden="true">
					{[0, 1, 2, 3].map((i) => (
						<i key={i} className="skel pick-sk" />
					))}
				</div>
			) : shown.length === 0 ? (
				<EmptyState icon="practice" title="Nothing to practise yet" className="card-empty">
					Topics land here once your lessons are saved to your graph.
				</EmptyState>
			) : (
				<>
					<div className="picks">
						{shown.map((t) => {
							const on = picked.includes(t.id);
							return (
								<button
									key={t.id}
									type="button"
									role="checkbox"
									aria-checked={on}
									className={`pick ${on ? "on" : ""}`}
									onClick={() => setPicked((p) => (on ? p.filter((x) => x !== t.id) : [...p, t.id]))}
								>
									<span className="box" aria-hidden="true">
										<Icon name="check" size="xs" strokeWidth={3} />
									</span>
									<span className="pick-t">
										<b className="trunc">{displayTopic(t.name)}</b>
										<span className="trunc">
											{t.ideaIds.length} ideas · {t.lastPracticedAt ? `practised ${now ? ago(t.lastPracticedAt, now) : ""}` : "never practised"}
										</span>
									</span>
								</button>
							);
						})}
					</div>
					<div className="card-foot">
						<span className="card-note">{note}</span>
						<button type="button" className="btn brand" disabled={busy} onClick={() => void start()}>
							<Icon name="practice" size="sm" />
							{picked.length > 1 ? `Practice these ${picked.length}` : "Start practice"}
						</button>
					</div>
				</>
			)}
		</section>
	);
}

// ─── Just added ───────────────────────────────────────────────────────────

const JUST_ADDED = 3;

function JustAdded({ ideas, now }: { ideas: IndexedIdea[] | null; now: Date | null }) {
	const topics = useTopics();
	const topicOf = useMemo(() => {
		const m = new Map<string, V4Topic>();
		for (const t of topics ?? []) for (const id of t.ideaIds) m.set(id, t);
		return m;
	}, [topics]);
	const week = now ? (ideas ?? []).filter((i) => now.getTime() - new Date(i.createdAt).getTime() < 7 * 86_400_000).length : 0;
	const shown = (ideas ?? []).slice(0, JUST_ADDED);
	return (
		<section className="added glass card rise" aria-labelledby="new">
			<div className="card-head">
				<h2 id="new" className="h">Just added</h2>
				<Link href="/knowledge" className="link t-small">
					Graph
					<Icon name="arrow-right" size="sm" />
				</Link>
			</div>
			{ideas === null ? (
				<div className="ideas" aria-hidden="true">
					{[0, 1, 2].map((i) => (
						<span key={i} className="idea-sk">
							<i className="skel" />
							<i className="skel" />
						</span>
					))}
				</div>
			) : shown.length === 0 ? (
				<EmptyState icon="idea" title="No ideas yet" className="card-empty">
					What you learn is saved here as ideas, linked into your graph.
				</EmptyState>
			) : (
				<div className="ideas">
					{shown.map((idea) => {
						const topic = topicOf.get(idea.id);
						const from = topic ? displayTopic(topic.name) : idea.source ? displayTopic(idea.source) : null;
						return (
							<Link key={idea.id} className="idea" href={`/knowledge?idea=${encodeURIComponent(idea.id)}`} title={idea.statement}>
								<span className="idea-dot" aria-hidden="true" style={topic ? { background: topicColor(topic.id) } : undefined} />
								<span className="idea-t">
									<span className="serif trunc">{idea.name}</span>
									<span className="trunc">{[from, now ? ago(idea.createdAt, now) : null].filter(Boolean).join(" · ")}</span>
								</span>
							</Link>
						);
					})}
					{week > shown.length && <span className="ideas-more">{week - shown.length} more this week</span>}
				</div>
			)}
		</section>
	);
}
