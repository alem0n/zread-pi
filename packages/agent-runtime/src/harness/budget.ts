/**
 * BudgetController —— token 预算控制器（首尾机制升级的唯一落点）。
 *
 * 旧形态（裸 agent loop，本次替换时删除）：
 *   · 轮数硬顶：`shouldStopAfterTurn` 里 `turnCount >= maxTurns` 后停止；
 *   · 倒数第 1 轮一次性 `agent.steer(notice)` 硬提示；
 *   · 收尾失败 → 内核 `error_max_turns`。
 *
 * harness 形态（本文件）：
 *   · 判据是 token 而不是轮次：累计用量取 harness 的 `usage` 事件
 *     （携带 committed usage ledger 的累计 totals），比轮数更贴近真实成本；
 *   · 两段式提示：软提示（默认 70% 预算）+ 硬提示（预算将尽），
 *     统一在 `before_run` 注入消息（transition-consumed，随 checkpoint 一起落库）；
 *   · 终止决策统一在 `before_run_end`：不返回 followUp 即终止（正常收尾边界的决策点）；
 *   · 预算耗尽时 `before_run_end` 返回强制交卷 followUp（硬提示），
 *     同时 `before_tool` 熔断后续工具调用，避免模型在预算外无限探索；
 *   · 强制交卷后仍未产出目标工具 → 内核标记预算耗尽，
 *     业务层照旧按「页面文件不存在」判页失败（该层逻辑不依赖内核）。
 *
 * 注意：控制器只持有**副本语义**的运行时状态（进程内），durable 状态由 harness 负责；
 * 因此钩子可以在崩溃点重放而不破坏一致性（提示注入与 checkpoint 同一事务提交）。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

/** 两段式提示文案。空字符串 = 关闭该段提示。 */
export interface BudgetNotices {
	/** 软提示：预算用掉 `softRatio` 后注入一次 */
	soft?: string;
	/** 硬提示：预算耗尽（强制交卷）时注入 */
	hard?: string;
}

/** token 预算配置（已由 agent.ts 归一化：0 = 不限制） */
export interface BudgetOptions {
	/** 累计 token 预算（0 = 不限制）。累计口径：input + output + cacheWrite + cacheRead */
	maxTokens?: number;
	/** 软提示阈值占预算比例（0-1，缺省 0.7） */
	softRatio?: number;
	/** 预算耗尽后允许的强制交卷轮数（缺省 1；0 = 立即终止） */
	forcedTurns?: number;
	/** 提示文案 */
	notices?: BudgetNotices;
	/** 目标输出工具名：出现成功调用即视为「已交卷」 */
	outputTools?: string[];
	/** 分段驱动时用于触发新 run 的续跑提示（绕过 for-budget-segment） */
	continuePrompt?: string;
}

/** 预算快照（供 driver 归类结果、供测试断言） */
export interface BudgetSnapshot {
	maxTokens: number;
	spent: number;
	softLimit: number;
	softInjected: boolean;
	hardInjected: boolean;
	forcedTurnsUsed: number;
	exhausted: boolean;
	outputDelivered: boolean;
	turns: number;
}

/** 缺省软提示（业务侧通常下发本地化文案） */
export const DEFAULT_SOFT_BUDGET_NOTICE =
	"[System notice] About 70% of the token budget for this run is used. Start converging: stop broad exploration and prepare to produce the required final output.";

/** 缺省硬提示（业务侧通常下发本地化文案） */
export const DEFAULT_HARD_BUDGET_NOTICE =
	"[System notice] The token budget for this run is exhausted. Stop exploring and produce the complete final result with the required output tool now, otherwise this run will be stopped and marked as failed.";

/** 缺省续跑提示（分段驱动新 run 的触发消息；提示正文由 before_run 注入） */
export const DEFAULT_CONTINUE_PROMPT = "Continue with the remaining work.";

/** 累计算用量的口径：一次响应消耗的 tokens（含缓存读写） */
export function usageTokens(usage: Usage | undefined): number {
	if (!usage) return 0;
	return usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
}

interface PendingNotices {
	messages: AgentMessage[];
}

export class BudgetController {
	private readonly maxTokens: number;
	private readonly softLimit: number;
	private readonly forcedTurns: number;
	private readonly softNotice: string;
	private readonly hardNotice: string;
	private readonly outputTools: Set<string>;
	readonly continuePrompt: string;

	private spent = 0;
	private softInjected = false;
	private hardInjected = false;
	private forcedTurnsUsed = 0;
	private exhausted = false;
	private outputDelivered = false;
	private turns = 0;

	constructor(options: BudgetOptions = {}) {
		this.maxTokens = Math.max(0, Math.floor(options.maxTokens ?? 0));
		const softRatio = options.softRatio === undefined ? 0.7 : Math.min(1, Math.max(0, options.softRatio));
		this.softLimit = this.maxTokens > 0 ? Math.floor(this.maxTokens * softRatio) : 0;
		this.forcedTurns = Math.max(0, Math.floor(options.forcedTurns ?? 1));
		this.softNotice = options.notices?.soft ?? DEFAULT_SOFT_BUDGET_NOTICE;
		this.hardNotice = options.notices?.hard ?? DEFAULT_HARD_BUDGET_NOTICE;
		this.outputTools = new Set(options.outputTools ?? []);
		this.continuePrompt = options.continuePrompt ?? DEFAULT_CONTINUE_PROMPT;
	}

	/** 是否配置了 token 预算（无预算 = 不限制，与旧 `maxTurns: 0` 等价） */
	get limited(): boolean {
		return this.maxTokens > 0;
	}

