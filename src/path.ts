/**
 * Pure path utilities — no Node.js dependencies.
 * All paths use "/" as separator.
 */

export function isAbsolute(path: string): boolean {
	return path.startsWith("/");
}

export function normalize(path: string): string {
	if (path === "") return ".";

	const absolute = isAbsolute(path);
	const trailingSlash = path.endsWith("/") && path !== "/";

	const segments = path.split("/").filter((s) => s !== "");
	const result: string[] = [];

	for (const seg of segments) {
		if (seg === ".") {
			continue;
		}
		if (seg === "..") {
			if (absolute) {
				result.pop();
			} else if (result.length > 0 && result[result.length - 1] !== "..") {
				result.pop();
			} else {
				result.push("..");
			}
		} else {
			result.push(seg);
		}
	}

	if (absolute) {
		const joined = `/${result.join("/")}`;
		return trailingSlash && joined !== "/" ? `${joined}/` : joined;
	}

	const joined = result.join("/");
	if (joined === "") return ".";
	return trailingSlash ? `${joined}/` : joined;
}

export function resolve(cwd: string, path: string): string {
	if (isAbsolute(path)) {
		return normalize(path);
	}
	return normalize(`${cwd}/${path}`);
}

export function join(...parts: string[]): string {
	if (parts.length === 0) return ".";
	return normalize(parts.filter((p) => p !== "").join("/"));
}

export function dirname(path: string): string {
	if (path === "" || path === ".") return ".";
	if (path === "/") return "/";

	const normalized = normalize(path);
	if (normalized === "/") return "/";

	const lastSlash = normalized.lastIndexOf("/");
	if (lastSlash === -1) return ".";
	if (lastSlash === 0) return "/";
	return normalized.slice(0, lastSlash);
}

export function basename(path: string, ext?: string): string {
	if (path === "") return "";
	if (path === "/") return "/";

	let normalized = path;
	while (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}

	const lastSlash = normalized.lastIndexOf("/");
	const base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);

	if (ext && base.endsWith(ext)) {
		return base.slice(0, base.length - ext.length);
	}
	return base;
}

export function extname(path: string): string {
	const base = basename(path);
	const dotIndex = base.lastIndexOf(".");
	if (dotIndex <= 0) return "";
	return base.slice(dotIndex);
}

export function split(path: string): string[] {
	const normalized = normalize(path);
	if (normalized === "/") return ["/"];
	if (normalized === ".") return ["."];

	const parts = normalized.split("/").filter((s) => s !== "");
	if (isAbsolute(normalized)) {
		return ["/", ...parts];
	}
	return parts;
}

export function relative(from: string, to: string): string {
	const fromNorm = normalize(from);
	const toNorm = normalize(to);

	if (fromNorm === toNorm) return ".";

	const fromParts = fromNorm.split("/").filter((s) => s !== "");
	const toParts = toNorm.split("/").filter((s) => s !== "");

	let common = 0;
	const maxLen = Math.min(fromParts.length, toParts.length);
	while (common < maxLen && fromParts[common] === toParts[common]) {
		common++;
	}

	const upCount = fromParts.length - common;
	const ups = Array.from({ length: upCount }, () => "..");
	const downs = toParts.slice(common);

	const result = [...ups, ...downs].join("/");
	return result || ".";
}
