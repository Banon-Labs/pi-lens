/**
 * SgRunner - encapsulates ast-grep subprocess management
 *
 * Extracted from AstGrepClient to simplify the main client.
 * Handles: spawn, spawnSync, temp dir management, JSON parsing.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SgMatch {
	file: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	text: string;
	replacement?: string;
}

export interface SgResult {
	matches: SgMatch[];
	error?: string;
}

export class SgRunner {
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[sg-runner] ${msg}`)
			: () => {};
	}

	/**
	 * Check if ast-grep CLI is available
	 */
	isAvailable(): boolean {
		const result = spawnSync("npx", ["sg", "--version"], {
			encoding: "utf-8",
			timeout: 10000,
			shell: true,
		});
		return !result.error && result.status === 0;
	}

	/**
	 * Run ast-grep asynchronously, return parsed matches
	 */
	async exec(args: string[]): Promise<SgResult> {
		return new Promise((resolve) => {
			const proc = spawn("npx", ["sg", ...args], {
				stdio: ["ignore", "pipe", "pipe"],
				shell: true,
			});
			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
			proc.stderr.on("data", (data: Buffer) => (stderr += data.toString()));

			proc.on("error", (err: Error) => {
				if (err.message.includes("ENOENT")) {
					resolve({
						matches: [],
						error: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
					});
				} else {
					resolve({ matches: [], error: err.message });
				}
			});

			proc.on("close", (code: number | null) => {
				if (code !== 0 && !stdout.trim()) {
					resolve({
						matches: [],
						error: stderr.includes("No files found")
							? undefined
							: stderr.trim() || `Exit code ${code}`,
					});
					return;
				}
				if (!stdout.trim()) {
					resolve({ matches: [] });
					return;
				}
				try {
					const parsed = JSON.parse(stdout);
					const matches = Array.isArray(parsed) ? parsed : [parsed];
					resolve({ matches });
				} catch {
					resolve({ matches: [], error: "Failed to parse output" });
				}
			});
		});
	}

	/**
	 * Run ast-grep synchronously (for simple scans)
	 */
	execSync(args: string[]): { output: string; error?: string } {
		const result = spawnSync("npx", ["sg", ...args], {
			encoding: "utf-8",
			timeout: 30000,
			shell: true,
			maxBuffer: 32 * 1024 * 1024,
		});

		if (result.error) {
			return { output: "", error: result.error.message };
		}

		const output = result.stdout || result.stderr || "";
		return { output };
	}

	/**
	 * Run a temporary rule scan (creates temp dir with rule file)
	 */
	tempScan(
		dir: string,
		ruleId: string,
		ruleYaml: string,
		timeout = 30000,
	): SgMatch[] {
		const tmpDir = os.tmpdir();
		const ts = Date.now();
		const sessionDir = path.join(tmpDir, `pi-lens-temp-${ruleId}-${ts}`);
		const rulesSubdir = path.join(sessionDir, "rules");
		const ruleFile = path.join(rulesSubdir, `${ruleId}.yml`);
		const configFile = path.join(sessionDir, ".sgconfig.yml");

		try {
			fs.mkdirSync(rulesSubdir, { recursive: true });
			fs.writeFileSync(configFile, `ruleDirs:\n  - ./rules\n`);
			fs.writeFileSync(ruleFile, ruleYaml);

			const result = spawnSync(
				"npx",
				["sg", "scan", "--config", configFile, "--json", dir],
				{ encoding: "utf-8", timeout, shell: true },
			);

			const output = result.stdout || result.stderr || "";
			if (!output.trim()) return [];

			const items = JSON.parse(output);
			return Array.isArray(items) ? items : [items];
		} catch {
			return [];
		} finally {
			try {
				fs.rmSync(sessionDir, { recursive: true, force: true });
			} catch (err) {
				this.log(`Cleanup failed: ${(err as Error).message}`);
			}
		}
	}

	/**
	 * Format matches for display
	 */
	formatMatches(matches: SgMatch[], isDryRun = false, maxItems = 50): string {
		if (matches.length === 0) return "No matches found";
		const shown = matches.slice(0, maxItems);
		const lines = shown.map((m) => {
			const loc = `${m.file}:${m.range.start.line + 1}:${m.range.start.column + 1}`;
			const text = m.text.length > 100 ? `${m.text.slice(0, 100)}...` : m.text;
			return isDryRun && m.replacement
				? `${loc}\n  - ${text}\n  + ${m.replacement}`
				: `${loc}: ${text}`;
		});
		if (matches.length > maxItems) {
			lines.unshift(
				`Found ${matches.length} matches (showing first ${maxItems}):`,
			);
		}
		return lines.join("\n");
	}
}
