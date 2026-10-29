"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/icon";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";
import { kbdEventForAction } from "@/src/core";

/**
 * Voice dictation — the cloud engine (STT wave 1, 2026-09-17).
 *
 * Architecture (docs/research/stt.md): the renderer captures mic audio in
 * an AudioWorklet (public/worklets/pcm-capture.js → linear16 16kHz mono),
 * opens the Deepgram streaming WebSocket DIRECTLY (audio never loops
 * through our server) with a short-lived token minted by /api/stt/token
 * (the real key stays server-side), and streams frames while it listens.
 * Finals append into the PRIMARY INPUT (see below).
 *
 * Owner round 4 (2026-10-29, "speech to text isn't working at all"): the
 * v4 rebuild dropped the old DictationBar — the ONLY place errors and the
 * live meter rendered — so every failure silently fell back to idle.
 *   - LIVE finals: each final lands in the primary input as it arrives
 *     (sentence-by-sentence, ~300ms after a pause). Supersedes round 2's
 *     deferred buffer. finish() still waits for the last finals.
 *   - Esc STOPS and keeps the text (supersedes round 3's discard).
 *   - Run state lives in a module store (useDictationState) so every mic
 *     and every target field re-renders with it: <DictationWave> draws
 *     the live level, <DictationMic> is the fields' mic button, the
 *     target field outlines itself, and <DictationError> shows the
 *     failure inline under the target field ("Fix key" for key errors).
 *
 * Ported patterns from the owner's pi `dictate` extension (his words:
 * "very well tuned") — see ~/.pi/agent/extensions/dictate:
 *   - generation counter: every start/stop increments it; all async
 *     handlers no-op when stale, so a dying session's socket can never
 *     tear down the current one.
 *   - meter: latest-RMS-never-resets — the level ref keeps the last
 *     observed value, so a tick with no fresh audio re-renders the last
 *     level instead of dropping to silence (60ms tick samples the ref).
 *   - dB mapping floor −50 / ceiling −10: the sweet spot for showing
 *     conversational speech as mid-height bars without pegging.
 *   - stop: mic dies FIRST (no more audio enqueues), then CloseStream,
 *     then a 3s safety net in case Deepgram never closes the socket.
 *   - interim_results=false, endpointing=300: his live-tuned params — no
 *     partial hypotheses, finals commit ~300ms after a pause (owner
 *     round 1: live words are distracting and shift the meter; the
 *     meter's width is FIXED while recording).
 *
 * Owner round 1 (2026-09-17, first live mic test):
 *   - ONE primary transcription input at all times: the pending
 *     quiz/ask question's field while one waits (text mode → the answer
 *     field, select modes → "Your thinking"), else the page's composer.
 *     Implemented as a module-level registry the question form claims on
 *     mount — see useDictationTarget below.
 *   - Click → meter IMMEDIATELY (optimistic): the meter strip renders
 *     from the click, connection + TCC happen behind it. The token mint
 *     and the mic acquisition run CONCURRENTLY (Promise.all) to shrink
 *     the real gap.
 *
 * Meter rendering lives in <DictationWave> (own 60ms timer over the level
 * ref) so the 16-renders/sec never touch the page component — only the
 * four bars repaint.
 *
 * Start-latency mitigation wave (owner, 2026-09-27 — A+B+C+D, the
 * optimistic meter stays): the old start path serialized [token ∥ mic] →
 * NEW AudioContext → addModule fetch → WSS handshake, and DROPPED every
 * frame that arrived before the socket was OPEN — the first seconds of
 * speech never reached Deepgram. Now:
 *   - QUEUE-DON'T-DROP (A): frames arriving before OPEN buffer (capped,
 *     oldest dropped) and flush in order on open — captured speech is
 *     never lost, wherever in setup it lands.
 *   - PARALLEL HANDSHAKE (B, mic-gated): the handshake starts the moment
 *     the capture graph is live, not after it. Mic-gated, NOT token-gated:
 *     an OS TCC prompt can outlive Deepgram's 10s idle timeout.
 *   - PERSISTENT GRAPH (C): one app-lifetime AudioContext + a memoized
 *     worklet module — per-run contexts paid context creation AND a
 *     worklet-module fetch on every start (through the dev server in dev).
 *   - WARM TOKEN (D): pre-minted at page mount and refreshed after every
 *     run (TTL 3min); the click no longer waits on the remote mint. A
 *     stale-token handshake failure self-heals via the reconnect-once
 *     path, which always mints FRESH.
 *   - The honest floor stays: getUserMedia can't be pre-warmed (the mic
 *     indicator would stay lit) — hence the owner's optimistic meter.
 */

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

