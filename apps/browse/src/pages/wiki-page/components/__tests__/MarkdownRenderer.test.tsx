/**
 * MarkdownRenderer 组件级测试：Markdown 渲染管线回归。
 *
 * 覆盖升级 react-markdown / react-syntax-highlighter / react-intersection-observer
 * 时最怕破的渲染契约：
 * 1. frontmatter 被剥离、标题层级渲染并提取（react-markdown components API +
 *    rehype-slug 锚点 + useInView 挂载）；
 * 2. ```mermaid 围栏路由到 MermaidDiagram（.mermaid-diagram），而不是当普通代码块；
 * 3. 普通代码块走语法高亮（react-syntax-highlighter 的 Prism + 语言标签）；
 * 4. GFM 表格渲染（remark-gfm 插件链）。
 */

import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { TocProvider } from '@/context/TocProvider';

const CONTENT = [
  '---',
  'title: 测试页',
  'slug: test-page',
  '---',
  '',
  '# 测试页面标题',
  '',
  '## 架构设计',
  '',
  '正文段落，讲模块职责与分层。',
  '',
  '```mermaid',
  'flowchart TB',
  '  A["入口层"] --> B["核心模块"]',
  '```',
  '',
  '```ts',
  'const answer: number = 42;',
  '```',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n');

function renderMarkdown(content = CONTENT) {
  const headings: { id: string; text: string; level: number }[] = [];
  const references: unknown[] = [];
  render(
    <TocProvider>
      <MarkdownRenderer
        content={content}
        onReferencesFound={(refs) => references.push(refs)}
        onHeadingsExtracted={(hs) => headings.push(...hs)}
      />
    </TocProvider>,
  );
  return { headings, references };
}

describe('MarkdownRenderer', () => {
  it('剥离 frontmatter 并渲染标题层级', () => {
    renderMarkdown();

    expect(screen.getByText('测试页面标题')).toBeInTheDocument();
    expect(screen.getByText('架构设计')).toBeInTheDocument();
    // frontmatter 被剥离：页面里不应出现元数据文本
    expect(screen.queryByText(/title:\s*测试页/)).toBeNull();
  });

  it('提取二级标题供目录使用', () => {
    const { headings } = renderMarkdown();

    expect(headings).toContainEqual({
      id: '架构设计',
      text: '架构设计',
      level: 2,
    });
  });

  it('把 mermaid 围栏路由到 MermaidDiagram（而非普通代码块）', () => {
    renderMarkdown();

    const diagram = document.querySelector('.mermaid-diagram');
    expect(diagram, 'mermaid 围栏应渲染为 .mermaid-diagram 容器').not.toBeNull();
  });

  it('普通代码块走语法高亮并带语言标签', () => {
    renderMarkdown();

    // CodeBlock 的语言标签 span（CSS uppercase 只改视觉，DOM 文本仍是小写）
    expect(screen.getByText('ts')).toBeInTheDocument();
    // SyntaxHighlighter 把代码切成 token span，用 code 元素的 textContent 校验
    const codeEl = document.querySelector('code');
    expect(codeEl, '应渲染出 <code> 元素').not.toBeNull();
    expect(codeEl!.textContent).toContain('const answer: number = 42;');
  });

  it('渲染 GFM 表格（remark-gfm 插件链）', () => {
    renderMarkdown();

    const th = screen.getByRole('columnheader', { name: '列 A' });
    expect(th).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2' })).toBeInTheDocument();
  });
});
