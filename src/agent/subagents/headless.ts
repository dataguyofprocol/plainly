import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { standardFontsDir } from "./pdf-ops";

export interface DemoRunResult {
	consoleErrors: string[];
	pageErrors: string[];
	failedRequests: string[];
	probeResult?: unknown;
	ok: boolean;
}

export interface RunDemoOptions {
	settleMs?: number;
	probe?: string;
}

export interface RenderSvgOptions {
	width?: number;
	height?: number;
}

export interface RenderPdfOptions {
	dpi?: number;
}

export interface RenderedPdfPage {
	page: number;
	png: Buffer;
}

export interface HeadlessApi {
	available(): boolean;
	unavailableReason(): string | null;
	runDemo(html: string, opts?: RunDemoOptions): Promise<DemoRunResult>;
	renderSvg(svg: string, opts?: RenderSvgOptions): Promise<Buffer>;
	renderPdfPages(pdfPath: string, pages: number[], opts?: RenderPdfOptions): Promise<RenderedPdfPage[]>;
}

export const headlessOverride: { current?: HeadlessApi } = {};

export function getHeadless(): HeadlessApi {
	return headlessOverride.current ?? realHeadless;
}

const CHROME_CANDIDATES = [
	...(process.platform === "win32" ? [
		path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
		path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
		...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")] : []),
	] : []),
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

export function resolveChromeExecutablePath(): string | null {
	const candidates = [process.env.CHROME_PATH, ...CHROME_CANDIDATES].filter(
		(p): p is string => typeof p === "string" && p.length > 0,
	);
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			/* not readable — try the next */
		}
	}
	return null;
}

const NO_CHROME_MESSAGE =
	"No render engine available: the app's own browser helper failed to start and no system Chrome/Chromium was found. " +
	"Install Google Chrome or set CHROME_PATH to a Chrome executable. " +
	"(Verification is mandatory — demos are never delivered untested.)";

// A Node IPC channel owns its lifetime: parent death/disconnect quits the
// helper on every OS (Windows Electron stdin is synthetic EOF). No orphans.

export function parseBrowserServiceLine(line: string): number | null {
	const m = line.match(/^BROWSER_SERVICE_CDP (\d+)$/);
	if (!m) return null;
	const port = Number(m[1]);
	return port >= 1 && port <= 65535 ? port : null;
}

/** Spawn env sanitizer (pure; exported for tests): the helper must run as a
 *  FULL Electron app — ELECTRON_RUN_AS_NODE must not leak — and must not
 *  inherit the dev-shell userData redirect. */
export function browserServiceSpawnEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = { ...env };
	delete out.ELECTRON_RUN_AS_NODE;
	delete out.LH_DEV_URL;
	delete out.LH_DESKTOP_API_SECRET;
	delete out.LH_DESKTOP_SERVER;
	return out;
}

/** The helper binary: inside the packaged app the server runs under
 *  ELECTRON_RUN_AS_NODE so process.execPath IS the app binary; in dev
 *  (plain node) the electron package resolves to the dev binary path. */
export function browserServiceBinary(): string | null {
	if (process.versions.electron) return process.execPath;
	try {
		const req = createRequire(import.meta.url);
		const p = req("electron") as unknown as string;
		return typeof p === "string" && p.length > 0 ? p : null;
	} catch {
		return null;
	}
}

const BROWSER_SERVICE_TIMEOUT_MS = 15_000;
let browserServiceProc: import("node:child_process").ChildProcess | null = null;

