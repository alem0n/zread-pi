import { readFile, writeFile, rename, mkdir, rm, stat } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { BlueprintDetailLevel } from '@zread-pi/types';
import { BLUEPRINT_DETAIL_LEVELS } from './blueprint-detail.js';
import { ZREAD_PI_DIR_NAME } from './project-home.js';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf-8');
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, 'utf-8');
}

/**
 * 原子写文本：先写同目录临时文件，再 rename 覆盖目标。
 *
 * rename 在三平台都支持覆盖已存在文件，因此读取方要么看到旧文件、要么看到新文件，
 * 不会读到写了一半的内容（配合 `withFileLock` 保护读-改-写整体）。
 */
export async function writeTextFileAtomic(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, 'utf-8');
  await rename(temp, path);
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await writeTextFile(path, content);
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readTextFile(path);
  return JSON.parse(content) as T;
}

/**
 * 检查文件是否存在
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function joinPath(...parts: string[]): string {
  return join(...parts);
}

export function getProjectRoot(): string {
  return process.cwd();
}

export function getOutputDir(): string {
  return join(getProjectRoot(), ZREAD_PI_DIR_NAME);
}

export function getCacheDir(): string {
  return join(getOutputDir(), 'cache');
}

/**
 * wiki 目录（可选档位 = 变体子目录）。
 *
 * - 传档位：`<项目>/.zread-pi/wiki/<detail>`（新生成一律写这里）；
 * - 不传 / null：`<项目>/.zread-pi/wiki`（遗留布局，只读兼容）。
 */
export function getWikiDir(detail?: BlueprintDetailLevel | null): string {
  const base = join(getOutputDir(), 'wiki');
  return detail ? join(base, detail) : base;
}

/** 某个变体的 wiki.json 路径（不传档位 = 遗留 `wiki/wiki.json`） */
export function getWikiJsonPath(detail?: BlueprintDetailLevel | null): string {
  return join(getWikiDir(detail), 'wiki.json');
}

/**
 * 一个已存在的 wiki 变体（档位子目录或遗留目录）。
 */
export interface WikiVariantInfo {
  /** 档位名；null = 遗留（无档位）目录，UI 显示为「默认」 */
  detail: BlueprintDetailLevel | null;
  /** 是否遗留布局（`wiki/wiki.json`，只读兼容） */
  legacy: boolean;
  /** 生成时间（wiki.json 的 generated_at，缺失时 undefined） */
  generatedAt?: string;
  /** wiki.json 登记的页面数（含未落盘页面；骨架为 0） */
  pagesCount: number;
  /** 分类数（旧 wiki.json 无 sections 时为 undefined） */
  sectionsCount?: number;
}

/** 读取单个变体的元信息；wiki.json 不存在 / 不可解析 / pages 非数组时返回 null */
function readVariantInfo(wikiRoot: string, detail: BlueprintDetailLevel | null): WikiVariantInfo | null {
  const wikiJsonPath = join(detail ? join(wikiRoot, detail) : wikiRoot, 'wiki.json');
  if (!existsSync(wikiJsonPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(wikiJsonPath, 'utf-8')) as {
      generated_at?: unknown;
      pages?: unknown;
      sections?: unknown;
    };
    if (!Array.isArray(parsed?.pages)) return null;
    return {
      detail,
      legacy: detail === null,
      generatedAt: typeof parsed.generated_at === 'string' ? parsed.generated_at : undefined,
      pagesCount: parsed.pages.length,
      sectionsCount: Array.isArray(parsed.sections) ? parsed.sections.length : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 枚举所有已存在的 wiki 变体（档位顺序 + 遗留目录最后）。
 *
 * 只包含「wiki.json 可解析且 pages 为数组」的目录——骨架（pages 为空）也计入
 * （消费方按 `pagesCount > 0` 判定「有文档」）。
 *
 * @param wikiRoot - wiki 根目录（缺省 = 当前项目 `.zread-pi/wiki`；browse 服务器传目标项目路径）
 */
export function listWikiVariants(wikiRoot: string = getWikiDir()): WikiVariantInfo[] {
  const variants: WikiVariantInfo[] = [];
  for (const level of BLUEPRINT_DETAIL_LEVELS) {
    const info = readVariantInfo(wikiRoot, level);
    if (info) variants.push(info);
  }
  const legacy = readVariantInfo(wikiRoot, null);
  if (legacy) variants.push(legacy);
  return variants;
}

/**
 * 解析「当前活动变体」：
 *   1. `preferred`（通常是配置档位）对应的变体存在 → 用它；
 *   2. 遗留变体存在 → `null`（遗留目录）；
 *   3. 否则按档位顺序取第一个存在的变体；
 *   4. 一个都没有 → `undefined`。
 *
 * 用途：CLI 首页 / 同步 / 浏览默认档位的统一口径（生成目标另由 `WikiStore.targetDetail` 决定）。
 */
export function resolveWikiVariant(
  preferred?: BlueprintDetailLevel | null,
  wikiRoot: string = getWikiDir(),
): BlueprintDetailLevel | null | undefined {
  const variants = listWikiVariants(wikiRoot);
  if (preferred && variants.some((variant) => variant.detail === preferred)) return preferred;
  if (variants.some((variant) => variant.legacy)) return null;
  return variants[0]?.detail;
}
