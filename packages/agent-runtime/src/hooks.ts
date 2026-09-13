/**
 * 钩子配置与执行。
 *
 * 迁移前的契约形状（`PreToolUse` / `PostToolUse` 匹配器 + 超时）保持不变，
 * 执行位置从裸 loop 的 `beforeToolCall` / `afterToolCall` 换成 harness 的
 * `before_tool` / `after_tool` 钩子（语义一一对应，见 MIGRATION.md §12）。
 *
 * 预算相关的终止/提示钩子不在这里，而在 `harness/budget.ts`（BudgetController）。
 */

/** 旧 agent-sdk 形状的工具钩子处理器 */
export type ToolHookHandler = (
	input: Record<string, unknown>,
	toolUseId: string,
	context: { signal: AbortSignal },
) => Promise<unknown>;

/** 单条匹配器（matcher 为正则字符串；timeout 为软超时，超时按 undefined 处理） */
export interface ToolHookMatcher {
	matcher?: string;
	hooks: ToolHookHandler[];
	timeout?: number;
}

/** 按事件名组织的钩子配置（PreToolUse / PostToolUse / ...） */
export type HookConfig = Record<string, ToolHookMatcher[]>;

/**
 * 兼容垫片：旧 agent-sdk 的 QueryEngineConfig 允许注入 HookRegistry 实例。
 * pi 版运行时把钩子按事件名直接传给 createAgent 的 `hooks` 选项，不需要独立注册表。
 */
export interface HookRegistry {
	/** 可选实现：按事件名注册钩子（pi 版由 createAgent 的 hooks 选项承担） */
	on?(event: string, handler: (...args: unknown[]) => unknown): void;
}

/** 执行一组匹配器，返回每个处理器的原始返回值（超时的记 undefined） */
export async function runToolHooks(
	hooks: HookConfig | undefined,
	eventName: string,
	payload: Record<string, unknown>,
	toolUseId: string,
	signal: AbortSignal,
	toolName?: string,
): Promise<unknown[]> {
	const matchers = hooks?.[eventName];
	if (!matchers?.length) return [];

	const results: unknown[] = [];
	for (const matcher of matchers) {
		if (matcher.matcher && toolName) {
			try {
				if (!new RegExp(matcher.matcher).test(toolName)) continue;
			} catch {
				continue;
			}
		}
		for (const handler of matcher.hooks ?? []) {
			const executed = handler(payload, toolUseId, { signal });
			results.push(
				matcher.timeout
					? await Promise.race([
							executed,
							new Promise((resolve) => setTimeout(() => resolve(undefined), matcher.timeout)),
						])
					: await executed,
			);
		}
	}
	return results;
}

/** PreToolUse 的阻断判定：任一处理器返回 `{ block: true, message? }` 即阻断 */
export function blockedByHookResult(results: unknown[]): string | undefined {
	for (const result of results) {
		if (result && typeof result === "object" && (result as { block?: boolean }).block === true) {
			const reason = (result as { message?: string }).message;
			return reason ?? "Blocked by PreToolUse hook";
		}
	}
	return undefined;
}
