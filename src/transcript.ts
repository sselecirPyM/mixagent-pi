/**
 * Packs the scout's work (user request + tool calls/results) into a compact Markdown
 * document for the planner, and prunes finished scout cycles from the scout's context.
 *
 * Pure functions over message arrays so they can be unit tested without pi.
 */

import { isAbsolute, resolve } from "node:path";

export const HANDOFF_TOOL = "handoff";
export const DISCARD_TOOL = "discard";

interface TextBlock {
	type: "text";
	text: string;
}
interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
}
export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}
type ContentBlock = TextBlock | ToolCallBlock | ImageBlock | { type: string; [key: string]: any };

/** Structural subset of pi's AgentMessage that this module relies on. */
export type Msg =
	| { role: "user"; content: string | ContentBlock[]; [key: string]: any }
	| { role: "assistant"; content: ContentBlock[]; stopReason?: string; [key: string]: any }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: ContentBlock[];
			isError?: boolean;
			details?: any;
			[key: string]: any;
	  }
	| { role: string; [key: string]: any };

export type HandoffStatus = "done" | "need_context" | "error";

export interface HandoffDetails {
	mixagent: HandoffStatus;
	[key: string]: unknown;
}

export interface ScoutStep {
	toolName: string;
	args: Record<string, any>;
	output: string;
	isError: boolean;
	/** Set when the scout discarded this step as irrelevant (the discard note replaces the output). */
	discarded?: string;
	/** Images in the result (e.g. `read` of a screenshot). */
	images?: ImageBlock[];
}

export interface ScoutCycle {
	/** User messages of this cycle (the request, plus any steering sent while scouting). */
	requests: string[];
	/** Images attached to the user messages of this cycle. */
	requestImages: ImageBlock[];
	steps: ScoutStep[];
	/** Planner "Need context" requests from earlier handoff rounds of this cycle. */
	plannerRequests: string[];
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is TextBlock => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

export function imagesOf(content: unknown): ImageBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter((c): c is ImageBlock => c?.type === "image" && typeof c.data === "string" && !!c.data);
}

function handoffStatus(msg: Msg): HandoffStatus | undefined {
	if (msg.role !== "toolResult" || msg.toolName !== HANDOFF_TOOL) return undefined;
	return (msg.details as HandoffDetails | undefined)?.mixagent;
}

/** A message that ends a previous agent run (or a finished scout cycle). */
function isRunBoundary(msg: Msg): boolean {
	if (msg.role === "assistant") return msg.stopReason !== undefined && msg.stopReason !== "toolUse";
	return handoffStatus(msg) === "done";
}

/** Index of the first message of the current (unfinished) cycle. */
export function currentCycleStart(messages: Msg[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isRunBoundary(messages[i])) return i + 1;
	}
	return 0;
}

export interface DiscardDetails {
	discarded: { toolCallId: string; ref: number }[];
	reason?: string;
}

function isDiscardCall(block: ContentBlock): boolean {
	return block.type === "toolCall" && (block as ToolCallBlock).name === DISCARD_TOOL;
}

function isDiscardResult(msg: Msg): boolean {
	return msg.role === "toolResult" && msg.toolName === DISCARD_TOOL;
}

export function discardNote(ref: number, reason?: string): string {
	return `[#${ref} discarded${reason?.trim() ? `: ${reason.trim()}` : ""}]`;
}

/** Step number (#1, #2, … in call order) of every scout tool call in the current cycle, by tool call id. */
function cycleStepRefs(messages: Msg[]): Map<string, number> {
	const refs = new Map<string, number>();
	for (const msg of messages.slice(currentCycleStart(messages))) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.content as ContentBlock[]) {
			if (block.type !== "toolCall") continue;
			const call = block as ToolCallBlock;
			if (call.name !== HANDOFF_TOOL && call.name !== DISCARD_TOOL) refs.set(call.id, refs.size + 1);
		}
	}
	return refs;
}

/** Discarded tool call id -> { ref, reason }, from successful discard results. */
function discardedSteps(messages: Msg[]): Map<string, { ref: number; reason?: string }> {
	const out = new Map<string, { ref: number; reason?: string }>();
	for (const msg of messages) {
		if (!isDiscardResult(msg) || msg.isError) continue;
		const d = msg.details as DiscardDetails | undefined;
		for (const step of d?.discarded ?? []) out.set(step.toolCallId, { ref: step.ref, reason: d?.reason });
	}
	return out;
}

