/**
 * 溯源台账（claims ledger 的代码版）—— 纯函数
 *
 * 来源：lecture-to-notes 的 `scripts/extract_claims.py`
 * （先逐字复制「脚本决定源里有什么，不由模型决定」的两段式结构——
 * 提取 → 逐条 check）。
 *
 * 复制后改写：正则抽数字台账 → AST 符号缓存（`last_symbols.json`，已由
 * repo-analyzer 产出到 `.zread-pi/cache/`，零额外解析成本）；LaTeX 宏剥离
 * （`flatten_tex`）→ Markdown 围栏剥离（只看散文里的行内代码，不看代码块）。
 *
 * 校验项（失败语义见下表）：
 * - 路径真实（FAIL）：`Sources:` 里的 `](path)` / `](path#Lx-Ly)` 落在
 *   manifest 内或磁盘上存在；
 * - 行号有效（FAIL）：`#Lx-Ly` 的 x ≤ y ≤ 文件行数（流式按行计数，不全量缓冲）；
 * - 符号可溯（WARN）：正文行内代码引用的标识符在符号缓存里存在；
 * - 跨页重复声明（WARN）：同一文件 + 同一行号区间被 ≥2 个页面声明为证据。
 *
 * 本模块纯逻辑 + 只读：I/O 只读缓存 / 被引用的源文件，不写任何产物。
 * 消费方：`verify-wiki.ts` 的 traceability 检查组。
 */

import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { CacheManifest, SymbolManifest, WikiPage } from '@zread-pi/types';
import { detectMermaidSyntax } from './mermaid-syntax.js';

// ==================== Sources 解析 ====================

export interface SourceRef {
	/** 引用路径（相对仓库根） */
	path: string;
	/** 行号区间（#Lx-Ly；无行号时 undefined） */
	lineFrom?: number;
	lineTo?: number;
	/** 出现该引用的页面 slug */
	pageSlug: string;
}

const SOURCES_LINE_RE = /^#{0,6}\s*Sources?:\s*(.*)$/im;
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * 从页面正文解析 `Sources:` 行里的全部引用。
 *
 * 支持两种形式：`[名](相对路径)` 与 `[名](相对路径#L12-34)`。
 * 绝对路径与外部链接（http(s):// / mailto:）不参与校验（它们不是仓库内溯源）。
 */
export function parseSourceRefs(markdown: string, pageSlug: string): SourceRef[] {
	const refs: SourceRef[] = [];
	const sourcesMatch = SOURCES_LINE_RE.exec(markdown);
	if (!sourcesMatch) return refs;

	const body = sourcesMatch[1];
	LINK_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = LINK_RE.exec(body)) !== null) {
		const target = match[2];
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith('mailto:')) continue;
		if (!target || target.startsWith('#')) continue;

		const hashIndex = target.indexOf('#');
		const path = hashIndex === -1 ? target : target.slice(0, hashIndex);
		const ref: SourceRef = { path, pageSlug };

		if (hashIndex !== -1) {
			const lineSpec = target.slice(hashIndex + 1);
			const lineMatch = /^L(\d+)(?:-L?(\d+))?$/.exec(lineSpec);
			if (lineMatch) {
				ref.lineFrom = Number.parseInt(lineMatch[1], 10);
				ref.lineTo = lineMatch[2] ? Number.parseInt(lineMatch[2], 10) : ref.lineFrom;
			}
		}
		refs.push(ref);
	}
	return refs;
}

// ==================== 符号解析（WARN） ====================

/** 行内代码标识符（只看散文：先剥离围栏代码块，避免把代码示例当成引用） */
const FENCE_BLOCK_RE = /^```[\s\S]*?^```/gm;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]{2,}$/;
/** 标识符扫描（消息标签 / 显示名是短语，取其中所有 >=3 字符的标识符片段） */
const IDENTIFIER_SCAN_RE = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;

/**
 * 从符号缓存构造「已知符号名」集合：exports / functions / imports。
 *
 * 这些都是解析器在源码里实际找到的标识符，因此可以充当台账
 * （脚本决定源里有什么，不由模型决定）。
 */
