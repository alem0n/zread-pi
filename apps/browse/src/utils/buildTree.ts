// apps/browse/src/utils/buildTree.ts
import type { WikiPage, WikiOutput, TreeNode } from '@/types/wiki';

/** section 标题归一化键（与编排层 blueprint-stages 的 sectionKeyOf 同口径） */
function sectionKeyOf(value: string): string {
  return value.trim().toLowerCase();
}

/** 页面的全局序号：slug 的数字前缀（主题阶段分配，如 `3-core-features` → 3）。
 *  无前缀返回 Infinity，配合稳定排序保持原序（旧数据兼容）。 */
function pageIndex(slug: string): number {
  const match = /^(\d+)-/.exec(slug);
  return match ? Number.parseInt(match[1], 10) : Number.POSITIVE_INFINITY;
}

/**
 * 按蓝图的权威阅读顺序整理页面（平铺）。
 *
 * 为什么必须排：主题阶段按 section **并发**执行，每个 section 完成时把它的
 * pages 追加进 wiki.json，所以 `pages` 数组的顺序是**并发完成顺序**，不是
 * 蓝图顺序。权威顺序在 `sections` 数组里（分类阶段的产出顺序）。
 *
 * - section 按 `sections` 数组的顺序排；不在清单里的 section 排到最后
 *   （保持首现顺序，稳定排序）；
 * - section 内按 slug 的数字前缀排（主题阶段的全局序号）。
 *
 * 消费方：`buildTree`（侧边目录树）与首页落点（第一篇）。
 */
export function orderedPages(wiki: WikiOutput): WikiPage[] {
  const sectionOrder = new Map(
    (wiki.sections ?? []).map((section, index) => [sectionKeyOf(section.title), index]),
  );

  return [...wiki.pages].sort((a, b) => {
    const ai = sectionOrder.get(sectionKeyOf(a.section)) ?? Number.MAX_SAFE_INTEGER;
    const bi = sectionOrder.get(sectionKeyOf(b.section)) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return pageIndex(a.slug) - pageIndex(b.slug);
  });
}

/**
 * 侧边目录树：**只留「类型（section）→ 文章（page）」两级**。
 *
 * `page.group` 只作落盘的分组信息，不进目录树（层级过深反而不利于快速定位）。
 * 顺序由 `orderedPages` 决定；`sections` 缺失时退到全局序号（旧 wiki.json
 * 里页面序号是唯一的顺序信号）。
 */
export function buildTree(wiki: WikiOutput): TreeNode[] {
  const sections = new Map<string, TreeNode>();

  for (const page of orderedPages(wiki)) {
    const sectionKey = sectionKeyOf(page.section);

    if (!sections.has(sectionKey)) {
      sections.set(sectionKey, {
        type: 'section',
        id: `section-${sectionKey}`,
        title: page.section,
        children: [],
      });
    }

    const section = sections.get(sectionKey);
    if (!section || !section.children) continue;

    section.children.push({
      type: 'page',
      id: `page-${page.slug}`,
      title: page.title,
      pageData: page,
    });
  }

  return Array.from(sections.values());
}
