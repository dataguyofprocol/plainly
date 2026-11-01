import type { LhMessage } from "./native-messages.ts";
import type {
	ChatRecord,
	ChatSettings,
	ChatSummary,
	GraphChain,
	GraphNode,
	JobKind,
	JobRecord,
	ExtractionRunUsage,
	PlanTree,
	Position,
	CoverageEntry,
	SessionCheckpoint,
	TurnUsage,
	NotesSource,
} from "./contracts.ts";
import type { UserSettings } from "./settings.ts";

export interface ChatStore {
	/** Persisted immediately. Absent kind = teach. */
	createChat(title: string, kind?: "practice"): ChatRecord;
	/** Null if unknown id or corrupt file. */
	getChat(id: string): ChatRecord | null;
	/** Newest activity first. */
	listChats(): ChatSummary[];
	saveMessages(id: string, messages: LhMessage[]): void;
	saveTree(id: string, tree: PlanTree): void;
	/** Idempotent per turn id: a turn persisted twice appends once, while
	 * continuation turns sharing a response message id each keep their usage. */
	appendTurnUsage(id: string, entry: TurnUsage): void;
	/** Idempotent per startedAt. */
	appendExtractionUsage(id: string, entry: ExtractionRunUsage): void;
	/** Replace-whole. Does not bump updatedAt. */
	saveSettings(id: string, settings: ChatSettings): void;
	/** Does not bump updatedAt. */
	renameChat(id: string, title: string): ChatRecord;
	/** Does not bump updatedAt. */
	setArchived(id: string, archived: boolean): ChatRecord;
	/** False when the id is unknown. Graph-ledger purge and job cleanup are
	 *  the caller's job, not the store's. */
	deleteChat(id: string): boolean;
}

export interface GraphStore {
	appendNode(node: GraphNode): void;
	/** Append order. */
	readNodes(): GraphNode[];

	/** Duplicate (premises, conclusion) assertions append another line;
	 *  readers merge. */
	appendChain(assertion: GraphChain): void;
	readChains(): GraphChain[];

	appendCheckpoint(checkpoint: SessionCheckpoint): void;
	readCheckpoints(): SessionCheckpoint[];
	/** One line per covered message. */
	appendCoverage(entry: CoverageEntry): void;
	readCoverage(): CoverageEntry[];

	/** An upsert keeps the existing usage log. */
	upsertSource(source: NotesSource): void;
	/** Order is not significant. */
	readSources(): NotesSource[];
	/** Idempotent per startedAt. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): void;

	/** nodeId → resting {x,y}. */
	readPositions(): Record<string, Position>;
	/** Replace-whole. Only settleGraphLayout writes this. */
	writePositions(positions: Record<string, Position>): void;

	/** Atomically replaces each provided ledger (temp file + rename, so a
	 *  torn write never replaces the original); absent keys are untouched. */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
	}): void;
}

export interface CreateJobInit {
	kind: JobKind;
	chatId: string;
	toolCallId: string;
	/** Defaults to "starting". */
	activity?: string;
}

export type JobPatch = Partial<Omit<JobRecord, "id" | "kind" | "chatId" | "toolCallId" | "createdAt">>;

export interface JobStore {
	createJob(init: CreateJobInit): JobRecord;
	getJob(id: string): JobRecord | null;
	/** Null if unknown id. */
	updateJob(id: string, patch: JobPatch): JobRecord | null;
	/** Newest activity first. */
	listJobs(chatId: string): JobRecord[];
	findJobByToolCallId(chatId: string, toolCallId: string): JobRecord | null;
	/** Deletes running and finished jobs alike. Returns how many files were
	 *  removed. */
	deleteJobsForChat(chatId: string): number;
}

/** Replace-whole on the record. Schema migration happens inside
 *  readSettings, never in callers. */
export interface SettingsStore {
	/** Sanitized; null when none exists yet. */
	readSettings(): UserSettings | null;
	/** Callers pass a sanitized record. */
	writeSettings(settings: UserSettings): void;
}

/** File presence does not enable an override: the settings record's
 *  agent.prompts switch does. */
export interface PromptOverrideStore {
	/** POSIX-relative paths ("teacher/20-teaching.md"), sorted. */
	listOverrides(): string[];
	/** Null when the path has no file. */
	readOverride(segmentPath: string): string | null;
	/** Creates parent directories. */
	writeOverride(segmentPath: string, text: string): void;
	/** Switches are untouched; an on-switch with no file uses the source
	 *  default. */
	deleteOverride(segmentPath: string): void;
}

/** Flat {VAR: value} map. Values are opaque; the store does no shape
 *  validation. Unknown vars are preserved verbatim. */
export interface AuthStore {
	/** Absent or corrupt file = {}. Never throws. */
	authVars(): Record<string, string>;
	/** Atomic write, mode 0600, other vars preserved. */
	setAuthVar(name: string, value: string): void;
	/** Absent = no-op. */
	deleteAuthVar(name: string): void;
}

