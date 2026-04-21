/**
 * Pure-JS `.gitignore` matcher — no Node.js dependencies, safe for browser
 * and server. Implements the commonly-used subset of the gitignore(5) spec:
 *
 *   - blank lines and `#` comments are skipped
 *   - `!pattern` negates a previously-ignored path
 *   - trailing `/` means the pattern only matches directories
 *   - a leading `/` or a `/` in the middle anchors the pattern to the
 *     gitignore's base directory; otherwise the pattern may match at any depth
 *   - `*` matches anything except `/`
 *   - `?` matches a single character except `/`
 *   - `[abc]` / `[!abc]` character classes
 *   - `**` matches any number of path segments (including zero)
 *
 * Not implemented: git's special handling for patterns with escaped `\`,
 * per-directory negations of an already-excluded parent dir (git forbids
 * re-including a child when a parent is excluded — we match that behaviour
 * via {@link GitIgnore.ignores} walking ancestors).
 */
export interface GitIgnoreRule {
	/** The original pattern text (without leading `!` or trailing `/`). */
	pattern: string;
	/** Base directory (posix, no leading/trailing `/`) the rule was declared in. */
	base: string;
	/** `true` if the rule starts with `!`. */
	negate: boolean;
	/** `true` if the rule ends with `/` and only matches directories. */
	dirOnly: boolean;
	/** Compiled matcher. Tested against paths relative to the repo root. */
	regex: RegExp;
}

export interface GitIgnoreAddOptions {
	/**
	 * Directory the `.gitignore` lives in, relative to the repo root.
	 * Defaults to `""` (repo root). Leading/trailing slashes are stripped.
	 */
	base?: string;
}

/**
 * A stateful collection of gitignore rules. Rules are evaluated in insertion
 * order; the last matching rule wins. Directory-only rules (`foo/`) only
 * match when the candidate is itself a directory, but ancestors of a queried
 * path are checked as directories automatically, so files under an ignored
 * directory are reported as ignored.
 */
export class GitIgnore {
	private readonly rules: GitIgnoreRule[] = [];

	constructor(initial?: string | string[], options?: GitIgnoreAddOptions) {
		if (initial !== undefined) this.add(initial, options);
	}

	/** Append rules from a `.gitignore` file's contents. */
	add(content: string | string[], options?: GitIgnoreAddOptions): this {
		const base = normalizeBase(options?.base ?? "");
		const lines = Array.isArray(content) ? content : content.split(/\r?\n/);
		for (const raw of lines) {
			const rule = parseLine(raw, base);
			if (rule) this.rules.push(rule);
		}
		return this;
	}

	/** Total number of active rules. */
	get size(): number {
		return this.rules.length;
	}

	/** Snapshot of the compiled rules. */
	getRules(): readonly GitIgnoreRule[] {
		return this.rules;
	}

	/**
	 * Check whether `path` is ignored. Path is normalised to posix-style,
	 * relative to the repo root (leading `/` stripped). Any ancestor directory
	 * that is ignored causes the path to be ignored too — matching git's
	 * "can't re-include a child of an excluded parent" rule.
	 */
	ignores(path: string, isDir: boolean = false): boolean {
		const clean = stripSlashes(path);
		if (clean === "") return false;

		const parts = clean.split("/");
		for (let i = 1; i < parts.length; i++) {
			const ancestor = parts.slice(0, i).join("/");
			if (this.match(ancestor, true) === "ignored") return true;
		}
		return this.match(clean, isDir) === "ignored";
	}

	private match(path: string, isDir: boolean): "ignored" | "included" | "unmatched" {
		let state: "ignored" | "included" | "unmatched" = "unmatched";
		for (const rule of this.rules) {
			if (rule.dirOnly && !isDir) continue;
			if (rule.regex.test(path)) {
				state = rule.negate ? "included" : "ignored";
			}
		}
		return state;
	}
}

/**
 * Parse a `.gitignore` file's contents into {@link GitIgnoreRule rules}.
 * Returns an empty array if the content has no actionable patterns.
 */
export function parseGitignore(content: string, base: string = ""): GitIgnoreRule[] {
	const gi = new GitIgnore(content, { base });
	return [...gi.getRules()];
}

