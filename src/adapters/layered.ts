import type { IFileSystem, MirageStats } from "../types.js";

/**
 * Union/overlay filesystem. Reads cascade through layers (first match wins).
 * Writes go to the top (writable) layer. Lower layers are never modified.
 *
 * Think: Docker image layers or overlayfs.
 *
 * Usage:
 *   const fs = new LayeredFileSystem(writableLayer, readonlyBase);
 */
export class LayeredFileSystem implements IFileSystem {
	private layers: IFileSystem[];

	constructor(...layers: IFileSystem[]) {
		if (layers.length === 0) {
			throw new Error("LayeredFileSystem requires at least one layer");
		}
		this.layers = layers;
	}

	/** The top layer where writes go */
	get writable(): IFileSystem {
		// Constructor guarantees layers.length >= 1
		return this.layers[0] as IFileSystem;
	}

	readFile(path: string): string {
		for (const layer of this.layers) {
			try {
				if (layer.exists(path)) {
					return layer.readFile(path);
				}
			} catch {}
		}
		throw new Error(`ENOENT: no such file or directory: ${path}`);
	}

	readDir(path: string): string[] {
		const entries = new Set<string>();
		for (const layer of this.layers) {
			try {
				if (layer.exists(path)) {
					for (const entry of layer.readDir(path)) {
						entries.add(entry);
					}
				}
			} catch {}
		}
		if (entries.size === 0) {
			let found = false;
			for (const layer of this.layers) {
				try {
					if (layer.exists(path) && layer.stat(path).isDirectory()) {
						found = true;
						break;
					}
				} catch {}
			}
			if (!found) throw new Error(`ENOENT: no such file or directory: ${path}`);
		}
		return [...entries].sort();
	}

	stat(path: string): MirageStats {
		for (const layer of this.layers) {
			try {
				if (layer.exists(path)) {
					return layer.stat(path);
				}
			} catch {}
		}
		throw new Error(`ENOENT: no such file or directory: ${path}`);
	}

	lstat(path: string): MirageStats {
		for (const layer of this.layers) {
			try {
				if (layer.exists(path)) {
					return layer.lstat(path);
				}
			} catch {}
		}
		throw new Error(`ENOENT: no such file or directory: ${path}`);
	}

	exists(path: string): boolean {
		return this.layers.some((layer) => {
			try {
				return layer.exists(path);
			} catch {
				return false;
			}
		});
	}

	writeFile(path: string, content: string): void {
		this.writable.writeFile(path, content);
	}

	appendFile(path: string, content: string): void {
		try {
			const existing = this.readFile(path);
			this.writable.writeFile(path, existing + content);
		} catch {
			this.writable.writeFile(path, content);
		}
	}

	mkdir(path: string, options?: { recursive?: boolean }): void {
		this.writable.mkdir(path, options);
	}

	rm(path: string, options?: { recursive?: boolean; force?: boolean }): void {
		this.writable.rm(path, options);
	}

	cp(src: string, dest: string, options?: { recursive?: boolean }): void {
		const srcStat = this.stat(src);
		if (srcStat.isDirectory()) {
			if (!options?.recursive) {
				throw new Error(`EISDIR: illegal operation on a directory: ${src}`);
			}
			this.writable.mkdir(dest, { recursive: true });
			for (const entry of this.readDir(src)) {
				const childSrc = src === "/" ? `/${entry}` : `${src}/${entry}`;
				const childDest = dest === "/" ? `/${entry}` : `${dest}/${entry}`;
				this.cp(childSrc, childDest, options);
			}
		} else {
			const content = this.readFile(src);
			this.writable.writeFile(dest, content);
		}
	}

	mv(src: string, dest: string): void {
		const content = this.readFile(src);
		this.writable.writeFile(dest, content);
		try {
			this.writable.rm(src);
		} catch {
			// Source may be in a lower layer — can't delete
		}
	}

	chmod(path: string, mode: number): void {
		this.writable.chmod(path, mode);
	}

	chown(path: string, uid: number, gid: number): void {
		this.writable.chown(path, uid, gid);
	}

	symlink(target: string, path: string): void {
		this.writable.symlink(target, path);
	}

	readlink(path: string): string {
		for (const layer of this.layers) {
			try {
				return layer.readlink(path);
			} catch {}
		}
		throw new Error(`EINVAL: not a symlink: ${path}`);
	}

	realpath(path: string): string {
		for (const layer of this.layers) {
			try {
				if (layer.exists(path)) {
					return layer.realpath(path);
				}
			} catch {}
		}
		throw new Error(`ENOENT: no such file or directory: ${path}`);
	}

	glob(pattern: string, options?: { cwd?: string }): string[] {
		const results = new Set<string>();
		for (const layer of this.layers) {
			try {
				for (const match of layer.glob(pattern, options)) {
					results.add(match);
				}
			} catch {}
		}
		return [...results].sort();
	}
}