/** Meter tuning — the owner's tested values, see the file header. */
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;
export const METER_TICK_MS = 60;
/** The mic button's four bars: per-bar gain over the smoothed level, so
 *  one level reads as a wave shape rather than four equal bars. */
const WAVE_GAINS = [0.55, 1, 0.8, 0.45];
/** Release per tick: bars rise with the voice at once and fall back
 *  gently, so they read as speech rather than flicker. */
const WAVE_RELEASE = 0.82;

/** The Deepgram key's id in the keys store (the env-var name — the Keys
 *  section's openRow state and the PUT /api/keys/:id seam). */
export const DEEPGRAM_KEY_ID = "DEEPGRAM_API_KEY";

/** The client-authored KEYLESS line (zero-keys wave, owner 2026-09-25):
 * the token route's raw 503 message is dev-speak ("add it to auth.json
 * (desktop) or .env.local (dev)") — the surface says the short truth
 * instead. Exported for pins; the errored idle button's click recognizes
 * it and deep-links Settings → Keys → the Deepgram row. */
export const DICTATION_KEYLESS = "Dictation needs a Deepgram key";

/** A failure the user fixes in Settings → Keys (no key, or Deepgram
 *  rejected it) — the inline error offers "Fix key" for these only. */
class DictationKeyError extends Error {}

/** Mint a fresh short-lived token (the route holds the real key
 *  server-side). Module-level: the start path's warm cache and the
 *  reconnect path both bottom out here. The keyless 503 (no
 *  DEEPGRAM_API_KEY) is the route's ONLY 503 — the raw message is
 *  dev-speak, so the error becomes the short client-authored line
 *  (zero-keys wave, owner 2026-09-25). A grant Deepgram refused for the
 *  key itself comes back tagged `reason: "key-rejected"`. */
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

/** Warm-token cache (mitigation D, owner 2026-09-27): the click path takes
 *  the cached promise instead of a remote mint. TTL keeps a cached token
 *  from going stale (self-heal anyway: a rejected handshake rides the
 *  reconnect-once path with a FRESH mint); a failed mint resets the cache
 *  so the next call re-mints — the honest error path stays honest.
 *  refresh() re-mints in the background (page mount, run end); its
 *  failures are silently tolerated (a keyless pre-mint just doesn't warm). */
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
					warm = null; // failed mint: next call re-mints
					throw e;
				});
				warm = { p, at: now() };
			}
			return warm.p;
		},
		refresh: () => {
			warm = null;
			m.mint().catch(() => {}); // background best-effort
		},
	};
	return m;
}

const warmTokens = createWarmMinter(mintFreshToken);

/* Persistent capture graph (mitigation C, owner 2026-09-27): one
 * app-lifetime AudioContext + a module-load memo. Created under the
 * click gesture (autoplay policy) and NEVER closed — per-run nodes
 * (source, worklet) disconnect at teardown instead. */
let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;

function ensureAudioGraph(): { ctx: AudioContext; module: Promise<void> } {
	if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 16000 });
	if (!workletModule) {
		workletModule = sharedCtx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((e: unknown) => {
			workletModule = null; // failed load: retry next run
			throw e;
		});
	}
	return { ctx: sharedCtx, module: workletModule };
}

/** RMS (0..1) → normalized 0..1 across the audible dB window. */
export function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
	return Math.max(0, Math.min(1, t));
}

/**
 * The primary-input registry: at most ONE non-composer input can claim the
 * dictation target while mounted — the pending question's answer/thinking
 * field (question-dock.tsx). The page's `append` (the composer) is the
 * fallback when nobody claims. Module-level by design: the claimant is a
 * sibling subtree far from the hook's owner, and there is exactly one
 * window, one pending question, one target at a time.
 */
let questionTarget: { token: object; append: (text: string) => void } | null = null;

export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

export type DictationError = {
	message: string;
	/** A key problem — the inline error links to Settings → Keys. */
	fixKey: boolean;
};

/**
 * The run's shared state (owner round 4): one module store, because the
 * mics and target fields live in subtrees far from the hook's owner and
 * all of them must re-render with the run. `claimant` is the claiming
 * field's token (null = the page's composer fallback is the target).
 */
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

/** Latest RMS from the worklet, 0..1 — written by the capture graph,
 *  sampled by <DictationWave>'s own tick. Never reset mid-run (dictate
 *  pattern); zeroed at each start so a new run never shows the old level. */
