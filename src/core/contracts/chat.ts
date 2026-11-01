import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../native-messages.ts";
import type { Phase3 } from "../phases.ts";
import type { PlanNodeStatus, PlanTree } from "./plan.ts";
import type { EmissionStats } from "./graph.ts";
import type { ChatAnswerStats, ChatPlanProgress, ChatProgress, ChatState, PracticeSetProgress } from "./activity.ts";

/** Absent on a record reads as "teach". */
export type ChatKind = "teach" | "practice";

/** One persisted session: data/chats/<id>.json. `messages` is pi-native history;
 *  replay is `state.messages = record.messages` + continue(). */
export interface ChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: LhMessage[];
	/** Absent = teach. */
	kind?: ChatKind;
	tree?: PlanTree;
	/** Append-only, one entry per model turn, keyed by messageId. Kept outside
	 * message objects because client re-POSTs drop server-stamped fields. */
	turns?: TurnUsage[];
	/** Append-only, one entry per finished pipeline run, idempotent per startedAt. */
	extractions?: ExtractionRunUsage[];
	settings?: ChatSettings;
	/** Absent = not archived; only true is ever written. */
	archived?: boolean;
	/** Absent reads as v1; every write stamps the current version. A record
	 *  stamped newer than CURRENT_CHAT_VERSION is refused on read. */
	version?: number;
}

export const CURRENT_CHAT_VERSION = 1;

/** Per-chat override for the conversation agents; absent fields fall back to
 *  config. Background sub-agents are never overridden. */
export interface ChatSettings {
	model?: { provider: string; id: string };
	/** Must be in the chosen model's supported levels. */
	thinkingLevel?: ThinkingLevel;
}

/** Per-step usage, not a sum. */
export interface ExtractionStageUsage {
	/** Provider-qualified: "provider:id". */
	model: string;
	steps: CallUsage[];
}

/** Appended on success or failure; `stats` present only when the merger ran. */
export interface ExtractionRunUsage {
	/** Registry startedAt (ms); the idempotency key. */
	startedAt: number;
	at: string;
	durationMs: number;
	stats?: EmissionStats;
	/** In pipeline order; the deterministic merger has no entry. */
	stages: {
		extractor: ExtractionStageUsage;
		auditor: ExtractionStageUsage;
	};
}

/** undefined = provider didn't report; render as absent, never zero. */
export interface CallUsage {
	/** Fresh input only; cache buckets are disjoint. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	cacheReadTokens: number | undefined;
	cacheWriteTokens: number | undefined;
	/** Subset of cacheWriteTokens with one-hour retention. Missing on older logs. */
	cacheWrite1hTokens?: number;
	reasoningTokens: number | undefined;
}

/** One full teacher invocation; spans one or more billed agent steps. */
export interface TurnUsage {
	/** Unique per turn; the idempotency key. Continuation turns can share a messageId. */
	id: string;
	messageId: string;
	at: string;
	/** Provider-qualified: "provider:id". */
	model: string;
	/** One entry per agent step. */
	steps: CallUsage[];
}

/** Model-facing text of the probe→teach handoff wake. */
export const HANDOFF_TEXT =
	"Next: plan the full teaching arc from my current understanding to the goal understanding. " +
	"Apply the teaching methodology in your system prompt, and find the optimal way to teach me this. " +
	"Find the unconditional truths, plan the motivated derivations/discoveries, so every reasoning step has to land as obviously true. " +
	"Take your time here and really think this through. " +
	"When it's genuinely reasoned out, call plan_init and present the plan; I'll accept it or ask for changes.";

export const THINKING_LABEL = "Your thinking";

/** 1 = Nudge, 2 = Bigger hint, 3 = First step. Bounds what the learner asks for;
 *  the practice doctrine still picks the actual rung. */
export type HintRung = 1 | 2 | 3;

export const HINT_RUNGS: ReadonlyArray<{ rung: HintRung; label: string }> = [
	{ rung: 1, label: "Nudge" },
	{ rung: 2, label: "Bigger hint" },
	{ rung: 3, label: "First step" },
];

const HINT_REQUEST_ASK: Record<HintRung, string> = {
	1: "a nudge",
	2: "a bigger hint",
	3: "the first step",
};

/** e.g. "[Hint request — rung 2 of 3: a bigger hint]". */
export function hintRequestText(rung: HintRung): string {
	return `[Hint request — rung ${rung} of 3: ${HINT_REQUEST_ASK[rung]}]`;
}

/** e.g. "with a bigger hint". */
export function hintTag(rung: HintRung): string {
	return `with ${HINT_REQUEST_ASK[rung]}`;
}

export function isHintRung(value: unknown): value is HintRung {
	return value === 1 || value === 2 || value === 3;
}

/** Shared by the executed conclude call and the dismissal-synthesized pair so
 *  both read identically to the model. */
export const CONCLUDE_ACK_TEXT =
	"Problem concluded. Say your closing words about the learner's work if useful, then END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, answer their questions about the concluded one.";

export const NEXT_PROBLEM_TEXT =
	"[NEXT PROBLEM] — the learner's explicit go-ahead: pose the next problem now per the selection rules, or wrap the session in text if the arc is complete.";

export const COMPACTED_HISTORY_HEADER =
	"[SESSION HISTORY COMPACTED] The transcript before this point was summarized to fit the context window; the summary below replaces it. Everything after this message is the verbatim recent transcript.";

export interface PlanBlockData {
	kind: "full";
	at: string;
	/** null = none. */
	current: string | null;
	/** Statuses as of emission; never re-derived at render. */
	nodes: Array<{ id: string; title: string; status: PlanNodeStatus }>;
	edges: Array<{ from: string; to: string }>;
}

/** `phase` and `pendingQuestion` derive from the stored record; `busy` is not
 *  record-derived (see ChatListItem). */
export interface ChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** Absent record field normalized to teach. */
	kind: ChatKind;
	messageCount: number;
	phase: Phase3;
	pendingQuestion: boolean;
	/** A posed problem with no conclude. Absent on teaching sessions. */
	pendingProblem: boolean;
	settings?: ChatSettings;
	archived?: boolean;
	/** Unpacked onto ChatListItem fields by the chats route; never shipped nested. */
	progress?: ChatProgress;
}

/** `busy` is true only while a teach turn is in flight. */
export interface ChatListItem extends ChatSummary {
	busy: boolean;
	/** True while a background compaction holds the chat's model gate. */
	compacting: boolean;
	/** Always populated by GET /api/chats; absent reads as unknown. */
	state?: ChatState;
	/** Plain text, ≤ ~140 chars. */
	pendingQuestionText?: string | null;
	/** null on practice / no plan. */
	plan?: ChatPlanProgress | null;
	/** Active minutes, rounded. */
	minutes?: number;
	/** null on practice. */
	answers?: ChatAnswerStats | null;
	/** null on teach. */
	practiceSet?: PracticeSetProgress | null;
}

export interface ArtifactPartProps {
	part: {
		type: string;
		state: string;
		toolCallId: string;
		input?: unknown;
		output?: unknown;
		/** The pose-side problem-call arguments, joined by projectView. */
		problemInput?: unknown;
		/** The modelSolution committed at pose time, joined by projectView. */
		reveal?: unknown;
		/** Hint rungs requested on this problem, in order. */
		hints?: HintRung[];
	};
}
