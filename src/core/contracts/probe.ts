import { Type, type Static } from "typebox";

export interface ProbeStrand {
	strand: string;
	assessment: string;
}

export interface ProbeAssessment {
	strands: ProbeStrand[];
	summary?: string;
}

export interface ProbeDoneInput {
	assessment: ProbeAssessment;
}

export const probeDoneInputSchema = Type.Object({
	assessment: Type.Object(
		{
			strands: Type.Array(
				Type.Object({
					strand: Type.String({
						description:
							"The dependency strand (e.g. 'the derivative as a limit') — a name the plan can hang a node on.",
					}),
					assessment: Type.String({
						description:
							"Where his edge sits on this strand: the floor (what he reliably gets right), the ceiling (where it runs out), " +
							"misconceptions found, and what the lesson should build from.",
					}),
				}),
				{ minItems: 1, description: "Every strand the planned lesson will depend on, each with your read of his edge on it." },
			),
			summary: Type.Optional(
				Type.String({
					description: "Optional overall synthesis: his apparent goal and where the teaching should enter.",
				}),
			),
		},
		{ description: "The learner assessment — the probe's distilled output." },
	),
});

/** Compiles only while the schema's static shape matches ProbeDoneInput. */
export const probeDoneSchemaLock = (v: Static<typeof probeDoneInputSchema>): ProbeDoneInput => v;

export interface ProbeDoneResult {
	ok: boolean;
	error?: string;
}

export const PROBE_DONE_ACK_TEXT =
	"Assessment recorded — it is shown to the learner now and the teacher plans from it. Say your closing sentence and end your turn; the teaching phase takes over from here.";