/**
 * Resolves step numbers of the current cycle to tool call ids. Steps without a result yet
 * (e.g. siblings of the discard call) and unknown numbers are reported as invalid.
 */
export function resolveDiscard(messages: Msg[], ids: number[]): { discarded: DiscardDetails["discarded"]; invalid: number[] } {
	const done = new Set(messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId as string] : [])));
	const byRef = new Map([...cycleStepRefs(messages)].map(([id, ref]) => [ref, id]));
	const discarded: DiscardDetails["discarded"] = [];
	const invalid: number[] = [];
	for (const ref of new Set(ids)) {
		const toolCallId = byRef.get(ref);
		if (toolCallId && done.has(toolCallId)) discarded.push({ toolCallId, ref });
		else invalid.push(ref);
	}
	return { discarded, invalid };
}

/** Prefixes the current cycle's scout tool results with their step number (`[#N]`) so the scout can discard them. */
export function labelCycleSteps(messages: Msg[]): Msg[] {
	const refs = cycleStepRefs(messages);
	if (refs.size === 0) return messages;
	return messages.map((msg) => {
		const ref = msg.role === "toolResult" ? refs.get(msg.toolCallId) : undefined;
		if (ref === undefined) return msg;
		return { ...msg, content: [{ type: "text", text: `[#${ref}]` }, ...(msg.content as ContentBlock[])] };
	});
}

/**
 * Applies the scout's discards to the context: discarded tool results are replaced with a short
 * note, and the discard calls and their results are removed entirely.
 */
export function applyDiscards(messages: Msg[]): Msg[] {
	if (!messages.some(isDiscardResult)) return messages;
	const discarded = discardedSteps(messages);
	const out: Msg[] = [];
	for (const msg of messages) {
		if (isDiscardResult(msg)) continue;
		const step = msg.role === "toolResult" ? discarded.get(msg.toolCallId) : undefined;
		if (step) {
			out.push({ ...msg, content: [{ type: "text", text: discardNote(step.ref, step.reason) }] });
			continue;
		}
		if (msg.role === "assistant" && (msg.content as ContentBlock[]).some(isDiscardCall)) {
			const kept = (msg.content as ContentBlock[]).filter((b) => !isDiscardCall(b) && b.type !== "thinking");
			if (kept.length > 0) out.push({ ...msg, content: kept });
			continue;
		}
		out.push(msg);
	}
	return out;
}

export function extractCycle(messages: Msg[]): ScoutCycle {
	const slice = messages.slice(currentCycleStart(messages));
	const results = new Map<string, Msg & { role: "toolResult" }>();
	for (const msg of slice) {
		if (msg.role === "toolResult") results.set(msg.toolCallId, msg as Msg & { role: "toolResult" });
	}
	const discarded = discardedSteps(slice);

	const cycle: ScoutCycle = { requests: [], requestImages: [], steps: [], plannerRequests: [] };
	for (const msg of slice) {
		if (msg.role === "user") {
			const text = textOf(msg.content).trim();
			if (text) cycle.requests.push(text);
			cycle.requestImages.push(...imagesOf(msg.content));
		} else if (msg.role === "assistant") {
			for (const block of msg.content as ContentBlock[]) {
				if (block.type !== "toolCall") continue;
				const call = block as ToolCallBlock;
				const result = results.get(call.id);
				if (call.name === HANDOFF_TOOL) {
					if (result && handoffStatus(result) === "need_context") cycle.plannerRequests.push(textOf(result.content));
					continue;
				}
				if (call.name === DISCARD_TOOL) continue;
				if (!result) continue; // still running or sibling of the current handoff call
				cycle.steps.push({
					toolName: call.name,
					args: call.arguments ?? {},
					output: textOf(result.content),
					isError: !!result.isError,
					discarded: discarded.has(call.id) ? (discarded.get(call.id)!.reason?.trim() ?? "") : undefined,
					images: imagesOf(result.content),
				});
			}
		}
	}
	return cycle;
}

function normalizePath(cwd: string, p: string): string {
	const stripped = p.replace(/^@/, "");
	return (isAbsolute(stripped) ? stripped : resolve(cwd, stripped)).replace(/\\/g, "/").toLowerCase();
}

