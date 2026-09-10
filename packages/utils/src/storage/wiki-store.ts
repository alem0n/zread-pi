import type { WikiPage } from '@open-zread/types';
import { getProjectRoot, joinPath, ensureDir, writeTextFile, readTextFile } from '../file-io.js';
import { dirname, join } from 'path';
import { createVersionSnapshot, generateSnapshotName } from './versioning';
import { existsSync, mkdirSync, renameSync } from 'fs';

const WIKI_DIR = '.open-zread/wiki';
const CURRENT_DIR = joinPath(WIKI_DIR, 'current');
const ARCHIVED_DIR = joinPath(WIKI_DIR, 'archived');

export class WikiStore {
  private currentDir: string;
  private archivedDir: string;

  constructor() {
    this.currentDir = join(getProjectRoot(), CURRENT_DIR);
    this.archivedDir = join(getProjectRoot(), ARCHIVED_DIR);
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
   * Archive a wiki page — move its .md file from current/ to archived/<snapshot>/
   */
  async archivePage(page: WikiPage): Promise<string | null> {
    const sourcePath = join(this.currentDir, page.file);
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
