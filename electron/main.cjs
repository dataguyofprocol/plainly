/**
 * The Electron shell.
 *
 * What this process is and is not:
 *   IS:  a thin launcher + security guard around the app's real server —
 *        `next build`'s standalone server.js (Next 16), spawned as a child
 *        on 127.0.0.1 with the BYOK auth file and the LH_DATA_DIR seam.
 *   NOT: a host for any app logic. Everything — teacher turns, extraction,
 *        the graph — runs in the Next server, unchanged.
 *
 * Pattern:
 *   - spawn via process.execPath + ELECTRON_RUN_AS_NODE=1 (Electron's
 *     bundled Node 24; the runAsNode fuse must stay enabled);
 *   - the server dir ships UNPACKED via extraResources (asar archives are
 *     read-only and native .node/dylib can't dlopen from one);
 *   - all mutable state under userData (never inside the .app bundle —
 *     translocated apps are read-only);
 *   - keys ride the child's ENV, never argv; auth.json (BYOK) is a flat
 *     {VAR: value} JSON map, plaintext, mode 0600, server-managed: the
 *     child reads/writes it DIRECTLY (LH_AUTH_FILE) and reflects values
 *     into its own env. A copy injected here would shadow every
 *     settings-page key change until restart.
 */

const { app, BrowserWindow, Menu, ipcMain, nativeTheme, net: electronNet, session, shell, dialog } = require("electron");
const { createChatGPT, fileStore } = require("./chatgpt.cjs");
const { attachChatGPTChild, trustedSender, chatGPTControl } = require("./chatgpt-ipc.cjs");
const { createSubscriptions, loadSubscriptionSDK } = require("./subscriptions.cjs");
const { attachSubscriptionChild, subscriptionControl } = require("./subscription-ipc.cjs");
const { desktopAPIHeaders } = require("./desktop-api.cjs");
const { migrateUserData } = require("./migrate-data.cjs");
const { createMacUpdater, feedBaseFromAppUpdate, bundleOf } = require("./mac-updater.cjs");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const PRODUCT_NAME = "Plainly";

// APP NAME → userData: the
// Application Support dir is exactly "Plainly" in dev AND packaged.
// Packaged Electron would otherwise derive it from package.json "name"
// (lowercase "plainly"), and productName metadata alone doesn't reach
// app.name. Must run before the LH_DEV_URL suffix below — dev becomes
// "Plainly-dev".
app.setName(PRODUCT_NAME);
const AUTH_FILE = () => path.join(app.getPath("userData"), "auth.json");
const DATA_DIR = () => path.join(app.getPath("userData"), "data");

function serverEntry() {
	return path.join(process.resourcesPath, "server", "standalone", "server.js");
}

if (process.argv.includes("--browser-service")) {
	const { waitForBrowserService } = require("./browser-service-readiness.cjs");
	const lifetime = new AbortController();
	const parentClosed = () => {
		lifetime.abort(new Error("browser-service parent IPC disconnected"));
		app.quit();
	};
	(async () => {
		try {
			// Full Windows Electron replaces stdin with synthetic EOF. Use the
			// real Node IPC channel, and refuse to start an unowned helper.
			if (!process.channel || !process.connected) throw new Error("browser-service requires connected parent IPC");
			process.once("disconnect", parentClosed);
			app.dock?.hide();
			const port = await freePort();
			// Must land before app-ready for Chromium to pick it up.
			app.commandLine.appendSwitch("remote-debugging-port", String(port));
			await app.whenReady();
			const win = new BrowserWindow({ show: false });
			await win.loadURL("about:blank");
			// Window load is not a DevTools HTTP readiness barrier. Confirm the
			// endpoint before both production and smoke clients see the handshake.
			await waitForBrowserService(port, { signal: lifetime.signal });
			if (!lifetime.signal.aborted) console.log(`BROWSER_SERVICE_CDP ${port}`);
		} catch (err) {
			if (lifetime.signal.aborted) return;
			console.error("browser-service failed:", err);
			app.exit(1);
		}
	})();
} else {
	if (process.env.LH_DEV_URL) {
		app.setPath("userData", `${app.getPath("userData")}-dev`);
	}

	if (!app.requestSingleInstanceLock()) {
		app.quit();
	} else {
		app.on("second-instance", () => {
			const win = BrowserWindow.getAllWindows()[0];
			if (win) {
				if (win.isMinimized()) win.restore();
				win.focus();
			}
		});
		try {
			const result = migrateUserData(app.getPath("userData"));
			if (result === "copied") log("data migration: copied LearnHarness userData into Plainly");
		} catch (err) {
			log(`data migration failed: ${err?.message ?? err}`);
		}
		main();
	}
}

