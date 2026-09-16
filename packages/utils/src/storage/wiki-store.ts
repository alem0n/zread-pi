import type { BlueprintDetailLevel, WikiPage } from '@zread-pi/types';
import { getWikiDir, joinPath, ensureDir, writeTextFile, readTextFile } from '../file-io.js';
import { dirname, join } from 'path';
import { createVersionSnapshot, generateSnapshotName } from './versioning';
import { existsSync, mkdirSync, renameSync } from 'fs';

/**
 * 变体感知的页面存储（sync 归档用）。
 *
 * - `detail` 指定变体子目录；
 * - 页面源目录 = `wiki/<detail>/<section>/<file>`（与生成/落盘契约一致）；
 * - 归档目录 = `wiki/<detail>/archived/<快照名>/<section>/<file>`（变体自包含）。
 *
 * 注：`createSnapshot()` 仍沿用历史 `versions/` 布局（依赖 `current/`，产物不匹配时返回 ''），
 * 本次只把归档路径对齐到变体目录，不在本特性内重做版本快照。
 */
export class WikiStore {
  private currentDir: string;
  private archivedDir: string;

  constructor(detail: BlueprintDetailLevel) {
    this.currentDir = getWikiDir(detail);
    this.archivedDir = join(this.currentDir, 'archived');
  }

  async writePage(page: WikiPage, content: string): Promise<string> {
    const filePath = join(this.currentDir, page.file);
    await ensureDir(dirname(filePath));
    await writeTextFile(filePath, content);
    return filePath;
  }

  async readPage(page: WikiPage): Promise<string | null> {
    const filePath = join(this.currentDir, page.file);
    try {
      return await readTextFile(filePath);
    } catch {
      return null;
    }
  }

  async createSnapshot(): Promise<string> {
    return createVersionSnapshot();
  }

  /**
   * Archive a wiki page — move its .md file into `archived/<snapshot>/<section>/`.
   * 文件不在契约位置（或不存在）时返回 null，不报错。
   */
  async archivePage(page: WikiPage): Promise<string | null> {
    const sourcePath = join(this.currentDir, page.section, page.file);
    if (!existsSync(sourcePath)) return null;

    const snapshotName = generateSnapshotName();
    const targetDir = join(this.archivedDir, snapshotName, page.section);
    mkdirSync(targetDir, { recursive: true });

    const fileName = page.file.split('/').pop() ?? page.file;
    const targetPath = join(targetDir, fileName);
    renameSync(sourcePath, targetPath);
    return targetPath;
  }
}
