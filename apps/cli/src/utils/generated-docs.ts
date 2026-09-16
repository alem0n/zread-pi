/**
 * 「文档是否已生成」判据（单一来源）。
 *
 * 页面落盘路径规则：`<wikiDir>/<section>/<file>`（与 wiki.json 契约一致）。
 * `detail` 指定档位变体（`wiki/<detail>/`）。
 * Wiki 首页的进度展示与「老旧项目自动登记」（`app.ts` 的 adoptExistingProject）
 * 共用本模块，确保两处对「已经生成了文档」的理解永远一致。
 */

import { fileExists, getWikiDir, joinPath } from "@zread-pi/utils";
import type { BlueprintDetailLevel, WikiPage } from "@zread-pi/types";

export interface GeneratedDocsProgress {
  /** wiki.json 里登记的页面总数 */
  total: number;
  /** 已经落盘的页面数 */
  generated: number;
}

/** 统计页面里已经落盘的数量（`generated === total && total > 0` 即「文档已生成」） */
export async function countGeneratedPages(
  pages: WikiPage[],
  detail: BlueprintDetailLevel,
): Promise<GeneratedDocsProgress> {
  const wikiDir = getWikiDir(detail);
  const results = await Promise.all(
    pages.map((page) => fileExists(joinPath(wikiDir, page.section, page.file))),
  );
  return { total: pages.length, generated: results.filter(Boolean).length };
}
