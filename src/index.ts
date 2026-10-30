/**
 * MixAgent — cheap scout, flagship planner, cheap executor.
 *
 *   1. Scout (default Haiku) runs in the main session with read-only tools and explores the code.
 *   2. Scout calls `handoff`: the user request + all scout tool calls/results (+ key files) are packed
 *      into one Markdown document and sent to the planner (default Opus) in a single tool-less call.
 *      The planner answers with every change as Markdown SEARCH/REPLACE blocks.
 *      For large work the planner may instead split the planning (## Subtasks): each subtask is planned by
 *      its own planner call in parallel, then a join planner call merges them into the final plan (1+N+1 calls).
 *   3. A new pi session is created for the executor (default Haiku), which applies the plan. Its final
 *      report is shown in the handoff tool result. If the plan has no changes or commands (e.g. the user
 *      only asked a question), the planner's answer is shown directly and no executor is started.
 *      If the final plan splits execution into tasks (## Tasks, disjoint files; written by the join planner),
 *      one executor per task runs in parallel, then one more executor runs the plan's commands.
 *
 * The flagship model never sees pi's system prompt, tool schemas, or a growing conversation; it reads
 * one compact package and writes only the diff. Models are configurable (see README.md).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	isToolCallEventType,
	keyHint,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	globalConfigPath,
	isThinkingLevel,
	loadConfig,
	type MixConfig,
	parseModelSpec,
	projectConfigPath,
	type Role,
	roleKey,
	type ThinkingLevel,
} from "./config.ts";
import { type ExecutorProgress, type ExecutorResult, emptyUsage, runExecutor } from "./executor.ts";
import {
	countPlanChanges,
	expandJoinPlan,
	type PlannerResult,
	parseNeedContext,
	parseSubtasks,
	runPlanner,
	splitPlan,
} from "./planner.ts";
import {
	buildExecutorKickoff,
	buildExecutorRetryNote,
	buildJoinInstructions,
	buildSubPlannerInstructions,
	SCOUT_APPEND,
} from "./prompts.ts";
import { findWriteReason } from "./safety.ts";
import {
	type AttachedFile,
	applyDiscards,
	buildPlannerPackage,
	DISCARD_TOOL,
	type DiscardDetails,
	extractCycle,
	HANDOFF_TOOL,
	type HandoffStatus,
	imageMimeFor,
	labelCycleSteps,
	type Msg,
	pruneFinishedCycles,
	resolveDiscard,
} from "./transcript.ts";

const ROLES: Role[] = ["scout", "planner", "executor"];
const MAX_ATTACHED_FILES = 20;
/** Raw size limit for image key files (~5 MB once base64-encoded, the common provider limit). */
const MAX_IMAGE_BYTES = 3_750_000;
const UPDATE_INTERVAL_MS = 150;
/** Extra attempts for a failed fork-join subtask (sub-planner or task executor); aborts are not retried. */
const MAX_TASK_RETRIES = 2;
/** Tools that only exist during scout runs. */
const SCOUT_ONLY_TOOLS = [HANDOFF_TOOL, DISCARD_TOOL];

type Stage = "packing" | "planning" | "subplanning" | "joining" | "executing" | "done";

/** One fork-join subtask: planned by its own planner call, merged by the join planner. */
interface SubPlanRun {
	id: string;
	goal: string;
	files: string[];
	state: "pending" | "running" | "done";
	/** 0 for the first attempt, then the retry number. */
	attempt?: number;
	text?: string;
	result?: Pick<PlannerResult, "usage" | "stopReason" | "errorMessage">;
}

type ExecutorView = ExecutorProgress & Partial<Pick<ExecutorResult, "output" | "sessionFile" | "stopReason" | "errorMessage">>;

/** One fork-join task: a group of plan files applied by its own executor. */
interface TaskRun {
	id: string;
	goal: string;
	files: string[];
	state: "pending" | "running" | "done";
	/** 0 for the first attempt, then the retry number. */
	attempt?: number;
	executor?: ExecutorView;
}

interface HandoffDetails {
	mixagent: HandoffStatus;
	stage: Stage;
	/** The user's original prompt for this cycle. */
	request?: string;
	plannerModel?: string;
	executorModel?: string;
	packageChars?: number;
	packageImages?: number;
	plan?: string;
	planPath?: string;
	/** The lead planner call (in fork-join planning: the call that split the work). */
	planner?: Pick<PlannerResult, "usage" | "stopReason">;
	/** Set in fork-join planning: the lead planner's split (Summary, Design, Subtasks). `plan` is the joined plan. */
	leadPlan?: string;
	/** Set in fork-join planning: one planner call per subtask, run in parallel. */
	subPlans?: SubPlanRun[];
	/** Set in fork-join planning: the join planner call that wrote the final plan. */
	join?: Pick<PlannerResult, "usage" | "stopReason">;
	/** True when the plan had nothing to apply and the planner's answer was returned without an executor. */
	answeredDirectly?: boolean;
	/** In fork-join mode: the join executor that runs the Commands (if any). */
	executor?: ExecutorView;
	/** Set in fork-join mode: one executor per task, run in parallel. */
	tasks?: TaskRun[];
	error?: string;
}

/**
 * Process-wide state that must survive session replacement (/new, /resume, /fork rebuild the
 * extension instance).
 */
interface SharedState {
	enabled?: boolean;
	overrides: Partial<MixConfig>;
}
const SHARED_KEY = Symbol.for("pi-mixagent.state");
const shared: SharedState = ((globalThis as any)[SHARED_KEY] ??= { overrides: {} });

function modelSpec(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "(none)";
}