const level = { current: 0 };

/* Is a dictation run live on this page? The Esc chain (keyboard wave A,
 * components/keyboard-shortcuts.tsx) needs a SYNCHRONOUS answer — the
 * stop handler can't report back through a CustomEvent. start() publishes
 * "connecting" synchronously and cleanup() publishes "idle" (every
 * terminal path runs through cleanup). */
export function isDictationActive(): boolean {
	return snapshot.phase !== "idle";
}

/** Clear the inline error without starting a run ("Fix key" leaves for
 *  Settings — the field must come back clean). */
export function clearDictationError() {
	if (snapshot.error) publish({ error: null });
}

/** Start or stop from any subtree — the same seam ⌘D uses. */
export function toggleDictation() {
	window.dispatchEvent(new CustomEvent(kbdEventForAction("toggle-dictation")));
}

/* The finisher registry: submit paths FAR from the hook's owner (the
 * pending question's dock) need finish() without a prop bridge. Same
 * module-level pattern as questionTarget — one window, one instance,
 * one finisher. Empty registry (no hook mounted) → resolve immediately. */
let dictationFinisher: (() => Promise<void>) | null = null;

/** Finish any live dictation run before continuing (see Dictation.finish). */
export function finishDictation(): Promise<void> {
	return dictationFinisher ? dictationFinisher() : Promise.resolve();
}

/** Join a dictated final onto the current text (shared separator rule). */
export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

/**
 * Claim the dictation target while mounted (and `claimed` is true).
 * Returns whether this field IS the target right now — the field outlines
 * itself and hosts the inline error while it is. The unmount guard is
 * token-based so dev-mode double-invoked effects can't clear another
 * claimant. `append` is read through a ref: finals always reach the
 * field's latest closure without re-claiming on every render.
 */
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
	/** Not idle — from the click until the stop completes (the optimistic window). */
	active: boolean;
	/** Start, or end and keep the text (the mic buttons and ⌘D). */
	toggle: () => void;
	/** End and keep the text — Esc (owner round 4: Esc no longer discards). */
	stop: () => void;
	/** FINISH, THEN CONTINUE (owner, 2026-10-01 "nothing gets lost" round):
	 *  if a run is live, stop it and resolve only when the run has fully
	 *  ended — Deepgram's last finals have landed in the target field. A
	 *  submit path awaits this before building its payload, so a learner
	 *  who forgets to stop dictation before Enter never loses the spoken
	 *  reasoning. Idle → resolves immediately (the common no-run submit
	 *  pays nothing). Every terminal path runs cleanup(), and cleanup()
	 *  resolves the waiters. */
	finish: () => Promise<void>;
};

/**
 * One dictation instance per composer-bearing page. `append` is the
 * composer fallback; the mounted question form's claim wins while a
 * question waits.
 */
