"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ChatInput, LhMessage, QuestionAnswerData } from "@/src/core";
import { SessionModel, type SessionState } from "@/components/session-core";

export interface UseChatSessionOptions {
	chatId: string;
	initialMessages: LhMessage[];
	initiallyInFlight?: boolean;
}

export function useChatSession({ chatId, initialMessages, initiallyInFlight }: UseChatSessionOptions) {
	const modelRef = useRef<SessionModel | null>(null);
	if (modelRef.current === null) {
		modelRef.current = new SessionModel({ chatId, initialMessages });
	}
	const model = modelRef.current;
	const [version, bump] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		model.onChange = bump;
		return () => {
			model.onChange = undefined;
		};
	}, [model, bump]);

	useEffect(() => {
		if (initiallyInFlight) void model.resumeStream(false);
		return () => {
			model.stop();
		};
	}, [initiallyInFlight, model]);

	const state = useMemo<SessionState>(() => model.getState(), [model, version] as const);

	const prevStatusRef = useRef(state.status);
	useEffect(() => {
		const was = prevStatusRef.current;
		prevStatusRef.current = state.status;
		if (was === state.status) return;
		const running = state.status === "submitted" || state.status === "streaming";
		const wasRunning = was === "submitted" || was === "streaming";
		if (running === wasRunning) return;
		window.dispatchEvent(new CustomEvent("lh:turn-state", { detail: { id: chatId, running } }));
	}, [state.status, chatId]);

	const setReattachSettled = useCallback(
		(fn: () => void) => {
			model.setReattachSettled(fn);
		},
		[model],
	);

	const send = useCallback((input: ChatInput) => void model.send(input), [model]);
	const steer = useCallback((text: string) => void model.steer(text), [model]);
	const submitAnswer = useCallback(
		(tool: string, toolCallId: string, output: QuestionAnswerData) =>
			void model.submitAnswer(tool, toolCallId, output),
		[model],
	);
	const dismissQuestion = useCallback(
		(toolCallId: string, answer: QuestionAnswerData) => void model.dismissQuestion(toolCallId, answer),
		[model],
	);
	const dismissProblem = useCallback(
		(problemCallId: string) => void model.dismissProblem(problemCallId),
		[model],
	);
	const setMessages = useCallback((record: LhMessage[]) => model.setMessages(record), [model]);
	const adoptRecord = useCallback((record: LhMessage[]) => model.adoptRecord(record), [model]);
	const stop = useCallback(() => model.stop(), [model]);
	const clearError = useCallback(() => model.clearError(), [model]);
	const resumeStream = useCallback(() => void model.resumeStream(), [model]);

	return {
		messages: state.messages,
		nativeMessages: state.nativeMessages,
		contextTokens: state.contextTokens,
		status: state.status,
		error: state.error,
		steerQueue: state.steerQueue,
		send,
		steer,
		submitAnswer,
		dismissQuestion,
		dismissProblem,
		setMessages,
		adoptRecord,
		stop,
		clearError,
		resumeStream,
		setReattachSettled,
	};
}