export function collectKnownSymbols(symbols: SymbolManifest | null | undefined): Set<string> {
	const known = new Set<string>();
	if (!symbols) return known;
	for (const entry of symbols.symbols) {
		for (const name of entry.exports) known.add(name);
		for (const fn of entry.functions) known.add(fn.name);
		for (const name of entry.imports) known.add(name);
	}
	return known;
}

/** 剥离围栏代码块后的正文（行内代码保留，供符号扫描） */
function stripFencedCode(markdown: string): string {
	return markdown.replace(FENCE_BLOCK_RE, '');
}

/**
 * 找出正文里引用了、但符号缓存里不存在的标识符（WARN）。
 *
 * 只扫描行内代码（反引号）里的标识符——这是页面「指名道姓引用源码符号」的
 * 常见写法。匹配不到可能是：① 模型幻觉了一个函数名；② 符号缓存过期
 * （文件改动了）；③ 引用的是别处的标识符（文档名、工具名等）。因此只 WARN。
 */
export function findUnresolvedSymbols(
	markdown: string,
	known: Set<string>,
	maxReported = 24,
): string[] {
	if (known.size === 0) return [];
	const stripped = stripFencedCode(markdown);
	const unresolved: string[] = [];
	const seen = new Set<string>();

	INLINE_CODE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = INLINE_CODE_RE.exec(stripped)) !== null) {
		const name = match[1].trim();
		if (!IDENTIFIER_RE.test(name)) continue;
		if (known.has(name) || seen.has(name)) continue;
		seen.add(name);
		unresolved.push(name);
		if (unresolved.length >= maxReported) break;
	}
	return unresolved;
}

// ==================== 图表符号 grounding（WARN） ====================

/** mermaid 围栏块（取四类图的参与者 / 消息标签 / 状态名做符号比对） */
const MERMAID_FENCE_RE = /^```[ \t]*mermaid[^\n]*\n([\s\S]*?)^```[ \t]*$/gim;

/** 参与者显示名：`participant A as <显示名>`（别名是图内坐标，不参与比对） */
const SEQ_DISPLAY_NAME_RE = /^\s*(?:participant|actor)\s+[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff-]*\s+as\s+(.+)$/i;
/** state "标签" as ID */
const STATE_LABELED_ID_RE = /^\s*state\s+(?:"[^"]*"|'[^']*')\s+as\s+([A-Za-z_]\w*)/i;
/** state ID（无标签形态） */
const STATE_BARE_ID_RE = /^\s*state\s+([A-Za-z_]\w*)\s*$/i;
/** 迁移端点：<from> --> <to>（[*] 是起止标记，不是源码符号） */
const STATE_TRANSITION_RE = /^\s*([A-Za-z_]\w*)\s*-->\s*([A-Za-z_]\w*)/;

/** 去掉显示名两侧的引号 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 从一个 mermaid 块里提取待比对的符号候选。
 *
 * 只提取**可能指名道姓引用源码符号**的部分（设计依据：脚本决定源里有什么）：
 * - sequence：`participant A as "AuthGateway"` 的**显示名**（别名是图内坐标，
 *   不是源码符号，不参与比对）与消息箭头后的**消息标签**；
 * - state：状态 id（`state "标签" as Id` / `state Id` / 迁移端点）；
 * - flowchart / 未知图种：不提取（架构 / 流程图的节点是目录 / 模块 / 步骤，
 *   不是可对账的源码符号——它们的 grounding 由 diagram-guide 的「画前必须读过」纪律承担）。
 *
 * 中文标签 / 显示名不含标识符片段，自然被 IDENTIFIER_SCAN_RE 过滤，不产生噪声。
 */
function extractDiagramSymbols(code: string): string[] {
  const syntax = detectMermaidSyntax(code);
  if (syntax === 'unknown') return [];

  const candidates: string[] = [];
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('%%')) continue;

    if (syntax === 'sequence') {
      const asMatch = SEQ_DISPLAY_NAME_RE.exec(line);
      if (asMatch) {
        candidates.push(unquote(asMatch[1]));
        continue;
      }
      // 消息标签：冒号之后的部分（可能含标识符，如 validateToken()）
      const colonIndex = line.indexOf(':');
      if (colonIndex !== -1) candidates.push(line.slice(colonIndex + 1));
      continue;
    }

    // state
    const labeledId = STATE_LABELED_ID_RE.exec(line);
    if (labeledId) {
      candidates.push(labeledId[1]);
      continue;
    }
    const bareId = STATE_BARE_ID_RE.exec(line);
    if (bareId) {
      candidates.push(bareId[1]);
      continue;
    }
    const transition = STATE_TRANSITION_RE.exec(line);
    if (transition) {
      candidates.push(transition[1]);
      candidates.push(transition[2]);
    }
  }
  return candidates;
}

