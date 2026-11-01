"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/icon";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";
import { kbdEventForAction } from "@/src/core";

/*
 * Deepgram streaming params (the owner's live-tuned dictate config): nova-3,
 * endpointing=300, no interims. Silence streams too (the worklet never
 * pauses), so the socket never idles — no KeepAlive needed.
 */
const DG_URL =
	"wss://api.deepgram.com/v1/listen" +
	"?model=nova-3" +
	"&encoding=linear16" +
	"&sample_rate=16000" +
	"&channels=1" +
	"&smart_format=true" +
	"&punctuate=true" +
	"&endpointing=300";

const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;
export const METER_TICK_MS = 60;
const WAVE_GAINS = [0.55, 1, 0.8, 0.45];
const WAVE_RELEASE = 0.82;

export const DEEPGRAM_KEY_ID = "DEEPGRAM_API_KEY";

export const DICTATION_KEYLESS = "Dictation needs a Deepgram key";

class DictationKeyError extends Error {}

async function mintFreshToken(): Promise<string> {
	const res = await fetch("/api/stt/token");
	const data = (await res.json()) as { token?: string; message?: string; reason?: string };
	if (!res.ok || !data.token) {
		if (res.status === 503) throw new DictationKeyError(DICTATION_KEYLESS);
		const message = data.message ?? `token route ${res.status}`;
		throw data.reason === "key-rejected" ? new DictationKeyError(message) : new Error(message);
	}
	return data.token;
}

export const WARM_TOKEN_TTL_MS = 3 * 60_000;

export type WarmMinter = { mint: () => Promise<string>; refresh: () => void };

export function createWarmMinter(
	mint: () => Promise<string>,
	now: () => number = Date.now,
	ttlMs: number = WARM_TOKEN_TTL_MS,
): WarmMinter {
	let warm: { p: Promise<string>; at: number } | null = null;
	const m: WarmMinter = {
		mint: () => {
			if (!warm || now() - warm.at > ttlMs) {
				const p = mint().catch((e: unknown) => {
					warm = null;
					throw e;
				});
				warm = { p, at: now() };
			}
			return warm.p;
		},
		refresh: () => {
			warm = null;
			m.mint().catch(() => {});
		},
	};
	return m;
}

const warmTokens = createWarmMinter(mintFreshToken);

/* One app-lifetime AudioContext, created under the click gesture
 * (autoplay policy) and never closed; per-run nodes disconnect at
 * teardown instead. */
let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;

function ensureAudioGraph(): { ctx: AudioContext; module: Promise<void> } {
	if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 16000 });
	if (!workletModule) {
		workletModule = sharedCtx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((e: unknown) => {
			workletModule = null;
			throw e;
		});
	}
	return { ctx: sharedCtx, module: workletModule };
}

export function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
	return Math.max(0, Math.min(1, t));
}

let questionTarget: { token: object; append: (text: string) => void } | null = null;

export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

export type DictationError = {
	message: string;
	fixKey: boolean;
};

export type DictationSnapshot = {
	phase: DictationPhase;
	error: DictationError | null;
	claimant: object | null;
};

const IDLE_SNAPSHOT: DictationSnapshot = { phase: "idle", error: null, claimant: null };
let snapshot = IDLE_SNAPSHOT;
const listeners = new Set<() => void>();

function publish(patch: Partial<DictationSnapshot>) {
	snapshot = { ...snapshot, ...patch };
	for (const l of listeners) l();
}

function subscribe(l: () => void) {
	listeners.add(l);
	return () => listeners.delete(l);
}

export function useDictationState(): DictationSnapshot {
	return useSyncExternalStore(subscribe, () => snapshot, () => IDLE_SNAPSHOT);
}

const level = { current: 0 };

export function isDictationActive(): boolean {
	return snapshot.phase !== "idle";
}

export function clearDictationError() {
	if (snapshot.error) publish({ error: null });
}

export function toggleDictation() {
	window.dispatchEvent(new CustomEvent(kbdEventForAction("toggle-dictation")));
}

let dictationFinisher: (() => Promise<void>) | null = null;

export function finishDictation(): Promise<void> {
	return dictationFinisher ? dictationFinisher() : Promise.resolve();
}

export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

export function useDictationTarget(append: (text: string) => void, claimed: boolean): boolean {
	const [token] = useState(() => ({}));
	const appendRef = useRef(append);
	appendRef.current = append;
	useEffect(() => {
		if (!claimed) return;
		questionTarget = { token, append: (t) => appendRef.current(t) };
		publish({ claimant: token });
		return () => {
			if (questionTarget?.token !== token) return;
			questionTarget = null;
			publish({ claimant: null });
		};
	}, [claimed, token]);
	const { claimant } = useDictationState();
	return claimed && claimant === token;
}