/** Convenience: match a single path against raw gitignore content. */
export function matchGitignore(
	content: string,
	path: string,
	options?: { base?: string; isDir?: boolean },
): boolean {
	return new GitIgnore(content, { base: options?.base }).ignores(path, options?.isDir ?? false);
}

function parseLine(raw: string, base: string): GitIgnoreRule | null {
	// Strip trailing unescaped whitespace
	let line = raw.replace(/\s+$/u, "");
	if (line === "") return null;
	if (line.startsWith("#")) return null;

	let negate = false;
	if (line.startsWith("\\#") || line.startsWith("\\!")) {
		// Escaped — peel off the backslash and don't treat the next char as syntax.
		line = line.slice(1);
	} else if (line.startsWith("!")) {
		negate = true;
		line = line.slice(1);
	}
	if (line === "") return null;

	let dirOnly = false;
	if (line.endsWith("/")) {
		dirOnly = true;
		line = line.slice(0, -1);
	}
	if (line === "") return null;

	const regex = compileToRegex(line, base);
	return { pattern: line, base, negate, dirOnly, regex };
}

function compileToRegex(pattern: string, base: string): RegExp {
	let p = pattern;
	let anchored = false;
	if (p.startsWith("/")) {
		anchored = true;
		p = p.slice(1);
	} else {
		// A "/" anywhere else in the pattern (not just trailing, we've already
		// stripped that) anchors the pattern to `base`.
		const firstSlash = p.indexOf("/");
		if (firstSlash !== -1 && firstSlash !== p.length - 1) {
			anchored = true;
		}
	}

	let body = "";
	for (let i = 0; i < p.length; ) {
		const c = p[i];
		// `**` handling — must be glued to `/` on at least one side (or start/end)
		if (c === "*" && p[i + 1] === "*") {
			const prevBoundary = i === 0 || p[i - 1] === "/";
			const nextChar = p[i + 2];
			if (prevBoundary && nextChar === "/") {
				// `**/` — match zero or more directories
				body += "(?:.+/)?";
				i += 3;
				continue;
			}
			if (prevBoundary && nextChar === undefined) {
				// Trailing `**` — match anything (including nothing)
				body += ".*";
				i += 2;
				continue;
			}
			// `**` not at a directory boundary is treated like a single `*`
			// (gitignore spec says "other consecutive asterisks are considered
			// regular asterisks").
			body += "[^/]*";
			i += 2;
			continue;
		}
		if (c === "*") {
			body += "[^/]*";
			i += 1;
			continue;
		}
		if (c === "?") {
			body += "[^/]";
			i += 1;
			continue;
		}
		if (c === "[") {
			const close = p.indexOf("]", i + 1);
			if (close === -1) {
				body += "\\[";
				i += 1;
				continue;
			}
			let cls = p.slice(i + 1, close);
			if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
			// Escape the closing bracket can't appear inside [] without escaping;
			// leave the rest of the class verbatim.
			body += `[${cls}]`;
			i = close + 1;
			continue;
		}
		if (c === "\\" && i + 1 < p.length) {
			body += escapeRegex(p[i + 1] ?? "");
			i += 2;
			continue;
		}
		if (c !== undefined) {
			body += escapeRegex(c);
		}
		i += 1;
	}

	const basePart = base === "" ? "" : `${base.split("/").map(escapeRegex).join("/")}/`;
	const prefix = anchored ? `^${basePart}` : `^${basePart}(?:.*/)?`;
	// Allow the pattern to match a directory plus any descendants — "foo" as a
	// pattern should ignore both the file `foo` and everything under the dir
	// `foo`. We enforce dir-only semantics separately via the `dirOnly` flag.
	const suffix = "(?:/.*)?$";
	return new RegExp(prefix + body + suffix);
}

function escapeRegex(c: string): string {
	return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBase(base: string): string {
	return stripSlashes(base);
}

function stripSlashes(p: string): string {
	let out = p;
	while (out.startsWith("/")) out = out.slice(1);
	while (out.endsWith("/")) out = out.slice(0, -1);
	return out;
}