/** provider/id plus the display name, e.g. "anthropic/claude-opus-4-7 · Claude Opus 4.7". */
function modelLabel(model: Model<Api>): string {
	return model.name && model.name !== model.id ? `${modelSpec(model)} · ${model.name}` : modelSpec(model);
}

function shortName(spec: string): string {
	return spec.slice(spec.indexOf("/") + 1);
}

function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(cost < 0.01 ? 4 : 3)}`;
}

function extractSection(plan: string, heading: string): string | undefined {
	const re = new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im");
	return plan.match(re)?.[1]?.trim() || undefined;
}

function changedFiles(plan: string): string[] {
	return [...plan.matchAll(/^###\s+`([^`]+)`\s*[—-]\s*(edit|create|delete)\b/gim)].map((m) => `${m[1]} (${m[2]})`);
}

function throttle<T>(fn: (arg: T) => void, ms: number): (arg: T) => void {
	let last = 0;
	return (arg: T) => {
		const now = Date.now();
		if (now - last >= ms) {
			last = now;
			fn(arg);
		}
	};
}

function emptyPlannerUsage(): PlannerResult["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addPlannerUsage(a: PlannerResult["usage"], b: PlannerResult["usage"]): PlannerResult["usage"] {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

function addExecutorUsage(a: ExecutorProgress["usage"], b: ExecutorProgress["usage"]): ExecutorProgress["usage"] {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
		turns: a.turns + b.turns,
	};
}

/**
 * Runs one fork-join subtask, retrying up to MAX_TASK_RETRIES times while it fails.
 * fn returns the attempt's error (undefined on success) and gets the previous attempt's error on retries.
 */
async function retryTask(
	signal: AbortSignal | undefined,
	fn: (attempt: number, lastError: string | undefined) => Promise<string | undefined>,
): Promise<void> {
	let lastError: string | undefined;
	for (let attempt = 0; attempt <= MAX_TASK_RETRIES; attempt++) {
		lastError = await fn(attempt, lastError);
		if (!lastError || signal?.aborted) return;
	}
}

/** Runs fn over items with at most `limit` running at once. fn must not throw. */
async function runPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, worker));
}

