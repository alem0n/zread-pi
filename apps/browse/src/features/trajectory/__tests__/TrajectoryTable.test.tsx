/**
 * TrajectoryTable 组件级测试：行模型纯函数 + sticky 表头结构回归。
 *
 * sticky 表头的回归点是「不能出现双表头」与「不能影响窗口几何」：
 * sticky 条必须是滚动容器的绝对定位兄弟（不在文档流里），且只有在真实
 * 表头完全滚出视口顶时才出现（见 MIGRATION §26.10）。
 */

import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { buildTrajectoryRows, TrajectoryTable, type TrajectoryRow } from '../TrajectoryTable';
import type { TranslateFn } from '@/i18n/I18nContext';
import { createTranslate } from '@/i18n/index';
import type { TrajectoryCellProps, TrajectoryCellKind, TrajectoryTurnModel } from '@zread-pi/trajectory';

// 简易翻译：原样返回 key（只用于占位文案，断言不依赖具体措辞）
const t = ((key: string) => key) as unknown as TranslateFn;
// 组件渲染走默认 en-US 上下文（无 Provider），期望文案用同一个翻译函数派生
const translate = createTranslate('en-US');

function makeCell(index: number, kind: TrajectoryCellKind, text: string): TrajectoryCellProps {
  return { index, kind, text, timeSeconds: 0.1, startedAt: 1_000 + index, recordId: `cell-${index}` };
}

function makeTurn(turn: number | null, cells: TrajectoryCellProps[], label = 'Agent'): TrajectoryTurnModel {
  return {
    turn,
    label: turn === null ? 'Between turns' : `${label} ${turn}`,
    sessionId: turn === null ? undefined : `session-${turn}`,
    groups: [{ title: 'Message', cells }],
  };
}

describe('buildTrajectoryRows', () => {
  it('turn 头 + group 头 + cell 三层行都生成', () => {
    const turns = [makeTurn(1, [makeCell(1, 'message', 'hello'), makeCell(2, 'tool', 'read')])];
    const rows = buildTrajectoryRows(turns, {
      collapseTurns: false,
      collapsedTurnSet: new Set(),
      collapseAssistant: false,
      focusIndexes: null,
      matchSet: null,
      hasMoreOlder: false,
      t,
    });
    expect(rows.map((row) => row.kind)).toEqual(['turn-header', 'group-header', 'cell', 'cell']);
  });

  it('collapseTurns 时 turn 只剩头部 + 一条折叠摘要', () => {
    const turns = [makeTurn(1, [makeCell(1, 'message', 'hello'), makeCell(2, 'tool', 'read')])];
    const rows = buildTrajectoryRows(turns, {
      collapseTurns: true,
      collapsedTurnSet: new Set(),
      collapseAssistant: false,
      focusIndexes: null,
      matchSet: null,
      hasMoreOlder: false,
      t,
    });
    expect(rows.map((row) => row.kind)).toEqual(['turn-header', 'collapsed-turn']);
    expect(rows[1]?.collapsedCount).toBe(2);
  });

  it('collapseAssistant 把同组连续 message 合并成一条（×N）', () => {
    const turns = [makeTurn(1, [makeCell(1, 'message', 'a'), makeCell(2, 'message', 'b'), makeCell(3, 'tool', 'read')])];
    const rows = buildTrajectoryRows(turns, {
      collapseTurns: false,
      collapsedTurnSet: new Set(),
      collapseAssistant: true,
      focusIndexes: null,
      matchSet: null,
      hasMoreOlder: false,
      t,
    });
    const cells = rows.filter((row) => row.kind === 'cell');
    expect(cells).toHaveLength(2);
    expect(cells[0]?.cell?.text).toBe('b ×2');
  });

  it('collapseAssistant 关闭时连续 message 各自保留', () => {
    const turns = [makeTurn(1, [makeCell(1, 'message', 'a'), makeCell(2, 'message', 'b')])];
    const rows = buildTrajectoryRows(turns, {
      collapseTurns: false,
      collapsedTurnSet: new Set(),
      collapseAssistant: false,
      focusIndexes: null,
      matchSet: null,
      hasMoreOlder: false,
      t,
    });
    expect(rows.filter((row) => row.kind === 'cell')).toHaveLength(2);
  });

  it('focusIndexes 过滤掉不在选区内的 cell，空 turn 整个跳过', () => {
    const turns = [
      makeTurn(1, [makeCell(1, 'message', 'a')]),
      makeTurn(2, [makeCell(2, 'message', 'b')]),
    ];
    const rows = buildTrajectoryRows(turns, {
      collapseTurns: false,
      collapsedTurnSet: new Set(),
      collapseAssistant: false,
      focusIndexes: new Set([2]),
      matchSet: null,
      hasMoreOlder: false,
      t,
    });
    expect(rows.map((row) => row.kind)).toEqual(['turn-header', 'group-header', 'cell']);
    expect(rows[2]?.cell?.index).toBe(2);
  });

  it('matchSet 过滤不匹配的 cell', () => {
    const turns = [makeTurn(1, [makeCell(1, 'message', 'alpha'), makeCell(2, 'tool', 'beta')])];
    const rows = buildTrajectoryRows(turns, {
      collapseTurns: false,
      collapsedTurnSet: new Set(),
      collapseAssistant: false,
      focusIndexes: null,
      matchSet: new Set(['cell-2']),
      hasMoreOlder: false,
      t,
    });
    expect(rows.filter((row) => row.kind === 'cell').map((row) => row.cell?.index)).toEqual([2]);
  });

  it('hasMoreOlder 时把「加载更旧」行插到最前', () => {
    const turns = [makeTurn(1, [makeCell(1, 'message', 'a')])];
    const rows = buildTrajectoryRows(turns, {
      collapseTurns: false,
      collapsedTurnSet: new Set(),
      collapseAssistant: false,
      focusIndexes: null,
      matchSet: null,
      hasMoreOlder: true,
      t,
    });
    expect(rows[0]?.kind).toBe('load-older');
  });

  it('collapsedTurnSet 单独收起某个 turn', () => {
    const turns = [
      makeTurn(1, [makeCell(1, 'message', 'a')]),
      makeTurn(2, [makeCell(2, 'message', 'b')]),
    ];
    const rows = buildTrajectoryRows(turns, {
      collapseTurns: false,
      collapsedTurnSet: new Set([1]),
      collapseAssistant: false,
      focusIndexes: null,
      matchSet: null,
      hasMoreOlder: false,
      t,
    });
    expect(rows.map((row) => row.kind)).toEqual([
      'turn-header',
      'collapsed-turn',
      'turn-header',
      'group-header',
      'cell',
    ]);
  });

  it('行高按行种类固定（可预先算总高）', () => {
    const turns = [makeTurn(1, [makeCell(1, 'message', 'a')])];
    const rows = buildTrajectoryRows(turns, {
      collapseTurns: false,
      collapsedTurnSet: new Set(),
      collapseAssistant: false,
      focusIndexes: null,
      matchSet: null,
      hasMoreOlder: false,
      t,
    });
    expect(rows.reduce((total, row) => total + row.height, 0)).toBe(34 + 26 + 30);
  });
});

