"use strict";

// macOS updater. Plainly is ad-hoc signed, and
// Squirrel.Mac (electron-updater's macOS path) only installs an update whose
// signature satisfies the running app's designated requirement. An ad-hoc
// requirement is the build's own cdhash, so every new build fails it. This
// module replaces Squirrel on macOS; Windows/Linux stay on electron-updater.
// Quarantine: files this app downloads are not quarantined (only browsers
// and other LSFileQuarantineEnabled apps set the flag), and the install
// script uses curl, which doesn't either. The xattr strip below is a guard.

const { execFile, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { promisify } = require("node:util");

const run = promisify(execFile);

/** Feed base URL from the baked app-update.yml (electron-builder's publish
 *  config): "owner: x" / "repo: y" lines → GitHub's latest-release URL. */
function feedBaseFromAppUpdate(text) {
	const field = (name) => text.match(new RegExp(`^${name}:\\s*(\\S+)\\s*$`, "m"))?.[1];
	const owner = field("owner");
	const repo = field("repo");
	if (!owner || !repo) throw new Error("app-update.yml has no owner/repo");
	return `https://github.com/${owner}/${repo}/releases/latest/download/`;
}

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, "$2");

/** latest-mac.yml → { version, zip: { url, sha512, size } }. Only the shape
 *  electron-builder writes: a top-level version and a files: list. The zip
 *  entry is the first file whose url ends in .zip. */
function parseFeed(text) {
	let version = null;
	const files = [];
	let inFiles = false;
	for (const line of text.split(/\r?\n/)) {
		const top = line.match(/^(\w+):\s*(.*)$/);
		if (top) {
			inFiles = top[1] === "files";
			if (top[1] === "version") version = unquote(top[2]);
			continue;
		}
		if (!inFiles) continue;
		const entry = line.match(/^\s*(-\s+)?(\w+):\s*(.*)$/);
		if (!entry) continue;
		if (entry[1]) files.push({});
		const file = files[files.length - 1];
		if (file) file[entry[2]] = unquote(entry[3]);
	}
	const zip = files.find((f) => f.url?.endsWith(".zip"));
	if (!version || !zip?.sha512 || !zip.size) throw new Error("latest-mac.yml has no version or zip entry");
	if (zip.url !== path.basename(zip.url) || zip.url.includes("..")) throw new Error(`latest-mac.yml zip url is not a bare file name: ${zip.url}`);
	return { version, zip: { url: zip.url, sha512: zip.sha512, size: Number(zip.size) } };
}

function isNewer(a, b) {
	const split = (v) => {
		const [core, pre] = String(v).split("-", 2);
		return { parts: core.split(".").map((n) => Number(n) || 0), pre: pre ?? null };
	};
	const x = split(a);
	const y = split(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
		if (d) return d > 0;
	}
	if (x.pre === y.pre) return false;
	if (x.pre === null) return true;
	if (y.pre === null) return false;
	return x.pre > y.pre;
}

function bundleOf(execPath) {
	return path.resolve(execPath, "..", "..", "..");
}

const SWAP_SCRIPT = `
pid="$1"; new="$2"; target="$3"; relaunch="$4"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
old="$target.plainly-old"
rm -rf "$old"
mv "$target" "$old" || exit 1
if mv "$new" "$target"; then rm -rf "$old"; else mv "$old" "$target"; fi
if [ "$relaunch" = 1 ]; then open "$target"; fi
`;

/**
 * @param {object} o
 * @param {string} o.currentVersion   running app's version
 * @param {string} o.bundleId         running app's CFBundleIdentifier
 * @param {string} o.appBundle        installed .app to replace
 * @param {string} o.feedBase         URL ending in "/" that serves latest-mac.yml + the zip
 * @param {string} o.workDir          scratch dir for downloads/staging (wiped on create)
 * @param {typeof fetch} o.fetch
 * @param {(line: string) => void} o.log
 * @param {(version: string) => void} o.onStaged
 */
function createMacUpdater({ currentVersion, bundleId, appBundle, feedBase, workDir, fetch, log, onStaged }) {
	fs.rmSync(workDir, { recursive: true, force: true });
	let staged = null;
	let inFlight = null;

	async function download(feed) {
		const dir = path.join(workDir, feed.version);
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		const zipPath = path.join(dir, feed.zip.url);
		const res = await fetch(new URL(feed.zip.url, feedBase).href);
		if (!res.ok || !res.body) throw new Error(`zip download failed: HTTP ${res.status}`);
		const hash = createHash("sha512");
		let size = 0;
		const body = Readable.fromWeb(res.body);
		body.on("data", (chunk) => {
			hash.update(chunk);
			size += chunk.length;
		});
		await pipeline(body, fs.createWriteStream(zipPath));
		if (size !== feed.zip.size) throw new Error(`zip size ${size} ≠ feed ${feed.zip.size}`);
		if (hash.digest("base64") !== feed.zip.sha512) throw new Error("zip sha512 does not match the feed");

		const out = path.join(dir, "app");
		await run("/usr/bin/ditto", ["-x", "-k", zipPath, out]);
		fs.rmSync(zipPath, { force: true });
		const app = path.join(out, path.basename(appBundle));
		const plist = path.join(app, "Contents", "Info.plist");
		const read = async (key) => (await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist])).stdout.trim();
		const id = await read("CFBundleIdentifier");
		if (id !== bundleId) throw new Error(`staged bundle id ${id} ≠ ${bundleId}`);
		const version = await read("CFBundleShortVersionString");
		if (version !== feed.version) throw new Error(`staged version ${version} ≠ feed ${feed.version}`);
		await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
		await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app]).catch(() => {});

		if (staged) fs.rmSync(path.dirname(staged.app), { recursive: true, force: true });
		staged = { version, app };
		log(`update staged: ${version}`);
		onStaged(version);
	}

	return {
		async check() {
			const res = await fetch(new URL("latest-mac.yml", feedBase).href);
			if (!res.ok) throw new Error(`latest-mac.yml: HTTP ${res.status}`);
			const feed = parseFeed(await res.text());
			if (!isNewer(feed.version, currentVersion)) return null;
			if (staged && !isNewer(feed.version, staged.version)) return staged.version;
			if (!inFlight) {
				log(`update available: ${feed.version} — downloading`);
				inFlight = download(feed)
					.catch((err) => log(`update download failed: ${err?.message ?? err}`))
					.finally(() => (inFlight = null));
			}
			return feed.version;
		},
		get staged() {
			return staged?.version ?? null;
		},
		applyOnExit({ relaunch = false, pid = process.pid } = {}) {
			if (!staged) return false;
			const child = spawn("/bin/sh", ["-c", SWAP_SCRIPT, "plainly-update", String(pid), staged.app, appBundle, relaunch ? "1" : "0"], {
				detached: true,
				stdio: "ignore",
			});
			child.unref();
			log(`update ${staged.version}: swap handed to helper (relaunch=${relaunch})`);
			return true;
		},
	};
}

module.exports = { createMacUpdater, parseFeed, isNewer, feedBaseFromAppUpdate, bundleOf, SWAP_SCRIPT };
