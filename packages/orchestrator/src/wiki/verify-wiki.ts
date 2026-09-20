/**
 * 交付闸门 verify-wiki —— 纯逻辑
 *
 * 来源：lecture-to-notes 的 `scripts/verify_notes.py`
 * （先逐字复制「检查组 + PASS/FAIL/SKIP + OVERALL」的结构，再做 TS 兼容改写）。
 *
 * 复制后改写：LaTeX 编译日志 / 图清单 / pdftotext 渲染门 → Markdown 静态文本门
 * （structure / content / mermaid / traceability / frontmatter）；
 * `OVERALL FAIL 不许交付` → 只报告 + 退出码（zread-pi 的产物已落盘，
 * 闸门是「事后体检」而非交付前置）。
 *
 * 落点约定：本模块**只读**（读 wiki.json / 页面文件 / 缓存清单），不写任何产物。
 * 唯一的写动作（`verify.json`）由调用方（CLI / generate-wiki 集成）按需执行。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fileExists,
  joinPath,
  loadCachedManifest,
  loadCachedSymbols,
  loadWikiBlueprint,
  resolveWikiVariant,
} from '@zread-pi/utils';
import type { BlueprintDetailLevel, WikiOutput, WikiPage } from '@zread-pi/types';
import { getDetailSpec } from '../agents/blueprint-detail.js';
import { evaluateContentGate, proseFloor } from './content-gate.js';
import { validateMermaidContent } from '../tools/page-tools.js';
import {
  checkAssociatedFiles,
  checkTraceability,
  collectManifestPaths,
} from './traceability.js';

// parseSourceRefs 曾在本模块定义；迁到 traceability.ts 后保持旧导入路径可用（测试与外部调用点）
export { parseSourceRefs } from './traceability.js';

// ==================== 类型 ====================

export type VerifyStatus = 'PASS' | 'FAIL' | 'SKIP';

/** 检查组（对齐 verify_notes.py 的分组结构；组名同时是机器可解析的 key） */
export type VerifyGroup = 'structure' | 'content' | 'mermaid' | 'traceability' | 'frontmatter';

export interface VerifyCheck {
  status: VerifyStatus;
  group: VerifyGroup;
  /** 一行可读结论（脚本解析行格式为 `<STATUS> <group> <message>`） */
  message: string;
  /** 诊断明细（失败时列出具体页面 / 路径 / 行号；不参与 PASS/FAIL 判定） */
  details?: string[];
}

export interface VerifyReport {
  /** 目标仓库根目录 */
  root: string;
  /** 解析到的变体（档位子目录名）；遗留目录产物为 null */
  variant: BlueprintDetailLevel | null;
  /** 是否为无档位的遗留目录产物 */
  legacy: boolean;
  /** 逐条检查结果（按执行顺序） */
  checks: VerifyCheck[];
  /** OVERALL（任一 FAIL 即 false；SKIP 不影响） */
  ok: boolean;
}

export interface VerifyWikiOptions {
  /** 目标仓库根目录（缺省 = process.cwd()） */
  root?: string;
  /** 显式档位（缺省 = resolveWikiVariant 自动解析） */
  detail?: BlueprintDetailLevel | null;
  /**
   * content 组是否计 FAIL：true 时内容门未达标的页面让 OVERALL FAIL；
   * false（缺省）时只把未达标页面列进 details（只列出，不判失败）。
   */
  enforce?: boolean;
}

// ==================== 报告收集器（对齐 verify_notes.py::Report） ====================

class Report {
  ok = true;
  readonly checks: VerifyCheck[] = [];

  emit(status: VerifyStatus, group: VerifyGroup, message: string, details?: string[]): void {
    if (status === 'FAIL') this.ok = false;
    this.checks.push({ status, group, message, details });
  }
}

// ==================== 变体解析（含遗留目录） ====================

/**
 * 解析要校验的 wiki.json 与页面根目录。
 *
 * 1. `resolveWikiVariant(detail)` 命中档位子目录 → 用它；
 * 2. 返回 undefined 时显式 fallback 读遗留目录 `.zread-pi/wiki/wiki.json`
 *    （以显式 path 调 `loadWikiBlueprint`，绕开 variant 必填约束）；
 * 3. 都不存在 → 返回 null（整体 SKIP，不报 FAIL：无产物可验）。
 */
