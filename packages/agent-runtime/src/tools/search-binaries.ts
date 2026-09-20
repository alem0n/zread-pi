/**
 * rg / fd 探测（**只探测，不静默下载**）
 *
 * 决策（外部二进制只探测、不静默下载，见 AGENTS.md §3 外部工具）：
 *  - 探测顺序与安装/卸载由 `@zread-pi/utils` 的工具层统一负责
 *    （`resolveToolBinary`：托管目录 `~/.zread-pi/bin` → 系统 PATH → 用户停用时直接不用）；
 *  - 缺失时本仓库的搜索工具会退回纯 JS 实现（见 file-walk.ts），能力不降级；
 *  - **只有用户在配置界面 /config/tools 里显式点安装才会联网下载**，
 *    agent 运行期不做任何隐式下载。
 *
 * 这里只做一层进程内缓存（工具热路径上会反复查询），并在工具可用性变化时失效。
 */

import { onToolsChanged, resolveToolBinary, getToolSpec } from "@zread-pi/utils";

export type SearchBinaryName = "rg" | "fd";

const cache = new Map<SearchBinaryName, string | null>();
let subscribed = false;

function ensureSubscription(): void {
	if (subscribed) return;
	subscribed = true;
	// 安装 / 卸载 / 启用状态变化后清空缓存，同一个进程内立即可用（配置界面装完即可搜索）
	onToolsChanged(() => resetSearchBinaryCache());
}

/**
 * 返回可用的二进制（命令名或绝对路径），不可用时返回 null。
 * 结果会被缓存，直到 `notifyToolsChanged()` / `resetSearchBinaryCache()` 触发。
 */
export function findSearchBinary(name: SearchBinaryName): string | null {
	ensureSubscription();
	if (cache.has(name)) return cache.get(name) ?? null;

	if (!getToolSpec(name)) {
		cache.set(name, null);
		return null;
	}
	const resolved = resolveToolBinary(name);
	const value = resolved ? resolved.path : null;
	cache.set(name, value);
	return value;
}

/** 清空探测缓存（安装/卸载后、或测试模拟二进制缺失/存在时使用）。 */
export function resetSearchBinaryCache(): void {
	cache.clear();
}
