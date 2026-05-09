export interface HttpBuiltinsOptions {
	allowlist: string[];
	maxBytes?: number;
}

export class HttpBuiltins {
	private readonly allowlist: string[];
	private readonly maxBytes: number;

	constructor(options: HttpBuiltinsOptions) {
		this.allowlist = options.allowlist;
		this.maxBytes = options.maxBytes ?? 1024 * 1024;
	}

	async httpRequest(url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
		const allowed = this.allowlist.some((prefix) => url.startsWith(prefix));
		if (!allowed) throw new Error("URL is not allowlisted");
		const res = await fetch(url, init);
		const text = await res.text();
		if (new TextEncoder().encode(text).byteLength > this.maxBytes) {
			throw new Error("Response exceeds configured maxBytes");
		}
		return { status: res.status, body: text };
	}
}
