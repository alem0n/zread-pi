/**
 * rg / fd 探测（**只探测，不下载**）
 *
 * 决策（见 AGENTS.md §1.1「搜索工具的外部二进制策略」）：
 * 上游 pi 的 `utils/tools-manager.ts` 会在缺失时从 GitHub Releases 自动下载并解包
 * （tar.gz / zip、chmod、Windows 用 System32\tar.exe 或 PowerShell Expand-Archive）。
 * 本仓库**刻意不做自动下载**：
 *  1. 运行期静默联网 + 解包可执行文件，对「生成文档」这种长任务来说失败面太大；
 *  2. 解包分支依赖 tar/unzip/PowerShell，是三平台上最容易出问题的一段（上游为此写了 4 个回退）；
 *  3. 缺失时的行为可完全由纯 JS 兜底实现覆盖（见 file-walk.ts），不牺牲能力，只牺牲一点速度。
 *
 * 因此策略是「探测已有 → 用系统二进制；没有 → 用纯 JS 实现」，并在工具描述里说明。
 * 允许通过环境变量显式指定路径（打包/离线场景、测试用）：
 *   ZREAD_PI_RG_PATH / ZREAD_PI_FD_PATH
 */

import { spawnSync } from "node:child_process";

export type SearchBinaryName = "rg" | "fd";

/** 系统命令名候选：Debian 系把 fd 命名为 fdfind。 */
const CANDIDATE_COMMANDS: Record<SearchBinaryName, string[]> = {
	rg: ["rg"],
	fd: ["fd", "fdfind"],
};

const ENV_OVERRIDES: Record<SearchBinaryName, string> = {
	rg: "ZREAD_PI_RG_PATH",
	fd: "ZREAD_PI_FD_PATH",
};

const cache = new Map<SearchBinaryName, string | null>();

function commandWorks(command: string): boolean {
	const result = spawnSync(command, ["--version"], { stdio: "pipe", timeout: 5_000, windowsHide: true });
	if (result.error) return false;
	return result.status === 0;
}

/**
 * 返回可用的二进制（命令名或绝对路径），不可用时返回 null。
 * 结果会被缓存（一次进程内只探测一次）。
 */
export function findSearchBinary(name: SearchBinaryName): string | null {
	if (cache.has(name)) return cache.get(name) ?? null;

	const override = process.env[ENV_OVERRIDES[name]];
	if (override && override.trim().length > 0) {
		const candidate = override.trim();
		const resolved = commandWorks(candidate) ? candidate : null;
		cache.set(name, resolved);
		return resolved;
	}

	let resolved: string | null = null;
	for (const candidate of CANDIDATE_COMMANDS[name]) {
		if (commandWorks(candidate)) {
			resolved = candidate;
			break;
		}
	}
	cache.set(name, resolved);
	return resolved;
}

/** 清空探测缓存（测试用：模拟二进制缺失/存在）。 */
export function resetSearchBinaryCache(): void {
	cache.clear();
}