async function resolveTarget(
  root: string,
  preferred: BlueprintDetailLevel | null | undefined,
): Promise<{ blueprint: WikiOutput; variant: BlueprintDetailLevel | null; legacy: boolean } | null> {
  const wikiRoot = join(root, '.zread-pi', 'wiki');

  const variant = resolveWikiVariant(preferred ?? undefined, wikiRoot);
  if (variant) {
    // 显式以 root 构造路径（getWikiJsonPath 走 process.cwd()，不能用于任意 root）
    const blueprint = await loadWikiBlueprint(join(wikiRoot, variant, 'wiki.json'), variant);
    return { blueprint, variant, legacy: false };
  }

  const legacyPath = join(wikiRoot, 'wiki.json');
  if (existsSync(legacyPath)) {
    // 遗留目录无档位概念；path 优先于 variant，传任一合法档位即可
    const blueprint = await loadWikiBlueprint(legacyPath, 'high');
    return { blueprint, variant: null, legacy: true };
  }

  return null;
}

/** 页面正文文件路径（变体 / 遗留目录两套布局） */
function pageFilePath(root: string, page: WikiPage, legacy: boolean, variant: BlueprintDetailLevel | null): string {
  const wikiBase = legacy
    ? join(root, '.zread-pi', 'wiki')
    : join(root, '.zread-pi', 'wiki', variant as BlueprintDetailLevel);
  return joinPath(wikiBase, page.section, page.file);
}

// ==================== 主入口 ====================

