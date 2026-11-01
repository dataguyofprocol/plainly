import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { migrateUserData, legacyUserData } = require("../electron/migrate-data.cjs");

function sandbox() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plainly-migrate-"));
	const source = path.join(root, "LearnHarness");
	const target = path.join(root, "Plainly");
	return { root, source, target, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function seedSource(source: string) {
	fs.mkdirSync(path.join(source, "data", "chats"), { recursive: true });
	fs.writeFileSync(path.join(source, "data", "chats", "c1.json"), "{}");
	fs.writeFileSync(path.join(source, "auth.json"), "{\"K\":\"v\"}", { mode: 0o600 });
	fs.mkdirSync(path.join(source, "Local Storage"));
	fs.writeFileSync(path.join(source, "Local Storage", "x"), "ls");
	fs.mkdirSync(path.join(source, "Code Cache"));
	fs.writeFileSync(path.join(source, "SingletonCookie"), "lock");
}

const snapshot = (dir: string): string[] =>
	fs.readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort();

test("legacyUserData maps packaged and dev folders", () => {
	assert.equal(legacyUserData("/a/Plainly"), path.join("/a", "LearnHarness"));
	assert.equal(legacyUserData("/a/Plainly-dev"), path.join("/a", "LearnHarness-dev"));
});

test("copies a LearnHarness folder into an empty Plainly folder, leaving the source untouched", () => {
	const s = sandbox();
	try {
		seedSource(s.source);
		const before = snapshot(s.source);
		fs.mkdirSync(s.target); // Electron creates userData before main.cjs runs
		assert.equal(migrateUserData(s.target, s.source), "copied");
		assert.equal(fs.readFileSync(path.join(s.target, "data", "chats", "c1.json"), "utf8"), "{}");
		assert.equal(fs.readFileSync(path.join(s.target, "Local Storage", "x"), "utf8"), "ls");
		assert.equal(fs.statSync(path.join(s.target, "auth.json")).mode & 0o777, 0o600);
		assert.equal(fs.existsSync(path.join(s.target, "SingletonCookie")), false);
		assert.equal(fs.existsSync(path.join(s.target, "Code Cache")), false);
		assert.equal(fs.existsSync(`${s.target}.migrating`), false);
		assert.deepEqual(snapshot(s.source), before);
	} finally {
		s.done();
	}
});

test("does nothing when Plainly already has data", () => {
	const s = sandbox();
	try {
		seedSource(s.source);
		fs.mkdirSync(path.join(s.target, "data"), { recursive: true });
		assert.equal(migrateUserData(s.target, s.source), "already");
		assert.deepEqual(snapshot(s.target), ["data"]);
	} finally {
		s.done();
	}
});

test("does nothing when Plainly already has keys but no data", () => {
	const s = sandbox();
	try {
		seedSource(s.source);
		fs.mkdirSync(s.target);
		fs.writeFileSync(path.join(s.target, "auth.json"), "{}");
		assert.equal(migrateUserData(s.target, s.source), "already");
		assert.equal(fs.readFileSync(path.join(s.target, "auth.json"), "utf8"), "{}");
	} finally {
		s.done();
	}
});

test("does nothing when there is no LearnHarness folder", () => {
	const s = sandbox();
	try {
		assert.equal(migrateUserData(s.target, s.source), "no-source");
		assert.equal(fs.existsSync(s.target), false);
	} finally {
		s.done();
	}
});

test("a failed earlier run is cleaned up and finished", () => {
	const s = sandbox();
	try {
		seedSource(s.source);
		fs.mkdirSync(path.join(`${s.target}.migrating`, "junk"), { recursive: true });
		fs.mkdirSync(path.join(s.target, "Local Storage"), { recursive: true });
		fs.writeFileSync(path.join(s.target, "Local Storage", "x"), "ls");
		assert.equal(migrateUserData(s.target, s.source), "copied");
		assert.equal(fs.existsSync(path.join(s.target, "data", "chats", "c1.json")), true);
		assert.equal(fs.existsSync(path.join(s.target, "auth.json")), true);
		assert.equal(fs.existsSync(path.join(s.target, "junk")), false);
		assert.equal(fs.existsSync(`${s.target}.migrating`), false);
	} finally {
		s.done();
	}
});
