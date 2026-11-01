import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// The Electron shell spawns .next/standalone/server.js. The copies of
	// public/ and .next/static that standalone output needs are done by
	// scripts/build-server.mjs.
	output: "standalone",
	devIndicators: false,
	// Without these excludes, output file tracing sweeps the repo's data/
	// (session records, graph ledgers), the dev auth.json key store and .env*
	// into the standalone bundle. Next also copies a loaded bare .env after
	// tracing, so build-server.mjs must still refuse to package a standalone
	// that contains them.
	//
	// Exclude patterns act in ways the Next docs do not describe. Directory
	// excludes such as "dist/**/*" or "./dist/**/*" strip the dist/ of the
	// server-external packages (pi-ai, pi-agent-core) and their deps, and the
	// packaged server fails with ERR_MODULE_NOT_FOUND. "**/data/**/*" works in
	// Next's JavaScript collector, but the native Turbopack tracer still
	// prunes gcp-metadata and its private deps with it: keep the closure
	// includes below and the native runtime gate. Repo dist/ is kept out of
	// the bundle by the desktop:dist clean step and the post-trace curation in
	// scripts/build-server.mjs, not by an exclude here.
	outputFileTracingExcludes: {
		"*": [
			"**/data/**/*",
			"auth.json",
			".env*",
		],
	},
	// The tracer misses JSON loaded through `import ... with { type: "json" }`
	// (pi-ai's provider catalog) and the files pdfjs-dist resolves at runtime
	// (the pdf.worker.mjs fake worker, standard_fonts).
	outputFileTracingIncludes: {
		"*": [
			// Runtime-imported by puppeteer-core; the trace omits this directory.
			"node_modules/@puppeteer/browsers/lib/browser-data/**/*.js",
			"node_modules/pdfjs-dist/legacy/**/*",
			"node_modules/pdfjs-dist/standard_fonts/**/*",
			// @napi-rs/canvas loads its platform binary through a dynamic
			// optional-dep require the tracer cannot see. npm installs only the
			// current platform's binary, so this glob matches one per build.
			"node_modules/@napi-rs/canvas-*/**/*",
			// Same per-platform binary as the canvas above.
			"node_modules/@resvg/resvg-js-*/**/*",
			"node_modules/@earendil-works/pi-ai/dist/providers/data/**/*",
			// pi-ai's OAuth factories load these flows through variable imports.
			"node_modules/@earendil-works/pi-ai/dist/auth/oauth/{load,github-copilot,xai,device-code}.js",
			"node_modules/@earendil-works/pi-ai/dist/utils/sleep.js",
			"node_modules/@earendil-works/pi-agent-core/dist/**/*.json",
			// Native Turbopack applies the **/data/**/* exclude while traversing
			// modules and prunes gcp-metadata and its runtime chain; includes
			// apply after traversal. This is the GoogleAuth closure only.
			"node_modules/gcp-metadata/**/*",
			"node_modules/json-bigint/**/*",
			"node_modules/bignumber.js/**/*",
		],
	},
	// pi's providers are runtime-loaded Node code (undici streams, catalog
	// data) that breaks when bundled into routes.
	serverExternalPackages: [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"pdfjs-dist", // bundling breaks its node fake-worker path
		"@napi-rs/canvas", // native binding: bundling breaks the .node require
		"@resvg/resvg-js", // native binding: same
	],
};

export default nextConfig;