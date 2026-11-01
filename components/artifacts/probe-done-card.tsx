"use client";

import { Icon } from "@/components/ui/icon";
import { parseProbeDoneInput, type ProbeDoneResult } from "@/src/core";

export function ProbeDoneCard({ part }: { part: { input?: unknown; output?: unknown; state?: unknown } }) {
	const output = part.output as ProbeDoneResult | undefined;
	const state = typeof part.state === "string" ? part.state : "";

	const input = parseProbeDoneInput(part.input);

	const assessment = input?.assessment;
	const strands = assessment && Array.isArray(assessment.strands) ? assessment.strands : null;

	return (
		<div data-testid="probe-done-card" className="ls-card">
			<div className="ls-card-h">
				<Icon name="learn" size="sm" />
				<span className="ls-card-t">Where you’re starting from</span>
				<span className="ls-card-sub">from the check-in</span>
			</div>
			{output && !output.ok ? (
				<p className="ls-card-b">The prober retried: {output.error}</p>
			) : state === "output-error" ? (
				<p className="ls-card-b">The assessment was malformed — the prober retried with a corrected one.</p>
			) : strands ? (
				<>
					<ul className="ls-strands">
						{strands.map((s, i) => (
							<li key={i}>
								<b>{s.strand}</b>
								<span>{s.assessment}</span>
							</li>
						))}
					</ul>
					{assessment?.summary && <p className="ls-summary">{assessment.summary}</p>}
				</>
			) : (
				<p className="ls-card-b">Writing the assessment…</p>
			)}
		</div>
	);
}