async function connectBrowserService(): Promise<import("puppeteer-core").Browser | null> {
	const puppeteer = (await import("puppeteer-core")).default;
	const { spawn } = await import("node:child_process");
	let port: number | null = null;

	if (browserServiceProc && browserServiceProc.exitCode === null) {
		port = (browserServiceProc as { __cdpPort?: number }).__cdpPort ?? null;
	}
	if (port === null) {
		const binary = browserServiceBinary();
		if (!binary) return null;
		// Dev: the bare electron binary needs the repo root as the app arg —
		// flagless it would open Electron's default app instead of our shell.
		const appArgs = process.versions.electron ? ["--browser-service"] : [
			path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
			"--browser-service",
		];
		const proc = spawn(binary, appArgs, {
			env: browserServiceSpawnEnv(process.env) as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "pipe", "ipc"] as const,
		});
		browserServiceProc = proc;
		port = await new Promise<number | null>((resolve) => {
			let buf = "";
			const timer = setTimeout(() => {
				proc.kill();
				resolve(null);
			}, BROWSER_SERVICE_TIMEOUT_MS);
			const onData = (chunk: Buffer) => {
				buf += chunk.toString("utf8");
				const line = buf.split("\n").find((l) => parseBrowserServiceLine(l) !== null);
				if (line !== undefined) {
					clearTimeout(timer);
					resolve(parseBrowserServiceLine(line));
				}
			};
			proc.stdout!.on("data", onData);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve(null);
			});
		});
		if (port === null) {
			browserServiceProc = null;
			return null;
		}
		(proc as { __cdpPort?: number }).__cdpPort = port;
	}

	try {
		const version = await fetch(`http://127.0.0.1:${port}/json/version`);
		const info = (await version.json()) as { webSocketDebuggerUrl?: string };
		if (!info.webSocketDebuggerUrl) return null;
		// connect ≠ launch: browser.close() below merely disconnects — the
		// helper stays resident for the next job (IPC-owned lifetime).
		return await puppeteer.connect({
			browserWSEndpoint: info.webSocketDebuggerUrl,
			defaultViewport: null,
		});
	} catch {
		return null;
	}
}

/** Serialized helper-page use: the helper owns ONE page target (Electron's
 *  CDP has no Target.createTarget — pages must be windows the helper made),
 *  so concurrent jobs queue here instead of fighting over one webContents. */
let helperPageChain: Promise<unknown> = Promise.resolve();

async function withBrowserPage<T>(fn: (page: import("puppeteer-core").Page) => Promise<T>): Promise<T> {
	const helper = await connectBrowserService();
	if (helper) {
		const run = async (): Promise<T> => {
			const pages = await helper.pages();
			const page = pages.find((p) => p.target().type() === "page");
			if (!page) throw new Error("browser service: no page target");
			try {
				return await fn(page);
			} finally {
				await page.goto("about:blank").catch(() => {});
			}
		};
		const next = helperPageChain.then(run, run);
		helperPageChain = next.catch(() => {});
		return next;
	}

	const puppeteer = (await import("puppeteer-core")).default;
	const executablePath = resolveChromeExecutablePath();
	const browser = await puppeteer.launch({
		headless: true,
		// Explicit path when we found one; otherwise let puppeteer resolve the
		// system Chrome install itself via the "chrome" channel.
		...(executablePath ? { executablePath } : { channel: "chrome" as const }),
		args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"],
	});
	try {
		const page = await browser.newPage();
		return await fn(page);
	} finally {
		await browser.close().catch(() => {});
	}
}

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function runDemo(html: string, opts: RunDemoOptions = {}): Promise<DemoRunResult> {
	const settleMs = opts.settleMs ?? 2000;
	const dir = tempDir("lh-demo-");
	const file = path.join(dir, "demo.html");
	fs.writeFileSync(file, html, "utf-8");

	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	let probeResult: unknown;
	let probed = false;

	try {
		await withBrowserPage(async (page) => {
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		});
		page.on("pageerror", (err) => pageErrors.push(err instanceof Error ? err.message : String(err)));
		page.on("requestfailed", (req) => failedRequests.push(`${req.url()} (${req.failure()?.errorText ?? "failed"})`));

		try {
			await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 30_000 });
			await new Promise((resolve) => setTimeout(resolve, settleMs));
			if (opts.probe) {
				try {
					probeResult = await page.evaluate(opts.probe);
				} catch (err) {
					pageErrors.push(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				probed = true;
			}
		} catch (err) {
			pageErrors.push(err instanceof Error ? err.message : String(err));
		}
		});
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}

	return {
		consoleErrors,
		pageErrors,
		failedRequests,
		...(probed ? { probeResult } : {}),
		ok: consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0,
	};
}