/**
 * 找出图表里指名道姓引用、但符号缓存里不存在的标识符（WARN）。
 *
 * 与正文行内代码的 `findUnresolvedSymbols` 同语义、同上限，结果由调用方
 * 并入 `unresolvedSymbols`（**只 WARN，不升级 FAIL**：未命中可能是符号缓存
 * 过期、或引用的是别处命名，与「调用链完整」的机械边界一致）。
 */
export function findUnresolvedDiagramSymbols(
  markdown: string,
  known: Set<string>,
  maxReported = 24,
): string[] {
  if (known.size === 0) return [];

  const unresolved: string[] = [];
  const seen = new Set<string>();

  MERMAID_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MERMAID_FENCE_RE.exec(markdown)) !== null) {
    for (const candidate of extractDiagramSymbols(match[1])) {
      IDENTIFIER_SCAN_RE.lastIndex = 0;
      let tokenMatch: RegExpExecArray | null;
      while ((tokenMatch = IDENTIFIER_SCAN_RE.exec(candidate)) !== null) {
        const token = tokenMatch[0];
        if (known.has(token) || seen.has(token)) continue;
        seen.add(token);
        unresolved.push(token);
        if (unresolved.length >= maxReported) return unresolved;
      }
    }
  }
  return unresolved;
}

// ==================== 路径 / 行号 ====================

/** 由 manifest 构造「已扫描文件」集合（相对根的路径） */
export function collectManifestPaths(manifest: CacheManifest | null | undefined): Set<string> {
	const paths = new Set<string>();
	if (!manifest) return paths;
	for (const file of manifest.files) paths.add(file.path.replace(/\\/g, '/'));
	return paths;
}

/**
 * 路径是否真实：manifest 命中，或磁盘上存在（manifest 是扫描快照，
 * 磁盘是当前事实；取并集避免对非源文件引用产生假 FAIL）。
 */
export function isPathReal(root: string, path: string, manifestPaths: Set<string>): boolean {
	const normalized = path.replace(/\\/g, '/');
	if (manifestPaths.has(normalized)) return true;
	return existsSync(join(root, normalized));
}

/** 流式按行计数（不全量缓冲；只对被引用的文件执行） */
export async function countLines(filePath: string): Promise<number | undefined> {
	try {
		const handle = await open(filePath, 'r');
		let lines = 0;
		for await (const _line of handle.readLines()) {
			lines++;
		}
		await handle.close();
		return lines;
	} catch {
		return undefined;
	}
}

// ==================== 蓝图维度：associatedFiles 存在性 ====================

export interface AssociatedFileIssue {
	slug: string;
	missing: string[];
}

/**
 * 校验每页 `associatedFiles` 指向真实存在的文件或目录（复活旧版
 * `validate_blueprint` 的存在性判定，由 verify-wiki 在页面维度执行）。
 *
 * 与 `Sources:` 引用不同，这是**蓝图声明**的关联路径——页面 prompt 以它们
 * 为读取范围，指向不存在的路径意味着这页从一开始就没有证据基础。
 */
export function checkAssociatedFiles(
	pages: WikiPage[],
	root: string,
	manifestPaths: Set<string>,
): AssociatedFileIssue[] {
	const issues: AssociatedFileIssue[] = [];
	for (const page of pages) {
		const missing: string[] = [];
		for (const path of page.associatedFiles ?? []) {
			if (!isPathReal(root, path, manifestPaths)) missing.push(path);
		}
		if (missing.length > 0) issues.push({ slug: page.slug, missing });
	}
	return issues;
}

// ==================== 汇总校验 ====================

