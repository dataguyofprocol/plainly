"use client";

/**
 * HOME — "one next step" (owner, 2026-10-26). Home answers a single
 * question: what do I do next? One centred column:
 *
 *   setup callout   only while no provider/model is set
 *   greeting        + one field for what to learn or practise (search-as-
 *                   you-type for sessions and ideas), Practice and Learn,
 *                   the model chip, and "Next from your graph"
 *   Continue        the session waiting on you (else the latest one); more
 *                   waiting sessions fold behind one quiet line
 *   progress line   this week's minutes, the goal, the graph's size
 *
 * Lessons and practice start the same way — type a topic, pick the kind
 * (owner: one uniform flow). "New practice" (sidebar, rail, ⌘K, /practice)
 * makes Practice the field's primary action. The sidebar keeps the full
 * session list, so nothing here repeats it. Every number is the server's
 * (components/v4/data.ts). Styles: app/ui/home.css (classes prefixed hm-).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { paletteResults, type PaletteRow } from "@/components/command-palette";
import { joinDictation, useDictation } from "@/components/dictation";
import { useGraphIndex, type IndexedIdea } from "@/components/graph-index";
import { ModelControl } from "@/components/model-picker";
import { SetupDialog } from "@/components/setup-dialog";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { OPEN_CONNECT_EVENT } from "@/components/connect-provider";
import { createSession, useStartReadiness, type StartPick } from "@/components/start-session";
import { displayTitle, displayTopic } from "@/components/ui/format";
import { Icon, type IconName } from "@/components/ui/icon";
import {
	ago,
	fmtDuration,
	fmtTokens,
	isPractice,
	sessionLine,
	sessionState,
	useChats,
	useDaily,
	useStats,
	useSuggestions,
	type V4Chat,
	type V4Daily,
	type V4Stats,
	type V4Topic,
} from "@/components/v4/data";
import { Field, SidebarCard } from "@/components/v4/shell";
import { MathLine } from "@/components/latex-glyph";

type Mode = "teach" | "practice";

/** Picks ride the practice create as graph context; a cap keeps the
 *  opening prompt bounded however many topics are mixed. */
const PICK_CAP = 40;

/** Pure: the time-of-day greeting. Exported for tests. */
export function greeting(now: Date): string {
	const h = now.getHours();
	return h < 5 ? "Good evening." : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}

/** Home's greeting lines by local time of day: [lead, tail] pairs per
 *  bucket (owner, 2026-10-26). An empty tail means the lead stands alone. */
const GREETINGS: Array<{ from: number; lines: Array<[string, string]> }> = [
	{ from: 1, lines: [["Burning the midnight oil?", ""], ["Quiet hours.", "What shall we explore?"]] },
	{ from: 5, lines: [["Early start.", "What's on your mind?"], ["Up with the sun.", "What shall we learn?"]] },
	{ from: 8, lines: [["Good morning.", "What shall we learn today?"], ["Morning.", "Fresh mind, fresh topic?"]] },
	{ from: 12, lines: [["Good afternoon.", "Got a few minutes?"], ["Lunch break?", "Let's learn something."]] },
	{ from: 14, lines: [["Good afternoon.", "What are you curious about?"], ["Afternoon.", "What shall we dig into?"]] },
	{ from: 18, lines: [["Good evening.", "What shall we dig into?"], ["Evening.", "Something new before the day ends?"]] },
	{ from: 22, lines: [["Still up?", "Let's learn something."], ["Late one.", "What's keeping you curious?"]] },
];
const PRACTICE_TAILS = ["What shall we sharpen?", "Ready for a few problems?"];

/** Pure: today's greeting for this moment, as { lead, tail }. The bucket
 *  follows the local hour; the line within it follows the local date, so
 *  it holds all day and changes tomorrow. Practice swaps in a practice
 *  tail. Exported for tests. */
export function homeGreeting(now: Date, mode: "teach" | "practice" = "teach"): { lead: string; tail: string } {
	const h = now.getHours();
	// 22:00–00:59 belongs to the late bucket; GREETINGS is ordered by start.
	const bucket = h < 1 ? GREETINGS[GREETINGS.length - 1]! : [...GREETINGS].reverse().find((b) => h >= b.from)!;
	const day = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 86_400_000);
	const [lead, tail] = bucket.lines[day % bucket.lines.length]!;
	if (mode === "practice") return { lead, tail: PRACTICE_TAILS[day % PRACTICE_TAILS.length]! };
	return { lead, tail };
}

/** Pure: Continue's hero (the first session waiting on you, else the most
 *  recent) and the other waiting sessions. Archived sessions never surface
 *  here. Exported for tests. */
