/**
 * Runs the plan in a brand-new pi session (SDK child session) on the cheap executor model.
 * The session gets a fresh context: only the executor system prompt, AGENTS.md files and the plan.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRegistry,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "./config.ts";
import { EXECUTOR_APPEND } from "./prompts.ts";
import { describeCall, textOf } from "./transcript.ts";

export interface ExecutorToolCall {
	id: string;
	label: string;
	done: boolean;
	isError: boolean;
}

export interface ExecutorUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface ExecutorProgress {
	toolCalls: ExecutorToolCall[];
	/** Text of the assistant message currently streaming (or the last one). */
	text: string;
	usage: ExecutorUsage;
}

export interface ExecutorResult extends ExecutorProgress {
	output: string;
	sessionFile?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface ExecutorOptions {
	cwd: string;
	model: Model<Api>;
	modelRegistry: ModelRegistry;
	thinking: ThinkingLevel;
	tools: string[];
	kickoff: string;
	sessionName: string;
	persist: boolean;
	parentSessionFile?: string;
	sessionDir?: string;
	signal?: AbortSignal;
	onProgress?: (progress: ExecutorProgress) => void;
}

export function emptyUsage(): ExecutorUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export async function runExecutor(opts: ExecutorOptions): Promise<ExecutorResult> {
	const agentDir = getAgentDir();
	// noExtensions: avoid loading MixAgent itself (and other extensions) into the child session.
	const resourceLoader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir,
		noExtensions: true,
		appendSystemPrompt: [EXECUTOR_APPEND],
	});
	await resourceLoader.reload();

	const sessionManager = opts.persist ? SessionManager.create(opts.cwd, opts.sessionDir) : SessionManager.inMemory(opts.cwd);
	if (opts.persist && opts.parentSessionFile) {
		sessionManager.newSession({ parentSession: opts.parentSessionFile });
	}
	sessionManager.appendSessionInfo(opts.sessionName);

	const { session } = await createAgentSession({
		cwd: opts.cwd,
		agentDir,
		model: opts.model,
		thinkingLevel: opts.model.reasoning ? opts.thinking : "off",
		tools: opts.tools,
		resourceLoader,
		sessionManager,
		modelRegistry: opts.modelRegistry,
		authStorage: opts.modelRegistry.authStorage,
	});

	const progress: ExecutorProgress = { toolCalls: [], text: "", usage: emptyUsage() };
	const emit = () => opts.onProgress?.(progress);
	let lastStopReason: string | undefined;
	let lastError: string | undefined;

	const unsubscribe = session.subscribe((event) => {
		switch (event.type) {
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					progress.text += event.assistantMessageEvent.delta;
					emit();
				}
				break;
			case "message_start":
				if (event.message.role === "assistant") progress.text = "";
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					const msg = event.message;
					progress.text = textOf(msg.content);
					progress.usage.input += msg.usage.input;
					progress.usage.output += msg.usage.output;
					progress.usage.cacheRead += msg.usage.cacheRead;
					progress.usage.cacheWrite += msg.usage.cacheWrite;
					progress.usage.cost += msg.usage.cost.total;
					progress.usage.turns++;
					lastStopReason = msg.stopReason;
					lastError = msg.errorMessage;
					emit();
				}
				break;
			case "tool_execution_start":
				progress.toolCalls.push({
					id: event.toolCallId,
					label: describeCall(event.toolName, event.args ?? {}).split("\n")[0],
					done: false,
					isError: false,
				});
				emit();
				break;
			case "tool_execution_end": {
				const call = progress.toolCalls.find((c) => c.id === event.toolCallId);
				if (call) {
					call.done = true;
					call.isError = event.isError;
				}
				emit();
				break;
			}
		}
	});

	const onAbort = () => void session.abort();
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		if (opts.signal?.aborted) throw new Error("aborted");
		await session.prompt(opts.kickoff, { expandPromptTemplates: false });
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
	}

	let output = "";
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const msg = session.messages[i];
		if (msg.role === "assistant") {
			output = textOf(msg.content).trim();
			if (output) break;
		}
	}
	const sessionFile = session.sessionFile;
	session.dispose();

	return { ...progress, output, sessionFile, stopReason: lastStopReason, errorMessage: lastError };
}
