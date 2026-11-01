import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const realWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window: unknown }).window = new EventTarget();

const {
	SETTINGS_SAVED_EVENT,
	notifySettingsSaved,
	onSettingsSaved,
} = await import("../components/settings-signal.ts");

afterEach(() => {
	(globalThis as { window: unknown }).window = realWindow ?? new EventTarget();
});

describe("settings-signal — the seam's contract", () => {
	it("a writer's notify reaches a reader with the section", () => {
		const got: string[] = [];
		const off = onSettingsSaved((section) => got.push(section));
		notifySettingsSaved("models");
		assert.deepEqual(got, ["models"]);
		off();
	});

	it("unsubscribe stops delivery (a reader unmounting never leaks)", () => {
		const got: string[] = [];
		const off = onSettingsSaved((section) => got.push(section));
		off();
		notifySettingsSaved("models");
		assert.deepEqual(got, []);
	});

	it("readers filter their own section — general doesn't reach a models reader", () => {
		const got: string[] = [];
		const off = onSettingsSaved((s) => {
			if (s === "models") got.push(s);
		});
		notifySettingsSaved("general");
		notifySettingsSaved("appearance");
		assert.deepEqual(got, []);
		notifySettingsSaved("models");
		assert.deepEqual(got, ["models"]);
		off();
	});

	it("a foreign CustomEvent on the same name with no section detail is ignored", () => {
		const got: string[] = [];
		const off = onSettingsSaved((section) => got.push(section));
		globalThis.window.dispatchEvent(
			new CustomEvent(SETTINGS_SAVED_EVENT, { detail: undefined }),
		);
		assert.deepEqual(got, []);
		off();
	});
});