let serverProcess = null;
let chatgpt = null;
let chatgptChild = null;
let subscriptions = null;
let subscriptionChild = null;
let desktopAPISecret = null;
const trustedAppWindows = new Set();

const THEME_CHROME = {
	light: { background: "#f4f5f2", symbol: "#191c1a" },
	dark: { background: "#121513", symbol: "#e4e7e3" },
};
const THEME_MODES = new Set(["system", "light", "dark"]);

function storedThemeMode() {
	try {
		const mode = JSON.parse(fs.readFileSync(path.join(DATA_DIR(), "settings.json"), "utf8"))?.appearance?.mode;
		return THEME_MODES.has(mode) ? mode : "system";
	} catch {
		return "system";
	}
}

function themeChrome() {
	return THEME_CHROME[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
}

function repaintWindowChrome() {
	const chrome = themeChrome();
	for (const win of trustedAppWindows) {
		if (win.isDestroyed()) continue;
		win.setBackgroundColor(chrome.background);
		if (process.platform !== "darwin") {
			try {
				win.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.symbol });
			} catch {
			}
		}
	}
}

process.on("uncaughtException", (err) => {
	try {
		log(`uncaught: ${err?.stack ?? err}`);
	} catch {
	}
});

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

function log(line) {
	const stamp = new Date().toISOString();
	try {
		console.log(`[lh ${stamp}] ${line}`);
	} catch {
	}
	try {
		const dir = path.join(app.getPath("userData"), "logs");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "main.log"), `[${stamp}] ${line}\n`);
	} catch {
	}
}

function startServer(port) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			// Only the macOS backend needs this: Next's native title setter
			// otherwise checks this Node-mode process in as a foreground app.
			process.platform === "darwin"
				? ["--require", path.join(process.resourcesPath, "server-title-guard.cjs"), serverEntry()]
				: [serverEntry()],
			{
				cwd: path.dirname(serverEntry()),
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: "1",
					NODE_ENV: "production",
					PORT: String(port),
					HOSTNAME: "127.0.0.1", // the server defaults to 0.0.0.0 — never
					LH_DATA_DIR: DATA_DIR(),
					LH_AUTH_FILE: AUTH_FILE(),
					LH_DESKTOP_SERVER: "1",
					LH_DESKTOP_API_SECRET: desktopAPISecret,
				},
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		serverProcess = child;
		chatgptChild = attachChatGPTChild(child, chatgpt);
		subscriptionChild = attachSubscriptionChild(child, subscriptions);
		const fwd = (buf) => buf.toString().trimEnd().split("\n").forEach((l) => l && log(`server: ${l}`));
		child.stdout.on("data", fwd);
		child.stderr.on("data", fwd);
		child.on("exit", (code, signal) => {
			log(`server exited (code=${code} signal=${signal})`);
			serverProcess = null;
			chatgptChild?.dispose();
			chatgptChild = null;
			subscriptionChild?.dispose();
			subscriptionChild = null;
			chatgpt?.close();
			subscriptions?.close();
		});
		resolve(child);
	});
}

/** No "ready" event exists — poll until the server answers (docs-confirmed). */
function waitUntilUp(url, tries = 150) {
	return new Promise((resolve, reject) => {
		const attempt = (n) => {
			const req = http.get(url, (res) => {
				res.resume();
				resolve(res.statusCode !== undefined);
			});
			req.on("error", () => {
				if (n <= 0) reject(new Error(`server never answered on ${url}`));
				else setTimeout(() => attempt(n - 1), 200);
			});
		};
		attempt(tries);
	});
}

function killServer() {
	chatgpt?.close();
	subscriptions?.close();
	if (!serverProcess) return;
	const child = serverProcess;
	serverProcess = null;
	child.kill("SIGTERM");
	setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
		}
	}, 3000);
}

/** Security posture (all defaults asserted explicitly; the guards are
 *  Electron's security checklist recommendations for localhost-app shells):
 *  - deny-by-default permission handler allowing only our loopback origin
 *    (Electron auto-approves by default);
 *  - will-navigate pinned to the app origin; window.open always denied —
 *    external links go to the real browser via shell.openExternal. */
