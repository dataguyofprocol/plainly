export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

export type SearchEngineId = "tavily" | "brave";

/** `search` throws on failure; callers catch and report. */
export interface SearchProvider {
	id: SearchEngineId;
	search(query: string, count: number): Promise<SearchHit[]>;
}

export interface SearchStatus {
	available: boolean;
	/** Null when unavailable. */
	engine: SearchEngineId | null;
	reason: string;
}
