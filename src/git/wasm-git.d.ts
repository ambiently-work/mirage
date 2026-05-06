// Ambient module declarations for wasm-git's WASM-loader entry points.
// The package ships JS without TS types; we treat them as opaque modules
// whose default export is an emscripten Module factory.

declare module "wasm-git/lg2.js" {
	const factory: (overrides?: Record<string, unknown>) => Promise<unknown>;
	export default factory;
}

declare module "wasm-git/lg2_async.js" {
	const factory: (overrides?: Record<string, unknown>) => Promise<unknown>;
	export default factory;
}

declare module "wasm-git/lg2_opfs.js" {
	const factory: (overrides?: Record<string, unknown>) => Promise<unknown>;
	export default factory;
}
