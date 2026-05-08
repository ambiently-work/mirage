import { spawn } from "node:child_process";

export interface ShellBuiltinsOptions {
	allowCommands: string[];
	timeoutMs?: number;
}

export interface ShellResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export class ShellBuiltins {
	private readonly allowCommands: Set<string>;
	private readonly timeoutMs: number;

	constructor(options: ShellBuiltinsOptions) {
		this.allowCommands = new Set(options.allowCommands);
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	runCommand(command: string, args: string[] = []): Promise<ShellResult> {
		if (!this.allowCommands.has(command)) {
			throw new Error(`Command '${command}' is not allowlisted`);
		}
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, this.timeoutMs);
			child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
			child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
			child.on("error", reject);
			child.on("close", (exitCode) => {
				clearTimeout(timer);
				resolve({ exitCode, stdout, stderr, timedOut });
			});
		});
	}
}