function svgViewport(svg: string, opts: RenderSvgOptions): { width: number; height: number } {
	if (opts.width && opts.height) return { width: opts.width, height: opts.height };
	const width = Number(svg.match(/\bwidth\s*=\s*"?(\d+(?:\.\d+)?)/)?.[1]);
	const height = Number(svg.match(/\bheight\s*=\s*"?(\d+(?:\.\d+)?)/)?.[1]);
	return {
		width: Math.ceil(Number.isFinite(width) && width > 0 ? width : 900),
		height: Math.ceil(Number.isFinite(height) && height > 0 ? height : 700),
	};
}

export function providerSafePng(png: Buffer): Buffer {
	const SIG_LEN = 8;
	if (png.length < SIG_LEN + 12 || png.subarray(0, SIG_LEN).toString("hex") !== "89504e470d0a1a0a") return png;
	const parts: Array<{ type: string; data: Buffer }> = [];
	let off = SIG_LEN;
	while (off + 12 <= png.length) {
		const len = png.readUInt32BE(off);
		if (off + 12 + len > png.length) break;
		parts.push({ type: png.subarray(off + 4, off + 8).toString("ascii"), data: png.subarray(off + 8, off + 8 + len) });
		off += 12 + len;
	}
	const idats = parts.filter((p) => p.type === "IDAT");
	if (idats.length < 2) return png;
	const merged = Buffer.concat(idats.map((p) => p.data));
	let emittedIdat = false;
	const out: Buffer[] = [png.subarray(0, SIG_LEN)];
	for (const p of parts) {
		if (p.type !== "IDAT") out.push(chunk(p.type, p.data));
		else if (!emittedIdat) {
			out.push(chunk("IDAT", merged));
			emittedIdat = true;
		}
	}
	return Buffer.concat(out);
}

function chunk(type: string, data: Buffer): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

function crc32(buf: Buffer): number {
	let c = ~0;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

async function renderSvg(svg: string, opts: RenderSvgOptions = {}): Promise<Buffer> {
	const { width } = svgViewport(svg, opts);
	try {
		const { Resvg } = await import("@resvg/resvg-js");
		const resvg = new Resvg(svg, {
			fitTo: { mode: "width", value: width },
			font: { loadSystemFonts: true },
			background: "#ffffff",
		});
		return providerSafePng(resvg.render().asPng());
	} catch {
		/* fall through to the browser path */
	}
	const dir = tempDir("lh-visual-");
	const file = path.join(dir, "figure.html");
	fs.writeFileSync(
		file,
		`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style></head><body>${svg}</body></html>`,
		"utf-8",
	);

	return withBrowserPage(async (page) => {
		const { width, height } = svgViewport(svg, opts);
		await page.setViewport({ width, height });
		await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 30_000 });
		const shot = (await page.screenshot({ fullPage: true, type: "png" })) as Buffer;
		return providerSafePng(Buffer.from(shot));
	}).finally(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	});
}

async function renderPdfPages(
	pdfPath: string,
	pages: number[],
	opts: RenderPdfOptions = {},
): Promise<RenderedPdfPage[]> {
	const dpi = opts.dpi ?? 150;
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const { createCanvas } = await import("@napi-rs/canvas");
	const data = new Uint8Array(fs.readFileSync(path.resolve(pdfPath)));
	// Standard-font data as a directory path (live-smoke finding 2026-09-19:
	// without it pdfjs renders non-embedded standard fonts via fallback);
	// verbosity 0 = errors only (JBIG2 noise on scanned PDFs).
	const loadingTask = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	const doc = await loadingTask.promise;
	try {
		const out: RenderedPdfPage[] = [];
		for (const pageNo of pages) {
			if (pageNo < 1 || pageNo > doc.numPages) continue;
			const pg = await doc.getPage(pageNo);
			const vp = pg.getViewport({ scale: dpi / 72 });
			const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
			const ctx = canvas.getContext("2d");
			// pdfjs's render types speak the DOM context; @napi-rs/canvas's
			// context is the same 2D API implemented over Skia.
			await pg.render({
				canvasContext: ctx as unknown as CanvasRenderingContext2D,
				canvas: canvas as unknown as HTMLCanvasElement,
				viewport: vp,
			}).promise;
			out.push({
				page: pageNo,
				png: providerSafePng(canvas.toBuffer("image/png")),
			});
		}
		return out;
	} finally {
		await loadingTask.destroy().catch(() => {});
	}
}

export const realHeadless: HeadlessApi = {
	available() {
		return browserServiceBinary() !== null || resolveChromeExecutablePath() !== null;
	},
	unavailableReason() {
		return browserServiceBinary() === null && resolveChromeExecutablePath() === null ? NO_CHROME_MESSAGE : null;
	},
	runDemo,
	renderSvg,
	renderPdfPages,
};
