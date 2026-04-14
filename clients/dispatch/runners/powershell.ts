/**
 * PowerShell runner for dispatch system
 *
 * Placeholder registration for the PowerShell lane.
 * The actual PSScriptAnalyzer integration is implemented under lens-vmr.2.
 */

import type {
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

const powerShellRunner: RunnerDefinition = {
	id: "psscriptanalyzer",
	appliesTo: ["powershell"],
	priority: 10,
	enabledByDefault: true,

	async run(_ctx: DispatchContext): Promise<RunnerResult> {
		return {
			status: "skipped",
			diagnostics: [],
			semantic: "none",
		};
	},
};

export default powerShellRunner;
