/** Single, tool-less call to the flagship planner model. */

import {
	type Api,
	type AssistantMessage,
	type ImageContent,
	type Model,
	streamSimple,
	type TextContent,
	type Usage,
} from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "./config.ts";
import { PLANNER_SPLIT, PLANNER_SYSTEM } from "./prompts.ts";
import type { PlannerPackage } from "./transcript.ts";

export interface PlannerResult {
	text: string;
	usage: Usage;
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
}

export interface PlannerOptions {
	model: Model<Api>;
	modelRegistry: ModelRegistry;
	thinking: ThinkingLevel;
	maxTokens: number;
	/**
	 * Let the lead planner split large work into subtasks (adds the "## Subtasks" instructions). Use the same
	 * value for every call of one cycle: the system prompt must stay identical for prompt caching.
	 */
	forkJoin?: boolean;
	/**
	 * Role instructions appended after the package (sub-planner / join). The package stays the first part
	 * of the message, so these calls reuse the prompt cache written by the lead call.
	 */
	extra?: string;
	signal?: AbortSignal;
	/** Called with the text generated so far (throttled by the caller if needed). */
	onProgress?: (text: string) => void;
}

/** The package as one user message: the Markdown first, then each referenced image with its label. */
export function plannerContent(pkg: PlannerPackage, extra?: string): (TextContent | ImageContent)[] {
	return [
		{ type: "text", text: pkg.text },
		...pkg.images.flatMap((img, i): (TextContent | ImageContent)[] => [
			{ type: "text", text: `[image ${i + 1}] ${img.label}:` },
			{ type: "image", data: img.data, mimeType: img.mimeType },
		]),
		...(extra ? [{ type: "text" as const, text: extra }] : []),
	];
}

export async function runPlanner(pkg: PlannerPackage, opts: PlannerOptions): Promise<PlannerResult> {
	const auth = await opts.modelRegistry.getApiKeyAndHeaders(opts.model);
	if (!auth.ok) throw new Error(auth.error);

	const stream = streamSimple(
		opts.model,
		{
			systemPrompt: opts.forkJoin ? PLANNER_SYSTEM + PLANNER_SPLIT : PLANNER_SYSTEM,
			messages: [{ role: "user", content: plannerContent(pkg, opts.extra), timestamp: Date.now() }],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: opts.signal,
			maxTokens: Math.min(opts.maxTokens, opts.model.maxTokens || opts.maxTokens),
			reasoning: opts.model.reasoning && opts.thinking !== "off" ? opts.thinking : undefined,
		},
	);

	let text = "";
	for await (const event of stream) {
		if (event.type === "text_delta") {
			text += event.delta;
			opts.onProgress?.(text);
		}
	}
	const message = await stream.result();
	const finalText = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
	return {
		text: finalText || text.trim(),
		usage: message.usage,
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
	};
}

