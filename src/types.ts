export interface MirageStats {
	size: number;
	mode: number;
	uid: number;
	gid: number;
	atime: number;
	mtime: number;
	ctime: number;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymlink(): boolean;
}

export interface IFileSystem {
	readFile(path: string): string;
	readDir(path: string): string[];
	stat(path: string): MirageStats;
	lstat(path: string): MirageStats;
	exists(path: string): boolean;
	writeFile(path: string, content: string): void;
	appendFile(path: string, content: string): void;
	mkdir(path: string, options?: { recursive?: boolean }): void;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): void;
	cp(src: string, dest: string, options?: { recursive?: boolean }): void;
	mv(src: string, dest: string): void;
	chmod(path: string, mode: number): void;
	chown(path: string, uid: number, gid: number): void;
	symlink(target: string, path: string): void;
	readlink(path: string): string;
	realpath(path: string): string;
	glob(pattern: string, options?: { cwd?: string }): string[];
}