export async function verifyWiki(options: VerifyWikiOptions = {}): Promise<VerifyReport> {
  const root = options.root ?? process.cwd();
  const report = new Report();

  // ---- 变体解析 ----
  const target = await resolveTarget(root, options.detail ?? null);
  if (!target) {
    report.emit('SKIP', 'structure', '无 wiki 产物可验（.zread-pi/wiki 下没有 wiki.json）');
    return { root, variant: null, legacy: false, checks: report.checks, ok: true };
  }
  const { blueprint, variant, legacy } = target;
  const spec = getDetailSpec(variant ?? blueprint.detail ?? 'high');

  // ==================== structure ====================
  // wiki.json 可加载（loadWikiBlueprint 已保证 pages 为数组或抛错），pages 非空
  const pages = blueprint.pages;
  if (pages.length === 0) {
    report.emit('FAIL', 'structure', 'wiki.json 的 pages 为空（骨架阶段未完成，无页面可验）');
  } else {
    report.emit('PASS', 'structure', `wiki.json 可加载：${pages.length} 页 / ${blueprint.sections?.length ?? 0} 分类`);
  }

  // 每页 file 真实存在 + (section, file) 不漂移（无重复）
  const seenPaths = new Set<string>();
  const missingFiles: string[] = [];
  const duplicates: string[] = [];
  for (const page of pages) {
    const filePath = pageFilePath(root, page, legacy, variant);
    const key = `${page.section}/${page.file}`;
    if (seenPaths.has(key)) duplicates.push(key);
    seenPaths.add(key);
    if (!(await fileExists(filePath))) missingFiles.push(key);
  }
  report.emit(
    missingFiles.length === 0 ? 'PASS' : 'FAIL',
    'structure',
    missingFiles.length === 0
      ? `${pages.length} 个页面文件全部存在`
      : `${missingFiles.length} 个页面文件缺失`,
    missingFiles.length === 0 ? undefined : missingFiles.slice(0, 12),
  );
  if (duplicates.length > 0) {
    report.emit('FAIL', 'structure', `${duplicates.length} 个 (section, file) 重复（slug/file 漂移）`, duplicates.slice(0, 12));
  }

  // sections 与 pages 的 section 集合一致（双向）
  if (blueprint.sections && blueprint.sections.length > 0 && pages.length > 0) {
    const declared = new Set(blueprint.sections.map((section) => section.title));
    const used = new Set(pages.map((page) => page.section));
    const undeclared = [...used].filter((section) => !declared.has(section));
    const empty = [...declared].filter((section) => !used.has(section));
    if (undeclared.length > 0 || empty.length > 0) {
      report.emit(
        'FAIL',
        'structure',
        'sections 与 pages 的分类集合不一致',
        [
          ...(undeclared.length > 0 ? [`页面引用了未声明的分类：${undeclared.join('、')}`] : []),
          ...(empty.length > 0 ? [`声明的分类没有页面：${empty.join('、')}`] : []),
        ],
      );
    } else {
      report.emit('PASS', 'structure', 'sections 与 pages 的分类集合一致');
    }
  }

  // 没有页面可验时，后续逐页检查组整体 SKIP（不报 FAIL）
  if (pages.length === 0) {
    for (const group of ['content', 'mermaid', 'traceability', 'frontmatter'] as VerifyGroup[]) {
      report.emit('SKIP', group, '无页面（pages 为空）');
    }
    return { root, variant, legacy, checks: report.checks, ok: report.ok };
  }

  // 预读全部页面正文（后续检查组共用，避免重复 I/O）
  const contents = new Map<string, string>();
  for (const page of pages) {
    const filePath = pageFilePath(root, page, legacy, variant);
    contents.set(page.slug, await readFileText(filePath));
  }

  // ==================== content（§3.1 内容密度门） ====================
  const gateFailures: Array<{ slug: string; proseChars: number; floor: number }> = [];
  for (const page of pages) {
    const content = contents.get(page.slug) ?? '';
    const gate = evaluateContentGate(content, page, spec, options.enforce ? 'enforce' : 'warn');
    if (!gate.passed) {
      gateFailures.push({
        slug: page.slug,
        proseChars: gate.metrics.proseChars,
        floor: proseFloorOf(page),
      });
    }
  }
  if (gateFailures.length === 0) {
    report.emit('PASS', 'content', `${pages.length} 页全部通过内容密度门`);
  } else {
    const summary = `${gateFailures.length}/${pages.length} 页未通过内容密度门`;
    if (options.enforce) {
      report.emit(
        'FAIL',
        'content',
        `${summary}（--enforce：计为整体失败）`,
        gateFailures.map((entry) => `${entry.slug}：散文 ${entry.proseChars} / 下限 ${entry.floor}`),
      );
    } else {
      // 非 enforce：只列出，不影响 OVERALL
      report.emit(
        'PASS',
        'content',
        `${summary}（未传 --enforce，仅列出）`,
        gateFailures.map((entry) => `${entry.slug}：散文 ${entry.proseChars} / 下限 ${entry.floor}`),
      );
    }
  }

  // ==================== mermaid（复用 write_page 的同一套校验） ====================
  const mermaidIssues: string[] = [];
  for (const page of pages) {
    const issues = validateMermaidContent(contents.get(page.slug) ?? '');
    for (const issue of issues) {
      mermaidIssues.push(`${page.slug}：block ${issue.block} line ${issue.line} 节点 ${issue.nodeId}`);
    }
  }
  report.emit(
    mermaidIssues.length === 0 ? 'PASS' : 'FAIL',
    'mermaid',
    mermaidIssues.length === 0
      ? '全部 Mermaid 图表合法（节点标签引号校验）'
      : `${mermaidIssues.length} 处 Mermaid 节点标签未加引号`,
    mermaidIssues.length === 0 ? undefined : mermaidIssues.slice(0, 12),
  );

  // ==================== frontmatter ====================
  const frontmatterIssues: string[] = [];
  for (const page of pages) {
    const content = contents.get(page.slug) ?? '';
    const fm = extractFrontmatter(content);
    if (!fm) {
      frontmatterIssues.push(`${page.slug}：缺少 frontmatter 块`);
      continue;
    }
    if (fm.title !== page.title) {
      frontmatterIssues.push(`${page.slug}：title "${fm.title}" 与 wiki.json "${page.title}" 不一致`);
    }
    if (fm.slug !== page.slug) {
      frontmatterIssues.push(`${page.slug}：slug "${fm.slug}" 与 wiki.json 不一致`);
    }
  }
  report.emit(
    frontmatterIssues.length === 0 ? 'PASS' : 'FAIL',
    'frontmatter',
    frontmatterIssues.length === 0
      ? '每页 frontmatter 含 title / slug 且与 wiki.json 一致'
      : `${frontmatterIssues.length} 处 frontmatter 问题`,
    frontmatterIssues.length === 0 ? undefined : frontmatterIssues.slice(0, 12),
  );

  // ==================== traceability（溯源台账，对齐 §3.3 的页面维度） ====================
  const [manifest, symbols] = await Promise.all([
    loadCachedManifest(),
    loadCachedSymbols(),
  ]);
  const manifestPaths = collectManifestPaths(manifest);

  // 蓝图声明：每页 associatedFiles 真实存在（复活旧版 validate_blueprint，页面维度）
  const associatedIssues = checkAssociatedFiles(pages, root, manifestPaths);
  report.emit(
    associatedIssues.length === 0 ? 'PASS' : 'FAIL',
    'structure',
    associatedIssues.length === 0
      ? `${pages.length} 页 associatedFiles 全部存在`
      : `${associatedIssues.length} 页 associatedFiles 指向不存在的文件或目录`,
    associatedIssues.length === 0
      ? undefined
      : associatedIssues
          .map((i) => `${i.slug}：${i.missing.join(', ')}`)
          .slice(0, 12),
  );

  await verifyTraceability(root, pages, contents, report, manifest, symbols);

  return { root, variant, legacy, checks: report.checks, ok: report.ok };
}