export interface TraceabilityResult {
	/** 解析到的全部引用（诊断用） */
	refs: SourceRef[];
	/** 页面完全没有 Sources 引用（页面 prompt 已强约束，机械校验兜底） */
	noSources: boolean;
	/** 路径不真实（FAIL） */
	badPaths: string[];
	/** 行号区间越界 / 无法读取（FAIL） */
	badLines: string[];
	/** 跨页重复声明（WARN：列出页面供人工裁决） */
	duplicateClaims: string[];
	/** 符号缓存里找不到的行内代码标识符（WARN） */
	unresolvedSymbols: string[];
	/** 符号缓存缺失（符号检查无法执行，调用方应 SKIP 该项） */
	symbolsUnavailable: boolean;
}

export interface TraceabilityInput {
	root: string;
	pages: WikiPage[];
	/** slug → 页面正文 */
	contents: Map<string, string>;
	manifest?: CacheManifest | null;
	symbols?: SymbolManifest | null;
}

/**
 * 溯源台账校验（两段式：先提取全部引用，再逐条 check）。
 *
 * 纯 I/O：只读被引用的源文件（按行计数）。结果只给事实，PASS/FAIL 判定
 * 由调用方（verify-wiki）按失败语义决定。
 */
export async function checkTraceability(input: TraceabilityInput): Promise<TraceabilityResult> {
	const { root, pages, contents, manifest, symbols } = input;

	// 1. 提取：全部页面的 Sources 引用
	const refs: SourceRef[] = [];
	for (const page of pages) {
		refs.push(...parseSourceRefs(contents.get(page.slug) ?? '', page.slug));
	}

	const manifestPaths = collectManifestPaths(manifest);
	const knownSymbols = collectKnownSymbols(symbols);

	// 2. 逐条 check：路径真实 + 行号有效
	const badPaths: string[] = [];
	const badLines: string[] = [];
	for (const ref of refs) {
		if (!isPathReal(root, ref.path, manifestPaths)) {
			badPaths.push(`${ref.pageSlug} -> ${ref.path}`);
			continue;
		}
		if (ref.lineFrom !== undefined && ref.lineTo !== undefined) {
			const lineCount = await countLines(join(root, ref.path));
			if (lineCount === undefined) {
				badLines.push(`${ref.pageSlug} -> ${ref.path}（无法读取行数）`);
			} else if (!(ref.lineFrom <= ref.lineTo && ref.lineTo <= lineCount)) {
				badLines.push(
					`${ref.pageSlug} -> ${ref.path}#L${ref.lineFrom}-${ref.lineTo}（文件共 ${lineCount} 行）`,
				);
			}
		}
	}

	// 3. 跨页重复声明（同文件 + 同行号区间被 ≥2 个页面声明）：WARN
	const seen = new Map<string, string[]>();
	const duplicateClaims: string[] = [];
	for (const ref of refs) {
		if (ref.lineFrom === undefined) continue;
		const key = `${ref.path}#L${ref.lineFrom}-${ref.lineTo}`;
		const owners = seen.get(key) ?? [];
		if (owners.length > 0 && !owners.includes(ref.pageSlug)) {
			duplicateClaims.push(`${key}：${owners[0]} 与 ${ref.pageSlug}`);
		}
		seen.set(key, [...owners, ref.pageSlug]);
	}

	// 4. 符号可溯（WARN）：符号缓存缺失时无法执行，调用方 SKIP。
	//    正文行内代码与图表（序列图参与者显示名 / 消息标签 / 状态图状态名）共用同一台账，
	//    未命中一律 WARN，不升级 FAIL。
	const symbolsUnavailable = knownSymbols.size === 0;
	const unresolvedSymbols: string[] = [];
	if (!symbolsUnavailable) {
		for (const page of pages) {
			const content = contents.get(page.slug) ?? '';
			const badInline = findUnresolvedSymbols(content, knownSymbols);
			const badDiagram = findUnresolvedDiagramSymbols(content, knownSymbols);
			for (const name of [...badInline, ...badDiagram]) {
				unresolvedSymbols.push(`${page.slug}：\`${name}\``);
			}
		}
	}

	return {
		refs,
		noSources: refs.length === 0,
		badPaths,
		badLines,
		duplicateClaims,
		unresolvedSymbols,
		symbolsUnavailable,
	};
}