function createWindow(url) {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		title: PRODUCT_NAME,
		// macOS centers each traffic light at y+6.75, so y 19.25 lands them
		// at 26, half of the renderer's 52pt bar.
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 19.25 } }
			: {
				titleBarStyle: "hidden",
				// Do not force the zoom-invariant native overlay to match
				// the renderer's 60 CSS px bar: zooming out would cover its border.
				titleBarOverlay: { color: themeChrome().background, symbolColor: themeChrome().symbol },
				autoHideMenuBar: true,
			}),
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			preload: path.join(__dirname, "preload.cjs"),
		},
		// Live-resize + first-paint flash: during a resize
		// the native window surface changes size before Chromium's compositor
		// has a frame at the new size, and the gap shows the window's NATIVE
		// background, which flashes against the app. The app background
		// (the current theme's ground, THEME_CHROME) fills the lag instead. `show: false` +
		// ready-to-show is the same treatment for first paint: the window
		// appears only once the page has actually rendered.
		backgroundColor: themeChrome().background,
		show: false,
		minWidth: 712,
		minHeight: 600,
	});

	trustedAppWindows.add(win);
	win.once("closed", () => trustedAppWindows.delete(win));
	const allowedOrigin = () => new URL(url).origin;
	// Deny-by-default, loopback-origin only: Electron's default is
	// auto-approve-everything. Chromium honors navigator.clipboard.writeText()
	// only with clipboard-sanitized-write.
	const allowedPermissions = new Set(["media", "clipboard-sanitized-write", "local-fonts"]);
	const fromOwnOrigin = (origin, permission) =>
		origin === allowedOrigin() && allowedPermissions.has(permission);
	session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
		const requestOrigin = details.requestingUrl ? new URL(details.requestingUrl).origin : null;
		callback(fromOwnOrigin(requestOrigin, permission));
	});
	session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
		return fromOwnOrigin(origin, permission);
	});

	win.webContents.on("will-navigate", (event, target) => {
		if (new URL(target).origin !== allowedOrigin()) {
			event.preventDefault();
			void shell.openExternal(target);
		}
	});
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		void shell.openExternal(target);
		return { action: "deny" };
	});

	void win.loadURL(url);
	// Menu-claimed keys never reach before-input-event, so the fallback
	// catcher below and the menu's ⌘Plus never both apply one keypress.
	win.webContents.on("did-finish-load", () => {
		win.webContents.send("lh:zoom", win.webContents.getZoomFactor());
	});
	win.webContents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown" || !(input.meta || input.control)) return;
		if (input.key === "=" || input.key === "+") zoomStep(win, +1);
		else if (input.key === "-") zoomStep(win, -1);
		else if (input.key === "0") applyZoom(win, 1);
		else return;
		event.preventDefault();
	});

	win.once("ready-to-show", () => win.show());
	return win;
}

/* The stock zoomIn/zoomOut roles change zoomLevel silently, so the renderer
 * never learns the factor and the native traffic lights (physical-fixed)
 * drift out of relation to the scaled chrome. */
