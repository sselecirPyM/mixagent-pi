/**
 * Scripted mock provider for the MixAgent end-to-end test. No network, no API key.
 * Logs every request (role, system prompt markers, tool names, message count) to $MOCK_LOG.
 */

import { appendFileSync } from "node:fs";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PLAN = `## Summary
Make the greeting friendlier.

## Changes

### \`src/greet.ts\` — edit
Use a template string.

\`\`\`\`text
<<<<<<< SEARCH
  return "hello " + name;
=======
  return \`Hello, \${name}!\`;
>>>>>>> REPLACE
\`\`\`\`
`;

const LEAD_SPLIT = `## Summary
Add two files.

## Design
Each file holds its task id.

## Subtasks
- S1: \`src/T1.txt\` — first file
- S2: \`src/T2.txt\` — second file
`;

const subPlan = (id: string) => `## Summary
Sub-plan ${id}.

## Changes

### \`src/T${id.slice(1)}.txt\` — create
\`\`\`\`text
T${id.slice(1)}
\`\`\`\`
`;

/** Join review: the sub-plans' file sections are used as written, with one revision note for T2. */
const FORK_PLAN = `## Summary
Add two files.

## Revisions
### \`src/T2.txt\`
- Keep the content exactly "T2", without a trailing newline.

## Tasks
- T1: \`src/T1.txt\` — first file
- T2: \`src/T2.txt\` — second file

## Commands
\`\`\`bash
echo joined
\`\`\`
`;

function lastText(ctx: Context): string {
	const last = ctx.messages[ctx.messages.length - 1];
	if (!last || last.role === "assistant") return "";
	return typeof last.content === "string"
		? last.content
		: last.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

type Reply = { text?: string; toolCall?: { name: string; arguments: Record<string, any> }; error?: string };

/** "flaky" prompts: sub-planner S2 answers empty once (counted here), task executor T2 fails until it is retried. */
const flakyCalls = new Map<string, number>();

function script(model: Model<any>, ctx: Context): Reply {
	const last = ctx.messages[ctx.messages.length - 1];
	switch (model.id) {
		case "scout": {
			// "noisy" prompts: an irrelevant search first, which the scout discards before the real one.
			const noisy = ctx.messages.some((m) => m.role === "user" && lastText({ ...ctx, messages: [m] }).includes("noisy"));
			const grep = { toolCall: { name: "bash", arguments: { command: "grep -rn greet src" } } };
			if (last?.role === "user" && lastText(ctx).includes("screenshot")) {
				return { toolCall: { name: "read", arguments: { path: "shot.png" } } };
			}
			if (last?.role === "toolResult" && last.toolName === "read") {
				return { toolCall: { name: "handoff", arguments: { notes: "screenshot read", files: ["src/greet.ts"] } } };
			}
			if (last?.role === "user") return noisy ? { toolCall: { name: "bash", arguments: { command: "echo NOISE_OUTPUT" } } } : grep;
			if (noisy && last?.role === "toolResult" && last.toolName === "bash") {
				const text = lastText(ctx);
				if (text.startsWith("[#1]")) return { toolCall: { name: "discard", arguments: { ids: [1], reason: "noise" } } };
				if (text.startsWith("[#1 discarded")) return grep;
			}
			if (last?.role === "toolResult" && last.toolName === "bash") {
				return {
					toolCall: {
						name: "handoff",
						arguments: { notes: "greet() is defined in src/greet.ts", files: ["src/greet.ts"] },
					},
				};
			}
			if (last?.role === "toolResult" && last.toolName === "handoff") {
				// Print mode: relay the executor report.
				return { text: lastText(ctx).match(/## Executor report\n([^\n]*)/)?.[1] ?? "(no report)" };
			}
			return { text: "scout: unexpected state" };
		}
		case "planner": {
			const text = lastText(ctx);
			if (text.includes("# Join instructions")) return { text: FORK_PLAN };
			const sub = text.match(/# Sub-planner instructions: subtask (S\d)/)?.[1];
			if (sub && sub === "S2" && text.includes("flaky")) {
				const n = (flakyCalls.get(sub) ?? 0) + 1;
				flakyCalls.set(sub, n);
				if (n === 1) return { text: "" };
			}
			if (sub) return { text: subPlan(sub) };
			return { text: text.includes("fork:") ? LEAD_SPLIT : PLAN };
		}
		case "executor": {
			if (last?.role === "user") {
				const task = lastText(ctx).match(/## Task (T\d)/)?.[1];
				if (task === "T2" && lastText(ctx).includes("flaky") && !lastText(ctx).includes("a previous attempt at this task failed")) {
					return { error: "mock executor failure" };
				}
				// Everything was auto-applied by MixAgent: only the report is left.
				if (lastText(ctx).includes("Applied by MixAgent") && !lastText(ctx).includes("## Commands")) {
					return { text: "Executor done. Auto-applied by MixAgent." };
				}
				if (task) return { toolCall: { name: "write", arguments: { path: `src/${task}.txt`, content: task } } };
				if (lastText(ctx).includes("## Already applied")) return { toolCall: { name: "bash", arguments: { command: "echo joined" } } };
				return {
					toolCall: {
						name: "edit",
						arguments: {
							path: "src/greet.ts",
							edits: [{ oldText: '  return "hello " + name;', newText: "  return `Hello, ${name}!`;" }],
						},
					},
				};
			}
			return { text: `Executor done. Edit result: ${lastText(ctx).slice(0, 80)}` };
		}
	}
	return { text: "?" };
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("mock", {
		baseUrl: "http://mock.invalid",
		apiKey: "mock-key",
		api: "mock-api",
		models: ["scout", "planner", "executor"].map((id) => ({
			id,
			name: `Mock ${id}`,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		})),
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const reply = script(model, context);
			if (process.env.MOCK_LOG) {
				appendFileSync(
					process.env.MOCK_LOG,
					`${JSON.stringify({
						model: model.id,
						scoutPrompt: context.systemPrompt?.includes("MixAgent scout mode") ?? false,
						executorPrompt: context.systemPrompt?.includes("MixAgent executor mode") ?? false,
						plannerPrompt: context.systemPrompt?.startsWith("You are the PLANNER") ?? false,
						systemPrompt: context.systemPrompt?.length ?? 0,
						lastUser: lastText(context).slice(-4000),
						tools: (context.tools ?? []).map((t) => t.name),
						messages: context.messages.length,
						roles: context.messages.map((m) => m.role),
						images: context.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.filter((c) => c.type === "image"))).length,
						toolResults: context.messages.flatMap((m) =>
							m.role === "toolResult" ? [`${m.toolName}:${lastText({ ...context, messages: [m] }).slice(0, 60)}`] : [],
						),
						firstUser: context.messages.find((m) => m.role === "user")
							? lastText({ ...context, messages: [context.messages.find((m) => m.role === "user")!] }).slice(0, 4000)
							: "",
					})}\n`,
				);
			}
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 100,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 120,
					cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
				},
				stopReason: reply.error ? "error" : reply.toolCall ? "toolUse" : "stop",
				errorMessage: reply.error,
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: output });
				if (reply.error) {
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
					return;
				}
				if (reply.text) {
					output.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					(output.content[0] as { text: string }).text = reply.text;
					stream.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial: output });
					stream.push({ type: "text_end", contentIndex: 0, content: reply.text, partial: output });
				}
				if (reply.toolCall) {
					const toolCall = { type: "toolCall" as const, id: `call_${Date.now()}`, ...reply.toolCall };
					output.content.push(toolCall);
					const idx = output.content.length - 1;
					stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
				}
				stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
				stream.end();
			});
			return stream;
		},
	});
}
