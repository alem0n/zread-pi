/**
 * WikiStore - wiki.json 状态（替代原 WikiProvider）
 *
 * 仅负责加载/重载 wiki.json，不包含业务逻辑。
 */

import type { WikiOutput } from "@zread-pi/types";
import { fileExists, getWikiJsonPath, readJsonFile } from "@zread-pi/utils";

export class WikiStore {
  catalog: WikiOutput | null = null;

  /** 重新加载 wiki.json（文件不存在时置空） */
  async reload(): Promise<void> {
    const wikiPath = getWikiJsonPath();
    try {
      const exists = await fileExists(wikiPath);
      if (exists) {
        this.catalog = await readJsonFile<WikiOutput>(wikiPath);
      } else {
        this.catalog = null;
      }
    } catch {
      this.catalog = null;
    }
  }

  /** 首次进入 wiki 区域时加载（等价原 WikiProvider 的挂载副作用） */
  async load(): Promise<void> {
    if (this.catalog !== null) return;
    await this.reload();
  }
}