/** If the planner asked for more context, returns the request body; otherwise undefined. */
export function parseNeedContext(plan: string): string | undefined {
	const match = plan.match(/^#{1,3}\s*Need context\s*$/im);
	if (!match || match.index === undefined) return undefined;
	// Only treat it as a context request when no actual changes/answer were produced.
	if (/^#{1,3}\s*(Changes|Answer)\s*$/im.test(plan)) return undefined;
	return plan.slice(match.index + match[0].length).trim() || "(no details given)";
}

/** Rough count of file operations in a plan, for status display. */
export function countPlanChanges(plan: string): number {
	return (plan.match(/^###\s+`[^`]+`\s*[—-]\s*(edit|create|delete)\b/gim) ?? []).length;
}

export interface PlanTask {
	id: string;
	goal: string;
	files: string[];
	/** Sub-plan for this task's executor: the summary, a task note and only this task's file sections. */
	plan: string;
}

export interface SplitPlan {
	tasks: PlanTask[];
	/** Plan for the join executor that runs the Commands after all tasks; undefined without Commands. */
	joinPlan?: string;
	answer?: string;
}

const FILE_HEADING = /^###\s+`([^`]+)`\s*[—-]\s*(edit|create|delete)\b/i;

function normalizePlanPath(p: string): string {
	return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Splits a plan into its `##` sections and `### \`path\`` file sections, ignoring headings inside code fences. */
function parsePlanParts(plan: string): { sections: Map<string, string>; files: { path: string; text: string }[] } {
	const sections = new Map<string, string[]>();
	const files: { path: string; lines: string[] }[] = [];
	let current: string[] | undefined;
	let fence = 0;
	for (const line of plan.split(/\r?\n/)) {
		const ticks = line.match(/^(`{3,})(.*)$/);
		if (fence > 0) {
			if (ticks && ticks[1].length >= fence && !ticks[2].trim()) fence = 0;
		} else if (ticks) {
			fence = ticks[1].length;
		} else {
			const file = line.match(FILE_HEADING);
			const heading = line.match(/^##\s+(.+?)\s*$/);
			if (file) {
				current = [];
				files.push({ path: normalizePlanPath(file[1]), lines: current });
			} else if (heading) {
				current = [];
				sections.set(heading[1].toLowerCase(), current);
				continue;
			}
		}
		current?.push(line);
	}
	return {
		sections: new Map([...sections].map(([k, v]): [string, string] => [k, v.join("\n").trim()])),
		files: files.map((f) => ({ path: f.path, text: f.lines.join("\n").trim() })),
	};
}

interface TaskLine {
	id: string;
	goal: string;
	files: string[];
}

const TASK_LINE = { T: /^\s*[-*]\s*\**(T\d+)\**\s*[:：.)]\s*(.*)$/i, S: /^\s*[-*]\s*\**(S\d+)\**\s*[:：.)]\s*(.*)$/i };

/** Parses "- T1: `a.ts`, `b.ts` — goal" lines; only the leading backticked items are files. */
function parseTaskLines(body: string, prefix: keyof typeof TASK_LINE): TaskLine[] {
	const tasks: TaskLine[] = [];
	for (const line of body.split("\n")) {
		const m = line.match(TASK_LINE[prefix]);
		if (!m) continue;
		const lead = m[2].match(/^(?:\s*`[^`]+`\s*[,，、]?)*/)?.[0] ?? "";
		const files = [...lead.matchAll(/`([^`]+)`/g)].map((f) => normalizePlanPath(f[1]));
		const goal = m[2].slice(lead.length).replace(/^[\s,，—–:-]+/, "").trim();
		tasks.push({ id: m[1].toUpperCase(), goal: goal || files.join(", "), files });
	}
	return tasks;
}

/**
 * Splits a plan with a valid `## Tasks` section into per-task sub-plans with disjoint files.
 * Returns undefined (run one executor) when there is no Tasks section, fewer than 2 tasks, or any
 * file is unassigned, assigned twice, or unknown.
 */
export function splitPlan(plan: string): SplitPlan | undefined {
	const { sections, files } = parsePlanParts(plan);
	const body = sections.get("tasks");
	if (!body) return undefined;
	const tasks = parseTaskLines(body, "T");
	if (tasks.length < 2 || tasks.some((t) => t.files.length === 0)) return undefined;
	if (new Set(tasks.map((t) => t.id)).size !== tasks.length) return undefined;
	const planned = [...new Set(files.map((f) => f.path))];
	const owner = new Map<string, number>();
	for (let i = 0; i < tasks.length; i++) {
		for (const f of tasks[i].files) {
			if (owner.has(f) || !planned.includes(f)) return undefined;
			owner.set(f, i);
		}
	}
	if (planned.some((p) => !owner.has(p))) return undefined;

	const summary = sections.get("summary");
	const head = summary ? `## Summary\n${summary}\n\n` : "";
	// Text between "## Changes" and the first file section (shared notes) goes to every task.
	const preamble = sections.get("changes");
	const split: PlanTask[] = tasks.map((t, i) => ({
		...t,
		plan: `${head}## Task ${t.id} (${i + 1} of ${tasks.length})\n${t.goal}\n\nOther executors apply the rest of this plan in parallel: change only the files in the Changes below and do not touch any other file. Do not run build or test commands; they run once after all tasks finish.\n\n## Changes\n\n${preamble ? `${preamble}\n\n` : ""}${files
			.filter((f) => owner.get(f.path) === i)
			.map((f) => f.text)
			.join("\n\n")}`,
	}));
	const commands = sections.get("commands");
	const joinPlan = commands
		? `${head}## Already applied\nParallel executors already applied all file changes of this plan to: ${planned.map((p) => `\`${p}\``).join(", ")}. Do not re-apply them.\n\n## Commands\n${commands}`
		: undefined;
	return { tasks: split, joinPlan, answer: sections.get("answer") };
}

/** One subtask of the lead plan, planned by its own sub-planner call. */
export type Subtask = TaskLine;

/**
 * If the lead planner split the planning ("## Subtasks" and no file changes), returns the subtasks.
 * Files may overlap: the join planner resolves overlaps.
 */
export function parseSubtasks(plan: string): Subtask[] | undefined {
	const { sections, files } = parsePlanParts(plan);
	const body = sections.get("subtasks");
	if (body === undefined || files.length > 0) return undefined;
	const seen = new Set<string>();
	const subtasks = parseTaskLines(body, "S").filter((t) => !seen.has(t.id) && !!seen.add(t.id));
	return subtasks.length > 0 ? subtasks : undefined;
}

/**
 * Replaces the join planner's "### `path` — from S1" lines with that sub-plan's section for the file, so the
 * join does not repeat unchanged SEARCH/REPLACE blocks. Falls back to any sub-plan that has the file.
 * Returns the expanded plan and the references no sub-plan could resolve.
 */
export function expandJoinPlan(join: string, subPlans: Map<string, string>): { plan: string; unresolved: string[] } {
	const byId = new Map(
		[...subPlans].map(([id, text]) => [id.toUpperCase(), new Map(parsePlanParts(text).files.map((f) => [f.path, f.text]))]),
	);
	const unresolved: string[] = [];
	const out: string[] = [];
	let fence = 0;
	for (const line of join.split(/\r?\n/)) {
		const ticks = line.match(/^(`{3,})(.*)$/);
		if (fence > 0) {
			if (ticks && ticks[1].length >= fence && !ticks[2].trim()) fence = 0;
		} else if (ticks) {
			fence = ticks[1].length;
		} else {
			const ref = line.match(/^###\s+`([^`]+)`\s*[—-]\s*from\s+\**(S\d+)\**\s*$/i);
			if (ref) {
				const path = normalizePlanPath(ref[1]);
				const id = ref[2].toUpperCase();
				const section = byId.get(id)?.get(path) ?? [...byId.values()].map((m) => m.get(path)).find(Boolean);
				if (section) {
					out.push(section);
					continue;
				}
				unresolved.push(`${path} from ${id}`);
			}
		}
		out.push(line);
	}
	return { plan: out.join("\n"), unresolved };
}
