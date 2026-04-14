/**
 * Declarative Tool Dispatcher for pi-lens
 *
 * Redesigned to handle the full complexity of pi-lens's tool_result handler:
 * - Multiple tools with different semantics (blocking, warning, silent)
 * - Delta mode (baseline tracking)
 * - Autofix handling
 * - Output aggregation and formatting
 *
 * Key abstractions:
 * - RunnerDefinition: A tool that can be run
 * - Diagnostic: Structured issue representation
 * - OutputSemantic: How to display (blocking, warning, silent, etc.)
 * - BaselineStore: Track pre-existing issues
 */

import type { FileKind } from "../file-kinds.js";
import { detectFileKind } from "../file-kinds.js";
import { isToolAvailable } from "../tool-availability.js";

import type {
	BaselineStore,
	Diagnostic,
	DispatchContext,
	DispatchResult,
	OutputSemantic,
	PiAgentAPI,
	RunnerDefinition,
	RunnerGroup,
	RunnerResult,
} from "./types.js";

const RUNNER_DISABLE_FLAGS: Partial<Record<string, string>> = {
	"ast-grep": "no-ast-grep",
	"biome-lint": "no-biome",
	"go-vet": "no-go",
	psscriptanalyzer: "no-powershell",
	"ruff-lint": "no-ruff",
	"rust-clippy": "no-rust",
	"ts-lsp": "no-lsp",
};

// --- In-Memory Baseline Store ---

export function createBaselineStore(): BaselineStore {
	const baselines = new Map<string, unknown[]>();

	return {
		get(filePath) {
			return baselines.get(filePath);
		},
		set(filePath, diagnostics) {
			baselines.set(filePath, diagnostics);
		},
		clear() {
			baselines.clear();
		},
	};
}

// --- Runner Registry ---

const globalRegistry = new Map<string, RunnerDefinition>();

export function registerRunner(runner: RunnerDefinition): void {
	if (globalRegistry.has(runner.id)) {
		console.error(`[dispatch] Duplicate runner: ${runner.id}`);
		return;
	}
	globalRegistry.set(runner.id, runner);
}

export function clearRunnerRegistryForTests(): void {
	globalRegistry.clear();
}

export function getRunner(id: string): RunnerDefinition | undefined {
	return globalRegistry.get(id);
}

export function getRunnersForKind(
	kind: FileKind | undefined,
): RunnerDefinition[] {
	if (!kind) return [];
	const runners: RunnerDefinition[] = [];
	for (const runner of globalRegistry.values()) {
		if (runner.appliesTo.includes(kind) || runner.appliesTo.length === 0) {
			runners.push(runner);
		}
	}
	return runners.sort((a, b) => a.priority - b.priority);
}

export function listRunners(): RunnerDefinition[] {
	return Array.from(globalRegistry.values());
}

// --- Dispatch Context Factory ---

export function createDispatchContext(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	baselines?: BaselineStore,
): DispatchContext {
	const kind = detectFileKind(filePath);

	return {
		filePath,
		cwd,
		kind,
		pi,
		autofix: !!(pi.getFlag("autofix-biome") || pi.getFlag("autofix-ruff")),
		deltaMode: !isFlagEnabled(pi, "no-delta"),
		baselines: baselines ?? createBaselineStore(),

		async hasTool(command: string): Promise<boolean> {
			return isToolAvailable(command);
		},

		log(message: string): void {
			console.error(`[dispatch] ${message}`);
		},
	};
}

// --- Delta Mode Logic ---

function filterDelta<T extends { id: string }>(
	after: T[],
	before: T[] | undefined,
	keyFn: (d: T) => string,
): { new: T[]; fixed: T[] } {
	const beforeSet = new Set((before ?? []).map(keyFn));
	const afterSet = new Set(after.map(keyFn));

	const fixed = (before ?? []).filter((d) => !afterSet.has(keyFn(d)));
	const newItems = after.filter((d) => !beforeSet.has(keyFn(d)));

	return { new: newItems, fixed };
}

// --- Output Formatting ---

const EMOJI: Record<string, string> = {
	blocking: "🔴",
	warning: "🟡",
	fixed: "✅",
	info: "ℹ️",
	silent: "📊",
	none: "",
};

function formatDiagnostic(d: Diagnostic): string {
	const line = d.line ? `L${d.line}${d.column ? `:${d.column}` : ""}: ` : "";
	return `  ${line}${d.message}`;
}

function formatDiagnostics(
	diagnostics: Diagnostic[],
	semantic: OutputSemantic,
	maxDisplay = 10,
): string {
	if (diagnostics.length === 0) return "";

	const emoji = EMOJI[semantic] ?? EMOJI.warning;
	let output = "";

	if (semantic === "blocking") {
		output += `\n${emoji} STOP — ${diagnostics.length} issue(s) must be fixed:\n`;
	} else if (semantic === "warning") {
		output += `\n${emoji} ${diagnostics.length} warning(s):\n`;
	} else if (semantic === "fixed") {
		output += `\n${emoji} Auto-fixed ${diagnostics.length} issue(s):\n`;
	}

	for (const d of diagnostics.slice(0, maxDisplay)) {
		output += `${formatDiagnostic(d)}\n`;
	}

	if (diagnostics.length > maxDisplay) {
		output += `  ... and ${diagnostics.length - maxDisplay} more\n`;
	}

	return output;
}

// --- Main Dispatch Function ---

