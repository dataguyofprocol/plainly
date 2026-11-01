import type { ComponentType } from "react";
import type { ArtifactPartProps } from "@/src/core";
import { DemoCard } from "@/components/artifacts/demo-card";
import { JobCard, PdfJobCard } from "@/components/artifacts/job-card";
import { VisualCard } from "@/components/artifacts/visual-card";
import { ProbeDoneCard } from "@/components/artifacts/probe-done-card";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import { ProblemCard, ConcludeCard } from "@/components/practice-cards";

export const artifactRenderers: Record<string, ComponentType<ArtifactPartProps>> = {
	research: JobCard,
	pdf: PdfJobCard, // sources v0 — live smoke 2026-09-19 caught the gap: without this the tool-pdf dispatch part rendered nothing
	demo: DemoCard,
	visual: VisualCard,
	probe_done: ProbeDoneCard,
	read: ToolCallCard,
	ls: ToolCallCard,
	find: ToolCallCard,
	grep: ToolCallCard,
	problem: ProblemCard,
	conclude: ConcludeCard,
	list_sessions: ToolCallCard,
	list_propositions: ToolCallCard,
};
