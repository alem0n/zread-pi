/**
 * 兼容垫片：旧 agent-sdk 的 QueryEngineConfig 允许注入 HookRegistry 实例。
 *
 * pi 版运行时把钩子按事件名（PreToolUse / PostToolUse）直接传给 createAgent，
 * 不再需要独立的 HookRegistry 实现；此处仅保留类型以满足既有类型契约。
 */

export interface HookRegistry {
	/** 可选实现：按事件名注册钩子（pi 版由 createAgent 的 hooks 选项承担） */
	on?(event: string, handler: (...args: unknown[]) => unknown): void;
}
