"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/icon";

export interface GraphContextData {
	propositions: { id: string; name: string; statement: string }[];
	chains: string[];
}

export function GraphContextCard({ data }: { data: GraphContextData }) {
	const [open, setOpen] = useState(false);
	const { propositions = [], chains = [] } = data ?? {};
	const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	return (
		<div data-testid="graph-context-card" className={`gctx ${open ? "open" : ""}`}>
			<button type="button" data-testid="graph-context-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="gctx-bar">
				<Icon name="knowledge" size="sm" className="gctx-ic" />
				<span className="gctx-t">From your knowledge graph</span>
				<span className="gctx-m trunc num">
					<span>{noun(propositions.length, "idea", "ideas")}</span>
					{chains.length > 0 && <span> · {noun(chains.length, "chain", "chains")}</span>}
				</span>
				<Icon name="chevron-down" size="sm" className="gctx-chev" />
			</button>
			{open && (
				<div data-testid="graph-context-body" className="gctx-body fade">
					{propositions.map((p) => (
						<div key={p.id} data-testid={`graph-context-prop-${p.id}`} className="gctx-idea">
							<span className="gctx-name serif">{p.name}</span>
							<span className="gctx-stmt">{p.statement}</span>
						</div>
					))}
					{chains.length > 0 && (
						<div className="gctx-links">
							{chains.map((c, i) => (
								<div key={i} className="mono">
									{c}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
