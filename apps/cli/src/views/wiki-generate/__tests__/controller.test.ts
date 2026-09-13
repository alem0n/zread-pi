/**
 * controller.test.ts —— WikiGenerateController 的槽位语义（纯状态，不触发生成）
 *
 * 覆盖：同一页正在生成时忽略重复的「重新生成」触发 —— 两次运行同时写同一槽位会让
 * 用量合计失真（快照是同轮累计值，交错覆盖无法再还原）。
 *
 * 运行：bun test apps/cli/src/views/wiki-generate/__tests__（已并入 bun run test:tui）
 */

import { describe, expect, test } from 'bun:test';
import type { WikiPage } from '@zread-pi/types';
import { WikiGenerateController } from '../controller';
import { createInitialArticlesState } from '../state';
import type { TokenUsage } from '../types';
import type { WikiStore } from '../../../state/wiki-store';

const page: WikiPage = {
  slug: 'a',
  title: 'A',
  file: 'a.md',
  section: 'core',
  level: 'Beginner',
};

/** 最小 WikiStore 替身：控制器只读 `catalog.pages` */
function makeController(): { controller: WikiGenerateController; changes: number[] } {
  const changes: number[] = [];
  const wiki = {
    catalog: { id: 'w', generated_at: '', language: 'zh', pages: [page] },
  } as unknown as WikiStore;

  const controller = new WikiGenerateController({
    forceRegenerate: false,
    wiki,
    onChange: () => changes.push(changes.length),
  });

  return { controller, changes };
}

describe('WikiGenerateController.regeneratePage', () => {
  test('页面生成中时忽略重复触发：状态与用量原样保留', async () => {
    const { controller, changes } = makeController();
    const usage: TokenUsage = { input_tokens: 500, output_tokens: 100 };
    controller.state.articles = {
      ...createInitialArticlesState([page]),
      pages: { a: { status: 'loading', phase: 'responding', usage } },
    };

    await controller.regeneratePage('a');

    // 未被重置为 waiting、未发 onChange（也就不会调用 generateWikiContent）
    expect(controller.state.articles.pages.a.status).toBe('loading');
    expect(controller.state.articles.pages.a.usage).toEqual(usage);
    expect(changes.length).toBe(0);
  });

  test('未知 slug 直接返回（不改变状态）', async () => {
    const { controller, changes } = makeController();
    controller.state.articles = createInitialArticlesState([page]);

    await controller.regeneratePage('missing');

    expect(changes.length).toBe(0);
    expect(controller.state.articles.pages.a.status).toBe('waiting');
  });
});
