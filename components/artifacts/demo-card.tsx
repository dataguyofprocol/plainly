"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { Hint } from "@/components/ui/hint";
import { Toggle } from "@/components/settings/controls";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { ChatActionsContext } from "@/components/chat";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import type { ArtifactPartProps, DemoResult } from "@/src/core";

export const DEMO_BRIDGE_SCRIPT = `<script>(function(){
var send=function(m){try{parent.postMessage(m,"*")}catch(e){}};
var post=function(){
var b=document.body;
if(!b){send({type:"demo-resize",height:document.documentElement.scrollHeight});return}
var h=Math.max(b.scrollHeight,b.getBoundingClientRect().height);
var cs=getComputedStyle(b);
h+=(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0);
send({type:"demo-resize",height:Math.ceil(h)})
};
if(typeof ResizeObserver!=="undefined"){new ResizeObserver(post).observe(document.documentElement)}
window.addEventListener("resize",post);
window.addEventListener("load",post);
window.addEventListener("error",function(e){send({type:"demo-error",message:e.message||String(e)})});
setTimeout(post,50);
setTimeout(post,400);
})();</script>`;

export function buildDemoSrcDoc(html: string): string {
	if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${DEMO_BRIDGE_SCRIPT}</body>`);
	return `${html}${DEMO_BRIDGE_SCRIPT}`;
}

export interface DemoBridgeState {
	height: number | null;
	error: string | null;
}

export const INITIAL_DEMO_BRIDGE_STATE: DemoBridgeState = { height: null, error: null };

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2400;

export function reduceDemoBridgeState(state: DemoBridgeState, data: unknown): DemoBridgeState {
	if (typeof data !== "object" || data === null) return state;
	const message = data as { type?: unknown; height?: unknown; message?: unknown };
	if (message.type === "demo-resize") {
		if (typeof message.height !== "number" || !Number.isFinite(message.height) || message.height <= 0) return state;
		const height = Math.min(Math.max(Math.round(message.height), MIN_HEIGHT), MAX_HEIGHT);
		return height === state.height ? state : { ...state, height };
	}
	if (message.type === "demo-error") {
		const text = typeof message.message === "string" && message.message.trim() ? message.message : "unknown error";
		return text === state.error ? state : { ...state, error: text };
	}
	return state;
}

export function DemoCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="demo" />;
}

export function DemoOutputCard({
	output,
	messageId,
	initialInverted = false,
}: {
	output: unknown;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const result = output as DemoResult | undefined;
	if (!result || typeof result.html !== "string" || typeof result.title !== "string") {
		return (
			<div className="ls-card">
				<div className="ls-card-b">The demo was built, but it could not be displayed.</div>
			</div>
		);
	}
	const failed = result.html.length === 0;
	if (failed) {
		return (
			<div className="ls-card" data-testid="demo-card-failed">
				<div className="ls-card-h">
					<Icon name="demo" size="sm" />
					<span className="ls-card-t">Interactive demo</span>
					<span className="pill danger">failed</span>
				</div>
				<p className="ls-card-b">{result.notes ?? "The demo could not be built."}</p>
			</div>
		);
	}
	return (
		<DemoFrame title={result.title} html={result.html} messageId={messageId} initialInverted={initialInverted} />
	);
}

function DemoFrame({
	title,
	html,
	messageId,
	initialInverted = false,
}: {
	title: string;
	html: string;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const actions = useContext(ChatActionsContext);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [state, setState] = useState<DemoBridgeState>(INITIAL_DEMO_BRIDGE_STATE);
	const [inverted, setInverted] = useState(initialInverted);
	const toggleInverted = (next: boolean) => {
		setInverted(next);
		if (!actions?.chatId || !messageId) return;
		void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	};
	const srcDoc = useMemo(() => buildDemoSrcDoc(html), [html]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			// Only messages from THIS demo's iframe (the sandbox gives it an
			// opaque origin; the window reference still matches).
			if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
			setState((prev) => reduceDemoBridgeState(prev, event.data));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);

	return (
		<div className="ls-card" data-testid="demo-card">
			<div className="ls-card-h">
				<Icon name="demo" size="sm" />
				<span className="ls-card-t">Interactive demo</span>
				<span className="ls-card-sub" title={title}>{title}</span>
				<span className="ls-card-x">
					<Toggle
						checked={inverted}
						onChange={toggleInverted}
						label="Invert demo brightness"
						title="Invert colors"
						discIcon={<InvertDiscIcon className="size-3" />}
					/>
					<Hint label="Download as HTML" side="bottom">
						<button
							type="button"
							aria-label="Download demo as HTML"
							onClick={() => downloadFile(`${slugFilename(title)}.html`, html, "text/html")}
							data-testid="demo-download"
							className="ib sm"
						>
							<Icon name="download" size="sm" />
						</button>
					</Hint>
				</span>
			</div>
			{state.error && (
				<DemoErrorChip
					title={title}
					message={state.error}
					onSend={actions ? () => actions.sendText(`The demo "${title}" threw an error: ${state.error}`) : undefined}
				/>
			)}
			<iframe
				ref={iframeRef}
				title={title}
				// allow-scripts ONLY — no allow-same-origin: the demo can run code
				// but never touch the app's storage, cookies, or DOM.
				sandbox="allow-scripts"
				srcDoc={srcDoc}
				// Scrolling off: a scrollable iframe traps the wheel, so session
				// scrolling would stall over the demo.
				scrolling="no"
				className="ls-demo-frame"
				// content-box: the bridge reports the content height; with the
				// preflight's border-box the 2px border would clip the demo's bottom.
				style={{
					height: state.height ?? 360,
					boxSizing: "content-box",
					filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined,
				}}
				data-testid="demo-iframe"
			/>
		</div>
	);
}

export function DemoErrorChip({
	title,
	message,
	onSend,
}: {
	title: string;
	message: string;
	onSend?: () => void;
}) {
	return (
		<div className="ls-callout" data-testid="demo-error-chip" role="alert">
			<Icon name="status-error" size="sm" />
			<span className="ls-callout-b">
				<b>This demo hit an error</b>
				<span className="mono" title={message}>
					{message}
				</span>
			</span>
			{onSend && (
				<button type="button" onClick={onSend} className="btn sm secondary" data-testid="demo-error-send">
					Send to teacher
				</button>
			)}
		</div>
	);
}
