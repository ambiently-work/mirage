/**
 * Optional WASM acceleration hooks.
 *
 * Mirage's core is pure TypeScript. Consumers that want faster glob matching
 * (or other compute-heavy operations) can provide a WASM module that conforms
 * to one of these interfaces and inject it via the corresponding `useWasm*`
 * setter.
 */

/** WASM-accelerable glob matching. */
export interface WasmGlobModule {
	globMatch(pattern: string, path: string): boolean;
}