// ==================== 辅助 ====================

async function readFileText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

/** 提取首个 `--- ... ---` 块并解析 title / slug（不做完整 YAML 解析，够校验用） */
function extractFrontmatter(content: string): { title?: string; slug?: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return null;
  const body = match[1];
  const titleMatch = /^title:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m.exec(body);
  const slugMatch = /^slug:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m.exec(body);
  return {
    title: titleMatch?.[1] ?? titleMatch?.[2] ?? titleMatch?.[3]?.trim(),
    slug: slugMatch?.[1] ?? slugMatch?.[2] ?? slugMatch?.[3]?.trim(),
  };
}

/** 内容门散文下限（与 content-gate 的 proseFloor 同口径，用于报告里的「当前 N / 下限 M」） */
function proseFloorOf(page: WikiPage): number {
  return proseFloor(page);
}

/** 溯源校验：路径真实 / 行号有效 / 跨页重复声明 / 符号可溯（委托 traceability.ts） */
async function verifyTraceability(
  root: string,
  pages: WikiPage[],
  contents: Map<string, string>,
  report: Report,
  manifest: Parameters<typeof checkTraceability>[0]['manifest'],
  symbols: Parameters<typeof checkTraceability>[0]['symbols'],
): Promise<void> {
  const result = await checkTraceability({ root, pages, contents, manifest, symbols });

  // 符号可溯（WARN）：与 Sources 正交，始终执行。符号缓存缺失时跳过
  // （脚本决定源里有什么——没有台账就无据可判）
  if (result.symbolsUnavailable) {
    report.emit('SKIP', 'traceability', '符号缓存缺失（未扫描源码），跳过符号溯源校验');
  } else if (result.unresolvedSymbols.length === 0) {
    report.emit('PASS', 'traceability', '正文引用的标识符在符号缓存里全部存在');
  } else {
    report.emit(
      'PASS',
      'traceability',
      `${result.unresolvedSymbols.length} 个行内代码标识符未在符号缓存中找到（WARN，供人工确认）`,
      result.unresolvedSymbols.slice(0, 12),
    );
  }

  // 无 Sources 行是硬失败；路径 / 行号 / 重复声明检查在无引用时无意义，跳过
  if (result.noSources) {
    report.emit('FAIL', 'traceability', '没有任何 Sources 溯源引用（页面 prompt 已强约束，机械校验兜底）');
    return;
  }

  report.emit(
    result.badPaths.length === 0 ? 'PASS' : 'FAIL',
    'traceability',
    result.badPaths.length === 0
      ? `${result.refs.length} 个溯源路径全部真实存在`
      : `${result.badPaths.length} 个溯源路径不存在`,
    result.badPaths.length === 0 ? undefined : result.badPaths.slice(0, 12),
  );
  report.emit(
    result.badLines.length === 0 ? 'PASS' : 'FAIL',
    'traceability',
    result.badLines.length === 0
      ? '全部行号区间落在文件长度内'
      : `${result.badLines.length} 个行号区间越界`,
    result.badLines.length === 0 ? undefined : result.badLines.slice(0, 12),
  );

  // 跨页重复声明（WARN 语义：重复声明未必错——同一核心事实被两篇引用，列出供人工裁决）
  report.emit(
    'PASS',
    'traceability',
    result.duplicateClaims.length === 0
      ? '无跨页重复声明'
      : `${result.duplicateClaims.length} 组跨页重复声明（WARN，供人工裁决）`,
    result.duplicateClaims.length === 0 ? undefined : result.duplicateClaims.slice(0, 12),
  );
}
