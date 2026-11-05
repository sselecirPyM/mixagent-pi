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
	/**
	 * Main session id. Providers use it for cache affinity, and subscription providers (opencode) require it
	 * as a session header.
	 */
	sessionId?: string;
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

/** Newer pi versions stream through the registry, which resolves auth and adds provider session headers. */
type RegistryStream = { streamSimple?: typeof streamSimple };

export async function runPlanner(pkg: PlannerPackage, opts: PlannerOptions): Promise<PlannerResult> {
	const context = {
		systemPrompt: opts.forkJoin ? PLANNER_SYSTEM + PLANNER_SPLIT : PLANNER_SYSTEM,
		messages: [{ role: "user" as const, content: plannerContent(pkg, opts.extra), timestamp: Date.now() }],
	};
	const options = {
		sessionId: opts.sessionId,
		signal: opts.signal,
		maxTokens: Math.min(opts.maxTokens, opts.model.maxTokens || opts.maxTokens),
		reasoning: opts.model.reasoning && opts.thinking !== "off" ? opts.thinking : undefined,
	};

	const registry = opts.modelRegistry as unknown as RegistryStream;
	let stream: ReturnType<typeof streamSimple>;
	if (typeof registry.streamSimple === "function") {
		stream = registry.streamSimple.call(opts.modelRegistry, opts.model, context, options);
	} else {
		const auth = await opts.modelRegistry.getApiKeyAndHeaders(opts.model);
		if (!auth.ok) throw new Error(auth.error);
		stream = streamSimple(opts.model, context, { ...options, apiKey: auth.apiKey, headers: auth.headers });
	}

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

/** Calls fn for every line; `outsideFence` is false for code fence lines and the lines inside them. */
function forEachLine(text: string, fn: (line: string, outsideFence: boolean) => void): void {
	let fence = 0;
	for (const line of text.split(/\r?\n/)) {
		const ticks = line.match(/^(`{3,})(.*)$/);
		if (fence > 0) {
			if (ticks && ticks[1].length >= fence && !ticks[2].trim()) fence = 0;
		} else if (ticks) {
			fence = ticks[1].length;
		}
		fn(line, fence === 0 && !ticks);
	}
}

/** Splits a plan into its `##` sections and `### \`path\`` file sections, ignoring headings inside code fences. */
function parsePlanParts(plan: string): { sections: Map<string, string>; files: { path: string; text: string }[] } {
	const sections = new Map<string, string[]>();
	const files: { path: string; lines: string[] }[] = [];
	let current: string[] | undefined;
	forEachLine(plan, (line, outsideFence) => {
		const file = outsideFence && line.match(FILE_HEADING);
		const heading = outsideFence && line.match(/^##\s+(.+?)\s*$/);
		if (file) {
			current = [];
			files.push({ path: normalizePlanPath(file[1]), lines: current });
		} else if (heading) {
			current = [];
			sections.set(heading[1].toLowerCase(), current);
			return;
		}
		current?.push(line);
	});
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

/** One `### \`path\` — kind` section of a plan. */
export interface FileSection {
	/** The heading line as written. */
	heading: string;
	/** Normalized path from the heading. */
	path: string;
	kind: "edit" | "create" | "delete";
	/** The lines after the heading, up to the next file section or `##` heading. */
	body: string;
}

/**
 * Rebuilds the plan with fn's replacement for each file section (heading included); undefined keeps the section.
 * Sections end like in parsePlanParts: at the next file section or `##` heading outside code fences.
 */
export function mapFileSections(plan: string, fn: (section: FileSection, index: number) => string | undefined): string {
	const out: string[] = [];
	let current: { heading: string; path: string; kind: FileSection["kind"]; lines: string[] } | undefined;
	let index = 0;
	const flush = () => {
		if (!current) return;
		const { lines, ...section } = current;
		const replaced = fn({ ...section, body: lines.join("\n") }, index++);
		if (replaced === undefined) {
			out.push(section.heading, ...lines);
		} else {
			// Keep the blank lines that separate the section from the next one.
			let end = lines.length;
			while (end > 0 && !lines[end - 1].trim()) end--;
			out.push(replaced, ...lines.slice(end));
		}
		current = undefined;
	};
	forEachLine(plan, (line, outsideFence) => {
		const file = outsideFence && line.match(FILE_HEADING);
		if (file || (outsideFence && /^##\s+(.+?)\s*$/.test(line))) flush();
		if (file) {
			current = { heading: line, path: normalizePlanPath(file[1]), kind: file[2].toLowerCase() as FileSection["kind"], lines: [] };
		} else if (current) {
			current.lines.push(line);
		} else {
			out.push(line);
		}
	});
	flush();
	return out.join("\n");
}

/** The plan's file sections, in order. */
export function fileSections(plan: string): FileSection[] {
	const sections: FileSection[] = [];
	mapFileSections(plan, (section) => void sections.push(section));
	return sections;
}

/** Heads the join's notes in a file section; the executor only learns how to apply them from here. */
export const REVISIONS_NOTE = "Revisions by the join planner (notes, not exact edits: `read`/`grep` the code to find the exact places";

/** Parses the join planner's "## Revisions": one "### `path`" entry of notes per file. */
function parseRevisions(join: string): { path: string; kind?: string; notes: string }[] {
	const revisions: { path: string; kind?: string; lines: string[] }[] = [];
	let inRevisions = false;
	let current: string[] | undefined;
	forEachLine(join, (line, outsideFence) => {
		const heading = outsideFence && line.match(/^##\s+(.+?)\s*$/);
		const file = outsideFence && inRevisions && line.match(/^###\s+`([^`]+)`\s*(?:[—-]\s*(edit|create|delete)\b)?/i);
		if (heading) {
			inRevisions = heading[1].toLowerCase() === "revisions";
			current = undefined;
		} else if (file) {
			current = [];
			revisions.push({ path: normalizePlanPath(file[1]), kind: file[2]?.toLowerCase(), lines: current });
		} else {
			current?.push(line);
		}
	});
	return revisions.map((r) => ({ path: r.path, kind: r.kind, notes: r.lines.join("\n").trim() })).filter((r) => r.notes);
}

/**
 * Builds the final fork-join plan, so the join planner never copies sub-plans: every sub-plan file section as
 * written (grouped by file), followed by the join's revision notes for that file, then the join's Tasks, Commands
 * and Answer. A join that wrote its own "## Changes" anyway is used as is.
 */
export function assembleJoinPlan(join: string, subPlans: { id: string; plan: string }[]): string {
	const { sections } = parsePlanParts(join);
	if (sections.has("changes")) return join;
	const byPath = new Map<string, string[]>();
	for (const s of subPlans) {
		for (const f of parsePlanParts(s.plan).files) {
			const [heading, ...body] = f.text.split("\n");
			byPath.set(f.path, [...(byPath.get(f.path) ?? []), [`${heading} (${s.id})`, ...body].join("\n")]);
		}
	}
	for (const r of parseRevisions(join)) {
		const parts = byPath.get(r.path);
		if (parts) parts.push(`${REVISIONS_NOTE}, they take precedence over the blocks above):\n${r.notes}`);
		else byPath.set(r.path, [`### \`${r.path}\` — ${r.kind ?? "edit"}\n${REVISIONS_NOTE}):\n${r.notes}`]);
	}
	const changes = [...byPath.values()].map((parts) => parts.join("\n\n")).join("\n\n");
	return [
		sections.get("summary") && `## Summary\n${sections.get("summary")}`,
		changes && `## Changes\n\n${changes}`,
		...["Tasks", "Commands", "Answer"].map((name) => sections.get(name.toLowerCase()) && `## ${name}\n${sections.get(name.toLowerCase())}`),
	]
		.filter(Boolean)
		.join("\n\n");
}
