/** One line of the append-only ledger <data>/time/YYYY-MM.jsonl (local
 *  month of `at`). The server clamps `seconds` to 0..60 and drops beats for
 *  unknown chats. */
export interface TimeBeat {
	chatId: string;
	/** ISO, server time at receipt. */
	at: string;
	/** 0..60, already clamped. */
	seconds: number;
}

export interface TimeBeatRequest {
	chatId: string;
	seconds: number;
}

/** Precedence top-down:
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

/** Plan POSITION, never mastery. `visited` counts nodes left in an earlier
 *  stay, EXCLUDING the current node; `current` is the 1-based index of the
 *  current node in plan node order, null before the first tagged check. */
export interface ChatPlanProgress {
	total: number;
	visited: number;
	current: number | null;
}

/** `total` counts every non-dismissed quiz or probe answer once ("I don't
 *  know" is graded incorrect); `firstTry` counts those graded correct. */
export interface ChatAnswerStats {
	total: number;
	firstTry: number;
}

/** `done` = problems concluded in the CURRENT set (0..size); a completed
 *  set reads `done === size` until the next set's first problem is posed. */
export interface PracticeSetProgress {
	size: number;
	done: number;
}

export const PRACTICE_SET_SIZE = 5;

/** `restingState` is the state WITHOUT liveness (chatStateOf folds `busy`
 *  in). */
export interface ChatProgress {
	restingState: Exclude<ChatState, "working">;
	pendingQuestionText: string | null;
	plan: ChatPlanProgress | null;
	answers: ChatAnswerStats | null;
	practiceSet: PracticeSetProgress | null;
}

/** "week" = Monday 00:00 local → now; "month" = the 1st 00:00 local → now. */
export type StatsPeriod = "week" | "month";

export interface StatsResponse {
	period: StatsPeriod;
	/** `prevSeconds` covers the previous period's start plus the same
	 *  elapsed span, capped at this period's start. */
	time: { seconds: number; prevSeconds: number };
	/** Teach sessions. active = updated in the period and not finished;
	 *  waiting = state "waiting" now, any age; finished = "finished" and
	 *  updated in the period. */
	lessons: { active: number; waiting: number; finished: number; allTime: number };
	/** added = distinct propositions whose createdAt falls in the period. */
	ideas: { added: number; total: number };
	/** Problems concluded in the period, dismissals included; solid =
	 *  outcome "solved". */
	practice: { problems: number; solid: number };
	/** total = input + output + cacheRead + cacheWrite (reasoning is inside
	 *  output). dollars = sum of the PRICED parts; null only when parts exist
	 *  and none is priced (no usage at all is 0). */
	tokens: { total: number; dollars: number | null };
}

export type WeekdayLabel = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export interface DailyStatsDay {
	/** Local date, "YYYY-MM-DD". */
	date: string;
	label: WeekdayLabel;
	/** Rounded; future days 0. */
	minutes: number;
	today: boolean;
}

export interface DailyStatsResponse {
	goalMinutes: number;
	/** The current week, Monday → Sunday. */
	days: DailyStatsDay[];
	/** Days up to and including today with minutes >= goalMinutes. */
	metDays: number;
}

export interface Suggestion {
	title: string;
	reason: string;
}

export interface SuggestionsResponse {
	suggestions: Suggestion[];
	/** Null when nothing is cached yet. */
	generatedAt: string | null;
}

export interface Topic {
	/** The birth session's chat/source id. */
	id: string;
	name: string;
	/** Derived implication nodes excluded. */
	ideaIds: string[];
	lastLearnedAt: string | null;
	/** Latest updatedAt of a practice session whose picks include any of
	 *  ideaIds. */
	lastPracticedAt: string | null;
}

export interface TopicsResponse {
	topics: Topic[];
}
