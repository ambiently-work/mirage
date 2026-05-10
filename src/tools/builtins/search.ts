export interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
}

export interface WebSearchAdapter {
	search(query: string, limit?: number): Promise<SearchResult[]>;
}

export class SearchBuiltins {
	constructor(private readonly adapter: WebSearchAdapter) {}

	webSearch(query: string, limit = 5): Promise<SearchResult[]> {
		return this.adapter.search(query, limit);
	}
}
