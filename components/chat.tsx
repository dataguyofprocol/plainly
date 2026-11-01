"use client";

import { createContext, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatSession } from "@/components/session";
import { visibleQueuedSteers } from "@/components/session-core";
import { SetupDialog } from "@/components/setup-dialog";
import { Hint } from "@/components/ui/hint";
import { useZeroKeys, ZeroKeysPill } from "@/components/setup-cta";
import type { StickToBottomContext } from "use-stick-to-bottom";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { LiveToolCard } from "@/components/artifacts/live-tool-card";
import { AnsweredCard } from "@/components/answered-card";
import { artifactRenderers } from "@/components/artifacts";
import { SubagentSteerCard } from "@/components/artifacts/steer-card";
import { Composer } from "@/components/composer";
import { AttachmentChips, AttachmentErrors, useAttachments, useCanAttach, useFilePicker } from "@/components/attachments";
import { useEnterSubmits } from "@/components/enter-submits";
import { QueuedSteersBody } from "@/components/queued-steers";
import { DictationErrorLine, DictationWave, joinDictation, useDictation, useDictationState } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { JobsContext } from "@/components/jobs-context";
import { useServerEvent, useServerResync } from "@/components/server-events";
import {
	isProviderKeyRefusal,
	firstSourceTextParts,
	messageAnchorId,
	textPartMessageId,
	kbdEventForAction as kbdEventForChat,
	needsContinuation,
	splitAttachments,
	withAttachments,
	type ChatInput,
	type ChatSettings,
	type LhMessage,
	type ModelSlotName,
} from "@/src/core";
import { PlanBlock, PlanPopup, latestTree } from "@/components/plan-block";
import { MermaidOverlay, SessionMermaidContext } from "@/components/session-overlay";
import { AbortTurnDialog, type AbortMode } from "@/components/abort-turn-dialog";
import type { PlanBlockData } from "@/src/core";
import { SessionFind } from "@/components/session-find";
import { SessionMessageNavigation } from "@/components/session-navigation";
import { ThinkingCard, type PracticeThinkingData } from "@/components/practice-cards";
import { GraphContextCard, type GraphContextData } from "@/components/graph-context-card";
import type { ArtifactPartProps, JobRecord, QuestionAnswerData, TurnUsage, SessionPricing } from "@/src/core";
import type { LhViewMessage } from "@/src/core";
import { PhaseDivider } from "@/components/phase-divider";
import {
	CompactionCutDivider,
	CompactionMomentDivider,
	type CompactionDividerData,
} from "@/components/compaction-divider";
import {
	activeProblemOf,
	dismissedAnswer,
	findPendingToolCall,
	phaseAt3,
	phaseTimeline,
	teachStepIndex,
	toolQuestionKind,
	questionNeedsReveal,
} from "@/src/core";
import { LessonPanel, PracticePanel, hintReplyIndices, planProgress, practiceSet, stepFold } from "@/components/lesson-panel";
import { ModelControl } from "@/components/model-picker";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/ui/empty-state";
import { displayTitle } from "@/components/ui/format";
import { Field, Rail } from "@/components/v4/shell";
import { currentUserThinkingOpen, setAllUserThinkingOpen } from "@/components/thinking-block";
import { PRACTICE_SET_SIZE, isHintRung, practiceHintsUsed, slotsConfigured, type HintRung, type ModelsSettings } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";

export const ChatActionsContext = createContext<{
	chatId: string;
	syncFromServer: () => Promise<void>;
	sendText: (text: string) => void;
	openSetup: () => void;
} | null>(null);

export function parseModelsRefusal(message: string | undefined): ModelSlotName[] | null {
	if (!message) return null;
	try {
		const body = JSON.parse(message) as { code?: unknown; missing?: unknown };
		if (body.code === "models_not_configured" && Array.isArray(body.missing)
			&& body.missing.every((s) => typeof s === "string")) {
			return body.missing as ModelSlotName[];
		}
		return null;
	} catch {
		return null;
	}
}

export function parseProviderKeyRefusal(message: string | undefined): boolean {
	if (!message) return false;
	try {
		const body = JSON.parse(message) as { code?: unknown; error?: unknown };
		return body.code === "provider_key_missing" && typeof body.error === "string" && isProviderKeyRefusal(body.error);
	} catch {
		return false;
	}
}

function SystemLine({ children, testId }: { children: React.ReactNode; testId?: string }) {
	return (
		<div data-testid={testId} className="ls-sys">
			{children}
		</div>
	);
}

function isSubagentSteer(m: LhViewMessage): boolean {
	return (m.metadata as { subagentResult?: unknown } | undefined)?.subagentResult != null;
}