describe('TrajectoryTable 渲染', () => {
  function makeProps(overrides: Partial<React.ComponentProps<typeof TrajectoryTable>> = {}) {
    const turns = [
      makeTurn(1, [makeCell(1, 'message', 'first message')]),
      makeTurn(2, [makeCell(2, 'tool', 'read a.ts')]),
    ];
    const rows = buildTrajectoryRows(turns, {
      collapseTurns: false,
      collapsedTurnSet: new Set(),
      collapseAssistant: false,
      focusIndexes: null,
      matchSet: null,
      hasMoreOlder: false,
      t,
    });
    const containerRef = { current: null } as React.ComponentProps<typeof TrajectoryTable>['containerRef'];
    return {
      rows,
      startIndex: 0,
      endIndex: rows.length,
      topHeight: 0,
      bottomHeight: 0,
      totalHeight: rows.reduce((total, row) => total + row.height, 0),
      scrollTop: 0,
      selectedIndex: null,
      matchSet: null,
      collapsedTurns: false,
      onToggleTurn: () => {},
      onSelectCell: () => {},
      onLoadOlder: () => {},
      onScroll: () => {},
      containerRef,
      ...overrides,
    };
  }

  it('渲染 turn 标签与记录文本', () => {
    render(<TrajectoryTable {...makeProps()} />);
    expect(screen.getByText(translate('trajectory.turnLabel', { turn: 1, label: 'Agent 1' }))).toBeInTheDocument();
    expect(screen.getByText('first message')).toBeInTheDocument();
    expect(screen.getByText('read a.ts')).toBeInTheDocument();
  });

  it('点击记录行触发 onSelectCell', () => {
    const spy: TrajectoryCellProps[] = [];
    render(<TrajectoryTable {...makeProps({ onSelectCell: (cell) => spy.push(cell) })} />);
    fireEvent.click(screen.getByText('read a.ts'));
    expect(spy).toHaveLength(1);
    expect(spy[0]?.text).toBe('read a.ts');
  });

  it('点击 turn 头触发 onToggleTurn（切换折叠）', () => {
    const calls: Array<number | null> = [];
    render(<TrajectoryTable {...makeProps({ onToggleTurn: (turn) => calls.push(turn) })} />);
    fireEvent.click(screen.getByText(translate('trajectory.turnLabel', { turn: 2, label: 'Agent 2' })));
    expect(calls).toEqual([2]);
  });

  it('空行集合显示「无记录」', () => {
    const containerRef = { current: null } as React.ComponentProps<typeof TrajectoryTable>['containerRef'];
    render(
      <TrajectoryTable
        rows={[] as TrajectoryRow[]}
        startIndex={0}
        endIndex={0}
        topHeight={0}
        bottomHeight={0}
        totalHeight={0}
        scrollTop={0}
        selectedIndex={null}
        matchSet={null}
        collapsedTurns={false}
        onToggleTurn={() => {}}
        onSelectCell={() => {}}
        onLoadOlder={() => {}}
        onScroll={() => {}}
        containerRef={containerRef}
      />,
    );
    expect(screen.getByText(translate('trajectory.noRecords'))).toBeInTheDocument();
  });

  it('选中行带高亮背景', () => {
    render(<TrajectoryTable {...makeProps({ selectedIndex: 2 })} />);
    const row = screen.getByText('read a.ts').closest('[role="button"]');
    expect(row?.className).toContain('bg-[#0075de]/10');
  });

  it('onScroll 事件向上透传', () => {
    const scrollCalls: number[] = [];
    const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
      scrollCalls.push(event.currentTarget.scrollTop);
    };
    render(<TrajectoryTable {...makeProps({ onScroll })} />);
    const scroller = screen.getByTestId('scroll-container');
    (scroller as HTMLDivElement).scrollTop = 123;
    fireEvent.scroll(scroller);
    expect(scrollCalls).toEqual([123]);
  });
});

