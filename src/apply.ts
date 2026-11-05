/**
 * Auto-apply: before the executor starts, MixAgent applies the plan's exact file changes itself (SEARCH/REPLACE
 * edits, new files, deletions), so the executor does not spend its first turns copying them into tool calls.
 * Edits and new files go through pi's own edit and write tools, so matching (line endings, BOM, uniqueness,
 * overlaps) is exactly what the executor would get.
 *
 * Only unambiguous changes are applied, each file all or nothing (all its blocks go into one edit call); anything
 * else is left to the executor as before. The executor gets the plan with each outcome in place: an applied section
 * keeps its description and gets the tool result instead of its content, a failed one keeps its content and gets
 * the error.
 */

import { lstat, readFile, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createEditTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import { type FileSection, fileSections, mapFileSections, REVISIONS_NOTE } from "./planner.ts";
import { AUTO_APPLIED, AUTO_APPLY_FAILED } from "./prompts.ts";
import { textOf } from "./transcript.ts";

export interface AppliedFile {
	path: string;
	kind: FileSection["kind"];
	/** applied: done by MixAgent. failed: tried, the file is unchanged. skipped: left to the executor untried. */
	status: "applied" | "failed" | "skipped";
	/** The tool result (applied), the error (failed) or why the file was left to the executor (skipped). */
	message: string;
}

export interface AutoApplyResult {
	/** The plan for the executors, with the outcome noted in each applied or failed file section. */
	plan: string;
	/** One entry per file, in plan order. */
	files: AppliedFile[];
}

export interface EditBlock {
	oldText: string;
	newText: string;
}

const SEARCH = /^<{5,9} ?SEARCH\s*$/;
const DIVIDER = /^={5,9}\s*$/;
const REPLACE = /^>{5,9} ?REPLACE\s*$/;
const FENCE = /^(`{3,})(.*)$/;
const TOOL_CALL_ID = "mixagent-auto-apply";

/** Splits lines into the text outside code fences and the content of each fence. */
function splitFences(lines: string[]): { outside: string[]; fences: { lines: string[]; closed: boolean }[] } {
	const outside: string[] = [];
	const fences: { lines: string[]; closed: boolean }[] = [];
	let open = 0;
	for (const line of lines) {
		const ticks = line.match(FENCE);
		const fence = fences[fences.length - 1];
		if (open > 0) {
			if (ticks && ticks[1].length >= open && !ticks[2].trim()) {
				open = 0;
				fence.closed = true;
			} else {
				fence.lines.push(line);
			}
		} else if (ticks) {
			open = ticks[1].length;
			fences.push({ lines: [], closed: false });
		} else {
			outside.push(line);
		}
	}
	return { outside, fences };
}

/**
 * Parses an edit section into its SEARCH/REPLACE blocks and the description around them, or returns why it is not
 * plainly that: malformed or unterminated blocks, an empty SEARCH, a block with two dividers (ambiguous), or code
 * outside the blocks (e.g. a snippet the executor has to work in by hand).
 */
export function parseEditSection(body: string): { blocks: EditBlock[]; description: string } | string {
	const blocks: EditBlock[] = [];
	const rest: string[] = [];
	let search: string[] | undefined;
	let replace: string[] | undefined;
	for (const line of body.split("\n")) {
		if (!search) {
			if (SEARCH.test(line)) search = [];
			else if (DIVIDER.test(line) || REPLACE.test(line)) return "malformed SEARCH/REPLACE markers";
			else rest.push(line);
		} else if (!replace) {
			if (DIVIDER.test(line)) replace = [];
			else if (SEARCH.test(line) || REPLACE.test(line)) return "malformed SEARCH/REPLACE markers";
			else search.push(line);
		} else if (REPLACE.test(line)) {
			if (!search.some((l) => l.trim())) return "an empty SEARCH block";
			blocks.push({ oldText: search.join("\n"), newText: replace.join("\n") });
			search = undefined;
			replace = undefined;
		} else if (DIVIDER.test(line)) {
			return "a block with two dividers (ambiguous)";
		} else if (SEARCH.test(line)) {
			return "malformed SEARCH/REPLACE markers";
		} else {
			replace.push(line);
		}
	}
	if (search) return "an unterminated SEARCH/REPLACE block";
	if (blocks.length === 0) return "no SEARCH/REPLACE blocks";
	const { outside, fences } = splitFences(rest);
	if (fences.some((f) => f.lines.some((l) => l.trim()))) return "code outside the SEARCH/REPLACE blocks";
	return { blocks, description: outside.join("\n").trim() };
}

/** Parses a create section: exactly one closed code block (the file content) and an optional description. */
export function parseCreateSection(body: string): { content: string; description: string } | string {
	const { outside, fences } = splitFences(body.split("\n"));
	if (fences.length !== 1) return fences.length === 0 ? "no code block with the file content" : "more than one code block";
	const { lines, closed } = fences[0];
	if (!closed) return "an unterminated code block";
	if (lines.some((l) => SEARCH.test(l)) && lines.some((l) => REPLACE.test(l))) return "SEARCH/REPLACE blocks in a new file";
	// As in Markdown, every line of the code block ends with a newline.
	return { content: lines.map((l) => `${l}\n`).join(""), description: outside.join("\n").trim() };
}

/** Absolute path of a plan path inside cwd; undefined outside it and for ~ or @ paths (the tools expand those). */
function insideCwd(cwd: string, path: string): string | undefined {
	if (/^[~@]/.test(path)) return undefined;
	const abs = resolve(cwd, path);
	const rel = relative(cwd, abs);
	return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? abs : undefined;
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** pi's edit errors count blocks as edits[i]; the executor knows them as SEARCH blocks. */
function errorText(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.replace(/\bedits\[(\d+)\]/g, (_, i) => `SEARCH block ${Number(i) + 1}`);
}

interface Tools {
	edit: ReturnType<typeof createEditTool>;
	write: ReturnType<typeof createWriteTool>;
}

/** How to apply one file's sections (the descriptions to keep and the change), or why the file is left to the executor. */
async function prepare(
	cwd: string,
	path: string,
	sections: FileSection[],
	tools: Tools,
	signal: AbortSignal | undefined,
): Promise<{ descriptions: string[]; run: () => Promise<string> } | string> {
	if (new Set(sections.map((s) => s.kind)).size > 1) return "several kinds of change for one file";
	if (sections.some((s) => s.body.includes(REVISIONS_NOTE))) return "the join planner's revision notes need the executor";
	const abs = insideCwd(cwd, path);
	if (!abs) return "outside the working directory";
	const kind = sections[0].kind;
	if (kind === "edit") {
		const parsed = sections.map((s) => parseEditSection(s.body));
		const error = parsed.find((p): p is string => typeof p === "string");
		if (error !== undefined) return error;
		const ok = parsed.filter((p) => typeof p !== "string");
		const edits = ok.flatMap((p) => p.blocks);
		// pi's edit tool falls back to fuzzy matching, which normalizes the whole file (trailing whitespace, quotes,
		// NFKC); only exact matches are applied here, the executor decides about the rest.
		const content = await readFile(abs, "utf8").catch(() => undefined);
		if (content !== undefined) {
			const text = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).replace(/\r\n?/g, "\n");
			if (edits.some((e) => !text.includes(e.oldText.replace(/\r\n?/g, "\n")))) return "a SEARCH block does not match the file exactly";
		}
		return {
			descriptions: ok.map((p) => p.description),
			run: async () => textOf((await tools.edit.execute(TOOL_CALL_ID, { path, edits }, signal)).content),
		};
	}
	if (kind === "create") {
		if (sections.length > 1) return "more than one create section";
		const parsed = parseCreateSection(sections[0].body);
		if (typeof parsed === "string") return parsed;
		if (await exists(abs)) return "the file already exists";
		return {
			descriptions: [parsed.description],
			run: async () => textOf((await tools.write.execute(TOOL_CALL_ID, { path, content: parsed.content }, signal)).content),
		};
	}
	return {
		descriptions: sections.map((s) => splitFences(s.body.split("\n")).outside.join("\n").trim()),
		run: async () => {
			if (!(await lstat(abs)).isFile()) throw new Error(`${path} is not a file`);
			if (signal?.aborted) throw new Error("Operation aborted");
			await unlink(abs);
			return `Deleted ${path}.`;
		},
	};
}

/**
 * Applies the plan's exact file changes in cwd. Returns the plan for the executors, with the outcome noted in each
 * applied or failed section, and the outcome per file. Throws only before anything was applied.
 */
export async function autoApplyPlan(plan: string, cwd: string, signal?: AbortSignal): Promise<AutoApplyResult> {
	const tools: Tools = { edit: createEditTool(cwd), write: createWriteTool(cwd) };
	const sections = fileSections(plan);
	const byPath = new Map<string, number[]>();
	sections.forEach((s, i) => byPath.set(s.path, [...(byPath.get(s.path) ?? []), i]));
	const files: AppliedFile[] = [];
	/** Section index -> the executor's text for that section (only for applied or failed files). */
	const noted = new Map<number, string>();
	for (const [path, indexes] of byPath) {
		const group = indexes.map((i) => sections[i]);
		const kind = group[0].kind;
		const op = signal?.aborted ? "aborted" : await prepare(cwd, path, group, tools, signal);
		if (typeof op === "string") {
			files.push({ path, kind, status: "skipped", message: op });
			continue;
		}
		let file: AppliedFile;
		try {
			file = { path, kind, status: "applied", message: await op.run() };
		} catch (err) {
			file = { path, kind, status: "failed", message: errorText(err) };
		}
		files.push(file);
		const applied = file.status === "applied";
		group.forEach((s, k) => {
			const text = applied ? op.descriptions[k] : s.body.trim();
			const line = `${applied ? AUTO_APPLIED : AUTO_APPLY_FAILED}: ${file.message}`;
			noted.set(indexes[k], [s.heading, ...(text ? [text, ""] : []), line].join("\n"));
		});
	}
	return { plan: mapFileSections(plan, (_, i) => noted.get(i)), files };
}
