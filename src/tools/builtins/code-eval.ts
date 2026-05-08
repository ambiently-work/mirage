export interface CodeEvalSandbox {
	runTypeScript(source: string): Promise<unknown>;
}

export class CodeEvalBuiltins {
	constructor(private readonly sandbox: CodeEvalSandbox) {}

	async evaluate(source: string): Promise<unknown> {
		return this.sandbox.runTypeScript(source);
	}
}
