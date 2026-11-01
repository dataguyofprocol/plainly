"use client";

import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { MessageResponse } from "@/components/ai-elements/message";
import type { ArtifactPartProps, PdfResult, ResearchResult } from "@/src/core";
import { Icon } from "@/components/ui/icon";

export function JobCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="research" />;
}

export function PdfJobCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="pdf" />;
}

export function PdfBriefCard({ output }: { output: unknown }) {
	const result = output as PdfResult | undefined;
	if (!result || typeof result.brief !== "string") {
		return (
			<div className="ls-card">
				<div className="ls-card-b">The PDF was read, but the result could not be displayed.</div>
			</div>
		);
	}
	const failed = result.brief.startsWith("PDF failed");
	const readList = result.pagesRead ?? result.pagesConsulted ?? [];
	const consultedList = result.pagesConsulted ?? [];
	return (
		<div className="ls-card" data-testid="pdf-brief-card">
			<div className="ls-card-h">
				<Icon name="pdf" size="sm" />
				<span className="ls-card-t">PDF brief</span>
				{failed && <span className="pill danger">failed</span>}
			</div>
			<div className="ls-card-b">
				<MessageResponse>{result.brief}</MessageResponse>
			</div>
			{!failed && readList.length > 0 && <div className="ls-card-f">Pages read: {readList.join(", ")}</div>}
			{!failed && consultedList.length > readList.length && (
				<div className="ls-card-f">Pages consulted: {consultedList.join(", ")}</div>
			)}
		</div>
	);
}

export function ResearchBriefCard({ output }: { output: unknown }) {
	const result = output as ResearchResult | undefined;
	if (!result || typeof result.brief !== "string") {
		return (
			<div className="ls-card">
				<div className="ls-card-b">Research finished, but the result could not be displayed.</div>
			</div>
		);
	}
	const failed = result.brief.startsWith("Research failed");
	return (
		<div className="ls-card" data-testid="research-brief-card">
			<div className="ls-card-h">
				<Icon name="research" size="sm" />
				<span className="ls-card-t">Research brief</span>
				{failed && <span className="pill danger">failed</span>}
			</div>
			<div className="ls-card-b">
				<MessageResponse>{result.brief}</MessageResponse>
			</div>
			{result.sources.length > 0 && (
				<div className="ls-card-f">
					<span className="over">Sources</span>
					<ul className="ls-sources">
						{result.sources.map((s) => (
							<li key={s.url}>
								<a href={s.url} target="_blank" rel="noopener noreferrer">
									<Icon name="external" size="xs" />
									<span>{s.title}</span>
								</a>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
