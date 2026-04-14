/**
 * PowerShell runner for dispatch system.
 *
 * Uses PSScriptAnalyzer via `pwsh -Command` and keeps diagnostics keyed to the
 * local edited path rather than whatever ScriptPath form the analyzer returns.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { basename, resolve } from "node:path";
import { stripAnsi } from "../../sanitize.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

const ANALYZER_SETTINGS_FILE = "PSScriptAnalyzerSettings.psd1";
const POWERSHELL_TIMEOUT_MS = 30_000;

type PowerShellCorrection = {
	Text?: string;
	Description?: string;
};

type PowerShellDiagnosticPayload = {
	RuleName?: string;
	Severity?: string;
	Line?: number | string | null;
	Column?: number | string | null;
	Message?: string;
	SuggestedCorrections?: PowerShellCorrection[] | null;
};

type PowerShellSuccessPayload = {
	kind: "diagnostics";
	diagnostics?: PowerShellDiagnosticPayload[] | PowerShellDiagnosticPayload | null;
};

type PowerShellErrorPayload = {
	kind: "config-error" | "execution-error";
	classification?: string;
	message?: string;
};

type PowerShellPayload = PowerShellSuccessPayload | PowerShellErrorPayload;

const powerShellRunner: RunnerDefinition = {
	id: "psscriptanalyzer",
	appliesTo: ["powershell"],
	priority: 10,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		if (basename(ctx.filePath).toLowerCase() === ANALYZER_SETTINGS_FILE.toLowerCase()) {
			return {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
			};
		}

		if (!(await ctx.hasTool("psscriptanalyzer"))) {
			return {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
			};
		}

		const localFilePath = resolve(ctx.cwd, ctx.filePath);
		const repoSettingsPath = resolve(ctx.cwd, ANALYZER_SETTINGS_FILE);
		const hasRepoSettings = fs.existsSync(repoSettingsPath);

		const command = buildPowerShellCommand(localFilePath, hasRepoSettings ? repoSettingsPath : undefined);
		const result = spawnSync(
			"pwsh",
			["-NoProfile", "-NonInteractive", "-Command", command],
			{
				cwd: ctx.cwd,
				encoding: "utf-8",
				timeout: POWERSHELL_TIMEOUT_MS,
				shell: false,
			},
		);

		const stdout = result.stdout.trim();
		const stderr = stripAnsi(result.stderr).trim();

		if (result.error) {
			return createExecutionFailure(localFilePath, result.error.message);
		}

		if (!stdout && result.status === 0 && !stderr) {
			return {
				status: "succeeded",
				diagnostics: [],
				semantic: "none",
			};
		}

		const payload = parsePowerShellPayload(stdout);
		if (payload?.kind === "diagnostics") {
			const diagnostics = normalizePowerShellDiagnostics(
				payload.diagnostics,
				ctx.filePath,
			);
			return {
				status: diagnostics.some((diagnostic) => diagnostic.severity === "error")
					? "failed"
					: "succeeded",
				diagnostics,
				semantic: diagnostics.some((diagnostic) => diagnostic.semantic === "blocking")
					? "blocking"
					: diagnostics.length > 0
						? "warning"
						: "none",
			};
		}

		if (payload?.kind === "config-error" || payload?.kind === "execution-error") {
			return createPayloadFailure(ctx.filePath, payload);
		}

		if (stderr) {
			return createExecutionFailure(
				ctx.filePath,
				classifyPowerShellError(stderr),
			);
		}

		if (result.status !== 0) {
			return createExecutionFailure(
				ctx.filePath,
				`PowerShell analysis failed with exit code ${result.status}.`,
			);
		}

		return {
			status: "succeeded",
			diagnostics: [],
			semantic: "none",
		};
	},
};

function buildPowerShellCommand(
	localFilePath: string,
	repoSettingsPath?: string,
): string {
	const targetCandidates = toPowerShellArrayLiteral(buildCandidatePaths(localFilePath));
	const settingsCandidates = repoSettingsPath
		? toPowerShellArrayLiteral(buildCandidatePaths(repoSettingsPath))
		: "@()";
	const settingsExpected = repoSettingsPath ? "$true" : "$false";

	return [
		"$ErrorActionPreference = 'Stop'",
		"function Resolve-CandidatePath([string[]]$Candidates) {",
		"  foreach ($candidate in $Candidates) {",
		"    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }",
		"    if (Test-Path -LiteralPath $candidate) { return $candidate }",
		"  }",
		"  return $null",
		"}",
		"function Project-Diagnostic($item) {",
		"  [pscustomobject]@{",
		"    RuleName = [string]$item.RuleName",
		"    Severity = [string]$item.Severity",
		"    Line = if ($null -ne $item.Line) { [int]$item.Line } else { $null }",
		"    Column = if ($null -ne $item.Column) { [int]$item.Column } else { $null }",
		"    Message = [string]$item.Message",
		"    SuggestedCorrections = @($item.SuggestedCorrections | ForEach-Object {",
		"      [pscustomobject]@{",
		"        Text = [string]$_.Text",
		"        Description = [string]$_.Description",
		"      }",
		"    })",
		"  }",
		"}",
		`$targetCandidates = ${targetCandidates}`,
		"$targetPath = Resolve-CandidatePath $targetCandidates",
		"if (-not $targetPath) {",
		"  [pscustomobject]@{ kind = 'execution-error'; classification = 'missing-target-path'; message = 'Unable to resolve the edited file for PowerShell analysis.' } | ConvertTo-Json -Compress -Depth 6",
		"  exit 0",
		"}",
		`$settingsExpected = ${settingsExpected}`,
		`$settingsCandidates = ${settingsCandidates}`,
		"$settingsPath = Resolve-CandidatePath $settingsCandidates",
		"if ($settingsExpected -and -not $settingsPath) {",
		"  [pscustomobject]@{ kind = 'config-error'; classification = 'missing-settings-path'; message = 'Unable to resolve repo-root PSScriptAnalyzer settings for the current PowerShell host.' } | ConvertTo-Json -Compress -Depth 6",
		"  exit 0",
		"}",
		"try {",
		"  if ($settingsPath) {",
		"    $configuredDiagnostics = @(Invoke-ScriptAnalyzer -Path $targetPath -Settings $settingsPath -ErrorAction Stop)",
		"  } else {",
		"    $configuredDiagnostics = @(Invoke-ScriptAnalyzer -Path $targetPath -ErrorAction Stop)",
		"  }",
		"} catch {",
		"  $message = if ($_.Exception) { $_.Exception.Message } else { $_.ToString() }",
		"  $classification = if ($settingsPath -and $message -match 'Cannot find the path') { 'missing-settings-path' } elseif ($settingsPath -and $message -match 'invalid') { 'invalid-settings' } else { 'execution-error' }",
		"  $kind = if ($settingsPath) { 'config-error' } else { 'execution-error' }",
		"  [pscustomobject]@{ kind = $kind; classification = $classification; message = $message } | ConvertTo-Json -Compress -Depth 6",
		"  exit 0",
		"}",
		"$parseDiagnostics = @()",
		"if ($settingsPath) {",
		"  try {",
		"    $parseDiagnostics = @(Invoke-ScriptAnalyzer -Path $targetPath -ErrorAction Stop | Where-Object { ([string]$_.Severity) -eq 'ParseError' })",
		"  } catch {",
		"    $message = if ($_.Exception) { $_.Exception.Message } else { $_.ToString() }",
		"    [pscustomobject]@{ kind = 'execution-error'; classification = 'parse-probe-failed'; message = $message } | ConvertTo-Json -Compress -Depth 6",
		"    exit 0",
		"  }",
		"}",
		"$projected = @($configuredDiagnostics + $parseDiagnostics | ForEach-Object { Project-Diagnostic $_ })",
		"[pscustomobject]@{ kind = 'diagnostics'; diagnostics = $projected } | ConvertTo-Json -Compress -Depth 6",
	].join("\n");
}

function buildCandidatePaths(localPath: string): string[] {
	const candidates = [localPath];
	const translated = translatePathForPowerShell(localPath);
	if (translated) {
		candidates.push(translated);
	}
	return candidates;
}

function translatePathForPowerShell(localPath: string): string | undefined {
	const translated = spawnSync("wslpath", ["-w", localPath], {
		encoding: "utf-8",
		timeout: 5_000,
		shell: false,
	});
	if (translated.error || translated.status !== 0) {
		return undefined;
	}
	const candidate = translated.stdout.trim();
	return candidate.length > 0 ? candidate : undefined;
}

function toPowerShellArrayLiteral(paths: string[]): string {
	return `@(${paths.map((pathValue) => `'${escapePowerShellSingleQuotedString(pathValue)}'`).join(", ")})`;
}

export function escapePowerShellSingleQuotedString(value: string): string {
	return value.replace(/'/g, "''");
}

function parsePowerShellPayload(stdout: string): PowerShellPayload | undefined {
	if (!stdout) {
		return undefined;
	}

	try {
		return JSON.parse(stdout) as PowerShellPayload;
	} catch {
		return undefined;
	}
}

export function normalizePowerShellDiagnostics(
	payload: PowerShellSuccessPayload["diagnostics"],
	localFilePath: string,
): Diagnostic[] {
	const items = Array.isArray(payload)
		? payload
		: payload
			? [payload]
			: [];
	const diagnostics: Diagnostic[] = [];
	const seen = new Set<string>();

	for (const item of items) {
		const normalized = normalizePowerShellDiagnostic(item, localFilePath);
		if (!normalized || seen.has(normalized.id)) {
			continue;
		}
		seen.add(normalized.id);
		diagnostics.push(normalized);
	}

	return diagnostics;
}

function normalizePowerShellDiagnostic(
	item: PowerShellDiagnosticPayload,
	localFilePath: string,
): Diagnostic | undefined {
	const rule = item.RuleName?.trim() || "PSScriptAnalyzer";
	const message = item.Message?.trim();
	if (!message) {
		return undefined;
	}

	const line = toOptionalNumber(item.Line);
	const column = toOptionalNumber(item.Column);
	const severity = normalizePowerShellSeverity(item.Severity);
	const suggestedCorrections = Array.isArray(item.SuggestedCorrections)
		? item.SuggestedCorrections.filter(
				(correction) => correction.Text || correction.Description,
			)
		: [];
	const fixSuggestion = suggestedCorrections
		.map((correction) => {
			const description = correction.Description?.trim();
			const text = correction.Text?.trim();
			if (description && text && description !== text) {
				return `${description}: ${text}`;
			}
			return description || text || "";
		})
		.filter(Boolean)
		.join(" | ");

	return {
		id: `psscriptanalyzer-${rule}-${line ?? 0}-${column ?? 0}-${message}`,
		message: `${rule}: ${message}`,
		filePath: localFilePath,
		line,
		column,
		severity,
		semantic: severity === "error" ? "blocking" : "warning",
		tool: "psscriptanalyzer",
		rule,
		fixable: suggestedCorrections.length > 0,
		fixSuggestion: fixSuggestion || undefined,
	};
}

function normalizePowerShellSeverity(
	severity: string | undefined,
): Diagnostic["severity"] {
	switch ((severity ?? "").toLowerCase()) {
		case "error":
		case "parseerror":
			return "error";
		case "information":
		case "info":
			return "info";
		default:
			return "warning";
	}
}

function toOptionalNumber(value: number | string | null | undefined): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function createPayloadFailure(
	filePath: string,
	payload: PowerShellErrorPayload,
): RunnerResult {
	const classification = payload.classification?.trim() || payload.kind;
	const message = payload.message?.trim() || "PowerShell analysis failed.";
	return {
		status: "failed",
		diagnostics: [
			{
				id: `psscriptanalyzer-${classification}`,
				message: `PSScriptAnalyzer ${classification}: ${message}`,
				filePath,
				severity: "error",
				semantic: "blocking",
				tool: "psscriptanalyzer",
				rule: classification,
			},
		],
		semantic: "blocking",
	};
}

function createExecutionFailure(filePath: string, message: string): RunnerResult {
	return {
		status: "failed",
		diagnostics: [
			{
				id: "psscriptanalyzer-execution-error",
				message: `PSScriptAnalyzer execution error: ${message}`,
				filePath,
				severity: "error",
				semantic: "blocking",
				tool: "psscriptanalyzer",
				rule: "execution-error",
			},
		],
		semantic: "blocking",
	};
}

export function classifyPowerShellError(text: string): string {
	const clean = stripAnsi(text).trim();
	if (!clean) {
		return "PowerShell analysis failed.";
	}
	if (/Cannot find the path/i.test(clean)) {
		return clean;
	}
	if (/invalid/i.test(clean) && /settings/i.test(clean)) {
		return clean;
	}
	return clean;
}

export default powerShellRunner;
