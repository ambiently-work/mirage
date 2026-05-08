import { globMatch } from "../glob.js";
import { basename, extname, isAbsolute, join, normalize } from "../path.js";
import type { IFileSystem, MirageStats } from "../types.js";

export type HookOperation = "write" | "append" | "copy";

export interface FileHookContext {
	/** Path as it was passed to the filesystem call. */
	path: string;
	/**
	 * Normalized absolute-ish path used for rule matching. Relative input is
	 * matched from "/" because IFileSystem does not expose cwd.
	 */
	normalizedPath: string;
	operation: HookOperation;
	filesystem: IFileSystem;
}

export type FileHookResult = string | Uint8Array | undefined;

export type FileHook = (content: string | Uint8Array, context: FileHookContext) => FileHookResult;

export interface HookRule {
	/** Human-readable label used by callers for diagnostics. */
	name?: string;
	/** Match one or more glob patterns against the normalized path. */
	glob?: string | string[];
	/** Match one or more file extensions, with or without the leading dot. */
	extensions?: string | string[];
	/** Extra predicate for path- or content-aware routing. */
	test?: (context: FileHookContext, content: string | Uint8Array) => boolean;
	/**
	 * Hook to run when this rule matches. Return modified content for formatters,
	 * throw for linters, or return nothing to leave content unchanged.
	 */
	hook: FileHook;
}

export interface HookedFileSystemOptions {
	rules?: HookRule[];
}

/**
 * Wraps any IFileSystem and runs ordered hooks before content is written.
 *
 * Formatters return modified content. Linters throw to reject a write. Rules can
 * be selected by glob, extension, a custom predicate, or any combination.
 */
export class HookedFileSystem implements IFileSystem {
	private rules: HookRule[];

	constructor(
		private inner: IFileSystem,
		options?: HookedFileSystemOptions,
	) {
		this.rules = [...(options?.rules ?? [])];
	}

	addHook(rule: HookRule): void {
		this.rules.push(rule);
	}

	getHooks(): HookRule[] {
		return [...this.rules];
	}

	readFile(path: string): string {
		return this.inner.readFile(path);
	}

	readFileBytes(path: string): Uint8Array {
		return this.inner.readFileBytes(path);
	}

	readDir(path: string): string[] {
		return this.inner.readDir(path);
	}

	stat(path: string): MirageStats {
		return this.inner.stat(path);
	}

	lstat(path: string): MirageStats {
		return this.inner.lstat(path);
	}

	exists(path: string): boolean {
		return this.inner.exists(path);
	}

	writeFile(path: string, content: string): void {
		const next = this.runHooks(content, this.context(path, "write"));
		if (typeof next !== "string") {
			throw new Error(`EINVAL: writeFile hook returned bytes for text path: ${path}`);
		}
		this.inner.writeFile(path, next);
	}

	writeFileBytes(path: string, content: Uint8Array): void {
		const next = this.runHooks(content, this.context(path, "write"));
		this.inner.writeFileBytes(path, toBytes(next));
	}

	appendFile(path: string, content: string): void {
		let existing = "";
		try {
			existing = this.inner.readFile(path);
		} catch (err) {
			if (!(err instanceof Error) || !err.message.startsWith("ENOENT")) {
				throw err;
			}
		}
		const next = this.runHooks(existing + content, this.context(path, "append"));
		if (typeof next !== "string") {
			throw new Error(`EINVAL: appendFile hook returned bytes for text path: ${path}`);
		}
		this.inner.writeFile(path, next);
	}

	mkdir(path: string, options?: { recursive?: boolean }): void {
		this.inner.mkdir(path, options);
	}

	rm(path: string, options?: { recursive?: boolean; force?: boolean }): void {
		this.inner.rm(path, options);
	}

	cp(src: string, dest: string, options?: { recursive?: boolean }): void {
		const srcStat = this.inner.stat(src);
		if (srcStat.isDirectory()) {
			if (!options?.recursive) {
				throw new Error(`EISDIR: illegal operation on a directory: ${src}`);
			}
			this.inner.mkdir(dest, { recursive: true });
			for (const entry of this.inner.readDir(src)) {
				const childSrc = src === "/" ? `/${entry}` : `${src}/${entry}`;
				const childDest = dest === "/" ? `/${entry}` : `${dest}/${entry}`;
				this.cp(childSrc, childDest, options);
			}
			return;
		}

		const finalDest = this.destinationPath(src, dest);
		const next = this.runHooks(this.inner.readFileBytes(src), this.context(finalDest, "copy"));
		this.inner.writeFileBytes(finalDest, toBytes(next));
	}

	mv(src: string, dest: string): void {
		this.inner.mv(src, dest);
	}

	chmod(path: string, mode: number): void {
		this.inner.chmod(path, mode);
	}

	chown(path: string, uid: number, gid: number): void {
		this.inner.chown(path, uid, gid);
	}

	symlink(target: string, path: string): void {
		this.inner.symlink(target, path);
	}

	readlink(path: string): string {
		return this.inner.readlink(path);
	}

	realpath(path: string): string {
		return this.inner.realpath(path);
	}

	glob(pattern: string, options?: { cwd?: string }): string[] {
		return this.inner.glob(pattern, options);
	}

	private runHooks(content: string | Uint8Array, context: FileHookContext): string | Uint8Array {
		let next = content;
		for (const rule of this.rules) {
			if (!matchesRule(rule, context, next)) continue;
			const result = rule.hook(next, context);
			if (result !== undefined) next = result;
		}
		return next;
	}

	private context(path: string, operation: HookOperation): FileHookContext {
		return {
			path,
			normalizedPath: normalizeForMatch(path),
			operation,
			filesystem: this.inner,
		};
	}

	private destinationPath(src: string, dest: string): string {
		try {
			if (this.inner.stat(dest).isDirectory()) {
				return join(dest, basename(src));
			}
		} catch {}
		return dest;
	}
}

function matchesRule(
	rule: HookRule,
	context: FileHookContext,
	content: string | Uint8Array,
): boolean {
	const hasPathMatcher = rule.glob !== undefined || rule.extensions !== undefined;
	const globMatched =
		rule.glob === undefined ||
		asArray(rule.glob).some((pattern) => globMatch(pattern, context.normalizedPath));
	const extMatched =
		rule.extensions === undefined ||
		asArray(rule.extensions).some(
			(extension) => normalizeExtension(extension) === extname(context.normalizedPath),
		);
	const testMatched = rule.test === undefined || rule.test(context, content);
	return (!hasPathMatcher || (globMatched && extMatched)) && testMatched;
}

function normalizeForMatch(path: string): string {
	return normalize(isAbsolute(path) ? path : `/${path}`);
}

function normalizeExtension(extension: string): string {
	return extension.startsWith(".") ? extension : `.${extension}`;
}

function asArray<T>(value: T | T[]): T[] {
	return Array.isArray(value) ? value : [value];
}

function toBytes(content: string | Uint8Array): Uint8Array {
	if (typeof content === "string") return new TextEncoder().encode(content);
	return content;
}
