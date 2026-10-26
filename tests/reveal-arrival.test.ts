import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { revealArrival } from "../components/lesson-panel.tsx";

/**
 * Teach-question arrival states (owner ruling, scroll-honesty round
 * 2026-09-25). Applied DURING RENDER before the first paint — the bug was
 * the stale expanded=true left by the previous question painting one
 * frame of the open question: the dock measured itself tall, reserved that
 * height permanently (fold immunity refused the give-back), and the
 * transcript scrolled as if the collapsed question had opened.
 */
/**
 * The geometry-mute's growth rule (flicker round, 2026-09-26): reserve
 * GROWTH while a question is pending is the dock stretching itself (the
 * dictation flush landing many dictated lines at once, reproduced d≈152 >
 * COLLAPSE_DIST) — the spacer's scroll catch-up must not read as the
 * learner leaving. Shrinks are the fold's own give-back and never stamp.
 */
describe("revealArrival — how a teach question lands", () => {
	it("fresh arrival after the composer: collapsed behind the reveal button", () => {
		assert.deepEqual(revealArrival(false), { expanded: false, revealed: false });
	});

	it("queued behind another question: open — the reading already happened", () => {
		assert.deepEqual(revealArrival(true), { expanded: true, revealed: true });
	});
});

/**
 * Probe-question arrival state (flicker round, 2026-09-26): open iff the
 * learner is following at the bottom; scrolled up in history → arrive as
 * the collapsed bar, decided DURING RENDER (the old after-paint effect
 * painted one stale-open frame first).
 */
