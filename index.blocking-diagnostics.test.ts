import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchLintResultMock = vi.fn();

vi.mock("./clients/dispatch/integration.js", () => ({
	dispatchLintResult: dispatchLintResultMock,
}));

type Handler = (event: any, ctx: any) => unknown;

function createMockPi(flagOverrides: Record<string, boolean> = {}) {
	const handlers: Record<string, Handler[]> = {};
	const messageRenderers = new Map<string, (...args: any[]) => unknown>();
	const commands = new Map<string, { handler?: Handler; description?: string }>();
	const flags = new Map<string, boolean>([
		["lens-verbose", false],
		["no-lsp", false],
		["no-biome", false],
		["no-ast-grep", false],
		["no-ruff", false],
		["no-madge", false],
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
		registerMessageRenderer: vi.fn((name: string, renderer: any) => {
			messageRenderers.set(name, renderer);
		}),
		on: vi.fn((event: string, handler: Handler) => {
			(handlers[event] ??= []).push(handler);
		}),
		getFlag: vi.fn((name: string) => flags.get(name) ?? false),
		sendMessage: vi.fn((message: any, options: any) => {
			sentMessages.push({ message, options });
		}),
	};

	return { pi, handlers, commands, messageRenderers, sentMessages };
}

describe("index PowerShell blocking diagnostics behavior", () => {
	let tmpDir: string;

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-powershell-blocking-test-"));
		dispatchLintResultMock.mockReset();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("keeps blocking PowerShell diagnostics in tool_result and re-emits them as an immediate follow-up", async () => {
		const filePath = path.join(tmpDir, "smoke-powershell-demo.ps1");
		fs.writeFileSync(filePath, "gps | % { $_ }\n}\n");

		dispatchLintResultMock.mockResolvedValue({
			output:
				"🔴 STOP — 1 issue(s) must be fixed:\n  L1: UnexpectedToken — Unexpected token '}' in expression or statement.\n  L1: PSAvoidUsingCmdletAliases — 'gps' is an alias of 'Get-Process'. Alias can introduce possible problems and make scripts hard to maintain.",
			hasBlockers: true,
		});

		const { default: registerExtension } = await import("./index.js");
		const { pi, handlers, sentMessages, messageRenderers } = createMockPi();
		registerExtension(pi as any);

		expect(messageRenderers.has("pi-lens-blocking-diagnostics")).toBe(true);

		const toolResult = handlers.tool_result?.at(-1);
		expect(toolResult).toBeTypeOf("function");

		const response = await toolResult?.(
			{
				toolName: "write",
				input: { path: filePath },
				details: {},
				isError: false,
				content: [
					{ type: "text", text: "Successfully wrote 19 bytes to smoke-powershell-demo.ps1" },
				],
			},
			{},
		);

		expect(response).toEqual({
			content: [
				{
					type: "text",
					text:
						"Successfully wrote 19 bytes to smoke-powershell-demo.ps1\n\n🔴 STOP — 1 issue(s) must be fixed:\n  L1: UnexpectedToken — Unexpected token '}' in expression or statement.\n  L1: PSAvoidUsingCmdletAliases — 'gps' is an alias of 'Get-Process'. Alias can introduce possible problems and make scripts hard to maintain.",
				},
			],
			isError: true,
		});

		await Promise.resolve();

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]).toEqual({
			message: {
				customType: "pi-lens-blocking-diagnostics",
				content:
					"🔴 STOP — 1 issue(s) must be fixed:\n  L1: UnexpectedToken — Unexpected token '}' in expression or statement.\n  L1: PSAvoidUsingCmdletAliases — 'gps' is an alias of 'Get-Process'. Alias can introduce possible problems and make scripts hard to maintain.",
				display: true,
				details: { filePath, toolName: "write" },
			},
			options: { deliverAs: "followUp", triggerTurn: false },
		});
	});

	it("does not re-emit a sticky blocker for warning-only PowerShell output", async () => {
		const filePath = path.join(tmpDir, "smoke-powershell-demo.ps1");
		fs.writeFileSync(filePath, "Get-Process\n");

		dispatchLintResultMock.mockResolvedValue({
			output:
				"🟡 1 warning(s):\n  L1: PSAvoidUsingWriteHost — File contains Write-Host usage.",
			hasBlockers: false,
		});

		const { default: registerExtension } = await import("./index.js");
		const { pi, handlers, sentMessages } = createMockPi();
		registerExtension(pi as any);

		const toolResult = handlers.tool_result?.at(-1);
		expect(toolResult).toBeTypeOf("function");

		const response = await toolResult?.(
			{
				toolName: "write",
				input: { path: filePath },
				details: {},
				isError: false,
				content: [{ type: "text", text: "Successfully wrote 12 bytes to smoke-powershell-demo.ps1" }],
			},
			{},
		);

		expect(response).toEqual({
			content: [
				{
					type: "text",
					text:
						"Successfully wrote 12 bytes to smoke-powershell-demo.ps1\n\n🟡 1 warning(s):\n  L1: PSAvoidUsingWriteHost — File contains Write-Host usage.",
				},
			],
			isError: false,
		});

		expect(sentMessages).toHaveLength(0);
	});
});
