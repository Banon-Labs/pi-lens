/**
 * Tests for declarative dispatch system.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	clearRunnerRegistryForTests,
	createBaselineStore,
	createDispatchContext,
	dispatchForFile,
	getRunner,
	getRunnersForKind,
	listRunners,
	registerRunner,
} from "./dispatcher.js";
import type {
	Diagnostic,
	DispatchContext,
	PiAgentAPI,
	RunnerDefinition,
	RunnerResult,
} from "./types.js";

function createMockPi(flags: Record<string, boolean> = {}): PiAgentAPI {
	return {
		getFlag(flag: string) {
			return flags[flag] ?? false;
		},
	};
}

function createDiagnostic(
	id: string,
	semantic: Diagnostic["semantic"] = "warning",
): Diagnostic {
	return {
		id,
		message: id,
		filePath: "test.ts",
		line: 1,
		column: 1,
		severity: semantic === "blocking" ? "error" : "warning",
		semantic,
		tool: "test",
	};
}

type TestRunnerOptions = {
	appliesTo?: RunnerDefinition["appliesTo"];
	priority?: number;
	enabledByDefault?: boolean;
	when?: RunnerDefinition["when"];
	run?: (ctx: DispatchContext) => Promise<RunnerResult> | RunnerResult;
};

function createRunner(
	id: string,
	options: TestRunnerOptions = {},
): RunnerDefinition {
	return {
		id,
		appliesTo: options.appliesTo ?? ["jsts"],
		priority: options.priority ?? 10,
		enabledByDefault: options.enabledByDefault ?? true,
		when: options.when,
		async run(ctx) {
			if (options.run) {
				return await options.run(ctx);
			}
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		},
	};
}

describe("Runner Registry", () => {
	beforeEach(() => {
		clearRunnerRegistryForTests();
		registerRunner(
			createRunner("test-runner-1", { appliesTo: ["jsts", "python"] }),
		);
		registerRunner(createRunner("test-runner-2", { appliesTo: ["python"] }));
		registerRunner(
			createRunner("test-runner-conditional", {
				enabledByDefault: false,
				priority: 5,
				when: async (ctx) => ctx.autofix,
			}),
		);
	});

	it("should register a runner", () => {
		const runner = getRunner("test-runner-1");
		expect(runner).toBeDefined();
		expect(runner?.id).toBe("test-runner-1");
	});

	it("should return undefined for unknown runner", () => {
		expect(getRunner("unknown-runner")).toBeUndefined();
	});

	it("should get runners for a specific kind", () => {
		const jstsRunners = getRunnersForKind("jsts");
		expect(jstsRunners.some((runner) => runner.id === "test-runner-1")).toBe(
			true,
		);
	});

	it("should return runners sorted by priority", () => {
		const jstsRunners = getRunnersForKind("jsts");
		const priorities = jstsRunners.map((runner) => runner.priority ?? 100);
		for (let i = 1; i < priorities.length; i++) {
			expect(priorities[i - 1]).toBeLessThanOrEqual(priorities[i]);
		}
	});

	it("should list all registered runners", () => {
		expect(listRunners()).toHaveLength(3);
	});

	it("should reject duplicate registrations", () => {
		expect(() => registerRunner(createRunner("test-runner-1"))).not.toThrow();
	});
});

describe("Dispatch Context", () => {
	beforeEach(() => {
		clearRunnerRegistryForTests();
	});

	it("should create a dispatch context", () => {
		const ctx = createDispatchContext("test.ts", "/project", createMockPi());

		expect(ctx.filePath).toBe("test.ts");
		expect(ctx.cwd).toBe("/project");
		expect(ctx.autofix).toBe(false);
		expect(ctx.deltaMode).toBe(true);
	});

	it("should detect file kind", () => {
		expect(
			createDispatchContext("test.ts", "/project", createMockPi()).kind,
		).toBe("jsts");
		expect(
			createDispatchContext("test.py", "/project", createMockPi()).kind,
		).toBe("python");
		expect(
			createDispatchContext("test.go", "/project", createMockPi()).kind,
		).toBe("go");
		expect(
			createDispatchContext("test.ps1", "/project", createMockPi()).kind,
		).toBe("powershell");
	});

	it("should respect autofix flag", () => {
		expect(
			createDispatchContext("test.ts", "/project", createMockPi()).autofix,
		).toBe(false);
		expect(
			createDispatchContext(
				"test.ts",
				"/project",
				createMockPi({ "autofix-biome": true }),
			).autofix,
		).toBe(true);
	});

	it("should disable delta mode when no-delta is set", () => {
		expect(
			createDispatchContext(
				"test.ts",
				"/project",
				createMockPi({ "no-delta": true }),
			).deltaMode,
		).toBe(false);
	});
});

describe("Dispatch semantics", () => {
	beforeEach(() => {
		clearRunnerRegistryForTests();
	});

	it("runs fallback groups until the first non-skipped runner", async () => {
		const calls: string[] = [];
		registerRunner(
			createRunner("fallback-a", {
				run: () => {
					calls.push("fallback-a");
					return { status: "skipped", diagnostics: [], semantic: "none" };
				},
			}),
		);
		registerRunner(
			createRunner("fallback-b", {
				run: () => {
					calls.push("fallback-b");
					return {
						status: "failed",
						diagnostics: [createDiagnostic("fallback-b")],
						semantic: "warning",
					};
				},
			}),
		);
		registerRunner(
			createRunner("fallback-c", {
				run: () => {
					calls.push("fallback-c");
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			}),
		);

		const result = await dispatchForFile(
			createDispatchContext("test.ts", "/project", createMockPi()),
			[{ mode: "fallback", runnerIds: ["fallback-a", "fallback-b", "fallback-c"] }],
		);

		expect(calls).toEqual(["fallback-a", "fallback-b"]);
		expect(result.warnings).toHaveLength(1);
	});

	it("runs first-success groups until a runner succeeds", async () => {
		const calls: string[] = [];
		registerRunner(
			createRunner("first-a", {
				run: () => {
					calls.push("first-a");
					return {
						status: "failed",
						diagnostics: [createDiagnostic("first-a")],
						semantic: "warning",
					};
				},
			}),
		);
		registerRunner(
			createRunner("first-b", {
				run: () => {
					calls.push("first-b");
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			}),
		);
		registerRunner(
			createRunner("first-c", {
				run: () => {
					calls.push("first-c");
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			}),
		);

		await dispatchForFile(
			createDispatchContext("test.ts", "/project", createMockPi()),
			[{ mode: "first-success", runnerIds: ["first-a", "first-b", "first-c"] }],
		);

		expect(calls).toEqual(["first-a", "first-b"]);
	});

	it("honors enabledByDefault and when conditions", async () => {
		let executed = false;
		registerRunner(
			createRunner("conditional-runner", {
				enabledByDefault: false,
				when: async (ctx) => ctx.autofix,
				run: () => {
					executed = true;
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			}),
		);

		await dispatchForFile(
			createDispatchContext("test.ts", "/project", createMockPi()),
			[{ mode: "all", runnerIds: ["conditional-runner"] }],
		);
		expect(executed).toBe(false);

		executed = false;
		await dispatchForFile(
			createDispatchContext(
				"test.ts",
				"/project",
				createMockPi({ "autofix-biome": true }),
			),
			[{ mode: "all", runnerIds: ["conditional-runner"] }],
		);
		expect(executed).toBe(true);
	});

	it("respects disable flags for known runners", async () => {
		let executed = false;
		registerRunner(
			createRunner("biome-lint", {
				run: () => {
					executed = true;
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			}),
		);

		await dispatchForFile(
			createDispatchContext(
				"test.ts",
				"/project",
				createMockPi({ "no-biome": true }),
			),
			[{ mode: "all", runnerIds: ["biome-lint"] }],
		);

		expect(executed).toBe(false);
	});

	it("stops after blocking diagnostics when stop-on-error is enabled", async () => {
		const calls: string[] = [];
		registerRunner(
			createRunner("blocking-runner", {
				run: () => {
					calls.push("blocking-runner");
					return {
						status: "failed",
						diagnostics: [createDiagnostic("blocking", "blocking")],
						semantic: "blocking",
					};
				},
			}),
		);
		registerRunner(
			createRunner("later-runner", {
				run: () => {
					calls.push("later-runner");
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			}),
		);

		await dispatchForFile(
			createDispatchContext(
				"test.ts",
				"/project",
				createMockPi({ "stop-on-error": true }),
			),
			[
				{ mode: "all", runnerIds: ["blocking-runner"] },
				{ mode: "all", runnerIds: ["later-runner"] },
			],
		);

		expect(calls).toEqual(["blocking-runner"]);
	});

	it("persists baselines and only shows new diagnostics in delta mode", async () => {
		const baselines = createBaselineStore();
		let currentDiagnostics = [createDiagnostic("existing-warning")];
		registerRunner(
			createRunner("delta-runner", {
				run: () => ({
					status: "failed",
					diagnostics: currentDiagnostics,
					semantic: "warning",
				}),
			}),
		);

		const ctx = createDispatchContext(
			"test.ts",
			"/project",
			createMockPi(),
			baselines,
		);
		const first = await dispatchForFile(ctx, [
			{ mode: "all", runnerIds: ["delta-runner"] },
		]);
		expect(first.warnings.map((diagnostic) => diagnostic.id)).toEqual([
			"existing-warning",
		]);

		currentDiagnostics = [
			createDiagnostic("existing-warning"),
			createDiagnostic("new-warning"),
		];
		const second = await dispatchForFile(ctx, [
			{ mode: "all", runnerIds: ["delta-runner"] },
		]);
		expect(second.warnings.map((diagnostic) => diagnostic.id)).toEqual([
			"new-warning",
		]);
	});

	it("shows full diagnostics when no-delta is enabled", async () => {
		const baselines = createBaselineStore();
		let currentDiagnostics = [createDiagnostic("existing-warning")];
		registerRunner(
			createRunner("delta-runner", {
				run: () => ({
					status: "failed",
					diagnostics: currentDiagnostics,
					semantic: "warning",
				}),
			}),
		);

		const ctx = createDispatchContext(
			"test.ts",
			"/project",
			createMockPi({ "no-delta": true }),
			baselines,
		);
		await dispatchForFile(ctx, [{ mode: "all", runnerIds: ["delta-runner"] }]);

		currentDiagnostics = [
			createDiagnostic("existing-warning"),
			createDiagnostic("new-warning"),
		];
		const second = await dispatchForFile(ctx, [
			{ mode: "all", runnerIds: ["delta-runner"] },
		]);
		expect(second.warnings.map((diagnostic) => diagnostic.id)).toEqual([
			"existing-warning",
			"new-warning",
		]);
	});
});