describe('sticky turn 表头（结构回归）', () => {
  function renderAt(scrollTop: number): { container: HTMLElement } {
    const turns = [
      makeTurn(1, [makeCell(1, 'message', 'first message'), makeCell(2, 'tool', 'read')]),
      makeTurn(2, [makeCell(3, 'message', 'second message')]),
    ];
    const rows = buildTrajectoryRows(turns, {
      collapseTurns: false,
      collapsedTurnSet: new Set(),
      collapseAssistant: false,
      focusIndexes: null,
      matchSet: null,
      hasMoreOlder: false,
      t,
    });
    const containerRef = { current: null } as React.ComponentProps<typeof TrajectoryTable>['containerRef'];
    const utils = render(
      <TrajectoryTable
        rows={rows}
        startIndex={0}
        endIndex={rows.length}
        topHeight={0}
        bottomHeight={0}
        totalHeight={rows.reduce((total, row) => total + row.height, 0)}
        scrollTop={scrollTop}
        selectedIndex={null}
        matchSet={null}
        collapsedTurns={false}
        onToggleTurn={() => {}}
        onSelectCell={() => {}}
        onLoadOlder={() => {}}
        onScroll={() => {}}
        containerRef={containerRef}
      />,
    );
    return utils;
  }

  it('scrollTop=0（首个表头可见）时不显示 sticky 条', () => {
    renderAt(0);
    expect(screen.queryByTestId('sticky-turn-header')).toBeNull();
  });

  it('表头半可见（未完全滚出）时不显示 sticky 条 —— 不出现双表头', () => {
    // turn 1 头在 offset 0、高 34；scrollTop=10 时它仍半可见
    renderAt(10);
    expect(screen.queryByTestId('sticky-turn-header')).toBeNull();
  });

  it('表头完全滚出后显示 sticky 条，且内容是最近的 turn', () => {
    // scrollTop=50：turn 1 头（offset 0、高 34）已完全滚出，turn 2 头尚未到达，
    // 所以 sticky 条应展示 turn 1
    renderAt(50);
    const sticky = screen.getByTestId('sticky-turn-header');
    expect(sticky).toBeInTheDocument();
    expect(sticky.textContent).toContain('Agent 1');
  });

  it('sticky 条不在滚动容器内部（不在文档流里）', () => {
    renderAt(500);
    const sticky = screen.getByTestId('sticky-turn-header');
    const scroller = screen.getByTestId('scroll-container');
    expect(scroller.contains(sticky)).toBe(false);
    // sticky 条与滚动容器是兄弟（同一个包装容器的直接子节点）
    expect(sticky.parentElement).toBe(scroller.parentElement);
  });
});
