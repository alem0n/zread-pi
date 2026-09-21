/**
 * MarkdownRenderer 组件级测试：Markdown 渲染管线回归。
 *
 * 覆盖升级 react-markdown / react-syntax-highlighter / react-intersection-observer
 * 时最怕破的渲染契约：
 * 1. frontmatter 被剥离、标题层级渲染并提取（react-markdown components API +
 *    rehype-slug 锚点 + useInView 挂载）；
 * 2. ```mermaid 围栏路由到 MermaidDiagram（.mermaid-diagram），而不是当普通代码块；
 * 3. 普通代码块走语法高亮（react-syntax-highlighter 的 Prism + 语言标签）；
 * 4. GFM 表格渲染（remark-gfm 插件链）；
 * 5. 四类语法图（flowchart / sequence / state）在显式锁定 dagre 布局下都能
 *    真正渲染成 SVG——sequence 有独立布局引擎、state 走 dagre，必须实测确认
 *    layout 锁定不影响这两类（dagre 锁定是为了 mermaid v12 起 ELK 成为默认
 *    布局会改变既有页面观感）；
 * 6. 图题注（**图｜<类型词>｜<标题>**）渲染为带类型徽标的段落。
 */

import { describe, it, expect } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
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

  // ---- 四类语法图在 dagre 锁定下的真实渲染（实测 layout 锁定不误伤 sequence / state） ----
//
// 实测结论（happy-dom + getBBox 桩，见 test/setup.ts）：
//   - sequence 有独立布局引擎，dagre 锁定**不影响**它，参与者 / 消息正常渲染；
//   - state 走 dagre，无边标签 / note 的形态正常渲染；
//   - dagre 的**边标签**几何求解（`-->|标签|` / `A --> B : 标签`）需要精确文本
//     包围盒，happy-dom 提供不了，flowchart 与 state 的边标签都渲染不出来——
//     这是**环境限制，不是 dagre 锁定的问题**；带边标签的图只做路由断言。

  const SEQUENCE_CONTENT = [
    '**图｜序列图｜登录鉴权调用链**：网关 → 鉴权服务 → 用户存储',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  participant Gateway as "网关"',
    '  participant Auth as "鉴权服务"',
    '  Gateway->>Auth: 鉴权请求',
    '  Auth-->>Gateway: 鉴权结果',
    '```',
  ].join('\n');

  const STATE_CONTENT = [
    '**图｜状态图｜连接生命周期**：空闲 → 运行 → 关闭',
    '',
    '```mermaid',
    'stateDiagram-v2',
    '  [*] --> Idle',
    '  Idle --> Running',
    '  Running --> [*]',
    '```',
  ].join('\n');

  // 带边标签的状态图（dagre 边标签几何在 happy-dom 下不可渲染，只做路由断言）
  const STATE_LABELED_CONTENT = [
    '```mermaid',
    'stateDiagram-v2',
    '  [*] --> Idle',
    '  Idle --> Running : 启动',
    '  Running --> [*] : 关闭',
    '```',
  ].join('\n');

  const FLOWCHART_TD_CONTENT = [
    '**图｜流程图｜请求处理管线**：解析 → 执行 → 返回',
    '',
    '```mermaid',
    'flowchart TD',
    '  Start["解析请求"] --> Exec["执行业务"]',
    '  Exec --> Done["返回响应"]',
    '```',
  ].join('\n');

  it('把 sequenceDiagram 渲染成 SVG（dagre 锁定不影响序列图布局引擎）', async () => {
    renderMarkdown(SEQUENCE_CONTENT);

    await waitFor(
      () => {
        const svg = document.querySelector('.mermaid-diagram svg');
        expect(svg, 'sequenceDiagram 应在 dagre 锁定下仍渲染成 SVG').not.toBeNull();
        // 参与者显示名真的画进去了（grounding 可见性）
        expect(svg!.textContent).toContain('网关');
      },
      { timeout: 4000 },
    );
  });

  it('把 stateDiagram-v2 渲染成 SVG（状态图走 dagre 布局）', async () => {
    renderMarkdown(STATE_CONTENT);

    await waitFor(
      () => {
        const svg = document.querySelector('.mermaid-diagram svg');
        expect(svg, 'stateDiagram-v2 应渲染成 SVG').not.toBeNull();
        expect(svg!.textContent).toContain('Idle');
      },
      { timeout: 4000 },
    );
  });

  it('把 flowchart TD（流程图）渲染成 SVG', async () => {
    renderMarkdown(FLOWCHART_TD_CONTENT);

    await waitFor(
      () => {
        const svg = document.querySelector('.mermaid-diagram svg');
        expect(svg, 'flowchart TD 应渲染成 SVG').not.toBeNull();
      },
      { timeout: 4000 },
    );
  });

  it('带边标签的 stateDiagram-v2 仍路由到 MermaidDiagram（dagre 边标签几何在 happy-dom 不可渲染，只断言路由）', () => {
    renderMarkdown(STATE_LABELED_CONTENT);

    const diagram = document.querySelector('.mermaid-diagram');
    expect(diagram, '带边标签的状态图同样路由到 MermaidDiagram，而非普通代码块').not.toBeNull();
  });

  it('图题注渲染为带类型徽标的段落（序列图 → sequence 徽标）', () => {
    renderMarkdown(SEQUENCE_CONTENT);

    const caption = screen.getByText(/登录鉴权调用链/).closest('p');
    expect(caption, '题注应渲染为 <p> 段落').not.toBeNull();
    expect(caption!.className).toContain('diagram-caption');
    expect(caption!.className).toContain('diagram-caption--sequence');
  });

  it('图题注按类型词着色（架构图 / 状态图徽标）', () => {
    renderMarkdown(['# 架构', '', '**图｜架构图｜模块关系**：核心与依赖', '', '正文段。'].join('\n'));
    const fcCaption = screen.getByText(/模块关系/).closest('p');
    expect(fcCaption!.className).toContain('diagram-caption--flowchart');

    renderMarkdown(STATE_CONTENT);
    const stCaption = screen.getByText(/连接生命周期/).closest('p');
    expect(stCaption!.className).toContain('diagram-caption--state');
  });

  it('普通段落不带题注徽标 class', () => {
    renderMarkdown('# 标题\n\n这是普通散文段落，不是题注。');

    const p = screen.getByText('这是普通散文段落，不是题注。').closest('p');
    expect(p!.className).not.toContain('diagram-caption');
  });
});
