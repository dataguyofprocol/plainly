/**
 * Activity contracts — the v4 redesign's progress surfaces (owner-approved
 * UI redesign, 2026-10-26): the active-learning time ledger, the home's
 * period stats + daily goal strip, the session list's progress fields,
 * the "next from your graph" suggestions, and the knowledge topics.
 *
 * Part of the domain-split contracts (src/core/contracts/): pure types +
 * protocol docs only. The folds live in core/activity.ts (pure, tested);
 * the routes compose them server-side (src/server/activity.ts).
 */

// ─── the time ledger (POST /api/activity/time) ──────────────────────────────

/** One heartbeat line of the active-learning ledger:
 *  <data>/time/YYYY-MM.jsonl (local month of `at`). APPEND-ONLY — the
 *  client beats every 30s while a lesson/practice page is visible and the
 *  learner interacted within the last 2 minutes; the server clamps
 *  `seconds` to 0..60 and drops beats for unknown chats. Aggregates are
 *  folds over these lines (core/activity.ts) — nothing else is stored. */
export interface TimeBeat {
	chatId: string;
	/** ISO wall-clock of the beat (server time at receipt). */
	at: string;
	/** Active seconds this beat credits (0..60, already clamped). */
	seconds: number;
}

/** The POST body (the client's beat). */
export interface TimeBeatRequest {
	chatId: string;
	seconds: number;
}

// ─── session list enrichment (GET /api/chats items) ─────────────────────────

/** The session row's one-word state, precedence top-down:
 *   working  — a turn is in flight (the `busy` liveness bit);
 *   waiting  — something waits on the learner: a pending quiz/ask/
 *              explain/probe/recall call, or a practice problem posed and
 *              not concluded;
 *   finished — teach: a plan exists, and the derived current node is the
 *              LAST node in plan order or every node has been visited
 *              (visited ∪ current covers the plan) — with nothing pending;
 *              practice: a whole set of PRACTICE_SET_SIZE problems has
 *              concluded (concluded > 0 and a multiple of the set size)
 *              and nothing is active;
 *   paused   — everything else. */
export type ChatState = "working" | "waiting" | "finished" | "paused";

/** Plan position of a teach session — POSITION, never mastery (the
 *  derived statuses of contracts/plan.ts: quiz CALLS tag position).
 *  `visited` counts nodes left in an earlier stay, EXCLUDING the current
 *  node (a revisit counts once, as current); `current` is the 1-based
 *  index of the current node in plan node order, null before the first
 *  tagged check. */
export interface ChatPlanProgress {
	total: number;
	visited: number;
	current: number | null;
}

/** Graded quiz answers of a teach session. Definition (what the record
 *  supports): every non-dismissed quiz-kind answer (tool quiz or probe —
 *  the graded multiple-choice tools) counts once in `total`; "I don't
 *  know" counts as a graded, incorrect answer. A question call takes
 *  exactly ONE answer in this app (no in-call retries), so `firstTry`
 *  is the number of those answers graded correct. */
export interface ChatAnswerStats {
	total: number;
	firstTry: number;
}

/** A practice session's current set (sets of PRACTICE_SET_SIZE problems,
 *  the practice doctrine). `done` = problems concluded in the CURRENT set
 *  (0..size): a completed set reads `done === size` until the next
 *  problem of the following set is posed, which reads 0 again. */
export interface PracticeSetProgress {
	size: number;
	done: number;
}

/** The practice set size (owner redesign, 2026-10-26). */
export const PRACTICE_SET_SIZE = 5;

/** The record-derived progress fold (core/activity.ts chatProgressOf) —
 *  computed in the store's listChats where the record is already parsed;
 *  `restingState` is the state WITHOUT liveness (the route folds `busy`
 *  in: chatStateOf). */
export interface ChatProgress {
	restingState: Exclude<ChatState, "working">;
	pendingQuestionText: string | null;
	plan: ChatPlanProgress | null;
	answers: ChatAnswerStats | null;
	practiceSet: PracticeSetProgress | null;
}

// ─── GET /api/stats?period=week|month ───────────────────────────────────────

/** "week" = Monday 00:00 local → now; "month" = the 1st 00:00 local → now. */
export type StatsPeriod = "week" | "month";

export interface StatsResponse {
	period: StatsPeriod;
	/** Active learning seconds this period vs the previous EQUAL period:
	 *  the previous period's start plus the same elapsed span (last week
	 *  Monday 00:00 → the same weekday/time-of-day; last month's 1st →
	 *  the same elapsed duration, capped at this period's start). */
	time: { seconds: number; prevSeconds: number };
	/** Teach sessions. active = updated in the period and not finished;
	 *  waiting = state "waiting" now (any age — a snapshot); finished =
	 *  state "finished" and updated in the period; allTime = every teach
	 *  session. */
	lessons: { active: number; waiting: number; finished: number; allTime: number };
	/** added = distinct propositions whose createdAt falls in the period;
	 *  total = distinct propositions. */
	ideas: { added: number; total: number };
	/** Practice problems concluded in the period (clean conclude results,
	 *  dismissals included); solid = outcome "solved". */
	practice: { problems: number; solid: number };
	/** Every usage channel in the period — teach/practice turns (incl.
	 *  compaction), sub-agent jobs (by createdAt), chat + notes extraction
	 *  runs, suggestion runs. total = input + output + cacheRead +
	 *  cacheWrite (reasoning is inside output). dollars: the sum of the
	 *  PRICED parts; null only when parts exist and none is priced (a
	 *  period with no usage at all is 0). Subscription usage is unpriced
	 *  API spend. */
	tokens: { total: number; dollars: number | null };
}

// ─── GET /api/stats/daily ───────────────────────────────────────────────────

export type WeekdayLabel = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export interface DailyStatsDay {
	/** Local calendar date, "YYYY-MM-DD". */
	date: string;
	label: WeekdayLabel;
	/** Active minutes that local day, rounded (future days 0). */
	minutes: number;
	today: boolean;
}

export interface DailyStatsResponse {
	/** settings general.dailyGoalMinutes (resolved; factory 30). */
	goalMinutes: number;
	/** The current week, Monday → Sunday. */
	days: DailyStatsDay[];
	/** Days up to and including today with minutes >= goalMinutes. */
	metDays: number;
}

// ─── GET /api/suggestions ───────────────────────────────────────────────────

export interface Suggestion {
	title: string;
	reason: string;
}

export interface SuggestionsResponse {
	suggestions: Suggestion[];
	/** ISO of the cached generation; null when nothing is cached yet. */
	generatedAt: string | null;
}

// ─── GET /api/topics ────────────────────────────────────────────────────────

export interface Topic {
	/** The snapshot cluster id (the birth session's chat/source id). */
	id: string;
	name: string;
	/** The cluster's PROPOSITION ids (derived implication nodes excluded). */
	ideaIds: string[];
	/** Newest createdAt among the cluster's propositions. */
	lastLearnedAt: string | null;
	/** Latest updatedAt of a practice session whose graph-context picks
	 *  include any of ideaIds; null if never practiced. */
	lastPracticedAt: string | null;
}

export interface TopicsResponse {
	topics: Topic[];
}