const ZOOM_LADDER = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/* Auto-update. Feed: GitHub Releases (app-update.yml baked into the bundle).
 * macOS: the app is ad-hoc signed, which Squirrel.Mac rejects, so
 * electron/mac-updater.cjs swaps the .app after quit. Linux deb installs can
 * request administrator permission via the package manager.
 *
 * Shell contract:
 *  - !app.isPackaged skips the updater entirely.
 *  - Every updater event and check is caught and logged; the updater can
 *    never take the app down.
 *  - LH_UPDATE_FEED (env) overrides the baked GitHub feed with a generic
 *    local server. Test-only seam.
 *  - On "lh:update-install" the child server is killed FIRST: it lives inside
 *    the .app bundle about to be replaced, and before-quit alone would race
 *    the swap. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let autoUpdater = null;
let macUpdater = null;
let relaunchAfterUpdate = false;

function broadcastUpdateStatus(status) {
	for (const win of BrowserWindow.getAllWindows()) {
		try {
			win.webContents.send("lh:update-status", status);
		} catch {
		}
	}
}

function checkForUpdates({ manual = false } = {}) {
	if (macUpdater) {
		macUpdater
			.check()
			.then((version) => {
				if (manual && !version) dialog.showMessageBox({ type: "info", message: "You're up to date.", detail: `Plainly ${app.getVersion()} is the latest version.` });
			})
			.catch((err) => {
				log(`update check failed: ${err?.message ?? err}`);
				if (manual) dialog.showMessageBox({ type: "warning", message: "Couldn't check for updates.", detail: String(err?.message ?? err) });
			});
		return;
	}
	if (!autoUpdater) return;
	autoUpdater
		.checkForUpdates()
		.then((result) => {
			if (!manual) return;
			const version = result?.updateInfo?.version;
			if (!version) dialog.showMessageBox({ type: "info", message: "You're up to date.", detail: `Plainly ${app.getVersion()} is the latest version.` });
		})
		.catch((err) => {
			log(`update check failed: ${err?.message ?? err}`);
			if (manual) dialog.showMessageBox({ type: "warning", message: "Couldn't check for updates.", detail: String(err?.message ?? err) });
		});
}

function installUpdateNow() {
	try {
		killServer();
	} catch {
	}
	if (macUpdater) {
		relaunchAfterUpdate = true;
		app.quit();
		return;
	}
	autoUpdater?.quitAndInstall();
}

function setupMacUpdater() {
	const appBundle = bundleOf(process.execPath);
	// A translocated copy (opened from a quarantined download) is read-only,
	// and a folder this user can't write to can't take the swap.
	if (appBundle.includes("/AppTranslocation/")) {
		log("auto-update: app is translocated — updates disabled");
		return;
	}
	try {
		fs.accessSync(path.dirname(appBundle), fs.constants.W_OK);
	} catch {
		log(`auto-update: ${path.dirname(appBundle)} is not writable — updates disabled`);
		return;
	}
	const feed = process.env.LH_UPDATE_FEED;
	const feedBase = feed
		? feed.replace(/\/?$/, "/")
		: feedBaseFromAppUpdate(fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8"));
	if (feed) log(`auto-update: LH_UPDATE_FEED override → ${feedBase}`);
	macUpdater = createMacUpdater({
		currentVersion: app.getVersion(),
		bundleId: "app.plainly.Plainly",
		appBundle,
		feedBase,
		workDir: path.join(app.getPath("userData"), "updates"),
		fetch: (url) => electronNet.fetch(url),
		log: (m) => log(`updater: ${m}`),
		onStaged: (version) => {
			log(`update downloaded: ${version} — banner shown`);
			broadcastUpdateStatus({ status: "downloaded", version });
		},
	});
	app.on("will-quit", () => {
		try {
			macUpdater.applyOnExit({ relaunch: relaunchAfterUpdate });
		} catch (err) {
			log(`update swap failed to start: ${err?.message ?? err}`);
		}
	});
}

function setupAutoUpdater() {
	if (!app.isPackaged) {
		log("auto-update: dev build — updater disabled");
		return;
	}
	if (process.platform === "darwin") {
		try {
			setupMacUpdater();
		} catch (err) {
			macUpdater = null;
			log(`auto-update: mac updater unavailable (${err?.message ?? err}) — updates disabled`);
		}
		return;
	}
	try {
		autoUpdater = require("electron-updater").autoUpdater;
	} catch (err) {
		log(`auto-update: electron-updater unavailable (${err?.message ?? err}) — updates disabled`);
		return;
	}
	const feed = process.env.LH_UPDATE_FEED;
	if (feed) {
		autoUpdater.setFeedURL({ provider: "generic", url: feed });
		log(`auto-update: LH_UPDATE_FEED override → ${feed}`);
	}
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;
	autoUpdater.logger = {
		info: (m) => log(`updater: ${m}`),
		warn: (m) => log(`updater warn: ${m}`),
		debug: (m) => {}, // too chatty for the persistent log
		error: (m) => log(`updater error: ${m}`),
	};
	autoUpdater.on("update-downloaded", (info) => {
		log(`update downloaded: ${info?.version} — banner shown`);
		broadcastUpdateStatus({ status: "downloaded", version: info?.version ?? null });
	});
	autoUpdater.on("error", (err) => log(`updater error: ${err?.message ?? err}`));
}

function zoomStep(win, dir) {
	const current = win.webContents.getZoomFactor();
	const next =
		dir > 0
			? ZOOM_LADDER.find((f) => f > current + 0.001) ?? ZOOM_LADDER[ZOOM_LADDER.length - 1]
			: [...ZOOM_LADDER].reverse().find((f) => f < current - 0.001) ?? ZOOM_LADDER[0];
	applyZoom(win, next);
}

function applyZoom(win, factor) {
	factor = Math.min(2, Math.max(0.75, factor));
	win.webContents.setZoomFactor(factor);
	win.webContents.send("lh:zoom", factor);
}

/** macOS needs an application menu with the Edit roles — without one,
 *  Cmd+C/V/A do nothing in the renderer. Everything else stays minimal. */
