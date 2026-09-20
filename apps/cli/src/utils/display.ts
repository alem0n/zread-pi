/**
 * 终端显示相关工具函数
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 打包时通过 tsup define 注入的全局常量
// （开发/测试模式没有注入，见下方 getVersion 的运行时回退）
declare global {
  var CLI_VERSION: string | undefined;
}

/** 仓库根 package.json 的 name（AGENTS.md §5：根 package.json 是唯一版本来源） */
const ROOT_PACKAGE_NAME = 'zread-pi';
/** 既没注入、也找不到 package.json 时的兜底版本 */
const FALLBACK_VERSION = '0.0.0-dev';

let cachedVersion: string | null = null;

/** 读取目录下的 package.json（不存在或解析失败返回 null） */
function readPackageJson(dir: string): { name?: string; version?: string } | null {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

/**
 * 从当前模块位置向上查找版本号：优先根 package.json（zread-pi），
 * 找不到时退回最近的 package.json，保证开发模式界面版本与项目版本同步。
 */
function resolveVersionFromDisk(): string | null {
  let nearest: string | null = null;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = readPackageJson(dir);
    if (pkg?.version) {
      if (pkg.name === ROOT_PACKAGE_NAME) {
        return pkg.version;
      }
      nearest ??= pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return nearest;
    }
    dir = parent;
  }
}

/**
 * 获取 CLI 版本号
 *
 * 打包产物走 tsup 注入的 CLI_VERSION；开发/测试直接跑源码时回退到
 * 读取根 package.json，避免界面一直显示 0.0.0-dev。
 */
export function getVersion(): string {
  if (globalThis.CLI_VERSION) {
    return globalThis.CLI_VERSION;
  }
  cachedVersion ??= resolveVersionFromDisk() ?? FALLBACK_VERSION;
  return cachedVersion;
}

/**
 * 计算字符串的终端显示宽度
 * 中文字符占2格，ASCII字符占1格
 */
export function getDisplayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    if (/[一-鿿]/.test(char)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * 按显示宽度截断字符串
 */
export function truncateByDisplayWidth(str: string, maxWidth: number): string {
  let result = '';
  let width = 0;
  for (const char of str) {
    const charWidth = /[一-鿿]/.test(char) ? 2 : 1;
    if (width + charWidth > maxWidth) {
      break;
    }
    result += char;
    width += charWidth;
  }
  return result;
}

/**
 * 格式化 token / 字节数字
 * 9900 -> 9.9k；200000 -> 200.0k；1500000 -> 1.5M
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)}M`;
  }
  if (bytes >= 1000) {
    return `${(bytes / 1000).toFixed(1)}k`;
  }
  return String(bytes);
}

/**
 * 格式化耗时
 * 1234 -> 1.2s
 * 56789 -> 56.8s
 */
export function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${ms}ms`;
}