export type Dictation = {
	phase: DictationPhase;
	active: boolean;
	toggle: () => void;
	stop: () => void;
	finish: () => Promise<void>;
};

export function useDictation({ append }: { append: (text: string) => void }): Dictation {
	const { phase } = useDictationState();
	const appendRef = useRef(append);
	appendRef.current = append;

	const wsRef = useRef<WebSocket | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	const pendingRef = useRef<ArrayBuffer[]>([]);
	const genRef = useRef(0);
	const safetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectsRef = useRef(0);
	const waitersRef = useRef<Array<() => void>>([]);

	const deliver = useCallback((text: string) => {
		(questionTarget?.append ?? appendRef.current)(text);
		window.dispatchEvent(new CustomEvent("lh:dictation-final"));
	}, []);

	const cleanup = useCallback(() => {
		genRef.current++;
		if (safetyRef.current) {
			clearTimeout(safetyRef.current);
			safetyRef.current = null;
		}
		pendingRef.current = [];
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;
		const ws = wsRef.current;
		wsRef.current = null;
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			try {
				ws.close();
			} catch {}
		}
		publish({ phase: "idle" });
		for (const w of waitersRef.current.splice(0)) w();
		warmTokens.refresh();
	}, []);

	const fail = useCallback(
		(e: unknown, fallback: string) => {
			publish({
				error: {
					message: e instanceof Error ? e.message : fallback,
					fixKey: e instanceof DictationKeyError,
				},
			});
			cleanup();
		},
		[cleanup],
	);

	const openSocket = useCallback(
		(gen: number, token: string) => {
			// Minted JWTs authenticate via the "bearer" subprotocol — ["token",
			// jwt] is rejected at the handshake (verified live; "token" is for
			// raw API keys only, as in the owner's pi dictate extension).
			const ws = new WebSocket(DG_URL, ["bearer", token]);
			wsRef.current = ws;

			ws.addEventListener("open", () => {
				if (gen !== genRef.current) return;
				// Mitigation A: everything captured during the handshake (or a
				// reconnect gap) goes out now, in order — Deepgram accepts
				// faster-than-realtime sends.
				for (const frame of pendingRef.current) ws.send(frame);
				pendingRef.current = [];
				if (snapshot.phase === "connecting") publish({ phase: "recording" });
			});
			ws.addEventListener("message", (ev) => {
				if (gen !== genRef.current) return;
				let msg: any;
				try {
					msg = JSON.parse(ev.data as string);
				} catch {
					return;
				}
				if (msg.type === "Results") {
					const text: string | undefined = msg.channel?.alternatives?.[0]?.transcript;
					if (msg.is_final && text) deliver(text);
				}
			});
			ws.addEventListener("close", (ev) => {
				if (gen !== genRef.current) return;
				if (ev.code === 1000) {
					cleanup();
					return;
				}
				if (reconnectsRef.current < 1) {
					reconnectsRef.current++;
					mintFreshToken()
						.then((t) => {
							if (gen === genRef.current) openSocket(gen, t);
						})
						.catch((e: unknown) => {
							if (gen === genRef.current) fail(e, "Deepgram reconnect failed");
						});
				} else {
					fail(null, `Deepgram connection lost (${ev.code})`);
				}
			});
		},
		[cleanup, deliver, fail],
	);

	const start = useCallback(async () => {
		publish({ phase: "connecting", error: null });
		level.current = 0;
		reconnectsRef.current = 0;
		pendingRef.current = [];
		const gen = ++genRef.current;

		// The mic is the long pole (macOS HAL + APM init). 127.0.0.1 is a secure
		// context, so getUserMedia works without TLS; macOS TCC prompts on first use.
		const tokenPromise = warmTokens.mint();
		tokenPromise.catch(() => {});
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			if (gen !== genRef.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			streamRef.current = stream;

			const { ctx, module } = ensureAudioGraph();
			await module;
			if (ctx.state === "suspended") await ctx.resume();
			if (gen !== genRef.current) return;

			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			workletRef.current = worklet;
			worklet.port.onmessage = (e) => {
				const msg = e.data as { type: string; rms?: number; buffer?: ArrayBuffer };
				if (msg.type === "level") {
					level.current = msg.rms ?? 0;
				} else if (msg.type === "audio") {
					const ws = wsRef.current;
					if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg.buffer!);
					// Mitigation A: not OPEN yet (handshake or reconnect gap) —
					// queue, capped; the open handler flushes in order.
					else {
						pendingRef.current.push(msg.buffer!);
						if (pendingRef.current.length > 256) pendingRef.current.shift();
					}
				}
			};
			const source = ctx.createMediaStreamSource(stream);
			sourceRef.current = source;
			source.connect(worklet);
			// Pull the graph with silence out (the worklet writes no output) —
			// an unconnected worklet node is never clocked.
			worklet.connect(ctx.destination);
		} catch (e) {
			if (gen !== genRef.current) return;
			const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
			fail(denied ? new Error("Microphone permission denied") : e, "mic unavailable");
			return;
		}
		if (gen !== genRef.current) return;
		let token: string;
		try {
			token = await tokenPromise;
		} catch (e) {
			if (gen !== genRef.current) return;
			fail(e, "token unavailable");
			return;
		}
		if (gen !== genRef.current) return;
		openSocket(gen, token);
	}, [openSocket, fail]);

	const stop = useCallback(() => {
		const gen = genRef.current;
		if (phase !== "recording" && phase !== "connecting") return;
		publish({ phase: "stopping" });

		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;

		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ type: "CloseStream" }));
			} catch {
				cleanup();
				return;
			}
			// Deepgram flushes remaining finals then closes; if it never
			// does, the safety net ends the run anyway (dictate pattern).
			safetyRef.current = setTimeout(() => {
				if (gen === genRef.current) cleanup();
			}, 3000);
		} else {
			cleanup();
		}
	}, [phase, cleanup]);

	const finish = useCallback((): Promise<void> => {
		return new Promise((resolve) => {
			if (phase === "idle") {
				resolve();
				return;
			}
			waitersRef.current.push(resolve);
			if (phase === "recording" || phase === "connecting") stop();
		});
	}, [phase, stop]);

	useEffect(() => {
		dictationFinisher = finish;
		return () => {
			if (dictationFinisher === finish) dictationFinisher = null;
		};
	}, [finish]);

	const toggle = useCallback(() => {
		if (phase === "idle") void start();
		else if (phase === "recording" || phase === "connecting") stop();
		// "stopping" presses are ignored — the last finals are in flight.
	}, [phase, start, stop]);

	useEffect(() => {
		warmTokens.refresh();
		return () => {
			if (isDictationActive()) cleanup();
			clearDictationError();
		};
	}, [cleanup]);
	useEffect(() => {
		window.addEventListener("lh:kbd-toggle-dictation", toggle);
		return () => window.removeEventListener("lh:kbd-toggle-dictation", toggle);
	}, [toggle]);
	useEffect(() => {
		window.addEventListener("lh:kbd-stop-dictation", stop);
		return () => window.removeEventListener("lh:kbd-stop-dictation", stop);
	}, [stop]);

	return {
		phase,
		active: phase !== "idle",
		toggle,
		stop,
		finish,
	};
}