function installMenu() {
	// AGPL attribution: the About panel credits upstream.
	app.setAboutPanelOptions({
		applicationName: PRODUCT_NAME,
		applicationVersion: app.getVersion(),
		credits: "Plainly is a fork of LearnHarness by Amos Blomqvist.\nFree software under the GNU AGPL-3.0.",
	});
	const template = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				{ label: "Check for Updates…", click: () => checkForUpdates({ manual: true }) },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{
					label: "Actual Size",
					accelerator: "CommandOrControl+0",
					click: () => applyZoom(BrowserWindow.getAllWindows()[0], 1),
				},
				{
					label: "Zoom In",
					accelerator: "CommandOrControl+Plus",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], +1),
				},
				{
					label: "Zoom Out",
					accelerator: "CommandOrControl+-",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], -1),
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ role: "windowMenu" },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main() {
	app.on("window-all-closed", () => {
		chatgpt?.pause();
		subscriptions?.pause();
		if (process.platform !== "darwin") app.quit();
	});

	app.on("before-quit", killServer);
	process.on("exit", killServer);
	process.on("SIGHUP", killServer);

	await app.whenReady();

	const devUrl = process.env.LH_DEV_URL;
	const url = devUrl ?? `http://127.0.0.1:${await freePort()}`;
	if (!devUrl) {
		desktopAPISecret = randomBytes(32).toString("hex");
		const ownedOrigin = new URL(url).origin;
		// All URLs, not only /api: remove the header again on external redirects.
		session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
			callback({ requestHeaders: desktopAPIHeaders(details, ownedOrigin, desktopAPISecret, [...trustedAppWindows]) });
		});
		chatgpt = createChatGPT({
			store: fileStore(path.join(app.getPath("userData"), "chatgpt-credentials.json")),
			openExternal: (target) => shell.openExternal(target),
			onChange: (value) => {
				chatgptChild?.send(value);
				for (const win of BrowserWindow.getAllWindows()) win.webContents.send("lh:chatgpt:changed");
			},
		});
		subscriptions = createSubscriptions({
			directory: app.getPath("userData"),
			loadSDK: () => loadSubscriptionSDK(path.dirname(serverEntry())),
			openExternal: (target) => shell.openExternal(target),
			onChange: (snapshot) => {
				subscriptionChild?.send(snapshot);
				for (const win of BrowserWindow.getAllWindows()) win.webContents.send("lh:subscriptions:changed");
			},
		});
		await subscriptions.ready;
		log(`starting server: ${serverEntry()}`);
		log(`data dir: ${DATA_DIR()}${fs.existsSync(AUTH_FILE()) ? " · auth.json: present" : " · auth.json: ABSENT (no BYOK keys yet)"}`);
		await startServer(new URL(url).port);
		await waitUntilUp(url);
		log(`server up: ${url}`);
	} else {
		log(`dev mode: ${devUrl}`);
	}

	ipcMain.handle("lh:chatgpt:control", async (event, command) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) return { error: "Untrusted desktop request." };
		if (!chatgpt || !serverProcess?.connected) return { available: false, pending: false, activeId: null, accounts: [], error: "ChatGPT sign-in requires the desktop app's private server connection. Browser-only and externally launched development servers keep API-key connections." };
		return chatGPTControl(command, chatgpt);
	});

	ipcMain.handle("lh:subscriptions:control", async (event, command) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		if (!subscriptions || !serverProcess?.connected) {
			if (command?.op === "status") return [];
			throw new Error("Subscription sign-in requires the desktop app's private server connection.");
		}
		return subscriptionControl(command, subscriptions);
	});

	nativeTheme.themeSource = storedThemeMode();
	nativeTheme.on("updated", repaintWindowChrome);
	ipcMain.on("lh:theme", (event, mode) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) return;
		if (!THEME_MODES.has(mode)) return;
		nativeTheme.themeSource = mode;
		repaintWindowChrome();
	});

	installMenu();

	setupAutoUpdater();
	ipcMain.on("lh:update-install", () => installUpdateNow());

	ipcMain.handle("lh:zoom:get", (event) => BrowserWindow.fromWebContents(event.sender)?.webContents.getZoomFactor() ?? 1);
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) { chatgpt?.resume(); subscriptions?.resume(); createWindow(url); }
	});
	createWindow(url);
	log(`window open: ${url}`);
	if (autoUpdater || macUpdater) {
		checkForUpdates();
		setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
	}
}