export function Chat({
	chatId,
	title,
	initialMessages,
	initialPrompt,
	initiallyInFlight,
	initiallyCompacting = false,
	initialConfigured = false,
	kind = "teach",
}: {
	chatId: string;
	title: string;
	initialMessages: LhMessage[];
	kind?: "teach" | "practice";
	initialPrompt?: string;
	initiallyInFlight?: boolean;
	initiallyCompacting?: boolean;
	initialConfigured?: boolean;
}) {
	const reattachSettledRef = useRef<() => void>(() => {});

	const { messages, nativeMessages, contextTokens, send, steer, steerQueue, submitAnswer, dismissQuestion, dismissProblem, setMessages, adoptRecord, status, error, stop, clearError, resumeStream, setReattachSettled } =
		useChatSession({ chatId, initialMessages, initiallyInFlight });

	const sessionFindScopeRef = useRef<HTMLDivElement | null>(null);
	const scrollContextRef = useRef<StickToBottomContext | null>(null);
	const sourceTextParts = useMemo(() => firstSourceTextParts(messages), [messages]);

	setReattachSettled(() => reattachSettledRef.current());

	const sentInitial = useRef(false);
	useEffect(() => {
		if (!sentInitial.current && initialPromptOwed(initialMessages, initialPrompt)) {
			sentInitial.current = true;
			void send({ type: "text", text: initialPrompt! });
		}
	}, [initialPrompt, initialMessages, send]);

	const [turnInFlight, setTurnInFlight] = useState(initiallyInFlight ?? false);

	const [titleText, setTitleText] = useState(title);
	const [renaming, setRenaming] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const titleInputRef = useRef<HTMLInputElement | null>(null);

	const commitRename = useCallback(
		async (next: string) => {
			setRenaming(false);
			const t = next.trim();
			if (t === "" || t === titleText) return;
			try {
				const res = await fetch(`/api/chats/${chatId}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: t }),
				});
				if (!res.ok) throw new Error(`rename failed: ${res.status}`);
				setTitleText(t);
				window.dispatchEvent(
					new CustomEvent("lh:chat-renamed", { detail: { id: chatId, title: t } }),
				);
			} catch (err) {
				console.error("rename failed:", err);
			}
		},
		[chatId, titleText],
	);

	useEffect(() => {
		if (renaming) {
			const el = titleInputRef.current;
			if (el) {
					el.focus();
					el.select();
			}
		}
	}, [renaming]);

	useEffect(() => {
		const onRename = () => {
			setTitleDraft(titleText);
			setRenaming(true);
		};
		window.addEventListener("lh:kbd-rename-session", onRename);
		return () => window.removeEventListener("lh:kbd-rename-session", onRename);
	}, [titleText]);

	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			if (id === chatId) setTitleText((prev) => (title !== prev ? title : prev));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, [chatId]);

	const abortInFlightTurn = useCallback(() => {
		if (localStreamRef.current) stop();
		void fetch("/api/activity/abort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "turn", id: chatId }),
		}).catch(() => {
			/* transient — the turn settles on its own; the record poll adopts */
		});
		// 409 not_running is the benign raced-settle: the stream's finish
			// already settled the view (or the poll fallback adopts) — nothing owed.
	}, [chatId, stop]);
	const [abortAsk, setAbortAsk] = useState<AbortMode | null>(null);
	const abortAskRef = useRef<AbortMode | null>(null);
	abortAskRef.current = abortAsk;
	useEffect(() => {
		const onAbort = () => {
			const target = escAbortTarget({
				abortAsk: abortAskRef.current !== null,
				mermaidFocus: mermaidFocusRef.current !== null || figureFocusRef.current !== null,
				planOpen: planOpenRef.current,
				setupOpen: setupOpenRef.current,
				pending: pendingRef.current !== null,
				problem: activeProblemRef.current !== null,
				busy: busyRef.current,
			});
			if (target === "question") setAbortAsk("question");
			else if (target === "problem") setAbortAsk("problem");
			else if (target === "turn") setAbortAsk("turn");
			else if (target === "mermaid") setMermaidFocus(null);
			else if (target === "plan") setPlanOpen(false);
			// setup closes itself; null = nothing to do — both claimed.
		};
		window.addEventListener("lh:kbd-abort-turn", onAbort);
		return () => window.removeEventListener("lh:kbd-abort-turn", onAbort);
	}, []);
	const confirmAbort = useCallback(
		(mode: AbortMode) => {
			setAbortAsk(null);
			if (mode === "turn") {
				abortInFlightTurn();
				return;
			}
			const p = pendingRef.current;
			if (p) {
				const question = (p.input as { question?: string } | null)?.question ?? "";
				const reading = readingThinkingRef.current.trim() || undefined;
				clearReadingThinking();
				const answer = dismissedAnswer(toolQuestionKind(p.tool), question);
				void dismissQuestion(
					p.toolCallId,
					reading ? { ...answer, readingThinking: reading } : answer,
				);
				if (busyRef.current) abortInFlightTurn();
				return;
			}
			const problem = activeProblemRef.current;
			if (problem) {
				void dismissProblem(problem.toolCallId);
				if (busyRef.current) abortInFlightTurn();
			}
		},
		[abortInFlightTurn, dismissQuestion, dismissProblem],
	);
	const mountContinuation = useRef(false);
	useEffect(() => {
		if (mountContinuation.current) return;
		mountContinuation.current = true;
		if (!turnInFlight && status === "ready" && needsContinuation(initialMessages)) {
			void send({ type: "continue" });
		}
		// mount-only by design (turnInFlight read at initial value)
	}, []);

	const pending = findPendingToolCall(messages);
	const pendingRef = useRef(pending);
	pendingRef.current = pending;

	const activeProblem = activeProblemOf(nativeMessages);
	const activeProblemRef = useRef(activeProblem);
	activeProblemRef.current = activeProblem;

	const localStream = status === "submitted" || status === "streaming";
	const busy = localStream || turnInFlight;
	const busyRef = useRef(busy);
	busyRef.current = busy;

	useEffect(() => {
		if (turnInFlight && (status === "submitted" || status === "streaming")) setTurnInFlight(false);
	}, [status, turnInFlight]);

	const turnInFlightRef = useRef(turnInFlight);
	turnInFlightRef.current = turnInFlight;
	const attachToRunningTurn = useCallback(() => {
		setTurnInFlight(true);
		void resumeStream();
	}, [resumeStream]);

	const submitThinking = useCallback(
		(text: string, hint?: HintRung) => {
			const problem = activeProblemRef.current;
			if (!problem) return;
			void send(hint ? { type: "thinking", problemCallId: problem.toolCallId, text, hint } : { type: "thinking", problemCallId: problem.toolCallId, text });
		},
		[send],
	);

	const requiresReveal = pending !== null && questionNeedsReveal(pending.tool, pending.input, phaseAt3(messages));

	const lessonProgress = useMemo(() => (kind === "practice" ? null : planProgress(latestTree(messages), messages)), [kind, messages]);
	const setProgress = useMemo(() => (kind === "practice" ? practiceSet(messages) : null), [kind, messages]);
	const fold = useMemo(() => (kind === "practice" ? null : stepFold(messages, lessonProgress)), [kind, messages, lessonProgress]);
	const [reviewOpen, setReviewOpen] = useState(false);
	const hintsUsed = activeProblem ? practiceHintsUsed(nativeMessages, activeProblem.toolCallId).length : 0;
	const hintReplies = useMemo(() => (kind === "practice" ? hintReplyIndices(messages) : new Set<number>()), [kind, messages]);

	const [readingThinking, setReadingThinking] = useState("");
	const readingThinkingRef = useRef("");

	useEffect(() => {
		const onToggle = () => setAllUserThinkingOpen(!currentUserThinkingOpen());
		window.addEventListener(kbdEventForChat("toggle-user-thinking"), onToggle);
		return () => window.removeEventListener(kbdEventForChat("toggle-user-thinking"), onToggle);
	}, []);
	const applyReadingThinking = useCallback((v: string) => {
		readingThinkingRef.current = v;
		setReadingThinking(v);
	}, []);
	const clearReadingThinking = useCallback(() => {
		readingThinkingRef.current = "";
		setReadingThinking("");
	}, []);
	const pendingQuestionId = pending?.toolCallId ?? null;
	useEffect(() => {
		readingThinkingRef.current = "";
		setReadingThinking("");
	}, [pendingQuestionId]);

	const phases = useMemo(() => phaseTimeline(messages), [messages]);

	const [text, setText] = useState("");
	const textRef = useRef("");
	const applyText = useCallback((v: string) => {
		textRef.current = v;
		setText(v);
	}, []);
	const [configured, setConfigured] = useState(initialConfigured);
	const zeroKeys = useZeroKeys();
	useSettingsSaved((section) => {
		if (section !== "models") return;
		fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings?: { models?: ModelsSettings } | null } | null>)
			.then((body) => setConfigured(slotsConfigured(body?.settings?.models)))
			.catch(() => {});
	});
	const [setupOpen, setSetupOpen] = useState(false);
	const draftRef = useRef<string | null>(null);
	const canAttach = useCanAttach();
	const attachments = useAttachments();
	const picker = useFilePicker(attachments.add);

	useEffect(() => {
		if (!error) return;
		const missing = parseModelsRefusal(error.message);
		const keyRefused = parseProviderKeyRefusal(error.message);
		if (!missing && !keyRefused) return;
		let cancelled = false;
		void (async () => {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
			if (!cancelled && res.ok) {
				const record = (await res.json().catch(() => null)) as { messages?: LhMessage[] } | null;
				if (Array.isArray(record?.messages)) setMessages(record.messages);
			}
			if (cancelled) return;
			if (draftRef.current !== null) {
				const draft = splitAttachments(draftRef.current);
				applyText(draft.text);
				attachments.restore(draft.paths);
				draftRef.current = null;
			}
			clearError();
			setSetupOpen(true);
		})();
		return () => {
			cancelled = true;
		};
		// (setMessages/clearError are stable per useChat instance — the
		//  dep pair [error, chatId] is what the flow actually keys on.)
	}, [error, chatId]);
	const cycleChatFields = useCallback((): readonly HTMLElement[] => {
		const pick = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
		return [
			...pick('[data-testid="reading-thinking-field"] textarea'),
			...pick('[data-testid="question-dock"] textarea'),
			...pick('[data-testid="practice-dock"] textarea'),
			...pick('[data-testid="composer"] textarea'),
		];
	}, []);
	useFieldCycle(cycleChatFields);
	const dictation = useDictation({
		append: (t) => applyText(joinDictation(textRef.current, t)),
	});
	const composerIsTarget = useDictationState().claimant === null;
	const dictationWasActiveRef = useRef(false);
	const composerInputRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			composerInputRef.current?.focus();
		}
	}, [dictation.active]);

	const [compacting, setCompacting] = useState(initiallyCompacting);
	const canSend =
		(text.trim().length > 0 || attachments.paths.length > 0 || dictation.active) && !pending && !activeProblem && !compacting;

	const nextReady =
		kind === "practice" &&
		!pending &&
		!activeProblem &&
		!compacting &&
		!busy &&
		nativeMessages.some(
			(m) => (m as { role?: string }).role === "assistant" &&
				Array.isArray((m as { content?: unknown[] }).content) &&
				(m as { content: Array<{ type?: string; name?: string }> }).content.some(
					(b) => b.type === "toolCall" && b.name === "problem",
				),
		);
	const sendNext = useCallback(() => {
		if (!nextReady) return;
		void send({ type: "next" });
	}, [nextReady, send]);

	useEnterSubmits(sendNext);

	const syncFromServer = useCallback(async () => {
		const res = await fetch(`/api/chats/${chatId}`);
		if (!res.ok) return;
		const record = (await res.json()) as { messages?: LhMessage[]; turns?: TurnUsage[]; pricing?: SessionPricing };
		if (Array.isArray(record.turns)) setTurns(record.turns);
		setPricing(record.pricing);
		if (!Array.isArray(record.messages)) return;
		setMessages(record.messages);
		if (status === "ready" && needsContinuation(record.messages)) {
			void send({ type: "continue" });
		}
	}, [chatId, setMessages, send, status]);

	reattachSettledRef.current = () => {
		setTurnInFlight(false);
		void syncFromServer();
	};

	const adoptAppendOnly = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}`);
			if (!res.ok) return;
			const record = (await res.json()) as { messages?: LhMessage[] };
			if (!Array.isArray(record.messages)) return;
			adoptRecord(record.messages);
		} catch {
			/* transient — the idle full sync is the net */
		}
	}, [chatId, adoptRecord]);

	const turnStartStatusRef = useRef(status);
	const adoptionWindowOpenRef = useRef(false);
	const turnStartTimerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);
	useEffect(() => {
		const was = turnStartStatusRef.current;
		turnStartStatusRef.current = status;
		if (was === "submitted" || status !== "submitted") return;
		adoptionWindowOpenRef.current = true;
		const timers = [400, 1000, 2000].map((ms) =>
			setTimeout(() => {
				if (adoptionWindowOpenRef.current) {
					void adoptAppendOnly();
				}
			}, ms),
		);
		timers.forEach((t) => {
			turnStartTimerRefs.current.push(t);
		});
	}, [status, adoptAppendOnly]);
	useEffect(() => {
		const timers = turnStartTimerRefs;
		return () => {
			adoptionWindowOpenRef.current = false;
			timers.current.forEach(clearTimeout);
			timers.current = [];
		};
	}, []);

	const [planOpen, setPlanOpen] = useState(false);
	const [mermaidFocus, setMermaidFocus] = useState<string | null>(null);
	const [figureFocus, setFigureFocus] = useState<{ svg: string; inverted: boolean } | null>(null);

	const mermaidFocusRef = useRef(mermaidFocus);
	mermaidFocusRef.current = mermaidFocus;
	const figureFocusRef = useRef(figureFocus);
	figureFocusRef.current = figureFocus;
	const planOpenRef = useRef(planOpen);
	planOpenRef.current = planOpen;
	const setupOpenRef = useRef(setupOpen);
	setupOpenRef.current = setupOpen;
	const planTree = useMemo(() => latestTree(messages), [messages]);

	const [turns, setTurns] = useState<TurnUsage[]>([]);
	const [pricing, setPricing] = useState<SessionPricing | undefined>();
	const syncTurns = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}`);
			if (!res.ok) return;
			const record = (await res.json()) as { turns?: TurnUsage[]; pricing?: SessionPricing };
			if (Array.isArray(record.turns)) setTurns(record.turns);
			setPricing(record.pricing);
		} catch {
			// transient blip: stats stay on the last known figures
		}
	}, [chatId]);
	useEffect(() => {
		void syncTurns();
	}, [syncTurns]);
	const prevStatusRef = useRef(status);
	useEffect(() => {
		const transitioned = prevStatusRef.current !== "ready" && status === "ready";
		prevStatusRef.current = status;
		if (!transitioned) return;
		void syncTurns();
		if (settleAnnouncedRef.current) {
			settleAnnouncedRef.current = false;
			void syncFromServer();
		}
		// (The extraction-discovery nudges that lived here died at S5: the
		// pipeline announces every phase on the events channel.)
	}, [status, syncTurns, syncFromServer]);

	const prevErrorStatusRef = useRef(status);
	useEffect(() => {
		const was = prevErrorStatusRef.current;
		prevErrorStatusRef.current = status;
		if (was === "error" || status !== "error") return;
		let cancelled = false;
		void (async () => {
			try {
				const res = await fetch(`/api/chats/${chatId}`);
				if (!res.ok || cancelled) return;
				const record = (await res.json()) as { turnInFlight?: boolean };
				if (cancelled) return;
				if (record.turnInFlight === true) setTurnInFlight(true);
				else void syncFromServer();
			} catch {
				/* transient — the banner stands; the next send's merge-retry heals */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [status, chatId, syncFromServer]);

	const [jobs, setJobs] = useState<JobRecord[]>([]);
	const localStreamRef = useRef(false);
	localStreamRef.current = localStream;
	const jobStatusRef = useRef<Map<string, string>>(new Map());
	const pendingSyncRef = useRef(false);
	const firstFetchRef = useRef(true);
	const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const fetchJobsRef = useRef<() => void>(() => {});
	const fetchJobs = useCallback(async () => {
		try {
			const res = await fetch(`/api/jobs?chatId=${encodeURIComponent(chatId)}`);
			if (!res.ok) return;
			const data = (await res.json()) as { jobs?: JobRecord[]; turnInFlight?: boolean };
			const list = data.jobs ?? [];
			for (const j of list) {
				const prev = jobStatusRef.current.get(j.id);
				if (prev === "running" && j.status !== "running") {
					if (localStreamRef.current || data.turnInFlight === true) {
						pendingSyncRef.current = true;
						void adoptAppendOnly();
					} else {
						void syncFromServer();
					}
				}
				jobStatusRef.current.set(j.id, j.status);
			}
			firstFetchRef.current = false;
			if (
				pendingSyncRef.current &&
				!localStreamRef.current &&
				data.turnInFlight !== true
			) {
				pendingSyncRef.current = false;
				void syncFromServer();
			}
			setJobs(list);
			// (Wake-turn adoption that lived here — the turnInFlight attach
			// line — died at S3: turn-started on the events channel owns
			// discovery now. turnInFlight is STILL READ above: the settle
			// logic's idle check needs it.)
		} catch {
			/* transient fetch failure — the next jobs-changed announcement re-fetches */
		}
	}, [chatId, syncFromServer, adoptAppendOnly]);
	fetchJobsRef.current = () => void fetchJobs();
	useEffect(() => {
		firstFetchRef.current = jobStatusRef.current.size === 0;
		void fetchJobs();
	}, [fetchJobs]);
	useServerEvent("jobs-changed", (p) => {
		if (p.chatId != null && p.chatId !== chatId) return;
		if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
		fetchDebounceRef.current = setTimeout(() => {
			fetchDebounceRef.current = undefined;
			fetchJobsRef.current();
		}, 250);
	});
	useServerResync(() => fetchJobsRef.current());
	useEffect(
		() => () => {
			if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
		},
		[],
	);

	const statusRef = useRef(status);
	statusRef.current = status;
	const settleAnnouncedRef = useRef(false);
	useServerEvent("turn-started", (p) => {
		if (p.chatId !== chatId) return;
		if (localStreamRef.current) return;
		if (turnInFlightRef.current) return;
		attachToRunningTurn();
	});
	useServerEvent("turn-settled", (p) => {
		if (p.chatId !== chatId) return;
		if (localStreamRef.current) {
			settleAnnouncedRef.current = true;
			return;
		}
		if (turnInFlightRef.current) {
			if (statusRef.current === "error") {
				setTurnInFlight(false);
				clearError();
				void syncFromServer();
			}
			return;
		}
		void syncFromServer();
	});
	useServerEvent("compaction-changed", (p) => {
		if (p.chatId !== chatId) return;
		setCompacting(p.running);
	});
	useServerEvent("record-changed", (p) => {
		if (p.chatId !== chatId) return;
		if (localStreamRef.current || turnInFlightRef.current) return;
		void syncFromServer();
	});

	const onSend = () => {
		if (pending || compacting) return;
		if (!dictation.active) {
			doSteerOrSend();
			return;
		}
		void dictation.finish().then(doSteerOrSend);
	};
	const doSend = () => {
		if (busy || pending || compacting) return;
		const t = withAttachments(textRef.current, attachments.current());
		if (!t) return;
		draftRef.current = t;
		applyText("");
		attachments.clear();
		void send({ type: "text", text: t });
	};

	const doSteerOrSend = () => {
		if (pending || compacting) return;
		const t = withAttachments(textRef.current, attachments.current());
		if (!t) return;
		if (busy) {
			applyText("");
			attachments.clear();
			void steer(t);
			return;
		}
		doSend();
	};

	const renderMessage = (m: (typeof messages)[number], mi: number, from = 0, to = m.parts.length) =>
								hintReplies.has(mi) && !m.parts.some((p) => p.type.startsWith("tool-") || p.type.startsWith("data-")) ? null : m.role === "user" && isSubagentSteer(m) ? (
									<SubagentSteerCard key={m.id || `m-${mi}`} message={m} />
								) : m.role === "user" && m.parts.some((p) => p.type === "data-probe-handoff") ? (
								<PhaseDivider key={m.id || `m-${mi}`} phase="plan" />
							) : m.role === "user" && m.parts.length > 0 && m.parts.every((p) => p.type.startsWith("data-")) ? (
								<Fragment key={m.id || `m-${mi}`}>
									{m.parts.map((part, pi) => {
										switch (part.type) {
											case "data-graph-context":
												return <GraphContextCard key={pi} data={part.data as GraphContextData} />;
											case "data-compaction":
												return <CompactionMomentDivider key={pi} data={part.data as CompactionDividerData} />;
											case "data-compaction-cut":
												return <CompactionCutDivider key={pi} data={part.data as CompactionDividerData} />;
											case "data-practice-thinking": {
												const data = part.data as PracticeThinkingData;
												if (isHintRung(data.hint) && !data.text.trim()) return null;
												return <ThinkingCard key={pi} data={data} />;
											}
											case "data-practice-next":
												return (
													<div key={pi} data-testid="practice-next-line" className="ls-divider quiet">
														<i aria-hidden="true" />
														<span>
															<Icon name="arrow-right" size="xs" />
															Next problem
														</span>
														<i aria-hidden="true" />
													</div>
												);
											default:
												return null;
										}
									})}
								</Fragment>
							) : (
									<Fragment key={`${m.id || `m-${mi}`}${from > 0 ? `-p${from}` : ""}`}>
									{m.role === "assistant" &&
									from === 0 &&
									mi > 0 &&
									phases[mi] === "teach" &&
									phases[mi - 1] !== "teach" &&
									teachStepIndex(m.parts) === -1 ? (
										<PhaseDivider key={`teach-${m.id || `m-${mi}`}`} phase="teach" />
									) : null}
									{m.role === "user" ? (
										<UserMessageBody text={m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")} />
									) : (
									<Message from="assistant" className="max-w-full">
									<MessageContent className="ls-turn">
											{m.parts.map((part, pi) => {
												if (pi < from || pi >= to) return null;
												if (hintReplies.has(mi) && (part.type === "text" || part.type === "reasoning" || part.type === "step-start")) return null;
												const isLastPart = mi === messages.length - 1 && pi === m.parts.length - 1;
												const teachBoundary =
													m.role === "assistant" &&
													mi > 0 &&
													phases[mi] === "teach" &&
													phases[mi - 1] !== "teach" &&
													teachStepIndex(m.parts) === pi;
												if (
													part.state === "output-error" &&
													part.type.startsWith("tool-") &&
													part.errorText !== "Operation aborted"
												) {
													return (
														<SystemLine key={`retry-${pi}`} testId="tool-retry">
															Retrying…
														</SystemLine>
													);
												}
												switch (part.type) {
													case "text": {
														const sourceId = textPartMessageId(part.id);
														const anchor = sourceId && sourceTextParts.get(sourceId) === part.id ? messageAnchorId(sourceId) : undefined;
														return (
															<div key={part.id || pi} id={anchor} data-source-message-id={sourceId ?? undefined} className="lh-source-passage">
																<MessageResponse>{part.text}</MessageResponse>
															</div>
														);
													}
													case "reasoning":
														return (
															<Reasoning key={pi} isStreaming={status === "streaming" && isLastPart}>
																<ReasoningTrigger />
																<ReasoningContent>{part.text ?? ""}</ReasoningContent>
															</Reasoning>
														);
													case "step-start":
														if (teachBoundary)
															return <PhaseDivider key={`teach-step-${pi}`} phase="teach" />;
														return pi > from ? <div key={pi} className="ls-stepgap" aria-hidden="true" /> : null;
													case "data-plan-block":
														return (
															<PlanBlock
																key={pi}
																data={part.data as PlanBlockData}
																onOpen={() => setPlanOpen(true)}
															/>
														);
													case "tool-quiz":
													case "tool-probe":
													case "tool-ask_user_question":
													case "tool-explain":
													case "tool-recall": {
														if (part.state === "output-available") {
															return (
																<AnsweredCard key={pi} answer={part.output as QuestionAnswerData} input={part.input} />
															);
														}
														return null;
													}
													default: {
														if (part.type.startsWith("tool-") && part.state === "input-streaming") {
															return <LiveToolCard key={pi} part={part as ArtifactPartProps["part"]} />;
														}
														if (part.type.startsWith("tool-")) {
															const Renderer = artifactRenderers[part.type.slice("tool-".length)];
															if (Renderer) return <Renderer key={pi} part={part as ArtifactPartProps["part"]} />;
														}
														return null;
													}
												}
											})}
										</MessageContent>
									</Message>
									)}
								</Fragment>
							);

	const submitPendingAnswer = (output: QuestionAnswerData) => {
		if (!pending) return;
		const reading = readingThinkingRef.current.trim() || undefined;
		clearReadingThinking();
		submitAnswer(pending.tool, pending.toolCallId, reading ? { ...output, readingThinking: reading } : output);
	};

	return (
		<ChatActionsContext.Provider
			value={{
				chatId,
				syncFromServer,
				sendText: (t: string) => {
					void send({ type: "text", text: t });
				},
				openSetup: () => setSetupOpen(true),
			}}
		>
		<SessionMermaidContext.Provider
			value={{
				openMermaid: setMermaidFocus,
				openFigure: (svg, inverted) => setFigureFocus({ svg, inverted }),
			}}
		>
		<JobsContext.Provider value={jobs}>
		<div className={`v4 ls-root ${kind === "practice" ? "warm" : ""}`}>
		<Field variant={kind === "practice" ? "warm" : "home"} />
		<div className="lshell">
			<Rail active={kind === "practice" ? "practice" : undefined} />
			<div className="center">
				<header
					className={`top ${renaming ? "" : "lh-drag"}`}
					onMouseDown={(e) => {
						if (renaming && e.target !== titleInputRef.current) titleInputRef.current?.blur();
					}}
				>
					{renaming ? (
						<input
							ref={titleInputRef}
							value={titleDraft}
							onChange={(e) => setTitleDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void commitRename(titleDraft);
								// stopPropagation claims the Esc: closing rename must not
								// also abort a turn.
								else if (e.key === "Escape") {
									e.stopPropagation();
									setRenaming(false);
								}
							}}
							onBlur={() => void commitRename(titleDraft)}
							spellCheck={false}
							aria-label="Session title"
							className="ls-rename"
						/>
					) : (
						<Hint label="Rename session" action="rename-session" side="bottom">
							<button
								type="button"
								className="ls-title"
								onClick={() => {
									setTitleDraft(titleText);
									setRenaming(true);
								}}
							>
								<h1>{displayTitle(titleText)}</h1>
							</button>
						</Hint>
					)}
					<span className="ls-pos hide-sm">
						<span data-testid="session-position">
							{kind === "practice"
								? setProgress && setProgress.length > 0
									? `Problem ${Math.min(setProgress.length, PRACTICE_SET_SIZE)} of ${PRACTICE_SET_SIZE}`
									: "Practice"
								: lessonProgress && lessonProgress.currentIndex !== null
									? `Step ${lessonProgress.currentIndex} of ${lessonProgress.total}`
									: (phases.at(-1) ?? "probe") === "probe"
										? "Check-in"
										: "Lesson"}
						</span>
						{kind === "practice" && setProgress && setProgress.length > 0 && (
							<span className="set" role="img" aria-label={`${setProgress.filter((p) => p.outcome).length} of ${PRACTICE_SET_SIZE} problems done`}>
								{Array.from({ length: Math.max(PRACTICE_SET_SIZE, setProgress.length) }, (_, i) => {
									const p = setProgress[i];
									const cls = !p ? "" : p.outcome === null ? "now" : p.outcome === "solved" ? "solid" : p.outcome === "solvedWithHints" ? "help" : "";
									return <i key={i} className={cls} />;
								})}
							</span>
						)}
						{kind !== "practice" && lessonProgress && (
							<span className="ticks" role="img" aria-label={`${lessonProgress.visited} of ${lessonProgress.total} steps visited`}>
								{lessonProgress.steps.map((st) => (
									<i key={st.id} className={st.status === "current" ? "c" : st.status === "visited" ? "d" : ""} />
								))}
							</span>
						)}
					</span>
					<span className="ls-actions">
						{kind === "practice" && activeProblem && <ProblemClock key={activeProblem.toolCallId} problemId={activeProblem.toolCallId} />}
						{kind !== "practice" && planTree && (
							<Hint label="Plan map" side="bottom">
								<button type="button" className="ib" aria-label="Plan map" data-testid="plan-chip" onClick={() => setPlanOpen(true)}>
									<Icon name="plan" size="md" />
								</button>
							</Hint>
						)}
						{kind !== "practice" && <ModelControl variant="chip" className="mchip" chatId={chatId} />}
						<DockToggle attention={Boolean(pending) || Boolean(activeProblem)} label={kind === "practice" ? "Your working" : "Question and path"} />
					</span>
				</header>

				<SessionFind scopeRef={sessionFindScopeRef} scrollContextRef={scrollContextRef} />
				<div ref={sessionFindScopeRef} className="ls-scope">
				<Conversation className="ls-conv" initial="instant" contextRef={scrollContextRef}>
					<SessionMessageNavigation />
					<ConversationContent className="scroll">
						<div data-session-find-root="" className="col">
							{messages.length === 0 && !busy && (
								<ConversationEmptyState>
									<EmptyState icon={kind === "practice" ? "practice" : "lesson"} title="New session">
										{kind === "practice"
											? "Your first problem arrives in a moment."
											: "Your teacher opens by checking what you already know."}
									</EmptyState>
								</ConversationEmptyState>
							)}

							{fold && (fold.startIndex > 0 || fold.startPart > 0) && (
								<div className="ls-past rise" data-testid="past-steps">
									<Icon name="status-ok" size="md" />
									<span className="ls-past-t">
										<b>Steps 1–{fold.steps}</b>
										{fold.answers.total > 0 && ` · ${fold.answers.firstTry} of ${fold.answers.total} right first time`}
									</span>
									<button type="button" className="ls-quiet" aria-expanded={reviewOpen} onClick={() => setReviewOpen((v) => !v)}>
										{reviewOpen ? "Hide" : "Review"}
										<Icon name="chevron-down" size="sm" />
									</button>
								</div>
							)}
							{(!fold || reviewOpen) && messages.slice(0, fold?.startIndex ?? 0).map((m, i) => renderMessage(m, i))}
							{fold && reviewOpen && fold.startPart > 0 && renderMessage(messages[fold.startIndex]!, fold.startIndex, 0, fold.startPart)}
							{fold?.heading && (
								<div className="ls-step-h rise" data-testid="step-heading">
									<span className="over">Step {fold.heading.number}</span>
									<h2 className="t-display">{fold.heading.title}</h2>
								</div>
							)}
							{messages.slice(fold?.startIndex ?? 0).map((m, i) => renderMessage(m, i + (fold?.startIndex ?? 0), i === 0 ? (fold?.startPart ?? 0) : 0))}
							{pending && !busy && (
								<button type="button" className="nudge" data-testid="your-turn" onClick={() => window.dispatchEvent(new CustomEvent("lh:focus-question"))}>
									<span className="ping" aria-hidden="true" />
									<span className="ls-nudge-t">
										<b>Your turn</b>
										<span>
											{requiresReveal ? "When you’ve read this step, open the check in the panel." : "Your teacher asked you something — answer it in the panel."}
										</span>
									</span>
									<Icon name="arrow-right" size="md" className="ls-nudge-go" />
								</button>
							)}

							{compacting && (
								<span className="ls-working">
									<BrailleSpinner label="Compacting context" />
									<Shimmer duration={1} as="span">Compacting context…</Shimmer>
								</span>
							)}
							{(status === "submitted" || turnInFlight) && (
								<span className="ls-working">
									<BrailleSpinner label="Thinking" />
									<Shimmer duration={1} as="span">Thinking…</Shimmer>
								</span>
							)}
							{error && (
								<div className="ls-error" role="alert">
									<Icon name="status-error" size="md" />
									<div>
										<b>Something went wrong</b>
										<span>{error.message}</span>
									</div>
								</div>
							)}
						</div>

				</ConversationContent>
				<ConversationScrollButton />
				</Conversation>

				{mermaidFocus !== null && (
					<MermaidOverlay chart={mermaidFocus} onClose={() => setMermaidFocus(null)} />
				)}
				{figureFocus !== null && (
					<MermaidOverlay
						svg={figureFocus.svg}
						inverted={figureFocus.inverted}
						onClose={() => setFigureFocus(null)}
					/>
				)}
				{planOpen && <PlanPopup messages={messages} onClose={() => setPlanOpen(false)} />}
				<AbortTurnDialog mode={abortAsk} onClose={() => setAbortAsk(null)} onConfirm={confirmAbort} busy={busy} />
				</div>

				<div className="composer">
					<div className="ls-dock">
						{zeroKeys ? (
							<ZeroKeysPill onOpen={() => setSetupOpen(true)} />
						) : (
							!configured && (
								<div className="ls-setup">
									<button type="button" className="btn brand" data-testid="setup-cta" onClick={() => setSetupOpen(true)}>
										Set up your models
									</button>
								</div>
							)
						)}
						<QueuedSteersBody steers={visibleQueuedSteers(steerQueue, nativeMessages)} />
						<AttachmentChips paths={attachments.paths} onRemove={attachments.remove} />
						<Composer
							busy={busy}
							value={text}
							onChange={applyText}
							inputRef={composerInputRef}
							onSend={onSend}
							onStop={abortInFlightTurn}
							canSend={canSend}
							onEscape={dictation.active ? dictation.stop : undefined}
							dictating={dictation.active && composerIsTarget}
							nextProblem={nextReady}
							onNext={sendNext}
							onFiles={canAttach ? attachments.add : undefined}
							trailing={
								<>
								{canAttach && (
									<Hint label="Attach a file" side="top">
										<button type="button" className="ib" aria-label="Attach a file" onClick={picker.open}>
											<Icon name="attach" size="md" />
										</button>
									</Hint>
								)}
								<Hint label={dictation.active ? "Stop dictation" : "Dictate"} action={dictation.active ? undefined : "toggle-dictation"} side="top">
								<button
									type="button"
									className={`ib ${dictation.active ? "on" : ""}`}
									aria-label={dictation.active ? "Stop dictation" : "Dictate"}
									aria-pressed={dictation.active}
									onClick={() => (dictation.active ? void dictation.finish() : dictation.toggle())}
								>
									{dictation.active ? (
										<DictationWave />
									) : (
										<Icon name="mic" size="md" />
									)}
								</button>
								</Hint>
								</>
							}
							placeholder={
								nextReady
									? "Ask anything, or press Enter for the next problem"
									: pending
										? "Ask a question — the check waits in the panel"
										: kind === "practice"
											? "Ask about the problem, or steer the set"
											: "Ask about this step, or steer the lesson"
							}
						/>
						{picker.input}
						<AttachmentErrors errors={attachments.errors} />
						<DictationErrorLine show={composerIsTarget} />
					</div>
				</div>
			</div>
			<DockResizer />
			<DockSlot>
			{kind === "practice" ? (
				<PracticePanel
					messages={messages}
					practice={activeProblem}
					onSubmitThinking={submitThinking}
					compactionRunning={compacting}
					dictationStop={dictation.stop}
					turns={turns}
					hintsUsed={hintsUsed}
				/>
			) : (
				<LessonPanel
					messages={messages}
					pending={pending}
					requiresReveal={requiresReveal}
					phase={phases.at(-1) ?? "probe"}
					compactionRunning={compacting}
					readingThinking={readingThinking}
					onReadingThinking={applyReadingThinking}
					onSubmitAnswer={submitPendingAnswer}
					dictationStop={dictation.stop}
					onOpenPlan={() => setPlanOpen(true)}
					busy={busy}
					turns={turns}
					contextTokens={contextTokens}
					pricing={pricing}
					chatId={chatId}
				/>
			)}
			</DockSlot>
		</div>
		</div>
		</JobsContext.Provider>
		</SessionMermaidContext.Provider>
		<SetupDialog
			open={setupOpen}
			onClose={() => setSetupOpen(false)}
			onDone={() => {
				setSetupOpen(false);
				setConfigured(true);
				// Save only saves (owner ruling 2026-10-09): the draft went
				// home into the composer at refusal time and STAYS there —
				// the learner sends it themselves.
			}}
		/>
		</ChatActionsContext.Provider>
	);
}

export type EscAbortTarget = "mermaid" | "plan" | "setup" | "question" | "problem" | "turn" | null;
export function initialPromptOwed(messages: readonly { role: string }[], prompt: string | undefined): boolean {
	if (!prompt) return false;
	return !messages.some((m) => m.role === "user" || m.role === "assistant");
}

export function escAbortTarget(s: {
	abortAsk: boolean;
	mermaidFocus: boolean;
	planOpen: boolean;
	setupOpen: boolean;
	pending: boolean;
	problem: boolean;
	busy: boolean;
}): EscAbortTarget {
	if (s.abortAsk) return null;
	if (s.mermaidFocus) return "mermaid";
	if (s.planOpen) return "plan";
	if (s.setupOpen) return "setup";
	if (s.pending) return "question";
	if (s.problem) return "problem";
	if (s.busy) return "turn";
	return null;
}

function ProblemClock({ problemId }: { problemId: string }) {
	const [start] = useState(() => Date.now());
	const [now, setNow] = useState(start);
	useEffect(() => {
		const t = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(t);
	}, [problemId]);
	const secs = Math.floor((now - start) / 1000);
	return (
		<span className="ls-clock" key={problemId} title="Time on this problem">
			<Icon name="time" size="xs" />
			<span className="mono num">
				{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
			</span>
			on this one
		</span>
	);
}

const DOCK_SLIDE_EVENT = "lh:dock-slide";

function DockToggle({ attention, label }: { attention: boolean; label: string }) {
	return (
		<Hint label={label} side="bottom">
			<button
				type="button"
				className="ib ls-dock-toggle"
				aria-label={label}
				onClick={() => window.dispatchEvent(new CustomEvent(DOCK_SLIDE_EVENT))}
			>
				<Icon name="panel" size="md" />
				{attention && <span className="ping" aria-hidden="true" />}
			</button>
		</Hint>
	);
}

const DOCK_MIN = 340;
const DOCK_MAX = 520;
const DOCK_WIDTH_KEY = "lh:dock-width";

export function clampDockWidth(px: number): number {
	return Math.round(Math.min(DOCK_MAX, Math.max(DOCK_MIN, px)));
}

function DockResizer() {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState<number | null>(null);
	const [dragging, setDragging] = useState(false);
	const lastTap = useRef(0);
	const apply = useCallback((w: number | null, save: boolean) => {
		const frame = ref.current?.parentElement;
		if (!frame) return;
		if (w === null) frame.style.removeProperty("--dock-w");
		else frame.style.setProperty("--dock-w", `${w}px`);
		setWidth(w);
		if (!save) return;
		try {
			if (w === null) localStorage.removeItem(DOCK_WIDTH_KEY);
			else localStorage.setItem(DOCK_WIDTH_KEY, String(w));
		} catch {
			// Storage unavailable (private window): the width lasts the visit.
		}
	}, []);
	useEffect(() => {
		let saved: number | null = null;
		try {
			const raw = Number(localStorage.getItem(DOCK_WIDTH_KEY));
			if (raw > 0) saved = clampDockWidth(raw);
		} catch {
			// Storage unavailable: stay fluid.
		}
		if (saved !== null) apply(saved, false);
	}, [apply]);
	const current = () => {
		const dock = ref.current?.parentElement?.querySelector<HTMLElement>(".dock");
		return width ?? (dock ? Math.round(dock.getBoundingClientRect().width) : DOCK_MIN);
	};
	return (
		<div
			ref={ref}
			className={`ls-resize ${dragging ? "drag" : ""}`}
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize the panel"
			aria-valuemin={DOCK_MIN}
			aria-valuemax={DOCK_MAX}
			aria-valuenow={width ?? undefined}
			tabIndex={0}
			title="Drag to resize · double-click to reset"
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				const el = e.currentTarget;
				el.setPointerCapture(e.pointerId);
				const startX = e.clientX;
				const startW = current();
				let last = startW;
				let moved = false;
				setDragging(true);
				const move = (ev: PointerEvent) => {
					if (Math.abs(ev.clientX - startX) < 3 && !moved) return;
					moved = true;
					last = clampDockWidth(startW + (startX - ev.clientX));
					apply(last, false);
				};
				const up = () => {
					el.removeEventListener("pointermove", move);
					el.removeEventListener("pointerup", up);
					el.removeEventListener("pointercancel", up);
					setDragging(false);
					if (moved) {
						lastTap.current = 0;
						apply(last, true);
						return;
					}
					const now = Date.now();
					if (now - lastTap.current < 400) {
						lastTap.current = 0;
						apply(null, true);
					} else lastTap.current = now;
				};
				el.addEventListener("pointermove", move);
				el.addEventListener("pointerup", up);
				el.addEventListener("pointercancel", up);
			}}
			onKeyDown={(e) => {
				if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
				e.preventDefault();
				apply(clampDockWidth(current() + (e.key === "ArrowLeft" ? 20 : -20)), true);
			}}
		>
			<i aria-hidden="true" />
		</div>
	);
}

function DockSlot({ children }: { children: React.ReactNode }) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const narrow = () => window.matchMedia("(min-width: 800px) and (max-width: 1023px)").matches;
		const toggle = () => setOpen((o) => !o);
		const show = () => {
			if (narrow()) setOpen(true);
		};
		window.addEventListener(DOCK_SLIDE_EVENT, toggle);
		window.addEventListener("lh:focus-question", show);
		return () => {
			window.removeEventListener(DOCK_SLIDE_EVENT, toggle);
			window.removeEventListener("lh:focus-question", show);
		};
	}, []);
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open]);
	return (
		<>
			<div className={`ls-dockscrim ${open ? "open" : ""}`} aria-hidden="true" onClick={() => setOpen(false)} />
			<div className={`ls-dockslot ${open ? "open" : ""}`}>
				<button type="button" className="ib ls-dockclose pop" aria-label="Close panel" onClick={() => setOpen(false)}>
					<Icon name="close" size="md" />
				</button>
				{children}
			</div>
		</>
	);
}

export function UserMessageBody({ text }: { text: string }) {
	const { text: words, paths } = splitAttachments(text);
	return (
		<div data-testid="user-message" className={words ? "ls-user" : "ls-user att-only"}>
			{words}
			<AttachmentChips paths={paths} />
		</div>
	);
}
