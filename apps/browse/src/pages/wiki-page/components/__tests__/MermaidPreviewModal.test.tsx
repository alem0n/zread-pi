/**
 * MermaidPreviewModal 组件级测试：弹窗的 mermaid 渲染契约回归。
 *
 * 回归点（升级 mermaid 大版本时最怕破的三件事）：
 * 1. 打开时真的把 flowchart 文本渲染成 <svg>（mermaid.render 契约，
 *    依赖 happy-dom 提供 getBBox / ResizeObserver）；
 * 2. 关闭时不渲染任何内容（Portal 随 open 收起）；
 * 3. 工具条显示缩放百分比、提供关闭按钮。
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import mermaid from 'mermaid';
import { MermaidPreviewModal } from '../MermaidPreviewModal';

const FLOWCHART = [
  'flowchart TB',
  '  A["入口层"] --> B["核心模块"]',
  '  B --> C["数据 / 存储"]',
  '  C --> D["外部依赖"]',
].join('\n');

// 弹窗本身不调 mermaid.initialize——生产环境里它只在 MarkdownRenderer 挂载后
// 才可能被打开，那时全局已初始化。测试忠实复现这个前置条件，否则 happy-dom
// 下未初始化的首帧 render 会静默返回空 svg。
// 参数与 MarkdownRenderer 保持一致：mermaid v12 起 ELK 成为默认布局，但
// ELK（elkjs，GWT 产物）在 happy-dom 里取不到 $wnd 会直接崩，生产与测试都
// 显式锁 dagre。
beforeAll(() => {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    layout: 'dagre',
  });
});

describe('MermaidPreviewModal', () => {
  it('打开时把 flowchart 渲染成 SVG（mermaid 渲染契约）', async () => {
    render(
      <MermaidPreviewModal open content={FLOWCHART} onOpenChange={() => {}} />,
    );

    await waitFor(() => {
      const diagram = document.querySelector('.mermaid-preview-diagram');
      expect(diagram, '预览容器应随弹窗挂载').not.toBeNull();
      const svg = diagram!.querySelector('svg');
      expect(svg, 'mermaid 应把 flowchart 文本渲染成 SVG').not.toBeNull();
    });
  });

  it('关闭时不渲染任何内容', () => {
    render(
      <MermaidPreviewModal open={false} content={FLOWCHART} onOpenChange={() => {}} />,
    );
    expect(document.querySelector('.mermaid-preview-content')).toBeNull();
  });

  it('工具条显示缩放百分比与关闭按钮', async () => {
    render(
      <MermaidPreviewModal open content={FLOWCHART} onOpenChange={() => {}} />,
    );
    expect(await screen.findByText(/^\d+%$/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '关闭 Mermaid 预览' }),
    ).toBeInTheDocument();
  });
});
