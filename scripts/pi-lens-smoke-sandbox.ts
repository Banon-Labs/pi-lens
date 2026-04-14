import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROVIDER = "smoke-sandbox";
const MODEL_ID = "deterministic";
const API = "smoke-sandbox-api" as const;

const TS_BLOCKER_PATH = "smoke-blocking-demo.ts";
const TS_BLOCKER_CONTENT = `function demo(flag: boolean): number {\n  if (flag) {\n    return 1;\n  }\n}\n`;

const POWERSHELL_BLOCKER_PATH = "smoke-powershell-demo.ps1";
const POWERSHELL_BLOCKER_CONTENT = `gps\n}\n`;

type TextBlock = { type: "text"; text: string };

let lastInteractiveInputText = "";

function extractScenarioText(text: string): string | null {
	if (!text) return null;
	if (
		/^reply with exactly\s+/i.test(text) ||
		text.includes(TS_BLOCKER_PATH) ||
		text.includes(POWERSHELL_BLOCKER_PATH) ||
		/klaatu berada nikto/i.test(text)
	) {
		return text;
	}
	return null;
}

function getLastUserText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((item): item is TextBlock => item.type === "text")
			.map((item) => item.text)
			.join("\n");
	}
	return "";
}

function hasToolResult(messages: Message[]): boolean {
	return messages.some((message) => message.role === "toolResult");
}

function createOutput(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function emitText(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	text: string,
) {
	output.content.push({ type: "text", text: "" });
	const contentIndex = output.content.length - 1;
	stream.push({ type: "text_start", contentIndex, partial: output });
	const block = output.content[contentIndex];
	if (block?.type === "text") {
		block.text = text;
	}
	stream.push({
		type: "text_delta",
		contentIndex,
		delta: text,
		partial: output,
	});
	stream.push({
		type: "text_end",
		contentIndex,
		content: text,
		partial: output,
	});
}

function emitToolCall(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	toolCall: ToolCall,
) {
	output.content.push({ ...toolCall });
	const contentIndex = output.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	stream.push({
		type: "toolcall_delta",
		contentIndex,
		delta: JSON.stringify(toolCall.arguments),
		partial: output,
	});
	stream.push({
		type: "toolcall_end",
		contentIndex,
		toolCall,
		partial: output,
	});
}

function buildResponsePlan(
	userText: string,
): { type: "text"; text: string } | { type: "tool"; toolCall: ToolCall } {
	const trimmed = userText.trim();
	const exactMatch = trimmed.match(/^reply with exactly\s+([\s\S]+)$/i);
	if (exactMatch) {
		return { type: "text", text: exactMatch[1] ?? "" };
	}

	if (trimmed.includes(TS_BLOCKER_PATH)) {
		return {
			type: "tool",
			toolCall: {
				type: "toolCall",
				id: "call_smoke_write_ts_blocker",
				name: "write",
				arguments: {
					path: TS_BLOCKER_PATH,
					content: TS_BLOCKER_CONTENT,
				},
			},
		};
	}

	if (trimmed.includes(POWERSHELL_BLOCKER_PATH)) {
		return {
			type: "tool",
			toolCall: {
				type: "toolCall",
				id: "call_smoke_write_powershell_blocker",
				name: "write",
				arguments: {
					path: POWERSHELL_BLOCKER_PATH,
					content: POWERSHELL_BLOCKER_CONTENT,
				},
			},
		};
	}

	if (/klaatu berada nikto/i.test(trimmed)) {
		return {
			type: "text",
			text: "KLAATU BERADA NIKTO acknowledged by pi-lens smoke sandbox",
		};
	}

	return {
		type: "text",
		text: "pi-lens smoke sandbox ready",
	};
}

function streamSmokeSandbox(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output = createOutput(model);
		try {
			stream.push({ type: "start", partial: output });

			if (hasToolResult(context.messages)) {
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
				return;
			}

			const contextPromptText = getLastUserText(context.messages);
			const promptText =
				extractScenarioText(contextPromptText) || lastInteractiveInputText;
			const plan = buildResponsePlan(promptText);
			if (plan.type === "text") {
				emitText(stream, output, plan.text);
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
				return;
			}

			emitToolCall(stream, output, plan.toolCall);
			output.stopReason = "toolUse";
			stream.push({ type: "done", reason: "toolUse", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage =
				error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function registerSmokeSandbox(pi: ExtensionAPI) {
	pi.on("input", (event) => {
		if (event.source !== "extension") {
			const scenarioText = extractScenarioText(event.text);
			if (scenarioText) {
				lastInteractiveInputText = scenarioText;
			}
		}
		return { action: "continue" } as const;
	});

	pi.registerProvider(PROVIDER, {
		baseUrl: "https://pi-lens-smoke-sandbox.invalid",
		apiKey: "pi-lens-smoke-sandbox",
		api: API,
		models: [
			{
				id: MODEL_ID,
				name: "pi-lens Smoke Sandbox Deterministic",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamSmokeSandbox as unknown as never,
	});
}