export function continueModel(chats: readonly V4Chat[]): { hero: V4Chat | null; waiting: V4Chat[] } {
	const live = chats.filter((c) => !c.archived);
	const waiting = live.filter((c) => sessionState(c) === "waiting");
	const hero = waiting[0] ?? live[0] ?? null;
	return { hero, waiting: waiting.filter((c) => c !== hero).slice(0, 3) };
}

/** Pure: the period's numbers as labelled cells (time, lessons, ideas,
 *  practice, tokens). Exported for tests; Home's progress line reads the
 *  time cell. */
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

/** Pure: bar heights as % of the week's busiest day (min 1.5× the goal,
 *  so a light week doesn't fill a chart). Exported for tests. */
export function barHeights(daily: V4Daily): number[] {
	const top = Math.max(...daily.days.map((d) => d.minutes), daily.goalMinutes * 1.5, 1);
	return daily.days.map((d) => Math.round((d.minutes / top) * 100));
}

export function Home({ initialConfigured, initialMode = "teach" }: { initialConfigured: boolean; initialMode?: Mode }) {
	const chats = useChats();
	const ideas = useGraphIndex();
	const readiness = useStartReadiness(initialConfigured);
	const [setupOpen, setSetupOpen] = useState(false);
	const [now, setNow] = useState<Date | null>(null);
	useEffect(() => setNow(new Date()), []);
	const needSetup = useCallback(() => setSetupOpen(true), []);
	// The session kind the composer starts — it also tints the page: teal
	// for Learn, the warm register for Practice. Follows the URL (/practice,
	// ⌘K "New practice set") and the New-session event.
	const [mode, setMode] = useState<Mode>(initialMode);
	useEffect(() => setMode(initialMode), [initialMode]);

	return (
		<div className={`v4 hm-root ${mode === "practice" ? "warm" : ""}`}>
			<Field variant={mode === "practice" ? "warm" : "home"} />
			<div className="shell">
				<SidebarCard knowledgeCount={ideas?.length ?? null} />
				<main className="main">
					<div className="hm">
						{readiness.configured !== null && !readiness.ready && (
							<section className="hm-setup glass rise" data-testid="home-setup">
								<span className="hm-setup-ic" aria-hidden="true">
									<Icon name="provider" size="lg" />
								</span>
								<span className="hm-setup-t">
									<b>{readiness.zeroKeys ? "Connect a provider to start" : "Choose your models to start"}</b>
									<span>Plainly runs on your own key: you pay the provider directly, and the key stays on this Mac.</span>
								</span>
								<button type="button" className="btn" data-testid="setup-cta" onClick={needSetup}>
									{readiness.zeroKeys ? "Add a provider key" : "Set up models"}
									<Icon name="arrow-right" size="sm" />
								</button>
							</section>
						)}
						<LearnField chats={chats} now={now} mode={mode} onMode={setMode} focusOnArrival={initialMode === "practice"} ready={readiness.ready} onNeedSetup={needSetup} />
						<ContinueCard chats={chats} now={now} />
						<WeekStrip ideaCount={ideas?.length ?? null} />
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

// ─── The composer ─────────────────────────────────────────────────────────

const ROW_ICON: Record<PaletteRow["icon"], IconName> = {
	learn: "learn",
	practice: "practice",
	session: "lesson",
	idea: "idea",
	graph: "knowledge",
	settings: "settings",
	connect: "provider",
};

const MODES: ReadonlyArray<{ id: Mode; label: string; icon: IconName }> = [
	{ id: "teach", label: "Learn", icon: "learn" },
	{ id: "practice", label: "Practice", icon: "practice" },
];

function LearnField({
	chats,
	now,
	mode,
	onMode,
	focusOnArrival,
	ready,
	onNeedSetup,
}: {
	chats: V4Chat[] | null;
	now: Date | null;
	mode: Mode;
	onMode: (m: Mode) => void;
	focusOnArrival: boolean;
	ready: boolean;
	onNeedSetup: () => void;
}) {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const ideas = useGraphIndex();
	const suggestions = useSuggestions();
	const [q, setQ] = useState("");
	const qRef = useRef("");
	const [walk, setWalk] = useState(-1);
	const [focused, setFocused] = useState(false);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const setQuery = useCallback((v: string) => {
		qRef.current = v;
		setQ(v);
		setWalk(-1);
	}, []);
	const dictation = useDictation({ append: (t) => setQuery(joinDictation(qRef.current, t)) });

	// Query → matching sessions and ideas (the ⌘K model). Its "Start" rows
	// are left out: the composer itself is the start, in the chosen kind.
	const groups = useMemo(
		() => (q.trim() ? paletteResults(q, mode, chats ?? [], ideas ?? []).filter((g) => g.name !== "Start") : []),
		[q, mode, chats, ideas],
	);
	const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
	const open = focused && rows.length > 0;
	// Nothing is preselected (-1): Enter starts a session until an arrow key
	// picks a result.
	const active = Math.min(walk, rows.length - 1);

	// New lesson / New practice (sidebar, rail, ⌘N) land here: focus the
	// field, ready for the kind the event names.
	useEffect(() => {
		const on = (e: Event) => {
			const next = (e as CustomEvent<{ mode?: Mode } | null>).detail?.mode;
			if (next) onMode(next);
			inputRef.current?.focus();
		};
		window.addEventListener("lh:focus-omnibar", on);
		return () => window.removeEventListener("lh:focus-omnibar", on);
	}, [onMode]);
	// Arriving to practise (/practice, ⌘K "New practice set"): focus the field.
	useEffect(() => {
		if (focusOnArrival) inputRef.current?.focus();
	}, [focusOnArrival]);

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
		const go = () => (open && active >= 0 ? run(rows[active]) : void start(qRef.current, mode));
		if (dictation.active) void dictation.finish().then(go);
		else go();
	};

	const greet = now ? homeGreeting(now, mode) : null;
	let index = -1;
	return (
		<section className="hm-learn rise" aria-labelledby="greet">
			<h1 id="greet" className="hm-greet serif" suppressHydrationWarning>
				{greet ? (
					<>
						{greet.lead} {greet.tail && <span>{greet.tail}</span>}
					</>
				) : (
					" "
				)}
			</h1>
			<form
				className={`hm-composer ${mode === "practice" ? "practice" : ""}`}
				role="search"
				aria-label="Start a lesson or practice, or search your sessions and ideas"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<label htmlFor="omni" className="sr">
					What to learn or practise, or search your sessions and ideas
				</label>
				<input
					ref={inputRef}
					id="omni"
					type="text"
					className="hm-input serif"
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
							// -1 (the field) → first/last row; past either end → back to the field.
							setWalk((i) => {
								const at = Math.min(i, n - 1);
								const next = e.key === "ArrowDown" ? at + 1 : at === -1 ? n - 1 : at - 1;
								return next >= n ? -1 : next;
							});
						} else if (e.key === "Escape") {
							e.stopPropagation();
							if (dictation.active) dictation.cancel();
							else if (q) setQuery("");
							else e.currentTarget.blur();
						}
					}}
					placeholder={mode === "practice" ? "What do you want to practise?" : "What do you want to understand?"}
				/>
				<div className="hm-bar">
					{/* The kind of session: Learn or Practice. A radio group —
					    arrows move between the two, the whole page re-tints. */}
					<div className="seg hm-mode" role="radiogroup" aria-label="Kind of session">
						{MODES.map((m) => {
							const on = mode === m.id;
							return (
								<button
									key={m.id}
									type="button"
									role="radio"
									aria-checked={on}
									tabIndex={on ? 0 : -1}
									className={on ? "on" : ""}
									data-testid={`home-mode-${m.id}`}
									onClick={() => {
										onMode(m.id);
										inputRef.current?.focus();
									}}
									onKeyDown={(e) => {
										if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
											e.preventDefault();
											const next: Mode = m.id === "teach" ? "practice" : "teach";
											onMode(next);
											(e.currentTarget.parentElement?.querySelector(`[data-testid=home-mode-${next}]`) as HTMLElement | null)?.focus();
										}
									}}
								>
									<Icon name={m.icon} size="md" />
									{m.label}
								</button>
							);
						})}
					</div>
					<ModelControl variant="chip" className="mini hm-model" />
					<span className="hm-fill" aria-hidden="true" />
					<button
						type="button"
						className={`ib lg tipb up mid ${dictation.active ? "on" : ""}`}
						aria-label={dictation.active ? "Stop dictation" : "Dictate"}
						data-tip={dictation.active ? "Stop dictation" : "Dictate"}
						aria-pressed={dictation.active}
						onClick={() => (dictation.active ? void dictation.finish() : dictation.toggle())}
					>
						{dictation.active ? (
							<span className="wave" aria-hidden="true">
								<i />
								<i />
								<i />
								<i />
							</span>
						) : (
							<Icon name="mic" size="md" />
						)}
					</button>
					<button
						type="submit"
						className="hm-send tipb up mid"
						aria-label={mode === "practice" ? "Start practice" : "Start lesson"}
						data-tip={mode === "practice" ? "Start practice  ↵" : "Start lesson  ↵"}
						data-testid={`home-start-${mode}`}
						disabled={busy || !q.trim()}
					>
						<Icon name="arrow-up" size="lg" strokeWidth={2.25} />
					</button>
				</div>
				{open && (
					<div className="hm-drop pop settle" role="listbox" aria-label="Matching sessions and ideas">
						{groups.map((g) => (
							<div key={g.name} className="hm-drop-g">
								<div className="hm-drop-h">{g.name}</div>
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
											className={`hm-row ${i === active ? "at" : ""} k-${row.icon}`}
											onMouseDown={(e) => e.preventDefault()}
											onMouseMove={() => setWalk(i)}
											onClick={() => run(row)}
										>
											<Icon name={ROW_ICON[row.icon]} size="md" />
											<span className={`hm-row-l trunc ${row.icon === "idea" ? "serif" : ""}`}>{session ? displayTitle(row.label) : row.label}</span>
											{row.hint === "waiting on you" ? (
												<span className="pill warn">Waiting on you</span>
											) : (
												<span className="hm-row-h">{row.icon === "idea" ? displayTopic(row.hint) : row.hint}</span>
											)}
										</button>
									);
								})}
							</div>
						))}
					</div>
				)}
			</form>
			{suggestions.length > 0 && (
				<div className="hm-next" aria-label="Next from your graph">
					{suggestions.slice(0, 3).map((s) => (
						<button
							key={s.title}
							type="button"
							className="chip"
							title={`${s.title} — ${s.reason}`}
							onClick={() => {
								setQuery(s.title);
								inputRef.current?.focus();
							}}
						>
							<Icon name="hint" size="sm" />
							<span>{s.title}</span>
						</button>
					))}
				</div>
			)}
		</section>
	);
}

