import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DAILY_GOAL_MAX, DAILY_GOAL_MIN, FACTORY_SETTINGS, resolveSettings, sanitizeUserSettings } from "../src/core/index.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";

describe("general.dailyGoalMinutes", () => {
	it("factory 30, bounds 5..240", () => {
		assert.equal(FACTORY_SETTINGS.general.dailyGoalMinutes, 30);
		assert.equal(DAILY_GOAL_MIN, 5);
		assert.equal(DAILY_GOAL_MAX, 240);
	});

	it("resolves absent → 30, explicit wins", () => {
		assert.equal(resolveSettings(null).general.dailyGoalMinutes, 30);
		assert.equal(resolveSettings({ version: 1, general: { dailyGoalMinutes: 45 } }).general.dailyGoalMinutes, 45);
	});

	it("the sanitizer clamps and rounds; junk drops", () => {
		const s = (v: unknown) => sanitizeUserSettings({ version: 1, general: { dailyGoalMinutes: v } })!.general!.dailyGoalMinutes;
		assert.equal(s(1), 5);
		assert.equal(s(999), 240);
		assert.equal(s(44.6), 45);
		assert.equal(s("30"), undefined);
		assert.equal(s(Number.NaN), undefined);
	});

	it("the PUT parser is strict: integer in range or 400", () => {
		const ok = parseGeneralSettingsBody({ dailyGoalMinutes: 60 });
		assert.ok(ok.ok);
		assert.deepEqual(ok.settings, { dailyGoalMinutes: 60 });
		for (const bad of [4, 241, 30.5, "30", null]) {
			assert.equal(parseGeneralSettingsBody({ dailyGoalMinutes: bad }).ok, false, String(bad));
		}
	});
});