export function DictationWave() {
	const { phase } = useDictationState();
	const live = phase === "recording" || phase === "stopping";
	const [height, setHeight] = useState(0);
	useEffect(() => {
		if (!live) {
			setHeight(0);
			return;
		}
		const id = setInterval(() => {
			setHeight((prev) => Math.max(rmsToMeter(level.current), prev * WAVE_RELEASE));
		}, METER_TICK_MS);
		return () => clearInterval(id);
	}, [live]);
	return (
		<span className={cn("wave live", !live && "wait")} aria-hidden="true" data-testid="dictation-wave">
			{WAVE_GAINS.map((g, i) => (
				<i key={i} style={{ height: `${20 + Math.round(height * g * 80)}%` }} />
			))}
		</span>
	);
}

export function DictationMic({ own }: { own: boolean }) {
	const { phase } = useDictationState();
	const on = own && phase !== "idle";
	return (
		<Hint label={on ? "Stop dictation" : "Dictate"} action={on ? undefined : "toggle-dictation"} side="top">
			<button
				type="button"
				className={cn("ib sm fmic", on && "on")}
				aria-label={on ? "Stop dictation" : "Dictate"}
				aria-pressed={on}
				data-testid="field-mic"
				onClick={toggleDictation}
			>
				{on ? <DictationWave /> : <Icon name="mic" size="sm" />}
			</button>
		</Hint>
	);
}

export function DictationErrorLine({ show }: { show: boolean }) {
	const { error } = useDictationState();
	const { open: openSettings } = useSettingsDialog();
	if (!show || !error) return null;
	return (
		<p className="ferror dict-err" role="alert" data-testid="dictation-error">
			<Icon name="mic" size="sm" />
			<span>{error.message}</span>
			{error.fixKey && (
				<button
					type="button"
					className="link"
					onClick={() => {
						clearDictationError();
						openSettings("keys", DEEPGRAM_KEY_ID);
					}}
				>
					Fix key
				</button>
			)}
		</p>
	);
}
