/**
 * MixAgent configuration.
 *
 * Precedence (highest first):
 *   1. CLI flags (--mix-scout, --mix-planner, --mix-executor, --mix-off, --mix-usage-log)
 *   2. Runtime overrides via /mix model ...
 *   3. Project config:  <cwd>/.pi/mixagent.json
 *   4. Global config:   ~/.pi/agent/mixagent.json
 *   5. Built-in defaults
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type Role = "scout" | "planner" | "executor";

export interface MixConfig {
	/** Whether the scout -> planner -> executor pipeline is active. */
	enabled: boolean;
	/** "provider/modelId" of the cheap model that explores the codebase. */
	scoutModel: string;
	/** "provider/modelId" of the flagship model that writes the change plan. */
	plannerModel: string;
	/** "provider/modelId" of the cheap model that applies the plan in a new session. */
	executorModel: string;
	scoutThinking: ThinkingLevel;
	plannerThinking: ThinkingLevel;
	executorThinking: ThinkingLevel;
	/** Max output tokens for the planner call (caps flagship output spend). */
	plannerMaxTokens: number;
	/** Tools active for the scout (handoff is always added). */
	scoutTools: string[];
	/** Tools available to the executor session. */
	executorTools: string[];
	/** Block bash commands that look like they modify state while scouting. */
	scoutBashGuard: boolean;
	/** Per tool-output character cap inside the planner package. */
	maxToolOutputChars: number;
	/** Per attached-file character cap inside the planner package. */
	maxFileChars: number;
	/** Total character cap for the planner package. */
	maxPackageChars: number;
	/** Max images (user attachments, image reads, image key files) sent to the planner; 0 disables. */
	maxPlannerImages: number;
	/** How many times the planner may send the scout back for more context per request. */
	maxContextRounds: number;
	/** Drop scout tool calls from finished cycles before sending context to the scout model. */
	pruneScoutHistory: boolean;
	/** Persist the executor session to disk (shows up in /resume). */
	persistExecutorSession: boolean;
	/**
	 * Apply the plan's exact file changes (SEARCH/REPLACE edits, new and deleted files) directly before the executor
	 * starts. The executor is told each result and only does the rest (unclear changes, Commands, the report).
	 */
	autoApply: boolean;
	/**
	 * Fork-join planning: the planner may split large work into subtasks, each planned by its own planner call,
	 * then merged by a join planner call that may also split execution across parallel executors.
	 */
	forkJoin: boolean;
	/** Max sub-planner calls running at the same time in fork-join mode. */
	maxParallelPlanners: number;
	/** Max task executors running at the same time in fork-join mode. */
	maxParallelExecutors: number;
	/** Extra attempts for a failed sub-planner in fork-join mode; 0 disables retries. */
	plannerRetries: number;
	/** Extra attempts (each in a fresh session) for a failed task executor in fork-join mode; 0 disables retries. */
	executorRetries: number;
	/** Directory to save plan Markdown files to. Empty string disables saving. "~" is expanded. */
	planDir: string;
	/**
	 * JSONL file to append one cost record per prompt to (every model call: scout or main model, planner, executors).
	 * Empty string disables it. "~" is expanded; relative paths resolve against the cwd.
	 */
	usageLog: string;
}

export const DEFAULT_CONFIG: MixConfig = {
	enabled: true,
	scoutModel: "anthropic/claude-haiku-4-5",
	plannerModel: "anthropic/claude-opus-4-7",
	executorModel: "anthropic/claude-haiku-4-5",
	scoutThinking: "off",
	plannerThinking: "high",
	executorThinking: "off",
	plannerMaxTokens: 32000,
	scoutTools: ["read", "bash", "grep", "find", "ls"],
	executorTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	scoutBashGuard: true,
	maxToolOutputChars: 20_000,
	maxFileChars: 60_000,
	maxPackageChars: 500_000,
	maxPlannerImages: 10,
	maxContextRounds: 3,
	pruneScoutHistory: true,
	persistExecutorSession: true,
	autoApply: true,
	forkJoin: true,
	maxParallelPlanners: 4,
	maxParallelExecutors: 4,
	plannerRetries: 2,
	executorRetries: 2,
	planDir: "~/.pi/agent/mixagent/plans",
	usageLog: "",
};

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function readJson(path: string): Partial<MixConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (err) {
		throw new Error(`mixagent: failed to parse ${path}: ${(err as Error).message}`);
	}
}

/** Keep only known keys with the same primitive type as the default. */
function sanitize(raw: Partial<MixConfig>): Partial<MixConfig> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!(key in DEFAULT_CONFIG)) continue;
		const def = DEFAULT_CONFIG[key as keyof MixConfig];
		if (Array.isArray(def)) {
			if (Array.isArray(value) && value.every((v) => typeof v === "string")) out[key] = value;
		} else if (typeof value === typeof def) {
			if (key.endsWith("Thinking") && !THINKING_LEVELS.includes(value as ThinkingLevel)) continue;
			out[key] = value;
		}
	}
	return out as Partial<MixConfig>;
}

export function globalConfigPath(agentDir: string): string {
	return join(agentDir, "mixagent.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "mixagent.json");
}

export function loadConfig(cwd: string, agentDir: string): MixConfig {
	return {
		...DEFAULT_CONFIG,
		...sanitize(readJson(globalConfigPath(agentDir))),
		...sanitize(readJson(projectConfigPath(cwd))),
	};
}

export function roleKey(role: Role): "scoutModel" | "plannerModel" | "executorModel" {
	return `${role}Model` as const;
}

export function parseModelSpec(spec: string): { provider: string; id: string } | undefined {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return undefined;
	return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}