export async function dispatchForFile(
	ctx: DispatchContext,
	groups: RunnerGroup[],
): Promise<DispatchResult> {
	const observedDiagnostics: Diagnostic[] = [];
	let stopRequested = false;

	for (const group of groups) {
		if (stopRequested) {
			break;
		}

		const runnerIds = getEligibleRunnerIds(ctx, group);
		if (runnerIds.length === 0) {
			continue;
		}

		if (group.mode === "all") {
			for (const runnerId of runnerIds) {
				const result = await maybeRunRunner(ctx, runnerId, group.semantic);
				if (!result) continue;

				observedDiagnostics.push(...result.diagnostics);
				if (
					isFlagEnabled(ctx.pi, "stop-on-error") &&
					hasBlockingDiagnostics(result.diagnostics)
				) {
					stopRequested = true;
					break;
				}
			}
			continue;
		}

		if (group.mode === "fallback") {
			for (const runnerId of runnerIds) {
				const result = await maybeRunRunner(ctx, runnerId, group.semantic);
				if (!result) continue;

				observedDiagnostics.push(...result.diagnostics);
				if (
					isFlagEnabled(ctx.pi, "stop-on-error") &&
					hasBlockingDiagnostics(result.diagnostics)
				) {
					stopRequested = true;
				}
				if (result.status !== "skipped") {
					break;
				}
			}
			continue;
		}

		for (const runnerId of runnerIds) {
			const result = await maybeRunRunner(ctx, runnerId, group.semantic);
			if (!result) continue;

			observedDiagnostics.push(...result.diagnostics);
			if (
				isFlagEnabled(ctx.pi, "stop-on-error") &&
				hasBlockingDiagnostics(result.diagnostics)
			) {
				stopRequested = true;
				break;
			}
			if (result.status === "succeeded") {
				break;
			}
		}
	}

	const baselineBefore = ctx.baselines.get(ctx.filePath) as Diagnostic[] | undefined;
	ctx.baselines.set(ctx.filePath, observedDiagnostics);

	const delta = ctx.deltaMode
		? filterDelta(observedDiagnostics, baselineBefore, (d) => d.id)
		: { new: observedDiagnostics, fixed: [] as Diagnostic[] };
	const visibleDiagnostics = delta.new;

	const blockers = visibleDiagnostics.filter((d) => d.semantic === "blocking");
	const warnings = visibleDiagnostics.filter(
		(d) => d.semantic === "warning" || d.semantic === "none",
	);
	const fixedItems = visibleDiagnostics.filter((d) => d.semantic === "fixed");

	let output = formatDiagnostics(blockers, "blocking");
	output += formatDiagnostics(warnings, "warning");
	output += formatDiagnostics(fixedItems, "fixed");

	return {
		diagnostics: visibleDiagnostics,
		blockers,
		warnings,
		fixed: fixedItems,
		output,
		hasBlockers: blockers.length > 0,
	};
}

// --- Run Single Runner ---

async function maybeRunRunner(
	ctx: DispatchContext,
	runnerId: string,
	defaultSemantic?: OutputSemantic,
): Promise<RunnerResult | undefined> {
	const runner = getRunner(runnerId);
	if (!runner) return undefined;
	if (!(await shouldRunRunner(ctx, runner))) {
		return undefined;
	}
	return runRunner(ctx, runner, defaultSemantic ?? "warning");
}

async function shouldRunRunner(
	ctx: DispatchContext,
	runner: RunnerDefinition,
): Promise<boolean> {
	const disableFlag = RUNNER_DISABLE_FLAGS[runner.id];
	if (disableFlag && isFlagEnabled(ctx.pi, disableFlag)) {
		return false;
	}

	if (!runner.enabledByDefault && !runner.when) {
		return false;
	}

	if (runner.when) {
		return !!(await runner.when(ctx));
	}

	return true;
}

async function runRunner(
	ctx: DispatchContext,
	runner: RunnerDefinition,
	defaultSemantic: OutputSemantic,
): Promise<RunnerResult> {
	try {
		const result = await runner.run(ctx);
		return {
			...result,
			semantic: result.semantic ?? defaultSemantic,
		};
	} catch (error) {
		ctx.log(`Runner ${runner.id} failed: ${error}`);
		return {
			status: "failed",
			diagnostics: [],
			semantic: defaultSemantic,
		};
	}
}

function getEligibleRunnerIds(
	ctx: DispatchContext,
	group: RunnerGroup,
): string[] {
	if (!group.filterKinds || !ctx.kind) {
		return group.runnerIds;
	}
	return group.runnerIds.filter((runnerId) => {
		const runner = getRunner(runnerId);
		return !!runner && group.filterKinds?.includes(ctx.kind!);
	});
}

function hasBlockingDiagnostics(diagnostics: Diagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.semantic === "blocking");
}

function isFlagEnabled(pi: PiAgentAPI, flag: string): boolean {
	return pi.getFlag(flag) === true;
}

// --- Simple Integration Helper ---

export async function dispatchLint(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	baselines?: BaselineStore,
): Promise<string> {
	const ctx = createDispatchContext(filePath, cwd, pi, baselines);
	const runners = getRunnersForKind(ctx.kind);
	if (runners.length === 0) {
		return "";
	}

	const groups: RunnerGroup[] = [
		{
			mode: "fallback",
			runnerIds: runners.map((runner) => runner.id),
		},
	];

	const result = await dispatchForFile(ctx, groups);
	return result.output;
}
