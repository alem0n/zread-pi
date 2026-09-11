/**
 * 目录遍历（gitignore 感知）—— Glob / Grep / Ls 的共享底座
 *
 * 设计取舍（对应「决定外部依赖获取策略」）：
 *  - 不自动联网下载 rg / fd：本仓库已有「首次解析语言时从 CDN 下载 WASM」的先例，
 *    但二进制下载还要处理 tar/zip 解包、chmod、Windows System32\tar.exe 等平台分支，
 *    收益（速度）远小于风险（供应链 + 三平台解包失败）。因此策略是：
 *      「探测已有 rg/fd → 有则用（更快、gitignore 语义最准）→ 没有则用本模块的纯 JS 兜底」。
 *  - 兜底路径必须与 fd/rg 的可见文件集合保持一致，所以这里实现同一套 gitignore 语义，
 *    并在 fd/rg 分支显式传入相同的内建排除项（见 glob.ts / grep.ts）。
 *
 * gitignore 规则累积方式移植自 vendor `harness/skills.ts` 的 `addIgnoreRules` /
 * `prefixIgnorePattern`（同一份 `ignore@5` 依赖，同一套前缀改写逻辑），不重写规则语义。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ignore from "ignore";
import type { Ignore } from "ignore";

/** fd / rg 默认都会跳过，且对模型无价值的目录（两条执行路径显式对齐）。 */
export const BUILTIN_EXCLUDED_DIRS = [".git", "node_modules", ".zread-pi"] as const;

/** 与 fd / rg 的 ignore 文件集合对齐。 */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** 安全上限：防止在异常仓库（超大目录 / 深层嵌套）上把资源吃光。 */
export const MAX_WALK_ENTRIES = 200_000;

export interface WalkEntry {
	/** 绝对路径（平台原生分隔符，调用方需要时再归一化） */
	absolutePath: string;
	/** 相对搜索根、POSIX 风格（以 `/` 分隔） */
	relativePath: string;
	isDirectory: boolean;
}

export interface WalkOptions {
	/** 中止信号；abort 后生成器立即结束。 */
	signal?: AbortSignal;
}

interface DirectoryFrame {
	absolutePath: string;
	relativePath: string;
	entries: Dirent[];
	index: number;
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

async function addIgnoreRules(matcher: Ignore, dir: string, relativeDir: string): Promise<void> {
	const prefix = relativeDir ? `${relativeDir}/` : "";
	for (const filename of IGNORE_FILE_NAMES) {
		let content: string;
		try {
			content = await readFile(join(dir, filename), "utf-8");
		} catch {
			continue;
		}
		const patterns = content
			.split(/\r?\n/)
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((line): line is string => Boolean(line));
		if (patterns.length > 0) matcher.add(patterns);
	}
}

function isTraversableEntry(entry: Dirent): boolean {
	// 软链接一律当文件处理，不跟随（与 fd 默认行为一致，也避免软链环路）
	return entry.isDirectory() || entry.isFile() || entry.isSymbolicLink();
}

async function readDirectoryEntries(dir: string): Promise<Dirent[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter(isTraversableEntry)
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	} catch {
		// 权限不足 / 目录消失：跳过而不是让整个工具失败
		return [];
	}
}

/**
 * 搜索根是否位于 git 仓库内。
 *
 * fd / rg 默认都只在 git 仓库内应用 `.gitignore`；不在仓库内时必须显式打开
 * `--no-require-git`，否则只要目标仓库没有 `.git`（例如解压出来的源码包、
 * 浅层拷贝、`git worktree` 外的目录）就会把 `node_modules` / `dist` 全部搜出来，
 * 并与纯 JS 兜底（本模块的 walker）行为不一致。
 */
export async function isInsideGitRepo(searchPath: string): Promise<boolean> {
	let current = resolve(searchPath);
	for (;;) {
		try {
			await stat(join(current, ".git"));
			return true;
		} catch {
			// 继续向上找
		}
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/**
 * 深度优先遍历 `root` 下的文件，顺序确定（每层按名称排序）。
 *
 * - `.git` / `node_modules` / `.zread-pi` 永不进入
 * - 累积 `.gitignore` / `.ignore` / `.fdignore` 规则（含子目录里的规则，带前缀改写）
 * - 软链接不跟随；目录读取失败静默跳过（权限问题不该让整次搜索失败）
 */
export async function* walkFiles(root: string, options: WalkOptions = {}): AsyncGenerator<WalkEntry> {
	const searchRoot = resolve(root);
	const matcher = ignore();
	const stack: DirectoryFrame[] = [];
	let visited = 0;

	await addIgnoreRules(matcher, searchRoot, "");
	stack.push({ absolutePath: searchRoot, relativePath: "", entries: await readDirectoryEntries(searchRoot), index: 0 });

	while (stack.length > 0) {
		if (options.signal?.aborted) return;
		const frame = stack[stack.length - 1];
		if (frame.index >= frame.entries.length) {
			stack.pop();
			continue;
		}

		const dirent = frame.entries[frame.index++];
		if ((BUILTIN_EXCLUDED_DIRS as readonly string[]).includes(dirent.name)) continue;

		const relativePath = frame.relativePath ? `${frame.relativePath}/${dirent.name}` : dirent.name;
		const absolutePath = join(frame.absolutePath, dirent.name);

		if (!dirent.isDirectory()) {
			if (matcher.ignores(relativePath)) continue;
			visited++;
			if (visited > MAX_WALK_ENTRIES) return;
			yield { absolutePath, relativePath, isDirectory: false };
			continue;
		}

		if (matcher.ignores(`${relativePath}/`)) continue;
		visited++;
		if (visited > MAX_WALK_ENTRIES) return;

		await addIgnoreRules(matcher, absolutePath, relativePath);
		stack.push({
			absolutePath,
			relativePath,
			entries: await readDirectoryEntries(absolutePath),
			index: 0,
		});
	}
}