// ─── Continue ─────────────────────────────────────────────────────────────

/** "Step 6 of 14" / "Problem 1 of 5", or null when the session has no map. */
function position(c: V4Chat): string | null {
	if (c.plan && c.plan.current !== null) return `Step ${c.plan.current} of ${c.plan.total}`;
	if (c.practiceSet) return `Problem ${Math.min(c.practiceSet.done + 1, c.practiceSet.size)} of ${c.practiceSet.size}`;
	return null;
}

function ContinueCard({ chats, now }: { chats: V4Chat[] | null; now: Date | null }) {
	const { hero, waiting } = useMemo(() => continueModel(chats ?? []), [chats]);
	const [moreOpen, setMoreOpen] = useState(false);
	if (chats === null) {
		return (
			<section className="hm-card glass rise hm-cont" aria-hidden="true">
				<i className="skel hm-sk-a" />
				<i className="skel hm-sk-b" />
				<i className="skel hm-sk-c" />
			</section>
		);
	}
	// No sessions yet: the Learn field is the whole invitation.
	if (!hero) return null;
	const isWaiting = sessionState(hero) === "waiting";
	const practice = isPractice(hero);
	const question = hero.pendingQuestionText;
	const where = position(hero);
	return (
		<section className="hm-card glass rise hm-cont" aria-labelledby="cont">
			<Link className="hm-cont-hero" href={`/chat/${hero.id}`} data-testid="home-continue">
				<span className="hm-over">
					{isWaiting ? (
						<span className="pill warn" id="cont">
							<span className="ping" aria-hidden="true" />
							Waiting on you
						</span>
					) : (
						<span className="hm-over-l" id="cont">
							Pick up where you left off
						</span>
					)}
					<span className="hm-ago">{now ? ago(hero.updatedAt, now) : ""}</span>
				</span>
				<span className="hm-q serif">{question ? <MathLine text={question} /> : displayTitle(hero.title)}</span>
				<span className="hm-cont-foot">
					<span className="hm-meta">
						<Icon name={practice ? "practice" : "lesson"} size="sm" />
						{question && <span className="trunc">{displayTitle(hero.title)}</span>}
						{question && where && <span aria-hidden="true">·</span>}
						{where ? <span className="hm-where">{where}</span> : !question && <span>{practice ? "Practice" : "Lesson"}</span>}
					</span>
					<span className="btn hm-cont-go">
						Continue
						<Icon name="arrow-right" size="sm" />
					</span>
				</span>
			</Link>
			{waiting.length > 0 && (
				<div className="hm-more">
					<button type="button" className="hm-more-t" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
						<span className="ping" aria-hidden="true" />
						{waiting.length} more waiting on you
						<Icon name="chevron-down" size="sm" className="hm-chev" />
					</button>
					{moreOpen && (
						<div className="hm-more-rows settle">
							{waiting.map((c) => (
								<Link key={c.id} className="hm-wrow" href={`/chat/${c.id}`}>
									<Icon name={isPractice(c) ? "practice" : "lesson"} size="sm" />
									<span className="hm-wrow-t trunc">{displayTitle(c.title)}</span>
									<span className="hm-wrow-m">{sessionLine(c)}</span>
									<Icon name="chevron-right" size="sm" className="hm-wrow-go" />
								</Link>
							))}
						</div>
					)}
				</div>
			)}
		</section>
	);
}

