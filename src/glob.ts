import { isAbsolute, join } from "./path.js";
import type { IFileSystem } from "./types.js";
import type { WasmGlobModule } from "./wasm.js";

let wasmGlobMatch: ((pattern: string, path: string) => boolean) | null = null;

export function useWasmGlob(module: WasmGlobModule): void {
	wasmGlobMatch = (pattern, path) => module.globMatch(pattern, path);
}

/**
 * Match a glob pattern against a path string.
 *
 * Supports: *, **, ?, [abc], [a-z], [!abc], {a,b,c}, and \ escaping.
 */
export function globMatch(pattern: string, path: string): boolean {
	if (wasmGlobMatch) return wasmGlobMatch(pattern, path);
	const expanded = expandBraces(pattern);
	return expanded.some((p) => matchSingle(p, path));
}

/**
 * Expand brace alternation: "{a,b,c}" → ["a", "b", "c"].
 * Supports nested braces.
 */
function expandBraces(pattern: string): string[] {
	const braceStart = findTopLevelBrace(pattern);
	if (braceStart === -1) return [pattern];

	const braceEnd = findMatchingBrace(pattern, braceStart);
	if (braceEnd === -1) return [pattern];

	const prefix = pattern.slice(0, braceStart);
	const suffix = pattern.slice(braceEnd + 1);
	const alternatives = splitBraceAlternatives(pattern.slice(braceStart + 1, braceEnd));

	const results: string[] = [];
	for (const alt of alternatives) {
		for (const expanded of expandBraces(prefix + alt + suffix)) {
			results.push(expanded);
		}
	}
	return results;
}

function findTopLevelBrace(pattern: string): number {
	let escaped = false;
	for (let i = 0; i < pattern.length; i++) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (pattern[i] === "\\") {
			escaped = true;
			continue;
		}
		if (pattern[i] === "{") return i;
	}
	return -1;
}

function findMatchingBrace(pattern: string, start: number): number {
	let depth = 0;
	let escaped = false;
	for (let i = start; i < pattern.length; i++) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (pattern[i] === "\\") {
			escaped = true;
			continue;
		}
		if (pattern[i] === "{") depth++;
		if (pattern[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function splitBraceAlternatives(content: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	let escaped = false;

	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (escaped) {
			current += `\\${ch}`;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "{") {
			depth++;
			current += ch;
		} else if (ch === "}") {
			depth--;
			current += ch;
		} else if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	parts.push(current);
	return parts;
}

/**
 * Match a single expanded pattern (no braces) against a path.
 */
function matchSingle(pattern: string, path: string): boolean {
	return doMatch(pattern, 0, path, 0);
}

function doMatch(pattern: string, pi: number, str: string, si: number): boolean {
	while (pi < pattern.length) {
		const ch = pattern[pi];

		if (ch === "\\") {
			pi++;
			if (pi >= pattern.length) return false;
			if (si >= str.length || str[si] !== pattern[pi]) return false;
			pi++;
			si++;
			continue;
		}

		if (ch === "*" && pi + 1 < pattern.length && pattern[pi + 1] === "*") {
			pi += 2;
			if (pi < pattern.length && pattern[pi] === "/") {
				pi++;
			}

			if (pi >= pattern.length) return true;

			for (let i = si; i <= str.length; i++) {
				if (doMatch(pattern, pi, str, i)) return true;
			}
			return false;
		}

		if (ch === "*") {
			pi++;
			for (let i = si; i <= str.length; i++) {
				if (i > si && str[i - 1] === "/") break;
				if (doMatch(pattern, pi, str, i)) return true;
			}
			return false;
		}

		if (ch === "?") {
			if (si >= str.length || str[si] === "/") return false;
			pi++;
			si++;
			continue;
		}

		if (ch === "[") {
			const closeIdx = findClassClose(pattern, pi);
			if (closeIdx === -1) {
				if (si >= str.length || str[si] !== "[") return false;
				pi++;
				si++;
				continue;
			}
			if (si >= str.length || str[si] === "/") return false;

			const classContent = pattern.slice(pi + 1, closeIdx);
			const negate = classContent.startsWith("!");
			const chars = negate ? classContent.slice(1) : classContent;
			const ch2 = str[si];
			if (ch2 === undefined) return false;
			const matched = matchCharClass(chars, ch2);

			if (negate ? matched : !matched) return false;
			pi = closeIdx + 1;
			si++;
			continue;
		}

		if (si >= str.length || str[si] !== ch) return false;
		pi++;
		si++;
	}

	return si >= str.length;
}

function findClassClose(pattern: string, start: number): number {
	for (let i = start + 1; i < pattern.length; i++) {
		if (pattern[i] === "]" && i > start + 1) return i;
	}
	return -1;
}

function matchCharClass(classContent: string, ch: string): boolean {
	let i = 0;
	while (i < classContent.length) {
		const current = classContent[i];
		if (current === undefined) break;
		if (i + 2 < classContent.length && classContent[i + 1] === "-") {
			const rangeEnd = classContent[i + 2];
			if (rangeEnd !== undefined && ch >= current && ch <= rangeEnd) return true;
			i += 3;
		} else {
			if (ch === current) return true;
			i++;
		}
	}
	return false;
}

/**
 * Walk the VFS and return all file paths matching a glob pattern.
 */
export function globFiles(fs: IFileSystem, pattern: string, cwd: string): string[] {
	const absPattern = isAbsolute(pattern) ? pattern : join(cwd, pattern);
	const results: string[] = [];

	collectPaths(fs, "/", results);

	return results.filter((p) => globMatch(absPattern, p)).sort();
}

function collectPaths(fs: IFileSystem, dir: string, results: string[]): void {
	let entries: string[];
	try {
		entries = fs.readDir(dir);
	} catch {
		return;
	}

	for (const entry of entries) {
		const fullPath = dir === "/" ? `/${entry}` : `${dir}/${entry}`;
		results.push(fullPath);
		if (fs.exists(fullPath)) {
			try {
				const stat = fs.lstat(fullPath);
				if (stat.isDirectory()) {
					collectPaths(fs, fullPath, results);
				}
			} catch {
				// skip inaccessible
			}
		}
	}
}
