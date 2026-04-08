import { spawnSync } from "node:child_process";
import * as path from "node:path";

export interface Diagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	rule?: string;
	file: string;
	fixable?: boolean;
}

export abstract class SubprocessClient<T extends Diagnostic> {
	protected available: boolean | null = null;
	protected log: (msg: string) => void;
	private toolName: string;

	constructor(verbose = false) {
		this.toolName = this.getToolName();
		this.log = verbose
			? (msg: string) => console.error(`[${this.toolName}] ${msg}`)
			: () => {};
	}

	protected abstract getToolName(): string;
	protected abstract getCheckCommand(): string[];
	protected abstract getSupportedExtensions(): string[];
	protected abstract parseOutput(output: string, filePath: string): T[];

	isAvailable(): boolean {
		if (this.available !== null) return this.available;

		const cmd = this.getCheckCommand();
		try {
			const result = spawnSync(cmd[0], cmd.slice(1), {
				encoding: "utf-8",
				timeout: 10000,
				shell: true,
			});

			this.available = !result.error && result.status === 0;
			if (this.available) {
				this.log(`${this.toolName} found`);
			} else {
				this.log(`${this.toolName} not available`);
			}
		} catch (err) {
			void err;
			this.available = false;
		}

		return this.available;
	}

	isSupportedFile(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase();
		return this.getSupportedExtensions().includes(ext);
	}

	abstract checkFile(filePath: string): T[];

	protected runCommand(
		cmd: string[],
		options: {
			cwd?: string;
			timeout?: number;
			input?: string;
		} = {},
	): ReturnType<typeof spawnSync> {
		const { cwd, timeout = 15000, input } = options;

		try {
			const result = spawnSync(cmd[0], cmd.slice(1), {
				encoding: "utf-8",
				timeout,
				cwd,
				shell: true,
				input,
			});

			if (result.error) {
				this.log(`Command error: ${result.error.message}`);
			}

			return result;
		} catch (err: any) {
			this.log(`Command failed: ${err.message}`);
			return {
				error: err,
				status: 1,
				stdout: "",
				stderr: err.message,
			} as unknown as ReturnType<typeof spawnSync>;
		}
	}
}
