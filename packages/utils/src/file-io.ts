import { readFile, writeFile, rename, mkdir, rm, stat } from 'fs/promises';
import { dirname, join } from 'path';
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

export function getWikiDir(): string {
  return join(getOutputDir(), 'wiki');
}

export function getWikiJsonPath(): string {
  return join(getWikiDir(), 'wiki.json');
}
