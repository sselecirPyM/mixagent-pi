/**
 * Cost accounting: every model call made for one user prompt (the main session's scout or main model, the planner
 * calls, the executors), summed per role. Written as one JSONL record per prompt when `usageLog` is set, so runs with
 * MixAgent on and off are measured by the same code.
 */

/** "main" is the main session's model while MixAgent is off (or skipped for the prompt). */
export type CostRole = "main" | "scout" | "planner" | "executor";

export interface CostTotals {
	/** Model requests, retried attempts included. */
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface CallCost extends CostTotals {
	role: CostRole;
	/** What the calls were: "session" (main session), "lead", "S1", "join", "executor", "T1", "commands". */
	label: string;
	/** provider/modelId */
	model: string;
}

export interface CostRecord {
	time: string;
	sessionId?: string;
	sessionFile?: string;
	cwd: string;
	prompt: string;
	/** True when the prompt ran through the scout -> planner -> executor pipeline. */
	mix: boolean;
	/** Wall-clock milliseconds from the prompt to the end of the agent run. */
	durationMs: number;
	total: CostTotals;
	byRole: Partial<Record<CostRole, CostTotals>>;
	calls: CallCost[];
}

export const COST_ROLES: CostRole[] = ["main", "scout", "planner", "executor"];

export function emptyTotals(): CostTotals {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addTotals(a: CostTotals, b: CostTotals): CostTotals {
	return {
		calls: a.calls + b.calls,
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

/** Adds a call to the list, summing it into an existing entry with the same role, label and model. */
export function addCall(calls: CallCost[], call: CallCost): void {
	if (call.calls === 0 && call.cost === 0 && call.input === 0 && call.output === 0) return;
	const i = calls.findIndex((c) => c.role === call.role && c.label === call.label && c.model === call.model);
	if (i < 0) calls.push({ ...call });
	else calls[i] = { ...calls[i], ...addTotals(calls[i], call) };
}

export function summarizeCalls(calls: CallCost[]): Pick<CostRecord, "total" | "byRole"> {
	let total = emptyTotals();
	const byRole: CostRecord["byRole"] = {};
	for (const c of calls) {
		total = addTotals(total, c);
		byRole[c.role] = addTotals(byRole[c.role] ?? emptyTotals(), c);
	}
	return { total, byRole };
}

export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(cost: number): string {
	return `$${cost.toFixed(cost < 0.01 ? 4 : 3)}`;
}

function formatTotals(t: CostTotals): string {
	return `${t.calls} call(s) · ${formatTokens(t.input + t.cacheRead + t.cacheWrite)} in (${formatTokens(t.cacheRead)} cached) / ${formatTokens(t.output)} out · ${formatCost(t.cost)}`;
}

/** One line per role that made calls, then the total. */
export function formatCostLines(calls: CallCost[]): string[] {
	const { total, byRole } = summarizeCalls(calls);
	const lines = COST_ROLES.flatMap((role) => {
		const t = byRole[role];
		if (!t) return [];
		const models = [...new Set(calls.filter((c) => c.role === role).map((c) => c.model))].join(", ");
		return [`  ${role.padEnd(8)} ${formatTotals(t)}  [${models}]`];
	});
	return [...lines, `  ${"total".padEnd(8)} ${formatTotals(total)}`];
}
