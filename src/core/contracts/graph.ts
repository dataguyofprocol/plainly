import type { CallUsage, ExtractionRunUsage } from "./chat.ts";

/** Derived from chains on every read; never stored. */
export interface GraphEdge {
	from: string;
	to: string;
}

/** Premises jointly entail the conclusion. Independent arguments for one
 *  conclusion are separate chains. A chain referencing a dead node dies with it. */
export interface GraphChain {
	/** "arg_" + nanoid-like. */
	id: string;
	/** At least one. Extractor-local ids at the wire; node ids after resolution. */
	premises: string[];
	conclusion: string;
	/** Unioned across assertion lines at read time. */
	provenance: ProvenancePoint[];
	createdAt: string;
}

/** `chains` is absent only in old usage records, which carry `edges` instead. */
export interface EmissionStats {
	nodes: number;
	chains?: number;
	/** Chains the simplification pass removed in this merge. Undefined when none. */
	droppedChains?: number;
}

export interface ProvenancePoint {
	/** A chat id, or a notes source id ("src_…") for imports, which have no message anchors. */
	chatId: string;
	messageId: string;
}

/** Ids are "src_" + hash of the file path, so re-importing a file reuses its id. */
export interface NotesSource {
	id: string;
	filePath: string;
	importedAt: string;
	/** Legacy; ignored on read, never written. */
	contentFp?: string;
	/** Append-only, idempotent per startedAt. */
	extractions?: ExtractionRunUsage[];
}

export interface NamingRunStats {
	/** All sizes. */
	detected: number;
	claimed: number;
	/** Unnamed, size >= MIN_CLUSTER_SIZE. */
	named: number;
	/** Idempotent dedupe may shrink this. */
	appended: number;
}

/** Version recorded in the format.json sidecar. */
export const CURRENT_GRAPH_FORMAT_VERSION = 1;


export interface GraphNode {
	/** "n_" + nanoid-like. */
	id: string;
	/** Short presentational label; not unique. Set by the first line, never changed by link-appends. */
	name: string;
	/** The identity anchor the auditor judges re-encounters against. */
	statement: string;
	/** Verbatim phrasings sessions used. */
	aliases: string[];
	createdAt: string;
	provenance: ProvenancePoint[];
}

export interface SessionCheckpoint {
	chatId: string;
	/** The chat record's `updatedAt` at fold time. */
	foldedAt: string;
}

/** One extracted message of one chat, keyed by content fingerprint; uncovered is derived, never stored. */
export interface CoverageEntry {
	chatId: string;
	/** sha256 of the message's view lines. */
	fp: string;
	/** chars/4 estimate. */
	tokens: number;
	foldedAt: string;
}

export interface ExtractedProposition {
	/** Extractor-local id ("p1", …). */
	id: string;
	/** Becomes the node's name on create; ignored on link. */
	name: string;
	statement: string;
	aliases: string[];
	/** Session path only, validated against the current batch; undefined becomes messageId "". */
	messageId?: string;
}

/** Endpoints are extractor-local proposition ids. */
export interface ExtractedChain {
	premises: string[];
	conclusion: string;
}

export interface SessionFindings {
	propositions: ExtractedProposition[];
	chains: ExtractedChain[];
}

/** Local proposition id → the existing node it is. */
export interface IdentityLink {
	id: string;
	linkTo: string;
}

export interface AuditVerdicts {
	links: IdentityLink[];
}

export interface Cluster {
	/** The labeling record id when claimed, else a member-hash id. */
	id: string;
	label: string | null;
	/** Node ids, sorted. */
	members: string[];
}

export interface GraphSnapshot {
	/** Propositions plus derived implication nodes (id = chain id). */
	nodes: GraphNode[];
	/** Stored propositions only. */
	propositions: GraphNode[];
	/** Derived: premise → imp → conclusion. */
	edges: GraphEdge[];
	/** Derived: each chain contracted to premise → conclusion over proposition ids. */
	logicalEdges: GraphEdge[];
	/** One per multi-premise live chain. */
	impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
	/** Stored chains, merged by (premises, conclusion). */
	chains: GraphChain[];
	/** chatId → title. */
	sessions: Record<string, string>;
	/** srcId → file path for imported notes. */
	fileSources: Record<string, string>;
	/** nodeId → chatIds that touched the node. */
	nodeSessions: Record<string, string[]>;
	/** Birth-session communities over propositions only. */
	clusters: Cluster[];
	/** Absent on a fresh graph. */
	positions?: Record<string, Position>;
}

export interface Position {
	x: number;
	y: number;
}

export const TITLE_MAX_CHARS = 72;

/** Collapses whitespace and cuts at a word boundary at or under TITLE_MAX_CHARS,
 *  splitting only a single word longer than the cap. */
export function titleFromPrompt(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	if (oneLine.length <= TITLE_MAX_CHARS) return oneLine;
	let cut = -1;
	for (let i = TITLE_MAX_CHARS; i > 0; i--) {
		if (oneLine[i - 1] === " ") {
			cut = i - 1;
			break;
		}
	}
	if (cut < 0) cut = TITLE_MAX_CHARS;
	return `${oneLine.slice(0, cut)}…`;
}