export function useDictation({ append }: { append: (text: string) => void }): Dictation {
	const { phase } = useDictationState();
	/** The page's fallback append — kept fresh per render so a mid-recording
	 *  retarget (composer↔question) is honored on the very next final. */
	const appendRef = useRef(append);
	appendRef.current = append;

	// Live machinery (non-render values). The MediaStream tracks stop and
	// the per-run nodes disconnect on teardown; the socket is recreated per
	// run; the AudioContext is app-lifetime (mitigation C).
	const wsRef = useRef<WebSocket | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	/** Per-run graph nodes — the CONTEXT outlives runs (mitigation C). */
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	/** Frames captured before the socket is OPEN (mitigation A): flushed in
	 *  order on open; capped at 256 frames (≈32s) with the oldest dropped;
	 *  cleared at teardown so a dead run's audio can't leak into the next. */
	const pendingRef = useRef<ArrayBuffer[]>([]);
	const genRef = useRef(0); // stale-handler guard (dictate pattern)
	const safetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectsRef = useRef(0);
	/** Resolvers waiting for the run to fully end (finish(), owner
	 *  2026-10-01): released by cleanup() — every terminal path runs it. */
	const waitersRef = useRef<Array<() => void>>([]);

	/** One final into the primary input — question claim first, composer
	 *  fallback (owner round 4: live, as each final arrives). */
	const deliver = useCallback((text: string) => {
		(questionTarget?.append ?? appendRef.current)(text);
		window.dispatchEvent(new CustomEvent("lh:dictation-final"));
	}, []);

	/** Full teardown of one run's machinery. Idempotent; generation-guarded by callers. */
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
		// The AudioContext is app-lifetime (mitigation C) — nodes die, it stays.
		const ws = wsRef.current;
		wsRef.current = null;
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			try {
				ws.close();
			} catch {}
		}
		publish({ phase: "idle" });
		// The finish() waiters ride until NOW — post-teardown: a submit path
		// resuming after `await finishDictation()` reads the target field
		// with the dictated tail already in it.
		for (const w of waitersRef.current.splice(0)) w();
		// Pre-mint for the next run (mitigation D) — best-effort; a keyless
		// page just doesn't warm.
		warmTokens.refresh();
	}, []);

	/** End the run with an explanation (shown inline under the target field). */
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

	/** Open the Deepgram socket and wire its messages. `gen` guards staleness. */
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
				// A stop pressed while connecting stays "stopping".
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
					// Only finals stream (interim_results=false) — each lands in
					// the field now (owner round 4).
					if (msg.is_final && text) deliver(text);
				}
			});
			ws.addEventListener("close", (ev) => {
				if (gen !== genRef.current) return;
				if (ev.code === 1000) {
					// Our own CloseStream landing: finalize now — the stop path's
					// safety net stays as the no-close backstop only.
					cleanup();
					return;
				}
				// Abnormal close mid-run: ONE reconnect with a fresh token (the
				// research pass: resume is our job, no SDK to lean on).
				if (reconnectsRef.current < 1) {
					reconnectsRef.current++;
					mintFreshToken() // always FRESH — a stale warm token is the likely culprit
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
		pendingRef.current = []; // fresh run, fresh queue (mitigation A)
		const gen = ++genRef.current;

		// Mitigation D: the warm token (pre-minted at mount / after the last
		// run) resolves ~instantly; a cold/keyless mint surfaces below. The
		// mic is the long pole (macOS HAL + APM init) and gates everything —
		// the token runs concurrently with it. 127.0.0.1 is a secure
		// context, so getUserMedia works without TLS; macOS TCC prompts on
		// first use.
		const tokenPromise = warmTokens.mint();
		tokenPromise.catch(() => {}); // surfaced below; no unhandled rejection
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

			// Mitigation C: app-lifetime context + memoized worklet module —
			// per-run costs (context creation, module fetch) are gone.
			const { ctx, module } = ensureAudioGraph();
			await module;
			if (ctx.state === "suspended") await ctx.resume();
			if (gen !== genRef.current) return;

			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			workletRef.current = worklet;
			worklet.port.onmessage = (e) => {
				const msg = e.data as { type: string; rms?: number; buffer?: ArrayBuffer };
				if (msg.type === "level") {
					level.current = msg.rms ?? 0; // never reset mid-run (dictate pattern)
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
		// Mitigation B: the handshake fires the moment the graph is live,
		// overlapping any remaining token wait — mic-gated, never before it.
		openSocket(gen, token);
	}, [openSocket, fail]);

	const stop = useCallback(() => {
		const gen = genRef.current;
		if (phase !== "recording" && phase !== "connecting") return;
		publish({ phase: "stopping" });

		// Mic dies FIRST — no more audio enqueues (dictate pattern). The
		// per-run nodes die with it; the AudioContext stays (mitigation C).
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
			// "stopping" is already ending — the waiter just rides to cleanup.
			if (phase === "recording" || phase === "connecting") stop();
		});
	}, [phase, stop]);

	// Publish finish() for the sibling subtrees (the pending question's
	// dock) — registered for as long as this page owns the hook.
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

	// Shortcut seams (keyboard wave A): ⌘D toggles from anywhere on the
	// page; the Esc chain lands here as a STOP (owner round 4). Each page
	// owns ONE hook instance, and only the mounted page's listener is
	// attached.
	useEffect(() => {
		warmTokens.refresh(); // pre-mint at mount (mitigation D) — silent if keyless
		// The run state is module-wide: leaving the page ends its run and
		// clears its error, so the next page starts clean.
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

/**
 * The mic's live bars (owner round 4): four bars driven by the real input
 * level on their own 60ms tick (only this span repaints). Flat and dimmed
 * while connecting, so "connecting" and "listening" look different.
 */
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

/**
 * A field's own mic (owner round 4: the question card's mic and the
 * fields that used to carry a decorative icon). `own` — this field is the
 * current target — lights it and shows the live bars.
 */
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

/**
 * The inline failure line under the target field (owner round 4). `show`
 * is the field's "I am the target" — exactly one field hosts it. Key
 * problems (no key, or Deepgram refused it) link to Settings → Keys →
 * the Deepgram row; the error clears on that click or the next start.
 */
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