	/** 是否要求「以目标工具交卷」 */
	get requiresOutput(): boolean {
		return this.outputTools.size > 0;
	}

	// ------------------------------------------------------------------
	// 观测：usage 事件（权威账本）/ tool_end / turn_end
	// ------------------------------------------------------------------

	/** 记录 harness 的 committed 累计用量（usage 事件的 totals 是权威来源） */
	observeUsage(usage: Usage | undefined): void {
		this.spent = usageTokens(usage);
		if (this.maxTokens > 0 && this.spent >= this.maxTokens) this.exhausted = true;
	}

	/** 记录一次成功的工具调用（用于判断目标产物是否已交卷） */
	observeToolEnd(toolName: string, isError: boolean): void {
		if (!isError && this.outputTools.has(toolName)) this.outputDelivered = true;
	}

	/** 记录一个 assistant turn（仅用于统计/展示，不再作为预算判据） */
	observeTurn(): void {
		this.turns += 1;
	}

	// ------------------------------------------------------------------
	// 钩子：before_run / before_run_end / before_tool
	// ------------------------------------------------------------------

	/**
	 * `before_run`：两段式提示的唯一注入点。
	 *
	 * 返回的 messages 由 harness 作为 run 的 checkpoint 消息一起提交（durable）；
	 * 已经交卷（目标工具成功）时刻意不再打扰模型。
	 */
	beforeRun(): PendingNotices | undefined {
		if (this.outputDelivered) return undefined;

		if (this.exhausted && !this.hardInjected && this.hardNotice.length > 0) {
			this.hardInjected = true;
			this.softInjected = true;
			return { messages: [this.noticeMessage(this.hardNotice)] };
		}
		if (this.forSoftNotice()) {
			this.softInjected = true;
			return { messages: [this.noticeMessage(this.softNotice)] };
		}
		return undefined;
	}

	/**
	 * `before_run_end`：正常收尾边界的唯一决策点。
	 *
	 * - 目标产物已产出 → 不返回 followUp → run 终止（成功）；
	 * - 预算耗尽且强制交卷轮未用完 → 返回硬提示 followUp（强制交卷）；
	 * - 其余情况 → 不返回 followUp → run 终止（预算未到而模型自然收尾，
	 *   或强制交卷轮已用完；两种都由业务层按产物存在与否判失败）。
	 */
	beforeRunEnd(): { followUp?: string } | undefined {
		if (this.outputDelivered) return undefined;
		if (this.exhausted && this.forcedTurnsUsed < this.forcedTurns && this.hardNotice.length > 0) {
			this.forcedTurnsUsed += 1;
			// 硬提示已随 followUp 进入上下文：不再需要为它单开一个 run 段
			this.hardInjected = true;
			this.softInjected = true;
			return { followUp: this.hardNotice };
		}
		return undefined;
	}

	/**
	 * `before_tool`：预算耗尽后熔断工具调用。
	 *
	 * 模型可能在预算耗尽后仍不断发起工具调用（此时永远不会到达 `before_run_end`），
	 * 熔断让最后一次调用以错误结果返回，模型据此收尾，然后由 `before_run_end` 终止。
	 *
	 * 例外：**目标输出工具（outputTools）永远放行** —— 强制交卷轮的存在意义就是让模型
	 * 把产物写出来，如果连交卷工具都被熔断，等于自己破坏了强制交卷。
	 */
	beforeTool(toolName?: string): { block: { reason: string; terminate?: boolean } } | undefined {
		if (!this.exhausted || this.outputDelivered) return undefined;
		if (this.hardNotice.length === 0) return undefined;
		if (toolName !== undefined && this.outputTools.has(toolName)) return undefined;
		return { block: { reason: this.hardNotice } };
	}

	// ------------------------------------------------------------------
	// 驱动：分段（让 `before_run` 有机会在中途注入提示）
	// ------------------------------------------------------------------

	/**
	 * 是否还有「已到期但尚未注入」的提示。
	 *
	 * `before_run` 只在 run 起点触发，因此分段边界（run 结束）时若提示到期且
	 * 目标产物未产出，driver 会再起一个 run，让 `before_run` 把提示写进上下文。
	 */
	pendingNotice(): boolean {
		if (this.outputDelivered) return false;
		if (!this.limited) return false;
		if (this.exhausted) {
			// 预算耗尽后：强制交卷轮未用完才值得再开一段；用完就是终止决策，不再打扰模型
			return this.forcedTurnsUsed < this.forcedTurns && !this.hardInjected;
		}
		return this.spent >= this.softLimit && !this.softInjected;
	}

	// ------------------------------------------------------------------
	// 结果归类
	// ------------------------------------------------------------------

	/** 目标产物是否已成功产出（无 outputTools 约束时恒为 false，表示内核不做产物判定） */
	get deliveredOutput(): boolean {
		return this.outputDelivered;
	}

	/** 预算是否已耗尽 */
	get budgetExhausted(): boolean {
		return this.exhausted;
	}

	snapshot(): BudgetSnapshot {
		return {
			maxTokens: this.maxTokens,
			spent: this.spent,
			softLimit: this.softLimit,
			softInjected: this.softInjected,
			hardInjected: this.hardInjected,
			forcedTurnsUsed: this.forcedTurnsUsed,
			exhausted: this.exhausted,
			outputDelivered: this.outputDelivered,
			turns: this.turns,
		};
	}

	private forSoftNotice(): boolean {
		return this.limited && this.spent >= this.softLimit && !this.softInjected && this.softNotice.length > 0;
	}

	private noticeMessage(text: string): AgentMessage {
		return {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
	}
}
