"use client";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { MermaidErrorComponentProps } from "streamdown";

/**
 * Fallback for mermaid diagrams that fail to parse — wired via Streamdown's
 * `mermaid.errorComponent`. Replaces the default light-themed red box with a
 * card matching the app: the error, the source in a details block (so a
 * broken diagram doesn't flood the transcript), and a retry.
 */
export const MermaidError = ({
	chart,
	error,
	retry,
	className,
}: MermaidErrorComponentProps & { className?: string }) => (
	<div className={cn("ls-callout my-4", className)} data-streamdown="mermaid-error" role="alert">
		<Icon name="status-warn" size="sm" />
		<div className="ls-callout-b">
			<b>Diagram failed to render</b>
			<span className="mono" title={error}>{error}</span>
			<details className="mt-1">
				<summary className="cursor-pointer text-muted-foreground">Show diagram source</summary>
				<pre className="mt-2 overflow-x-auto rounded-lg bg-surface p-3 font-mono text-xs text-foreground">{chart}</pre>
			</details>
		</div>
		<button type="button" className="btn sm secondary" onClick={retry}>
			<Icon name="retry" size="sm" />
			Retry
		</button>
	</div>
);
