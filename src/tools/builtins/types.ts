export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ToolResult {
	ok: boolean;
	content?: JsonValue;
	error?: string;
}

export interface Tool<Input extends JsonValue = JsonValue, Output extends JsonValue = JsonValue> {
	name: string;
	description: string;
	run(input: Input): Promise<Output>;
}