/**
 * Removes redundant steps: identical repeated calls (keep the latest) and reads of files
 * that are attached in full anyway.
 */
export function dedupeSteps(steps: ScoutStep[], cwd: string, attachedFiles: string[]): ScoutStep[] {
	const attached = new Set(attachedFiles.map((f) => normalizePath(cwd, f)));
	const seen = new Set<string>();
	const kept: ScoutStep[] = [];
	for (let i = steps.length - 1; i >= 0; i--) {
		const step = steps[i];
		if (step.toolName === "read" && typeof step.args.path === "string" && !step.isError) {
			if (attached.has(normalizePath(cwd, step.args.path))) continue;
		}
		const key = `${step.toolName}\u0000${JSON.stringify(step.args)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(step);
	}
	return kept.reverse();
}

export function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.7);
	const tail = max - head;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n… [${omitted} chars omitted] …\n${text.slice(text.length - tail)}`;
}

export function describeCall(toolName: string, args: Record<string, any>): string {
	switch (toolName) {
		case "bash":
			return `$ ${args.command}`;
		case "read": {
			const range =
				args.offset !== undefined || args.limit !== undefined
					? ` (offset ${args.offset ?? 1}, limit ${args.limit ?? "∞"})`
					: "";
			return `read ${args.path}${range}`;
		}
		case "grep":
			return `grep ${JSON.stringify(args.pattern)}${args.path ? ` in ${args.path}` : ""}${args.glob ? ` --glob ${args.glob}` : ""}`;
		case "find":
			return `find ${JSON.stringify(args.pattern)}${args.path ? ` in ${args.path}` : ""}`;
		case "ls":
			return `ls ${args.path ?? "."}`;
		default:
			return `${toolName} ${JSON.stringify(args)}`;
	}
}

/** Longest run of backticks in text, so fences can always be made longer than any content. */
function fenceFor(text: string): string {
	let longest = 0;
	for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
	return "`".repeat(Math.max(3, longest + 1));
}

function fenced(text: string, lang = ""): string {
	const fence = fenceFor(text);
	return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`;
}

const EXT_LANG: Record<string, string> = {
	ts: "ts",
	tsx: "tsx",
	js: "js",
	jsx: "jsx",
	mjs: "js",
	cjs: "js",
	py: "python",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	cs: "csharp",
	cpp: "cpp",
	cc: "cpp",
	c: "c",
	h: "c",
	hpp: "cpp",
	rb: "ruby",
	php: "php",
	swift: "swift",
	sh: "bash",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	html: "html",
	css: "css",
	scss: "scss",
	sql: "sql",
	vue: "vue",
	svelte: "svelte",
};

export function langFor(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return EXT_LANG[ext] ?? "";
}

const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** MIME type of image files the planner can be shown, by extension. */
export function imageMimeFor(path: string): string | undefined {
	return IMAGE_MIME[path.split(".").pop()?.toLowerCase() ?? ""];
}

export interface AttachedFile {
	path: string;
	content?: string;
	/** Set instead of `content` for image files. */
	image?: ImageBlock;
	error?: string;
}

export interface PackageInput {
	cycle: ScoutCycle;
	notes: string;
	files: AttachedFile[];
	cwd: string;
	maxToolOutputChars: number;
	maxFileChars: number;
	maxPackageChars: number;
	/** Max images attached to the package; 0 when the planner model cannot see images. */
	maxImages: number;
}

export interface PackageImage extends ImageBlock {
	/** Where the image came from, e.g. "attached by the user" or "step 3: read shot.png". */
	label: string;
}

export interface PlannerPackage {
	/** The Markdown document; images are referenced as `[image N]`. */
	text: string;
	/** Images sent after the text, in `[image N]` order. */
	images: PackageImage[];
}

/** Builds the Markdown document (plus the images it references) sent to the planner. */
export function buildPlannerPackage(input: PackageInput): PlannerPackage {
	const { cycle, notes, files, cwd } = input;
	const parts: string[] = [];
	const images: PackageImage[] = [];
	const attach = (list: ImageBlock[], label: string): string =>
		list
			.map((img) => {
				if (images.length >= input.maxImages) return "[image omitted]";
				images.push({ type: "image", data: img.data, mimeType: img.mimeType, label });
				return `[image ${images.length}]`;
			})
			.join(" ");

	const [request, ...followUps] = cycle.requests;
	parts.push(`# User request\n\n${request ?? "(empty)"}`);
	if (followUps.length > 0) {
		parts.push(`## Additional user messages\n\n${followUps.map((t) => `- ${t.replace(/\n/g, "\n  ")}`).join("\n")}`);
	}
	if (cycle.requestImages.length > 0) {
		parts.push(`## Images attached by the user\n\n${attach(cycle.requestImages, "attached by the user")}`);
	}
	parts.push(`# Environment\n\nWorking directory: \`${cwd}\`\nPlatform: ${process.platform}`);

	if (notes.trim()) parts.push(`# Scout notes\n\n${notes.trim()}`);

	if (cycle.plannerRequests.length > 0) {
		parts.push(
			`# Your earlier context requests (already handled by the scout below)\n\n${cycle.plannerRequests.join("\n\n")}`,
		);
	}

	const steps = dedupeSteps(
		cycle.steps,
		cwd,
		files.filter((f) => f.content !== undefined || f.image).map((f) => f.path),
	);
	if (steps.length > 0) {
		const rendered = steps.map((step, i) => {
			if (step.discarded !== undefined) {
				const why = step.discarded ? `: ${step.discarded}` : "";
				return `## ${i + 1}. ${describeCall(step.toolName, step.args).split("\n")[0]}\n\n[discarded by the scout as irrelevant${why}]`;
			}
			const output = truncateMiddle(step.output || "(no output)", input.maxToolOutputChars);
			const label = step.isError ? " (error)" : "";
			const title = describeCall(step.toolName, step.args).split("\n")[0];
			const stepImages = step.images?.length ? `\n\n${attach(step.images, `step ${i + 1}: ${title}`)}` : "";
			return `## ${i + 1}. ${title}${label}\n\n${
				step.toolName === "bash" && step.args.command?.includes("\n") ? `${fenced(step.args.command, "bash")}\n\n` : ""
			}${fenced(output)}${stepImages}`;
		});
		parts.push(`# Scout tool calls\n\n${rendered.join("\n\n")}`);
	}

	if (files.length > 0) {
		const rendered = files.map((f) => {
			if (f.image) return `## \`${f.path}\`\n\n${attach([f.image], `key file ${f.path}`)}`;
			if (f.content === undefined) return `## \`${f.path}\`\n\n(unavailable: ${f.error ?? "unknown error"})`;
			return `## \`${f.path}\`\n\n${fenced(truncateMiddle(f.content, input.maxFileChars), langFor(f.path))}`;
		});
		parts.push(`# Key files (current full content)\n\n${rendered.join("\n\n")}`);
	}

	return { text: truncateMiddle(parts.join("\n\n"), input.maxPackageChars), images };
}

/**
 * Drops the scout's exploration (non-handoff tool calls/results) from cycles that already
 * finished with a successful handoff. The handoff call and its result (plan + executor report)
 * are kept, so the scout still knows what happened in earlier cycles.
 */
export function pruneFinishedCycles(messages: Msg[]): Msg[] {
	const drop = new Set<string>();
	let cycleStart = 0;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (handoffStatus(msg) === "done") {
			for (let j = cycleStart; j < i; j++) {
				const m = messages[j];
				if (m.role !== "assistant") continue;
				for (const block of m.content as ContentBlock[]) {
					if (block.type === "toolCall" && (block as ToolCallBlock).name !== HANDOFF_TOOL) {
						drop.add((block as ToolCallBlock).id);
					}
				}
			}
			cycleStart = i + 1;
		} else if (isRunBoundary(msg)) {
			cycleStart = i + 1;
		}
	}
	if (drop.size === 0) return messages;

	const out: Msg[] = [];
	for (const msg of messages) {
		if (msg.role === "toolResult" && drop.has(msg.toolCallId)) continue;
		if (msg.role === "assistant") {
			const content = msg.content as ContentBlock[];
			const hadDropped = content.some((b) => b.type === "toolCall" && drop.has((b as ToolCallBlock).id));
			if (hadDropped) {
				const kept = content.filter(
					(b) => !(b.type === "toolCall" && drop.has((b as ToolCallBlock).id)) && b.type !== "thinking",
				);
				if (kept.length === 0) continue;
				out.push({ ...msg, content: kept });
				continue;
			}
		}
		out.push(msg);
	}
	return out;
}
