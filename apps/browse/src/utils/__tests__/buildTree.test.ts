/**
 * buildTree 单测：侧边目录树的层级与顺序契约。
 *
 * 修这两个问题：
 * 1. 顺序：主题阶段按 section **并发**执行，wiki.json 的 pages 数组顺序是
 *    并发完成顺序，不是蓝图顺序；权威的阅读顺序在 `sections` 数组里。
 *    树必须按 sections 排，section 内按 slug 的数字前缀排。
 * 2. 层级：左侧列表只留「类型（section）→ 文章（page）」两级，不再建 group
 *    中间层（page.group 只作落盘分组信息，不进目录树）。
 */

import { describe, it, expect } from 'bun:test';
import { buildTree, orderedPages } from '../buildTree';
import type { WikiOutput, WikiPage, TreeNode } from '@/types/wiki';

function makePage(slug: string, title: string, section: string, group?: string): WikiPage {
  return { slug, title, section, group, file: `${slug}.md`, level: 'Intermediate' };
}

function makeWiki(pages: WikiPage[], sections: WikiOutput['sections']): WikiOutput {
  return {
    id: 'test',
    generated_at: '2026-01-01T00:00:00Z',
    language: 'zh',
    detail: 'high',
    pages,
    sections,
  };
}

/** 收集树的「section 标题 → 子页面标题」二维清单（断言用） */
function treeOutline(nodes: TreeNode[]): Array<[string, string[]]> {
  return nodes.map((node) => [
    node.title,
    (node.children ?? []).map((child) => child.title),
  ]);
}

describe('buildTree 顺序', () => {
  it('section 按 wiki.json 的 sections 数组排，不按 pages 首现顺序', () => {
    // pages 数组里「快速开始」的页先出现（模拟并发先完成），但蓝图顺序是 概览 → 快速开始
    const wiki = makeWiki(
      [
        makePage('11-env', '环境', '快速开始'),
        makePage('12-first', '首次配置', '快速开始'),
        makePage('1-positioning', '项目定位', '概览'),
        makePage('2-pipeline', '生成流水线', '概览'),
      ],
      [{ title: '概览' }, { title: '快速开始' }],
    );

    const outline = treeOutline(buildTree(wiki));

    expect(outline.map(([section]) => section)).toEqual(['概览', '快速开始']);
    expect(outline).toEqual([
      ['概览', ['项目定位', '生成流水线']],
      ['快速开始', ['环境', '首次配置']],
    ]);
  });

  it('section 内按 slug 的数字前缀排（主题阶段的全局序号）', () => {
    const wiki = makeWiki(
      [
        makePage('3-core', '核心特性', '概览'),
        makePage('1-positioning', '项目定位', '概览'),
        makePage('2-pipeline', '生成流水线', '概览'),
      ],
      [{ title: '概览' }],
    );

    expect(treeOutline(buildTree(wiki))).toEqual([
      ['概览', ['项目定位', '生成流水线', '核心特性']],
    ]);
  });

  it('无数字前缀的 slug 保持原序（稳定排序，旧数据兼容）', () => {
    const wiki = makeWiki(
      [makePage('beta', '乙', '概览'), makePage('alpha', '甲', '概览')],
      [{ title: '概览' }],
    );

    expect(treeOutline(buildTree(wiki))).toEqual([['概览', ['乙', '甲']]]);
  });

  it('sections 缺失时按全局序号排（旧 wiki.json 兼容：序号是唯一信号）', () => {
    const wiki = makeWiki(
      [makePage('2-b', '乙', '快速开始'), makePage('1-a', '甲', '概览')],
      undefined,
    );

    expect(treeOutline(buildTree(wiki)).map(([section]) => section)).toEqual([
      '概览',
      '快速开始',
    ]);
  });

  it('不在 sections 清单里的 section 排到最后，内部仍按序号', () => {
    const wiki = makeWiki(
      [
        makePage('20-other', '其它', '未登记分类'),
        makePage('1-a', '甲', '概览'),
        makePage('19-late', '迟到', '未登记分类'),
      ],
      [{ title: '概览' }],
    );

    const outline = treeOutline(buildTree(wiki));
    expect(outline.map(([section]) => section)).toEqual(['概览', '未登记分类']);
    // 19-late（迟到）排在 20-other（其它）之前
    expect(outline[1][1]).toEqual(['迟到', '其它']);
  });
});

describe('buildTree 层级（只留 section → page 两级）', () => {
  it('page 带 group 也不建中间层节点', () => {
    const wiki = makeWiki(
      [
        makePage('1-a', '甲', '概览', '项目全景'),
        makePage('2-b', '乙', '概览', '功能地图'),
      ],
      [{ title: '概览' }],
    );

    const tree = buildTree(wiki);
    // 树里只有 section 与 page 两种节点
    const kinds = new Set<string>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        kinds.add(node.type);
        if (node.children) walk(node.children);
      }
    };
    walk(tree);
    expect(kinds).toEqual(new Set(['section', 'page']));

    // group 不作为节点标题出现
    expect(tree[0].children?.map((child) => child.title)).toEqual(['甲', '乙']);
  });
});

describe('orderedPages 平铺序（首页落点与导出用）', () => {
  it('平铺顺序与树的前序遍历一致（首页落到蓝图第一篇）', () => {
    const wiki = makeWiki(
      [
        makePage('11-env', '环境', '快速开始'),
        makePage('1-positioning', '项目定位', '概览'),
        makePage('2-pipeline', '生成流水线', '概览'),
        makePage('12-first', '首次配置', '快速开始'),
      ],
      [{ title: '概览' }, { title: '快速开始' }],
    );

    const flat = orderedPages(wiki);
    expect(flat.map((page) => page.slug)).toEqual([
      '1-positioning',
      '2-pipeline',
      '11-env',
      '12-first',
    ]);

    // 树的前序遍历应与平铺序逐项相同
    const preorder: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'page' && node.pageData) preorder.push(node.pageData.slug);
        if (node.children) walk(node.children);
      }
    };
    walk(buildTree(wiki));
    expect(preorder).toEqual(flat.map((page) => page.slug));
  });
});
