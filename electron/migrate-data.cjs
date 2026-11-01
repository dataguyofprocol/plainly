"use strict";

// Electron creates userData before main.cjs runs (measured: the folder exists
// at module load), so "target missing" can't be the trigger. The target
// counts as fresh while it holds neither data/ nor auth.json; those two are
// moved in LAST, so a crash mid-copy leaves a target that is still fresh and
// the next launch finishes the job.

const fs = require("node:fs");
const path = require("node:path");

const LEGACY_NAME = "LearnHarness";

// Chromium's per-process lock files (must never be shared between apps) and
// caches it rebuilds on its own.
const SKIP = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket", "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Crashpad"]);
const LAST = ["data", "auth.json"];

function legacyUserData(target) {
	const suffix = path.basename(target).endsWith("-dev") ? "-dev" : "";
	return path.join(path.dirname(target), `${LEGACY_NAME}${suffix}`);
}

/** @returns {"no-source" | "already" | "copied"} — throws on I/O failure. */
function migrateUserData(target, source = legacyUserData(target)) {
	if (!fs.existsSync(source)) return "no-source";
	if (LAST.some((name) => fs.existsSync(path.join(target, name)))) return "already";
	const staging = `${target}.migrating`;
	fs.rmSync(staging, { recursive: true, force: true });
	fs.cpSync(source, staging, {
		recursive: true,
		preserveTimestamps: true,
		filter: (src) => path.dirname(src) !== source || !SKIP.has(path.basename(src)),
	});
	fs.mkdirSync(target, { recursive: true });
	const names = fs.readdirSync(staging).sort((a, b) => LAST.indexOf(a) - LAST.indexOf(b));
	for (const name of names) {
		const to = path.join(target, name);
		if (!fs.existsSync(to)) fs.renameSync(path.join(staging, name), to);
	}
	fs.rmSync(staging, { recursive: true, force: true });
	return "copied";
}

module.exports = { migrateUserData, legacyUserData, LEGACY_NAME };
