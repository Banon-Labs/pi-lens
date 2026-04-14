/**
 * Dispatch integration helpers
 *
 * Provides utilities for integrating the declarative dispatch system
 * with the existing index.ts tool_result handler.
 */

import { isScannableFile } from "../file-kinds.js";
import {
	createBaselineStore,
	createDispatchContext,
	dispatchForFile,
	getRunnersForKind,
} from "./dispatcher.js";
import { TOOL_PLANS } from "./plan.js";
import type { BaselineStore, DispatchResult, PiAgentAPI } from "./types.js";

// Import runners to register them
import "./runners/index.js";

const sharedLintBaselines = createBaselineStore();

/**
 * Run linting for a file using the declarative dispatch system.
 */
export async function dispatchLintResult(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	baselines: BaselineStore = sharedLintBaselines,
): Promise<DispatchResult | null> {
	if (!isScannableFile(filePath)) {
		return null;
	}

	const ctx = createDispatchContext(filePath, cwd, pi, baselines);
	const kind = ctx.kind;
	if (!kind) return null;

	const plan = TOOL_PLANS[kind];
	if (!plan) return null;

	return dispatchForFile(ctx, plan.groups);
}

/**
 * Run linting for a file using the declarative dispatch system
 *
 * @param filePath - Path to the file to lint
 * @param cwd - Project root directory
 * @param pi - Pi agent API (for flags)
 * @returns Output string to display to user
 */
export async function dispatchLint(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	baselines: BaselineStore = sharedLintBaselines,
): Promise<string> {
	const result = await dispatchLintResult(filePath, cwd, pi, baselines);
	return result?.output ?? "";
}

/**
 * Create a baseline store for delta mode tracking
 */
export function createLintBaselines(): BaselineStore {
	return createBaselineStore();
}

/**
 * Check if a file should be processed by the dispatcher.
 */
export function shouldDispatch(filePath: string): boolean {
	return isScannableFile(filePath);
}

/**
 * Get list of available runners for a file.
 */
export async function getAvailableRunners(filePath: string): Promise<string[]> {
	if (!isScannableFile(filePath)) return [];

	const ctx = createDispatchContext(filePath, process.cwd(), {
		getFlag: () => false,
	});
	const runners = getRunnersForKind(ctx.kind);
	return runners.map((runner) => runner.id);
}
