/**
 * Tests for the PowerShell dispatch runner.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchContext } from "../types.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	spawnSync: spawnSyncMock,
}));

vi.mock("node:fs", () => ({
	existsSync: existsSyncMock,
}));

import powerShellRunner, {
	classifyPowerShellError,
	escapePowerShellSingleQuotedString,
	normalizePowerShellDiagnostics,
} from "./powershell.js";

function createContext(
	filePath = "/repo/script.ps1",
	overrides: Partial<DispatchContext> = {},
): DispatchContext {
	return {
		filePath,
		cwd: "/repo",
		kind: "powershell",
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		baselines: {
			get: () => undefined,
			set: () => undefined,
			clear: () => undefined,
		},
		hasTool: async () => true,
		log: () => undefined,
		...overrides,
	};
}

describe("PowerShell runner", () => {
	beforeEach(() => {
		spawnSyncMock.mockReset();
		existsSyncMock.mockReset();
		existsSyncMock.mockReturnValue(false);
	});

	it("skips the analyzer settings file itself", async () => {
		const result = await powerShellRunner.run(
			createContext("/repo/PSScriptAnalyzerSettings.psd1"),
		);

		expect(result.status).toBe("skipped");
		expect(result.diagnostics).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("skips when PSScriptAnalyzer is unavailable", async () => {
		const result = await powerShellRunner.run(
			createContext("/repo/script.ps1", {
				hasTool: async () => false,
			}),
		);

		expect(result.status).toBe("skipped");
		expect(result.diagnostics).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("runs pwsh with translated file and settings candidates and preserves the local path", async () => {
		existsSyncMock.mockImplementation(
			(path: string) => path === "/repo/PSScriptAnalyzerSettings.psd1",
		);
		spawnSyncMock
			.mockReturnValueOnce({ stdout: "C:\\repo\\script.ps1\n", stderr: "", status: 0 })
			.mockReturnValueOnce({
				stdout: "C:\\repo\\PSScriptAnalyzerSettings.psd1\n",
				stderr: "",
				status: 0,
			})
			.mockReturnValueOnce({
				stdout: JSON.stringify({
					kind: "diagnostics",
					diagnostics: [
						{
							RuleName: "PSAvoidUsingCmdletAliases",
							Severity: "Warning",
							Line: 4,
							Column: 2,
							Message: "Use Get-Process instead of gps.",
							SuggestedCorrections: [
								{
									Text: "Get-Process",
									Description: "Replace gps with Get-Process",
								},
							],
						},
						{
							RuleName: "UnexpectedToken",
							Severity: "ParseError",
							Line: 4,
							Column: 8,
							Message: "Unexpected token '}' in expression or statement.",
						},
					],
				}),
				stderr: "",
				status: 0,
			});

		const result = await powerShellRunner.run(createContext());

		expect(spawnSyncMock).toHaveBeenNthCalledWith(
			1,
			"wslpath",
			["-w", "/repo/script.ps1"],
			expect.objectContaining({ shell: false }),
		);
		expect(spawnSyncMock).toHaveBeenNthCalledWith(
			2,
			"wslpath",
			["-w", "/repo/PSScriptAnalyzerSettings.psd1"],
			expect.objectContaining({ shell: false }),
		);
		expect(spawnSyncMock).toHaveBeenNthCalledWith(
			3,
			"pwsh",
			expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
			expect.objectContaining({ cwd: "/repo", shell: false }),
		);

		const command = spawnSyncMock.mock.calls[2]?.[1]?.[3] as string;
		expect(command).toContain("C:\\repo\\script.ps1");
		expect(command).toContain("C:\\repo\\PSScriptAnalyzerSettings.psd1");
		expect(command).toContain("ParseError");

		expect(result.status).toBe("failed");
		expect(result.diagnostics).toHaveLength(2);
		expect(result.diagnostics[0]?.filePath).toBe("/repo/script.ps1");
		expect(result.diagnostics[0]?.fixable).toBe(true);
		expect(result.diagnostics[0]?.fixSuggestion).toContain("Get-Process");
		expect(result.diagnostics[1]?.severity).toBe("error");
		expect(result.diagnostics[1]?.semantic).toBe("blocking");
		expect(result.diagnostics[0]?.id).not.toBe(result.diagnostics[1]?.id);
	});

	it("surfaces structured configuration failures as blocking diagnostics", async () => {
		spawnSyncMock
			.mockReturnValueOnce({ stdout: "C:\\repo\\script.ps1\n", stderr: "", status: 0 })
			.mockReturnValueOnce({
				stdout: JSON.stringify({
					kind: "config-error",
					classification: "invalid-settings",
					message: "Settings file is invalid because it does not contain a hashtable.",
				}),
				stderr: "",
				status: 0,
			});

		const result = await powerShellRunner.run(createContext());

		expect(result.status).toBe("failed");
		expect(result.semantic).toBe("blocking");
		expect(result.diagnostics[0]?.message).toContain("invalid-settings");
	});

	it("treats non-JSON stderr output as an execution failure", async () => {
		spawnSyncMock
			.mockReturnValueOnce({ stdout: "C:\\repo\\script.ps1\n", stderr: "", status: 0 })
			.mockReturnValueOnce({
				stdout: "",
				stderr: "\u001b[31;1mCannot find the path 'C:\\\\repo\\\\missing.psd1'.\u001b[0m",
				status: 0,
			});

		const result = await powerShellRunner.run(createContext());

		expect(result.status).toBe("failed");
		expect(result.diagnostics[0]?.message).toContain("Cannot find the path");
	});
});

describe("PowerShell runner helpers", () => {
	it("escapes single quotes for PowerShell single-quoted strings", () => {
		expect(escapePowerShellSingleQuotedString("O'Brien")).toBe("O''Brien");
	});

	it("normalizes diagnostics and preserves distinct ids for same-line findings", () => {
		const diagnostics = normalizePowerShellDiagnostics(
			[
				{
					RuleName: "RuleA",
					Severity: "Warning",
					Line: 2,
					Column: 4,
					Message: "First issue",
				},
				{
					RuleName: "RuleA",
					Severity: "Warning",
					Line: 2,
					Column: 9,
					Message: "Second issue",
				},
			],
			"/repo/script.ps1",
		);

		expect(diagnostics).toHaveLength(2);
		expect(diagnostics[0]?.id).not.toBe(diagnostics[1]?.id);
		expect(diagnostics[0]?.filePath).toBe("/repo/script.ps1");
	});

	it("strips ANSI codes before classifying fallback errors", () => {
		expect(
			classifyPowerShellError(
				"\u001b[31;1mSettings file is invalid because it does not contain a hashtable.\u001b[0m",
			),
		).toBe("Settings file is invalid because it does not contain a hashtable.");
	});
});