export default function mixagent(pi: ExtensionAPI) {
	let config: MixConfig | undefined;
	/** Tools that were active before MixAgent took over; restored on /mix off. */
	let baseTools: string[] | undefined;
	/** The user's model before MixAgent switched to the scout; restored on /mix off. */
	let savedModel: Model<Api> | undefined;
	/** Kept from session_start: argument completions get no ctx but list models for /mix model <role>. */
	let modelRegistry: ExtensionContext["modelRegistry"] | undefined;

	pi.registerFlag("mix-scout", { description: "MixAgent scout model (provider/id)", type: "string" });
	pi.registerFlag("mix-planner", { description: "MixAgent planner model (provider/id)", type: "string" });
	pi.registerFlag("mix-executor", { description: "MixAgent executor model (provider/id)", type: "string" });
	pi.registerFlag("mix-off", { description: "Start with MixAgent disabled", type: "boolean", default: false });

	function effectiveConfig(cwd: string): MixConfig {
		const cfg: MixConfig = { ...loadConfig(cwd, getAgentDir()), ...shared.overrides };
		for (const role of ROLES) {
			const flag = pi.getFlag(`mix-${role}`);
			if (typeof flag === "string" && flag.trim()) cfg[roleKey(role)] = flag.trim();
		}
		if (pi.getFlag("mix-off") === true && shared.enabled === undefined) shared.enabled = false;
		if (shared.enabled !== undefined) cfg.enabled = shared.enabled;
		return cfg;
	}

	function resolveModel(ctx: ExtensionContext, role: Role): Model<Api> {
		const spec = config![roleKey(role)];
		const parsed = parseModelSpec(spec);
		if (!parsed) throw new Error(`MixAgent: invalid ${role} model "${spec}" (expected provider/modelId)`);
		const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (!model) throw new Error(`MixAgent: ${role} model "${spec}" not found. Check /model or ~/.pi/agent/models.json`);
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`MixAgent: no API key configured for ${role} model "${spec}"`);
		}
		return model;
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI || !config) return;
		const theme = ctx.ui.theme;
		if (!config.enabled) {
			ctx.ui.setStatus("mixagent", theme.fg("dim", "mix: off"));
			return;
		}
		const chain = ROLES.map((r) => shortName(config![roleKey(r)])).join(theme.fg("dim", " → "));
		ctx.ui.setStatus("mixagent", `${theme.fg("accent", "mix")} ${chain}`);
	}

	function scoutToolNames(): string[] {
		const available = new Set(pi.getAllTools().map((t) => t.name));
		return [...config!.scoutTools.filter((t) => available.has(t) && t !== "edit" && t !== "write"), ...SCOUT_ONLY_TOOLS];
	}

	async function enterScout(ctx: ExtensionContext): Promise<boolean> {
		let scout: Model<Api>;
		try {
			scout = resolveModel(ctx, "scout");
			resolveModel(ctx, "planner"); // fail fast before spending scout tokens
			resolveModel(ctx, "executor");
		} catch (err) {
			ctx.ui.notify(`${(err as Error).message}. MixAgent skipped for this prompt.`, "error");
			return false;
		}
		const active = pi.getActiveTools();
		if (!active.includes(HANDOFF_TOOL)) baseTools = active;
		if (ctx.model && modelSpec(ctx.model) !== modelSpec(scout)) {
			savedModel = ctx.model;
			if (!(await pi.setModel(scout))) {
				ctx.ui.notify(`MixAgent: cannot switch to scout model ${modelSpec(scout)}`, "error");
				return false;
			}
		} else if (!ctx.model && !(await pi.setModel(scout))) {
			return false;
		}
		pi.setThinkingLevel(config!.scoutThinking);
		pi.setActiveTools(scoutToolNames());
		return true;
	}

	function leaveScout() {
		const active = pi.getActiveTools();
		if (active.includes(HANDOFF_TOOL)) {
			pi.setActiveTools(baseTools ?? active.filter((t) => !SCOUT_ONLY_TOOLS.includes(t)));
		}
	}

	/** True while the current agent run is a scout run (set on input, cleared on agent_end). */
	let scouting = false;

	pi.on("session_start", async (_event, ctx) => {
		config = effectiveConfig(ctx.cwd);
		modelRegistry = ctx.modelRegistry;
		// handoff and discard are only meaningful during scout runs.
		const active = pi.getActiveTools();
		if (active.some((t) => SCOUT_ONLY_TOOLS.includes(t))) {
			pi.setActiveTools(active.filter((t) => !SCOUT_ONLY_TOOLS.includes(t)));
		}
		updateStatus(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		config = effectiveConfig(ctx.cwd);
		scouting = config.enabled && (await enterScout(ctx));
		if (!scouting) leaveScout();
		updateStatus(ctx);
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		if (!scouting) return;
		return { systemPrompt: `${event.systemPrompt}\n${SCOUT_APPEND}` };
	});

	pi.on("agent_end", async () => {
		scouting = false;
	});

	pi.on("tool_call", async (event) => {
		if (!scouting) return;
		if (event.toolName === "edit" || event.toolName === "write") {
			return { block: true, reason: "MixAgent scout mode is read-only. Gather context, then call handoff." };
		}
		if (config?.scoutBashGuard && isToolCallEventType("bash", event)) {
			const reason = findWriteReason(event.input.command);
			if (reason) {
				return {
					block: true,
					reason: `MixAgent scout mode is read-only: ${reason}. Use read-only commands (rg, grep, git log/diff/show, ls, cat).`,
				};
			}
		}
	});

	pi.on("context", async (event) => {
		const original = event.messages as Msg[];
		let messages = config?.pruneScoutHistory ? pruneFinishedCycles(original) : original;
		// Number the scout's results ([#N]) so it can discard them; discard calls never reach the model.
		if (scouting) messages = labelCycleSteps(messages);
		messages = applyDiscards(messages);
		if (messages !== original) return { messages: messages as typeof event.messages };
	});

	pi.registerTool({
		name: HANDOFF_TOOL,
		label: "Handoff",
		description:
			"MixAgent: hand the gathered context to the planner model, which writes the exact change plan; a fresh executor session then applies it. Call exactly once when you have enough context.",
		promptSnippet: "Hand gathered code context to the planner model, which plans the changes for the executor",
		promptGuidelines: [
			"Call handoff once you have located the relevant code; do not attempt to solve the task yourself in MixAgent scout mode.",
		],
		parameters: Type.Object({
			notes: Type.String({
				description:
					"Concise findings for the planner: relevant locations, how the code works, constraints, and any needed context from earlier in the conversation.",
			}),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description: "Paths (relative to cwd) of files the planner must see in full, typically the files to change.",
				}),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cfg = config ?? effectiveConfig(ctx.cwd);
			const details: HandoffDetails = { mixagent: "done", stage: "packing" };
			const finish = (text: string, status: HandoffStatus, terminate: boolean) => {
				details.mixagent = status;
				details.stage = "done";
				return { content: [{ type: "text" as const, text }], details, terminate };
			};
			const fail = (message: string) => {
				details.error = message;
				return finish(`MixAgent handoff failed: ${message}`, "error", true);
			};

			let planner: Model<Api>;
			let executor: Model<Api>;
			try {
				planner = resolveModel(ctx, "planner");
				executor = resolveModel(ctx, "executor");
			} catch (err) {
				return fail((err as Error).message);
			}
			details.plannerModel = modelSpec(planner);
			details.executorModel = modelSpec(executor);

			// 1. Pack request + scout tool calls + key files.
			const messages = ctx.sessionManager
				.getBranch()
				.flatMap((e) => (e.type === "message" ? [e.message as unknown as Msg] : []));
			const cycle = extractCycle(messages);
			const files: AttachedFile[] = await Promise.all(
				(params.files ?? []).slice(0, MAX_ATTACHED_FILES).map(async (p): Promise<AttachedFile> => {
					const path = p.replace(/^@/, "");
					try {
						const mimeType = imageMimeFor(path);
						if (mimeType) {
							const data = await readFile(resolve(ctx.cwd, path));
							if (data.length > MAX_IMAGE_BYTES) return { path, error: "image too large to attach; read it instead (read resizes images)" };
							return { path, image: { type: "image", data: data.toString("base64"), mimeType } };
						}
						return { path, content: await readFile(resolve(ctx.cwd, path), "utf8") };
					} catch (err) {
						return { path, error: (err as NodeJS.ErrnoException).code ?? (err as Error).message };
					}
				}),
			);
			const pkg = buildPlannerPackage({
				cycle,
				notes: params.notes ?? "",
				files,
				cwd: ctx.cwd,
				maxToolOutputChars: cfg.maxToolOutputChars,
				maxFileChars: cfg.maxFileChars,
				maxPackageChars: cfg.maxPackageChars,
				maxImages: planner.input.includes("image") ? cfg.maxPlannerImages : 0,
			});
			details.packageChars = pkg.text.length;
			details.packageImages = pkg.images.length;
			const request = cycle.requests.join("\n\n") || "(see scout notes)";
			details.request = cycle.requests.join("\n\n") || undefined;

			// 2. Planner: one tool-less call to the flagship model.
			details.stage = "planning";
			const pushUpdate = () => onUpdate?.({ content: [{ type: "text", text: "" }], details: { ...details } });
			const throttledUpdate = throttle(pushUpdate, UPDATE_INTERVAL_MS);
			pushUpdate();
			// Every planner call shares the system prompt and the package, so follow-up calls hit the prompt cache.
			const callPlanner = (extra: string | undefined, onProgress: (text: string) => void) =>
				runPlanner(pkg, {
					model: planner,
					modelRegistry: ctx.modelRegistry,
					thinking: cfg.plannerThinking,
					maxTokens: cfg.plannerMaxTokens,
					forkJoin: cfg.forkJoin,
					extra,
					signal,
					onProgress: (text) => {
						onProgress(text);
						throttledUpdate(undefined);
					},
				});
			const plannerError = (r: PlannerResult) =>
				r.stopReason === "aborted"
					? "aborted"
					: r.stopReason === "error"
						? (r.errorMessage ?? "planner error")
						: !r.text
							? "planner returned an empty response"
							: undefined;
			let result: PlannerResult;
			try {
				result = await callPlanner(undefined, (text) => {
					details.plan = text;
				});
			} catch (err) {
				return fail(`planner call failed: ${(err as Error).message}`);
			}
			details.plan = result.text;
			details.planner = { usage: result.usage, stopReason: result.stopReason };
			const leadError = plannerError(result);
			if (leadError) return fail(leadError);

			const needContext = parseNeedContext(result.text);
			if (needContext) {
				if (cycle.plannerRequests.length < cfg.maxContextRounds) {
					return finish(
						`The planner needs more context before it can write the plan:\n\n${needContext}\n\nGather exactly this (read-only), then call handoff again. Earlier findings are included automatically; put only new findings in notes.`,
						"need_context",
						false,
					);
				}
				return finish(
					`The planner still lacks context after ${cfg.maxContextRounds} extra rounds and asked for:\n\n${needContext}\n\nThe executor was not started. Please clarify the request.`,
					"done",
					true,
				);
			}

			// 2b. Fork-join planning: the lead planner split the work into subtasks. Each subtask is planned by its
			// own planner call in parallel, then a join planner call verifies and merges them into the final plan.
			const subtasks = cfg.forkJoin ? parseSubtasks(result.text) : undefined;
			let unresolved: string[] = [];
			if (subtasks) {
				const lead = result.text;
				details.leadPlan = lead;
				details.plan = undefined;
				details.stage = "subplanning";
				const runs: SubPlanRun[] = subtasks.map((s) => ({ ...s, state: "pending" as const }));
				details.subPlans = runs;
				pushUpdate();
				await runPool(subtasks, cfg.maxParallelPlanners, async (s, i) => {
					const run = runs[i];
					if (signal?.aborted) {
						run.result = { usage: emptyPlannerUsage(), stopReason: "aborted" };
					} else {
						run.state = "running";
						// Usage of failed attempts is kept, so the shown tokens and cost cover every attempt.
						let usage = emptyPlannerUsage();
						await retryTask(signal, async (attempt) => {
							run.attempt = attempt;
							run.text = undefined;
							pushUpdate();
							try {
								const r = await callPlanner(buildSubPlannerInstructions(lead, s.id, i + 1, subtasks.length), (text) => {
									run.text = text;
								});
								usage = addPlannerUsage(usage, r.usage);
								run.text = r.text;
								run.result = { usage, stopReason: r.stopReason, errorMessage: plannerError(r) };
							} catch (err) {
								run.result = { usage, stopReason: "error", errorMessage: (err as Error).message };
							}
							return run.result.errorMessage;
						});
					}
					run.state = "done";
					pushUpdate();
				});
				if (signal?.aborted) return fail("aborted");
				const failed = runs.find((r) => r.result?.errorMessage);
				if (failed) return fail(`sub-planner ${failed.id} failed: ${failed.result?.errorMessage}`);

				details.stage = "joining";
				details.plan = "";
				pushUpdate();
				const subPlans = runs.map((r) => ({ id: r.id, goal: r.goal, plan: r.text ?? "" }));
				let joined: PlannerResult;
				try {
					joined = await callPlanner(buildJoinInstructions(lead, subPlans), (text) => {
						details.plan = text;
					});
				} catch (err) {
					return fail(`join planner call failed: ${(err as Error).message}`);
				}
				details.join = { usage: joined.usage, stopReason: joined.stopReason };
				const joinError = plannerError(joined);
				if (joinError) return fail(`join planner: ${joinError}`);
				const expanded = expandJoinPlan(joined.text, new Map(subPlans.map((s) => [s.id, s.plan])));
				unresolved = expanded.unresolved;
				result = { ...joined, text: expanded.plan };
				details.plan = result.text;
			}

			// Plans without changes or commands are plain answers: shown directly, no executor.
			const actionable = countPlanChanges(result.text) > 0 || extractSection(result.text, "Commands") !== undefined;

			// 3. Save the plan as Markdown.
			if (cfg.planDir) {
				try {
					const dir = resolve(ctx.cwd, expandHome(cfg.planDir));
					await mkdir(dir, { recursive: true });
					const stamp = new Date().toISOString().replace(/[:.]/g, "-");
					details.planPath = join(dir, `plan-${stamp}.md`);
					const planning = details.leadPlan
						? `\n---\n\n# Planning (fork-join)\n\n## Lead\n\n${details.leadPlan}\n\n${(details.subPlans ?? []).map((s) => `## Sub-plan ${s.id} — ${s.goal}\n\n${s.text ?? ""}`).join("\n\n")}\n`
						: "";
					await writeFile(details.planPath, `# MixAgent plan\n\n## Request\n\n${request}\n\n${result.text}\n${planning}`, "utf8");
				} catch {
					details.planPath = undefined;
				}
			}
			if (unresolved.length > 0) {
				const saved = details.planPath ? ` Plan saved to ${details.planPath}.` : "";
				return fail(`join plan references sections no sub-plan has: ${unresolved.join(", ")}. The executor was not started.${saved}`);
			}

			// 4a. Nothing to apply: return the planner's answer directly, without starting an executor.
			if (!actionable) {
				details.answeredDirectly = true;
				const answer = extractSection(result.text, "Answer") ?? result.text;
				const lines = [
					"The planner answered directly (no changes requested; no executor was started).",
					`\n## Answer\n${answer}`,
					details.planPath ? `\nFull plan: ${details.planPath}` : "",
				];
				// Print/JSON mode only outputs the final assistant text, so let the scout relay the answer once.
				if (!ctx.hasUI) lines.push("\nReply to the user with the answer above, verbatim, and nothing else.");
				return finish(lines.filter(Boolean).join("\n"), "done", ctx.hasUI);
			}

			// 4b. Executors: fresh sessions on the cheap model apply the plan.
			details.stage = "executing";
			const sessionName = `mixagent: ${request.split("\n")[0].slice(0, 60)}`;
			const idle = (): ExecutorView => ({ toolCalls: [], text: "", usage: emptyUsage() });
			const execute = (kickoff: string, name: string, onProgress: (progress: ExecutorProgress) => void) =>
				runExecutor({
					cwd: ctx.cwd,
					model: executor,
					modelRegistry: ctx.modelRegistry,
					thinking: cfg.executorThinking,
					tools: cfg.executorTools,
					kickoff,
					sessionName: name,
					persist: cfg.persistExecutorSession,
					parentSessionFile: ctx.sessionManager.getSessionFile(),
					sessionDir: ctx.sessionManager.getSessionDir(),
					signal,
					onProgress: (progress) => {
						onProgress(progress);
						throttledUpdate(undefined);
					},
				});
			const report = (ex: ExecutorView | undefined) =>
				ex?.output || ex?.errorMessage || (ex?.stopReason === "aborted" ? "(aborted)" : "(no output)");

			// Keep the result compact: it stays in the scout's context for follow-up prompts.
			const summary = extractSection(result.text, "Summary");
			const changed = changedFiles(result.text);
			const planLines = [
				summary ? `\n## Plan summary\n${summary}` : "",
				changed.length ? `\n## Planned file changes\n${changed.map((f) => `- ${f}`).join("\n")}` : "",
			];
			let lines: string[];
			// Fork-join: the planner split the work into tasks with disjoint files; each task runs in its own
			// executor in parallel, then one more executor runs the plan's Commands.
			const split = cfg.forkJoin ? splitPlan(result.text) : undefined;
			if (split) {
				const runs: TaskRun[] = split.tasks.map((t) => ({ id: t.id, goal: t.goal, files: t.files, state: "pending" as const }));
				details.tasks = runs;
				pushUpdate();
				await runPool(split.tasks, cfg.maxParallelExecutors, async (task, i) => {
					const run = runs[i];
					if (signal?.aborted) {
						run.executor = { ...idle(), stopReason: "aborted" };
					} else {
						run.state = "running";
						// Usage of failed attempts is kept, so the shown tokens and cost cover every attempt.
						let prior = emptyUsage();
						const withPrior = <T extends ExecutorView>(ex: T): T => ({ ...ex, usage: addExecutorUsage(prior, ex.usage) });
						await retryTask(signal, async (attempt, lastError) => {
							run.attempt = attempt;
							run.executor = withPrior(idle());
							pushUpdate();
							const kickoff = buildExecutorKickoff(request, task.plan) + (lastError ? buildExecutorRetryNote(lastError) : "");
							try {
								run.executor = withPrior(
									await execute(kickoff, `${sessionName} [${task.id}]`, (progress) => {
										run.executor = withPrior(progress);
									}),
								);
							} catch (err) {
								run.executor = { ...run.executor, stopReason: "error", errorMessage: (err as Error).message };
							}
							prior = run.executor.usage;
							return run.executor.stopReason === "error" ? (run.executor.errorMessage ?? "executor error") : undefined;
						});
					}
					run.state = "done";
					pushUpdate();
				});
				const failed = runs.some((r) => r.executor?.stopReason === "error" || r.executor?.stopReason === "aborted");
				let join: ExecutorResult | undefined;
				if (split.joinPlan && !failed && !signal?.aborted) {
					details.executor = idle();
					pushUpdate();
					try {
						join = await execute(buildExecutorKickoff(request, split.joinPlan), `${sessionName} [join]`, (progress) => {
							details.executor = progress;
						});
					} catch (err) {
						return fail(`executor failed: ${(err as Error).message}`);
					}
					details.executor = join;
				}
				const sessions = [...runs.map((r) => r.executor?.sessionFile), join?.sessionFile].filter(Boolean);
				lines = [
					signal?.aborted ? "Executors were aborted." : `Plan applied by ${runs.length} parallel executors (fork-join), each in a new session.`,
					...planLines,
					`\n## Executor report\n${runs.map((r) => `### ${r.id} — ${r.goal}\n${report(r.executor)}`).join("\n\n")}`,
					split.joinPlan ? `\n### Commands\n${join ? report(join) : "Not run: a task failed or was aborted."}` : "",
					split.answer ? `\n## Answer\n${split.answer}` : "",
					details.planPath ? `\nFull plan: ${details.planPath}` : "",
					sessions.length ? `Executor sessions:\n${sessions.map((f) => `- ${f}`).join("\n")}` : "",
				];
			} else {
				details.executor = idle();
				pushUpdate();
				let exec: ExecutorResult;
				try {
					exec = await execute(buildExecutorKickoff(request, result.text), sessionName, (progress) => {
						details.executor = progress;
					});
				} catch (err) {
					return fail(`executor failed: ${(err as Error).message}`);
				}
				details.executor = exec;
				lines = [
					exec.stopReason === "aborted" ? "Executor was aborted." : "Plan applied by the executor in a new session.",
					...planLines,
					`\n## Executor report\n${exec.output || exec.errorMessage || "(no output)"}`,
					details.planPath ? `\nFull plan: ${details.planPath}` : "",
					exec.sessionFile ? `Executor session: ${exec.sessionFile}` : "",
				];
			}
			// With a UI the result is rendered directly, so stop without another scout turn. Print/JSON
			// mode only outputs the final assistant text, so let the scout relay the report once.
			if (!ctx.hasUI) {
				lines.push("\nReply to the user with the executor report above, verbatim, and nothing else.");
			}
			return finish(lines.filter(Boolean).join("\n"), "done", ctx.hasUI);
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const files = args.files?.length ? theme.fg("dim", ` · ${args.files.length} file(s)`) : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("handoff"))} ${theme.fg("muted", "scout → planner → executor")}${files}`);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const d = result.details as HandoffDetails | undefined;
			if (!d) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			const md = getMarkdownTheme();
			const container = new Container();
			const add = (s: string) => container.addChild(new Text(s, 0, 0));

			// Original user prompt: one line when collapsed, full text when expanded.
			if (d.request) {
				if (expanded) {
					add(theme.fg("muted", "prompt:"));
					add(d.request.split("\n").map((l) => theme.fg("dim", `  ${l}`)).join("\n"));
				} else {
					const [first, ...more] = d.request.split("\n");
					const line = first.length > 100 ? `${first.slice(0, 97)}...` : first;
					add(theme.fg("dim", `prompt: ${line}${more.length ? " …" : ""}`));
				}
			}

			if (d.error) {
				add(theme.fg("error", `✗ ${d.error}`));
				return container;
			}

			const tokens = (u: PlannerResult["usage"] | undefined) =>
				u ? ` ${formatTokens(u.input + u.cacheRead + u.cacheWrite)} in / ${formatTokens(u.output)} out · ${formatCost(u.cost.total)}` : "";
			const planTokens = tokens(d.planner?.usage);
			const retryLabel = (attempt: number | undefined) =>
				attempt ? theme.fg("warning", ` (retry ${attempt}/${MAX_TASK_RETRIES})`) : "";
			const planner = shortName(d.plannerModel ?? "planner");
			const executor = shortName(d.executorModel ?? "executor");

			if (d.mixagent === "need_context") {
				add(`${theme.fg("warning", "↺")} ${theme.fg("accent", planner)} needs more context${theme.fg("dim", planTokens)}`);
				const t = result.content[0];
				if (expanded && t?.type === "text") container.addChild(new Markdown(t.text, 0, 0, md));
				return container;
			}

			// Planner line
			if (isPartial && d.stage === "planning") {
				const chars = d.plan?.length ?? 0;
				const imgs = d.packageImages ? ` + ${d.packageImages} image(s)` : "";
				add(`${theme.fg("warning", "⏳")} ${theme.fg("accent", planner)} planning… ${theme.fg("dim", `${formatTokens(d.packageChars ?? 0)} chars${imgs} in · ${chars} chars out`)}`);
				if (d.plan) {
					const tail = d.plan.split("\n").slice(-6).join("\n");
					add(theme.fg("dim", tail));
				}
				return container;
			}

			// Fork-join planning: lead split, one line per sub-planner, then the join planner.
			if (d.subPlans) {
				add(`${theme.fg("success", "✓")} ${theme.fg("accent", planner)} split into ${d.subPlans.length} subtask(s)${theme.fg("dim", planTokens)}`);
				if (expanded && d.leadPlan) container.addChild(new Markdown(d.leadPlan, 0, 0, md));
				for (const s of d.subPlans) {
					const goal = theme.fg("muted", `· ${s.goal}`);
					const retry = retryLabel(s.attempt);
					if (s.state === "pending") {
						add(`  ${theme.fg("dim", "·")} ${theme.fg("accent", planner)} ${s.id} waiting ${goal}`);
					} else if (isPartial && s.state === "running") {
						add(`  ${theme.fg("warning", "⏳")} ${theme.fg("accent", planner)} ${s.id} planning…${retry} ${theme.fg("dim", `${s.text?.length ?? 0} chars out`)} ${goal}`);
					} else {
						const icon = s.result?.errorMessage ? theme.fg("error", "✗") : theme.fg("success", "✓");
						add(`  ${icon} ${theme.fg("accent", planner)} ${s.id} planned${retry}${theme.fg("dim", tokens(s.result?.usage))} ${goal}`);
						if (expanded && s.text) container.addChild(new Markdown(s.text, 0, 0, md));
					}
				}
				if (isPartial && d.stage === "subplanning") return container;
				if (isPartial && d.stage === "joining") {
					add(`${theme.fg("warning", "⏳")} ${theme.fg("accent", planner)} joining… ${theme.fg("dim", `${d.plan?.length ?? 0} chars out`)}`);
					if (d.plan) add(theme.fg("dim", d.plan.split("\n").slice(-6).join("\n")));
					return container;
				}
			}
			const finalTokens = d.subPlans ? tokens(d.join?.usage) : planTokens;
			const finalLabel = d.subPlans ? "join" : "plan";
			if (d.answeredDirectly) {
				add(`${theme.fg("success", "✓")} ${theme.fg("accent", planner)} answered ${theme.fg("dim", "(no executor)")}${theme.fg("dim", finalTokens)}`);
				const body = expanded ? d.plan : d.plan && (extractSection(d.plan, "Answer") ?? d.plan);
				if (body) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(body, 0, 0, md));
				}
				if (expanded && d.planPath) add(theme.fg("dim", `saved: ${d.planPath}`));
				return container;
			}
			const nChanges = d.plan ? countPlanChanges(d.plan) : 0;
			const nTasks = d.tasks ? ` · ${d.tasks.length} parallel task(s)` : "";
			add(`${theme.fg("success", "✓")} ${theme.fg("accent", planner)} ${finalLabel} · ${nChanges} file change(s)${nTasks}${theme.fg("dim", finalTokens)}`);
			if (expanded && d.plan) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(d.plan, 0, 0, md));
				if (d.planPath) add(theme.fg("dim", `saved: ${d.planPath}`));
				container.addChild(new Spacer(1));
			}

			const usageText = (u: ExecutorProgress["usage"]) =>
				` ${u.turns} turn(s) · ${formatTokens(u.input + u.cacheRead)} in / ${formatTokens(u.output)} out · ${formatCost(u.cost)}`;
			const stateIcon = (ex: ExecutorView, running: boolean) =>
				running
					? theme.fg("warning", "⏳")
					: ex.stopReason === "error" || ex.stopReason === "aborted"
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
			const addCalls = (calls: ExecutorProgress["toolCalls"], keep: number) => {
				const shown = keep >= calls.length ? calls : calls.slice(calls.length - keep);
				if (calls.length > shown.length) add(theme.fg("dim", `  … ${calls.length - shown.length} earlier tool call(s)`));
				for (const c of shown) {
					const icon = !c.done ? theme.fg("warning", "·") : c.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
					add(`  ${icon} ${theme.fg("muted", c.label.length > 120 ? `${c.label.slice(0, 117)}...` : c.label)}`);
				}
			};

			// Fork-join task lines: one executor per task, running in parallel.
			for (const t of d.tasks ?? []) {
				const running = isPartial && t.state === "running";
				if (t.state === "pending" || !t.executor) {
					add(`${theme.fg("dim", "·")} ${theme.fg("accent", executor)} ${t.id} waiting ${theme.fg("muted", `· ${t.goal}`)}`);
					continue;
				}
				add(`${stateIcon(t.executor, running)} ${theme.fg("accent", executor)} ${t.id} ${running ? "executing…" : "executed"}${retryLabel(t.attempt)}${theme.fg("dim", usageText(t.executor.usage))} ${theme.fg("muted", `· ${t.goal}`)}`);
				if (running || expanded) addCalls(t.executor.toolCalls, expanded ? Infinity : 3);
				if (expanded && !running && t.executor.output) container.addChild(new Markdown(t.executor.output, 0, 0, md));
			}

			// Executor line (in fork-join mode: the join executor that runs the Commands)
			const ex = d.executor;
			if (!ex) {
				const t = result.content[0];
				if (t?.type === "text" && d.stage === "done") container.addChild(new Markdown(t.text, 0, 0, md));
				return container;
			}
			const running = isPartial && d.stage === "executing";
			add(`${stateIcon(ex, running)} ${theme.fg("accent", executor)}${d.tasks ? " commands" : ""} ${running ? "executing…" : "executed"}${theme.fg("dim", usageText(ex.usage))}`);
			addCalls(ex.toolCalls, expanded ? Infinity : running ? 8 : 5);
			const output = running ? ex.text : (ex.output ?? ex.text);
			if (output) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(output, 0, 0, md));
			}
			if (!running && !expanded) add(theme.fg("dim", keyHint("app.tools.expand", "to view the full plan")));
			if (!running && expanded && ex.sessionFile) add(theme.fg("dim", `executor session: ${ex.sessionFile}`));
			return container;
		},
	});

	pi.registerTool({
		name: DISCARD_TOOL,
		label: "Discard",
		description:
			'MixAgent: drop irrelevant tool results from your context and from the planner package. Each result is replaced with a short "[#N discarded]" note; the discard call itself is not kept in the context. Only use it for searches whose results turned out to be unrelated to the task.',
		promptSnippet: "Discard irrelevant search results (by their [#N] number) from the context",
		promptGuidelines: [
			"Call discard only when a search or listing returned results unrelated to the task (wrong matches, vendored or generated code); never discard anything the planner might need.",
		],
		parameters: Type.Object({
			ids: Type.Array(Type.Integer({ minimum: 1 }), {
				description: "Numbers of the tool results to discard, as shown in their [#N] prefix.",
			}),
			reason: Type.Optional(Type.String({ description: 'Very short reason, e.g. "only matches in node_modules".' })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const messages = ctx.sessionManager
				.getBranch()
				.flatMap((e) => (e.type === "message" ? [e.message as unknown as Msg] : []));
			const { discarded, invalid } = resolveDiscard(messages, params.ids);
			if (invalid.length > 0 || discarded.length === 0) {
				const refs = invalid.map((r) => `#${r}`).join(", ") || "(none)";
				throw new Error(`No finished tool result ${refs} in the current exploration; nothing was discarded.`);
			}
			const details: DiscardDetails = { discarded, reason: params.reason?.trim() || undefined };
			return {
				content: [{ type: "text", text: `Discarded ${discarded.map((d) => `#${d.ref}`).join(", ")}.` }],
				details,
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const ids = (args.ids ?? []).map((r) => `#${r}`).join(", ");
			const reason = args.reason ? theme.fg("dim", ` · ${args.reason}`) : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("discard"))} ${theme.fg("muted", ids)}${reason}`);
			return text;
		},
	});

	pi.registerCommand("mix", {
		description: "MixAgent: /mix [on|off|status|model [<role> [provider/id]]|thinking <role> <level>|save [global|project]]",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length === 3 && parts[0] === "model" && ROLES.includes(parts[1] as Role)) {
				const role = parts[1] as Role;
				const query = parts[2].toLowerCase();
				const items = (modelRegistry?.getAvailable() ?? [])
					.filter((m) => modelSpec(m).toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
					.map((m) => ({
						value: `model ${role} ${modelSpec(m)}`,
						label: modelSpec(m),
						description: config?.[roleKey(role)] === modelSpec(m) ? `${m.name} (current)` : m.name,
					}));
				return items.length > 0 ? items : null;
			}
			const options =
				parts.length <= 1
					? ["on", "off", "status", "model", "thinking", "save"]
					: parts.length === 2 && (parts[0] === "model" || parts[0] === "thinking")
						? ROLES
						: parts.length === 2 && parts[0] === "save"
							? ["global", "project"]
							: [];
			const last = parts[parts.length - 1] ?? "";
			const head = parts.slice(0, -1).join(" ");
			const items = options
				.filter((o) => o.startsWith(last))
				.map((o) => ({ value: head ? `${head} ${o}` : o, label: o }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			config = effectiveConfig(ctx.cwd);
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

			switch (sub) {
				case "on":
					shared.enabled = true;
					config.enabled = true;
					ctx.ui.notify("MixAgent enabled: the next prompt starts with the scout.", "info");
					break;
				case "off":
					shared.enabled = false;
					config.enabled = false;
					leaveScout();
					if (savedModel) await pi.setModel(savedModel);
					ctx.ui.notify(`MixAgent disabled. Model: ${modelSpec(savedModel ?? ctx.model)}`, "info");
					break;
				case "model": {
					const role = rest[0] as Role;
					if (!role) {
						const models = ctx.modelRegistry.getAvailable();
						if (models.length === 0) {
							ctx.ui.notify("No models with configured auth. Check /model or ~/.pi/agent/models.json", "error");
							return;
						}
						const lines = models.map((m) => {
							const roles = ROLES.filter((r) => config![roleKey(r)] === modelSpec(m));
							return `  ${modelLabel(m)}${roles.length > 0 ? `  ← ${roles.join(", ")}` : ""}`;
						});
						ctx.ui.notify(
							[`Available models (${models.length}):`, ...lines, "Set one with /mix model <scout|planner|executor> <provider/modelId>"].join("\n"),
							"info",
						);
						return;
					}
					if (!ROLES.includes(role)) {
						ctx.ui.notify("Usage: /mix model <scout|planner|executor> [provider/modelId]", "error");
						return;
					}
					let spec: string | undefined = rest[1];
					if (!spec && ctx.hasUI) {
						const models = ctx.modelRegistry.getAvailable();
						const label = await ctx.ui.select(`MixAgent ${role} model`, models.map(modelLabel));
						const chosen = models.find((m) => modelLabel(m) === label);
						spec = chosen && modelSpec(chosen);
					}
					if (!spec) return;
					const parsed = parseModelSpec(spec);
					if (!parsed || !ctx.modelRegistry.find(parsed.provider, parsed.id)) {
						ctx.ui.notify(`Unknown model "${spec}"`, "error");
						return;
					}
					shared.overrides[roleKey(role)] = spec;
					config = effectiveConfig(ctx.cwd);
					ctx.ui.notify(`MixAgent ${role} model: ${spec} (this pi process; use /mix save to persist)`, "info");
					break;
				}
				case "thinking": {
					const role = rest[0] as Role;
					const level = rest[1];
					if (!ROLES.includes(role) || !level || !isThinkingLevel(level)) {
						ctx.ui.notify("Usage: /mix thinking <scout|planner|executor> <off|minimal|low|medium|high|xhigh>", "error");
						return;
					}
					shared.overrides[`${role}Thinking`] = level as ThinkingLevel;
					config = effectiveConfig(ctx.cwd);
					ctx.ui.notify(`MixAgent ${role} thinking: ${level}`, "info");
					break;
				}
				case "save": {
					const target = rest[0] === "project" ? projectConfigPath(ctx.cwd) : globalConfigPath(getAgentDir());
					let existing: Record<string, unknown> = {};
					try {
						existing = JSON.parse(await readFile(target, "utf8"));
					} catch {
						// new file
					}
					const next = { ...existing, ...shared.overrides };
					await mkdir(resolve(target, ".."), { recursive: true });
					await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
					ctx.ui.notify(`MixAgent settings saved to ${target}`, "info");
					break;
				}
				case "status": {
					const lines = [
						`MixAgent: ${config.enabled ? "on" : "off"}`,
						...ROLES.map((r) => `  ${r.padEnd(8)} ${config![roleKey(r)]}  (thinking: ${config![`${r}Thinking`]})`),
						`  fork-join: ${config.forkJoin ? `on (max ${config.maxParallelPlanners} parallel planners, ${config.maxParallelExecutors} parallel executors)` : "off"}`,
						`  config: ${globalConfigPath(getAgentDir())}, ${projectConfigPath(ctx.cwd)}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}
				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Try /mix status`, "error");
			}
			updateStatus(ctx);
		},
	});
}