// ─── This week ────────────────────────────────────────────────────────────

function fmtMin(m: number): string {
	return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
}

/** The week at a glance: minutes against the weekly goal with the seven
 *  days drawn, then lessons, ideas and practice. Zeros read as a next step,
 *  never as "+0". Every number is the server's (useStats / useDaily). */
function WeekStrip({ ideaCount }: { ideaCount: number | null }) {
	const stats = useStats("week");
	const daily = useDaily();
	if (!stats || !daily) {
		return (
			<section className="hm-week glass" aria-hidden="true">
				{[0, 1, 2, 3].map((i) => (
					<div key={i} className="hm-cell">
						<i className="skel hm-sk-l" />
						<i className="skel hm-sk-v" />
						<i className="skel hm-sk-s" />
					</div>
				))}
			</section>
		);
	}
	const minutes = Math.round(stats.time.seconds / 60);
	const goalWeek = daily.goalMinutes * daily.days.length;
	const heights = barHeights(daily);
	const top = Math.max(...daily.days.map((d) => d.minutes), daily.goalMinutes * 1.5, 1);
	const goalPct = Math.round((daily.goalMinutes / top) * 100);
	const todayIdx = daily.days.findIndex((d) => d.today);
	const ideasAdded = stats.ideas.added;
	const graph = ideaCount ?? stats.ideas.total;
	return (
		<section className="hm-week glass rise" aria-labelledby="week">
			<div className="hm-cell hm-cell-week">
				<span className="hm-cell-l" id="week">
					This week
				</span>
				<span className="hm-cell-v num">
					{fmtMin(minutes)}
					<small>of {fmtMin(goalWeek)}</small>
				</span>
				<div
					className="hm-bars"
					role="img"
					aria-label={`Minutes per day: ${daily.days.map((d) => `${d.label} ${d.minutes}`).join(", ")}. Goal ${daily.goalMinutes} a day.`}
				>
					<span className="hm-goal" style={{ bottom: `${goalPct}%` }} aria-hidden="true" />
					{daily.days.map((d, i) => {
						const future = todayIdx !== -1 && i > todayIdx;
						return (
							<i
								key={d.date}
								className={d.today ? "today" : future ? "future" : d.minutes >= daily.goalMinutes ? "met" : ""}
								style={future ? undefined : { height: `${Math.max(heights[i] ?? 0, d.minutes > 0 ? 8 : 4)}%` }}
								title={`${d.label}: ${d.minutes} min`}
							/>
						);
					})}
				</div>
				<div className="hm-days" aria-hidden="true">
					{daily.days.map((d) => (
						<span key={d.date} className={d.today ? "today" : ""} title={d.today ? "Today" : d.label}>
							{d.label.slice(0, 1)}
						</span>
					))}
				</div>
			</div>
			<div className="hm-cell">
				<span className="hm-cell-l">Lessons</span>
				<span className="hm-cell-v num">{stats.lessons.active}</span>
				<span className="hm-cell-s">
					{stats.lessons.waiting > 0 ? `${stats.lessons.waiting} waiting on you` : stats.lessons.active > 0 ? "In progress" : "Start one above"}
				</span>
			</div>
			<Link href="/knowledge" className="hm-cell hm-cell-link">
				<span className="hm-cell-l">Ideas</span>
				<span className="hm-cell-v num">{ideasAdded > 0 ? `+${ideasAdded}` : graph}</span>
				<span className="hm-cell-s">{ideasAdded > 0 ? `${graph} in your graph` : graph > 0 ? "in your graph" : "Grows as you learn"}</span>
			</Link>
			<div className="hm-cell">
				<span className="hm-cell-l">Practice</span>
				<span className="hm-cell-v num">{stats.practice.problems}</span>
				<span className="hm-cell-s">
					{stats.practice.problems > 0 ? `${stats.practice.solid} solid` : "Switch to Practice above"}
				</span>
			</div>
		</section>
	);
}
