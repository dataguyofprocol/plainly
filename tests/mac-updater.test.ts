import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createMacUpdater, parseFeed, isNewer, feedBaseFromAppUpdate, bundleOf } = require("../electron/mac-updater.cjs");

const FEED = `version: 0.2.0
files:
  - url: Plainly-0.2.0-arm64-mac.zip
    sha512: abc==
    size: 1234
path: Plainly-0.2.0-arm64-mac.zip
sha512: abc==
releaseDate: '2026-10-27T09:17:22.675Z'
`;

test("parseFeed reads the version and the zip entry", () => {
	assert.deepEqual(parseFeed(FEED), { version: "0.2.0", zip: { url: "Plainly-0.2.0-arm64-mac.zip", sha512: "abc==", size: 1234 } });
	assert.equal(parseFeed(FEED.replace("version: 0.2.0", "version: '0.2.0'")).version, "0.2.0");
});

test("parseFeed refuses feeds without a zip, and zip urls that leave the feed's folder", () => {
	assert.throws(() => parseFeed("version: 0.2.0\nfiles:\n  - url: x.dmg\n    sha512: a\n    size: 1\n"));
	assert.throws(() => parseFeed(FEED.replace("url: Plainly", "url: ../Plainly")));
	assert.throws(() => parseFeed(FEED.replace("url: Plainly", "url: https://evil.example/Plainly")));
});

test("isNewer orders x.y.z and prereleases", () => {
	assert.equal(isNewer("0.2.0", "0.1.0"), true);
	assert.equal(isNewer("0.1.10", "0.1.9"), true);
	assert.equal(isNewer("0.1.0", "0.1.0"), false);
	assert.equal(isNewer("0.1.0", "0.2.0"), false);
	assert.equal(isNewer("1.0.0", "1.0.0-beta"), true);
	assert.equal(isNewer("1.0.0-beta", "1.0.0"), false);
});

test("feedBaseFromAppUpdate builds the latest-release URL", () => {
	assert.equal(
		feedBaseFromAppUpdate("owner: dataguyofprocol\nrepo: plainly\nprovider: github\n"),
		"https://github.com/dataguyofprocol/plainly/releases/latest/download/",
	);
	assert.throws(() => feedBaseFromAppUpdate("provider: github\n"));
});

test("bundleOf walks from the executable to the .app", () => {
	assert.equal(bundleOf("/Applications/Plainly.app/Contents/MacOS/Plainly"), "/Applications/Plainly.app");
});

const mac = { skip: process.platform !== "darwin" };

function fakeApp(dir: string, version: string, id = "app.plainly.Plainly") {
	const app = path.join(dir, "Plainly.app");
	fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
	fs.copyFileSync("/usr/bin/true", path.join(app, "Contents", "MacOS", "Plainly"));
	fs.writeFileSync(
		path.join(app, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Plainly</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
	);
	execFileSync("/usr/bin/codesign", ["--force", "-s", "-", app], { stdio: "ignore" });
	return app;
}

async function feedServer(root: string, version: string, opts: { id?: string; corrupt?: boolean } = {}) {
	const build = path.join(root, `build-${version}`);
	fs.mkdirSync(build, { recursive: true });
	const app = fakeApp(build, version, opts.id);
	const zipName = `Plainly-${version}-arm64-mac.zip`;
	const zip = path.join(build, zipName);
	execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
	const bytes = fs.readFileSync(zip);
	const sha512 = createHash("sha512").update(opts.corrupt ? "nope" : bytes).digest("base64");
	const yml = `version: ${version}\nfiles:\n  - url: ${zipName}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${zipName}\n`;
	const server = http.createServer((req, res) => {
		if (req.url === "/latest-mac.yml") res.end(yml);
		else if (req.url === `/${zipName}`) res.end(bytes);
		else res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	return { base: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

function sandbox() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plainly-update-"));
	const installed = fakeApp(path.join(root, "Applications"), "0.1.0");
	return { root, installed, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function updater(s: ReturnType<typeof sandbox>, base: string, onStaged: (v: string) => void = () => {}) {
	return createMacUpdater({
		currentVersion: "0.1.0",
		bundleId: "app.plainly.Plainly",
		appBundle: s.installed,
		feedBase: base,
		workDir: path.join(s.root, "updates"),
		fetch,
		log: () => {},
		onStaged,
	});
}

const version = (app: string) =>
	execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(app, "Contents", "Info.plist")]).toString().trim();

test("stages a newer version, then swaps it in after the waited-for process exits", mac, async () => {
	const s = sandbox();
	const feed = await feedServer(s.root, "0.2.0");
	try {
		let resolveStaged: (v: string) => void;
		const stagedP = new Promise<string>((r) => (resolveStaged = r));
		const u = updater(s, feed.base, (v) => resolveStaged(v));
		assert.equal(await u.check(), "0.2.0");
		assert.equal(await stagedP, "0.2.0");
		assert.equal(u.staged, "0.2.0");
		assert.equal(await u.check(), "0.2.0", "a staged version is not downloaded again");

		const standIn = spawn("/bin/sleep", ["0.5"]);
		assert.equal(u.applyOnExit({ pid: standIn.pid }), true);
		assert.equal(version(s.installed), "0.1.0", "nothing moves while the process lives");
		await new Promise((r) => standIn.on("exit", r));
		for (let i = 0; i < 50 && version(s.installed) !== "0.2.0"; i++) await new Promise((r) => setTimeout(r, 100));
		assert.equal(version(s.installed), "0.2.0");
		assert.equal(fs.existsSync(`${s.installed}.plainly-old`), false);
		execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", s.installed]);
	} finally {
		feed.close();
		s.done();
	}
});

test("up to date → null, nothing staged, applyOnExit is a no-op", mac, async () => {
	const s = sandbox();
	const feed = await feedServer(s.root, "0.1.0");
	try {
		const u = updater(s, feed.base);
		assert.equal(await u.check(), null);
		assert.equal(u.applyOnExit(), false);
	} finally {
		feed.close();
		s.done();
	}
});

for (const [name, opts] of [["a sha512 mismatch", { corrupt: true }], ["a foreign bundle id", { id: "com.example.Other" }]] as const) {
	test(`refuses to stage ${name}`, mac, async () => {
		const s = sandbox();
		const feed = await feedServer(s.root, "0.2.0", opts);
		try {
			const lines: string[] = [];
			const u = createMacUpdater({
				currentVersion: "0.1.0",
				bundleId: "app.plainly.Plainly",
				appBundle: s.installed,
				feedBase: feed.base,
				workDir: path.join(s.root, "updates"),
				fetch,
				log: (l: string) => lines.push(l),
				onStaged: () => assert.fail("must not stage"),
			});
			await u.check();
			for (let i = 0; i < 50 && !lines.some((l) => l.includes("download failed")); i++) await new Promise((r) => setTimeout(r, 100));
			assert.ok(lines.some((l) => l.includes("download failed")), lines.join("\n"));
			assert.equal(u.staged, null);
			assert.equal(u.applyOnExit(), false);
		} finally {
			feed.close();
			s.done();
		}
	});
}
