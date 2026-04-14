import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchLintMock = vi.fn();

vi.mock("./clients/dispatch/integration.js", () => ({
	dispatchLint: dispatchLintMock,
}));

type Handler = (event: any, ctx: any) => unknown;

function createMockPi(flagOverrides: Record<string, boolean> = {}) {
	const handlers: Record<string, Handler[]> = {};
	const commands = new Map<string, { handler?: Handler; description?: string }>();
	const flags = new Map<string, boolean>([
		["lens-verbose", false],
		["no-lsp", true],
		["no-biome", true],
		["no-ast-grep", true],
		["no-ruff", true],
		["no-madge", true],
		["no-tests", true],
		...Object.entries(flagOverrides),
	]);
	const sentMessages: Array<{ message: any; options: any }> = [];

	const pi = {
		registerTool: vi.fn(),
		registerCommand: vi.fn(
			(name: string, config: { handler?: Handler; description?: string }) => {
				commands.set(name, config);
			},
		),
		registerFlag: vi.fn((name: string, config: { default?: boolean }) => {
			if (!flags.has(name) && typeof config?.default === "boolean") {
				flags.set(name, config.default);
			}
		}),
		registerMessageRenderer: vi.fn(),
		on: vi.fn((event: string, handler: Handler) => {
			(handlers[event] ??= []).push(handler);
		}),
		getFlag: vi.fn((name: string) => flags.get(name) ?? false),
		sendMessage: vi.fn((message: any, options: any) => {
			sentMessages.push({ message, options });
		}),
	};

	return { pi, handlers, commands, sentMessages };
}

describe("index blocking diagnostics proof", () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-blocking-proof-"));
		originalCwd = process.cwd();
		process.chdir(tmpDir);
		dispatchLintMock.mockReset();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("should keep blocking diagnostics visibly surfaced by the end of the turn", async () => {
		const filePath = path.join(tmpDir, "smoke-blocking-demo.ts");
		fs.writeFileSync(
			filePath,
			"function demo(flag: boolean): number {\n  if (flag) {\n    return 1;\n  }\n}\n",
		);

		dispatchLintMock.mockResolvedValue(
			"🔴 STOP — 1 issue(s) must be fixed:\n  L1: Function lacks ending return statement and return type does not include 'undefined'.",
		);

		const { default: registerExtension } = await import("./index.ts");
		const { pi, handlers, sentMessages } = createMockPi();
		registerExtension(pi as any);

		const toolResult = handlers.tool_result?.[0];
		expect(toolResult).toBeTypeOf("function");

		const response = await toolResult?.(
			{
				toolName: "write",
				input: { path: filePath },
				details: {},
				isError: false,
				content: [
					{ type: "text", text: "Successfully wrote 73 bytes to smoke-blocking-demo.ts" },
				],
			},
			{ cwd: tmpDir },
		);

		const inlineText = (response?.content ?? [])
			.filter((item: any) => item?.type === "text")
			.map((item: any) => item.text ?? "")
			.join("\n");
		expect(inlineText).toContain("🔴 STOP — 1 issue(s) must be fixed:");

		for (const hookName of ["turn_end", "agent_end"] as const) {
			for (const handler of handlers[hookName] ?? []) {
				await handler({ messages: [{ role: "assistant", content: [] }] }, { cwd: tmpDir });
			}
		}

		expect(sentMessages).toContainEqual(
			expect.objectContaining({
				message: expect.objectContaining({
					content: expect.stringContaining("🔴 STOP — 1 issue(s) must be fixed:"),
					display: true,
				}),
			}),
		);
	});
});
