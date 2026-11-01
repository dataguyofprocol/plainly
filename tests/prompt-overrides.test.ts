import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-prompt-overrides-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { PROMPTS_OVERRIDE_DIR } = await import("../config.ts");
const teacherAgent = await import("../src/agent/teacher-agent.ts");
const { allSegmentPaths, effectivePromptSegments } = await import("../src/agent/prompt-segments.ts");
const { isValidSegmentPath } = await import("../src/core/prompt-segments.ts");
const { promptOverrides } = await import("../src/store/prompt-overrides.ts");
const { PUT: putSettingsSection } = await import("../app/api/settings/[section]/route.ts");
const { DELETE: deletePromptText } = await import("../app/api/settings/prompts/[...segment]/route.ts");
const { readSettingsRecord } = await import("../src/server/index.ts");

const REPO_PROMPTS = path.resolve(import.meta.dirname, "../data/prompts");

function snapshotDir(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (rel: string) => {
		for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(child);
			else out.push(`${child}|${fs.statSync(path.join(dir, child)).size}`);
		}
	};
	walk("");
	return out;
}
const REAL_PROMPTS_BEFORE = snapshotDir(REPO_PROMPTS);

after(() => {
	assert.deepEqual(
		snapshotDir(REPO_PROMPTS),
		REAL_PROMPTS_BEFORE,
		"real data/prompts survives npm test byte-for-byte (the old suite wiped it)",
	);
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function putSection(section: string, body: unknown): Promise<Response> {
	return putSettingsSection(
		new Request(`http://test/api/settings/${section}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ section }) },
	);
}

function deleteSegment(segment: string[]): Promise<Response> {
	return deletePromptText(new Request("http://test/api/settings/prompts", { method: "DELETE" }), {
		params: Promise.resolve({ segment }),
	});
}

describe("isValidSegmentPath (the mirror-layout discipline)", () => {
	it("accepts the shared base and numeric fragments, rejects everything else", () => {
		assert.equal(isValidSegmentPath("system-prompt.md"), true);
		assert.equal(isValidSegmentPath("teacher/20-teaching.md"), true);
		assert.equal(isValidSegmentPath("prober/10-probe-doctrine.md"), true);
		assert.equal(isValidSegmentPath("shared/10-personality.md"), true);
		for (const bad of [
			"",
			"README.md",
			"teacher/README.md",
			"teacher/20-teaching.txt",
			"../system-prompt.md",
			"agent/../teacher/20-teaching.md",
			"/etc/passwd",
			"teacher",
			"teacher/",
			"teacher/sub/10-x.md",
			"prober\\10-x.md",
		]) {
			assert.equal(isValidSegmentPath(bad), false, bad);
		}
	});
});

describe("the override store", () => {
	it("listOverrides is empty with no dir, then lists written mirrors sorted", () => {
		fs.rmSync(PROMPTS_OVERRIDE_DIR, { recursive: true, force: true });
		assert.deepEqual(promptOverrides.listOverrides(), []);
		promptOverrides.writeOverride("teacher/20-teaching.md", "custom teaching");
		promptOverrides.writeOverride("system-prompt.md", "custom base");
		assert.deepEqual(promptOverrides.listOverrides(), ["system-prompt.md", "teacher/20-teaching.md"]);
	});

	it("readOverride round-trips; delete removes idempotently; invalid paths no-op", () => {
		promptOverrides.writeOverride("prober/30-probe-done.md", "custom probe-done");
		assert.equal(promptOverrides.readOverride("prober/30-probe-done.md"), "custom probe-done");
		promptOverrides.deleteOverride("prober/30-probe-done.md");
		assert.equal(promptOverrides.readOverride("prober/30-probe-done.md"), null);
		promptOverrides.deleteOverride("prober/30-probe-done.md");
		promptOverrides.writeOverride("../evil.md", "nope");
		assert.equal(fs.existsSync(path.join(PROMPTS_OVERRIDE_DIR, "..", "evil.md")), false);
	});

	it("switches are NOT the store's concern — files alone never enable", () => {
		promptOverrides.writeOverride("system-prompt.md", "custom base");
		const off = effectivePromptSegments("teacher", {})
			.find((s) => s.path === "system-prompt.md");
		assert.ok(off);
		assert.equal(off.overrideText, "custom base");
		assert.equal(off.enabled, false);
		promptOverrides.deleteOverride("system-prompt.md");
	});
});

describe("the source-derived segment list", () => {
	it("mirrors composeInstructions' discovery: base first, numeric fragments sorted, per agent", () => {
		const prober = effectivePromptSegments("prober", {});
		const teacher = effectivePromptSegments("teacher", {});
		assert.equal(prober[0]?.path, "system-prompt.md");
		assert.equal(teacher[0]?.path, "system-prompt.md");
		assert.equal(prober[0].shared, true);
		assert.equal(teacher[0].shared, true);
		assert.equal(prober[0].sourceText.length > 0, true, "base prompt text loads");
		assert.deepEqual(
			prober.map((s) => s.path),
			[
				"system-prompt.md",
				"prober/10-probe-doctrine.md",
				"shared/10-voice.md",
				"shared/15-accuracy.md",
				"shared/16-mental-model.md",
				"shared/20-question-tools.md",
				"shared/25-confidence.md",
				"shared/30-learner-files.md",
				"shared/40-formatting.md",
			],
		);
		assert.equal(teacher.some((s) => s.path === "teacher/05-method.md"), true);
		assert.equal(teacher.some((s) => s.path === "teacher/10-planning.md"), true);
		assert.equal(teacher.some((s) => s.path === "teacher/60-probing-in-brief.md"), false);
		assert.equal(
			teacher.every(
				(s) => s.path === "system-prompt.md" || s.path.startsWith("teacher/") || s.path.startsWith("shared/"),
			),
			true,
		);
		assert.equal(teacher.some((s) => s.path === "shared/30-learner-files.md" && s.shared), true);
		assert.equal(prober.some((s) => s.path === "shared/30-learner-files.md" && s.shared), true);
		assert.equal(prober.some((s) => s.path === "shared/10-voice.md" && s.shared), true);
		assert.equal(teacher.some((s) => s.path === "shared/10-voice.md" && s.shared), true);
		assert.equal(prober.some((s) => s.path === "shared/15-accuracy.md" && s.shared), true);
		assert.equal(prober.some((s) => s.path.startsWith("teacher/")), false);
		assert.equal(teacher.some((s) => s.path.startsWith("prober/")), false);
		assert.equal(allSegmentPaths().some((p) => p.includes("README")), false);
	});

	it("effective segments: switch+file → override; either missing → source text", () => {
		promptOverrides.writeOverride("teacher/20-teaching.md", "MY WAY");
		const switches = { "teacher/20-teaching.md": true, "system-prompt.md": false };
		const teacher = effectivePromptSegments("teacher", switches);
		const teaching = teacher.find((s) => s.path === "teacher/20-teaching.md");
		assert.ok(teaching);
		assert.equal(teaching.overrideText, "MY WAY");
		assert.equal(teaching.enabled, true);
		const base = teacher.find((s) => s.path === "system-prompt.md");
		assert.ok(base);
		assert.equal(base.overrideText, null);
		assert.equal(base.enabled, false);
		const weird = effectivePromptSegments("teacher", { "teacher/10-planning.md": true });
		const planning = weird.find((s) => s.path === "teacher/10-planning.md");
		assert.ok(planning);
		assert.equal(planning.enabled, false);
		assert.equal(planning.overrideText, null);
	});

	it("adapts to source changes by construction: the list is computed, not stored", () => {
		const before = allSegmentPaths().length;
		assert.equal(before > 5, true, "base + prober fragments + teacher fragments");
	});
});

describe("composeInstructions: override honoring + the byte-identical source path", () => {
	const { composeInstructions, createTeacherAgent } = teacherAgent;

	it("switches-less composition is byte-identical to the pre-refactor loader", () => {
		const oldLoader = (kind: "prober" | "teacher") => {
			const fragmentsOf = (dir: string) =>
				fs
					.readdirSync(dir)
					.filter((f) => /^\d+-[\w.-]+\.md$/.test(f))
					.sort()
					.map((f) => fs.readFileSync(path.join(dir, f), "utf-8").trim())
					.filter(Boolean);
			const base = fs.readFileSync("src/agent/system-prompt.md", "utf-8").trim();
			return [
				base,
				...fragmentsOf(`src/agent/prompts/${kind}`),
				...fragmentsOf("src/agent/prompts/shared"),
			].join("\n\n---\n\n");
		};
		assert.equal(composeInstructions("teacher"), oldLoader("teacher"));
		assert.equal(composeInstructions("prober"), oldLoader("prober"));
	});

	it("an enabled override swaps in; switch off or file absent composes source", () => {
		promptOverrides.writeOverride("teacher/20-teaching.md", "CUSTOM TEACHING LOOP");
		try {
			const on = composeInstructions("teacher", { "teacher/20-teaching.md": true });
			assert.ok(on.includes("CUSTOM TEACHING LOOP"), "override composes when switch on");
			assert.ok(!on.includes("# Teach — one step at a time"), "source text is replaced");
			const off = composeInstructions("teacher", {});
			assert.ok(off.includes("# Teach — one step at a time"), "source composes when switch off");
			const noFile = composeInstructions("teacher", { "teacher/10-planning.md": true });
			assert.ok(noFile.includes("# Planning"), "file absent → source default");
		} finally {
			promptOverrides.deleteOverride("teacher/20-teaching.md");
		}
	});

	it("shared/ fragments are overridable — one edit swaps the doctrine in BOTH agents", () => {
		promptOverrides.writeOverride("shared/30-learner-files.md", "MY SHARED FILES DOCTRINE");
		try {
			const switches = { "shared/30-learner-files.md": true };
			for (const kind of ["teacher", "prober"] as const) {
				const composed = composeInstructions(kind, switches);
				assert.ok(composed.includes("MY SHARED FILES DOCTRINE"), `${kind} composes the override`);
				assert.ok(!composed.includes("## Learner files"), `${kind} source fragment is replaced`);
			}
			assert.ok(composeInstructions("teacher").includes("## Learner files"));
		} finally {
			promptOverrides.deleteOverride("shared/30-learner-files.md");
		}
	});

	it("promptSwitches threads through agent construction into the system prompt", () => {
		promptOverrides.writeOverride("system-prompt.md", "TOTALLY CUSTOM BASE");
		try {
			const engine = fauxEngine();
			const agent = createTeacherAgent(undefined, { engine, promptSwitches: { "system-prompt.md": true } });
			assert.ok(agent.state.systemPrompt.includes("TOTALLY CUSTOM BASE"));
			const source = createTeacherAgent(undefined, { engine });
			assert.ok(!source.state.systemPrompt.includes("TOTALLY CUSTOM BASE"), "no switches → cached source");
		} finally {
			promptOverrides.deleteOverride("system-prompt.md");
		}
	});
});

describe("delete clears the switch — the record and file agree by construction", () => {
	const SEGMENT = "teacher/20-teaching.md";

	it("DELETE removes the file AND clears the on-switch in one operation", async () => {
		promptOverrides.writeOverride(SEGMENT, "custom teaching");
		const on = await putSection("agent", { prompts: { [SEGMENT]: true } });
		assert.equal(on.status, 200, "ON with a real file is valid");
		assert.equal(readSettingsRecord()?.agent?.prompts?.[SEGMENT], true, "switch landed in the record");

		const res = await deleteSegment(["teacher", "20-teaching.md"]);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { deleted: boolean; switchCleared: boolean };
		assert.deepEqual(body, { path: SEGMENT, deleted: true, switchCleared: true }, "the response names what happened");

		assert.equal(readSettingsRecord()?.agent?.prompts?.[SEGMENT], undefined, "the switch is GONE from the record");
		assert.equal(promptOverrides.readOverride(SEGMENT), null, "the file is gone");
		const followUp = await putSection("agent", { tools: { research: false } });
		assert.equal(followUp.status, 200, "a subsequent agent write succeeds");
		assert.equal(readSettingsRecord()?.agent?.tools?.research, false);
	});

	it("DELETE is idempotent for file and switch — nothing to clear, still 200", async () => {
		const res = await deleteSegment(["teacher", "20-teaching.md"]);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { switchCleared: boolean };
		assert.equal(body.switchCleared, false, "no switch was present — nothing cleared");
	});
});

describe("an orphaned ON heals to OFF on write — never a 400 (the invariant: a user can never get stuck)", () => {
	const SEGMENT = "teacher/20-teaching.md";

	it("the exact repro: file wiped at disk level → UI mirrors the orphan and flips a tool toggle → the write SUCCEEDS and heals", async () => {
		promptOverrides.writeOverride(SEGMENT, "custom teaching");
		const on = await putSection("agent", { prompts: { [SEGMENT]: true } });
		assert.equal(on.status, 200);

		fs.rmSync(path.join(PROMPTS_OVERRIDE_DIR, "teacher", "20-teaching.md"));

		const res = await putSection("agent", { tools: { research: false }, prompts: { [SEGMENT]: true } });
		assert.equal(res.status, 200, "the write heals instead of 400-ing — the user is never stuck");

		const record = readSettingsRecord();
		assert.equal(record?.agent?.prompts?.[SEGMENT], undefined, "the orphaned ON landed as OFF (key dropped)");
		assert.equal(record?.agent?.tools?.research, false, "the rest of the write landed — nothing was silently dropped");

		const again = await putSection("agent", { tools: { research: false }, prompts: { [SEGMENT]: true } });
		assert.equal(again.status, 200, "repeated writes keep succeeding");
	});

	it("an ON for a segment that left the source tree heals the same way", async () => {
		promptOverrides.writeOverride(SEGMENT, "custom teaching");
		const on = await putSection("agent", { prompts: { "teacher/99-vanished.md": true, [SEGMENT]: true } });
		assert.equal(on.status, 200, "vanished-fragment ON heals too, not a 400");
		assert.equal(readSettingsRecord()?.agent?.prompts?.["teacher/99-vanished.md"], undefined, "the vanished key healed to OFF");
		promptOverrides.deleteOverride(SEGMENT);
	});

	it("a VALID ON (file present) stays valid — no heal, no 400", async () => {
		promptOverrides.writeOverride(SEGMENT, "custom teaching");
		try {
			const res = await putSection("agent", { prompts: { [SEGMENT]: true } });
			assert.equal(res.status, 200);
			const record = (await res.json()) as { settings: { agent?: { prompts?: Record<string, boolean> } } };
			assert.equal(record.settings.agent?.prompts?.[SEGMENT], true, "a real ON+file write keeps the switch on");
		} finally {
			promptOverrides.deleteOverride(SEGMENT);
		}
	});
});

describe("test isolation (the suite must never touch real user data)", () => {
	it("every write this suite makes lands under the LH_DATA_DIR seam, not the repo data dir", () => {
		assert.ok(
			PROMPTS_OVERRIDE_DIR.startsWith(TMP_DATA),
			`PROMPTS_OVERRIDE_DIR (${PROMPTS_OVERRIDE_DIR}) must live under the temp seam (${TMP_DATA})`,
		);
		assert.notEqual(
			PROMPTS_OVERRIDE_DIR,
			REPO_PROMPTS,
			"the seam must NOT resolve to the repo's real data/prompts",
		);
		promptOverrides.writeOverride("system-prompt.md", "isolation probe");
		assert.equal(
			fs.existsSync(path.join(TMP_DATA, "prompts", "system-prompt.md")),
			true,
			"the write landed under the temp dir",
		);
		promptOverrides.deleteOverride("system-prompt.md");
	});
});
