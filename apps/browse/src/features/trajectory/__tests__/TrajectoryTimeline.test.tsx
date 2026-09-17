/**
 * TrajectoryTimeline 组件级测试：sub-pixel span 合并 / 滚轮缩放 / 模式切换。
 *
 * 核心回归是「span 数可达数万时不能逐条画 div」：宽度不足 2 CSS px 的 span
 * 必须合并，每泳道条数被视口宽度封顶（见 MIGRATION §26.10）。
 */

import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { stubElementLayout } from '../../../../test/setup';
import { TrajectoryTimeline } from '../TrajectoryTimeline';
import { createTranslate } from '@/i18n/index';
import type { TrajectoryCellKind, TrajectoryCellProps, TrajectoryTurnModel } from '@zread-pi/trajectory';

const translate = createTranslate('en-US');

function makeCells(count: number, kind: TrajectoryCellKind = 'message'): TrajectoryCellProps[] {
  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    kind,
    text: `cell ${index}`,
    timeSeconds: 0.01,
    startedAt: 1_000 + index * 10,
    recordId: `cell-${index + 1}`,
  }));
}

function turnsOf(cells: TrajectoryCellProps[], turn = 1): TrajectoryTurnModel[] {
  return [
    {
      turn,
      label: 'Agent',
      sessionId: 'session-1',
      groups: [{ title: 'Message', cells }],
    },
  ];
}

function renderTimeline(props: Partial<React.ComponentProps<typeof TrajectoryTimeline>> = {}): void {
  render(
    <TrajectoryTimeline
      turns={[]}
      mode="sequence"
      focusIndexes={null}
      onFocusChange={() => {}}
      selectedIndexes={new Set<number>()}
      onSelectIndex={() => {}}
      onTimelineModeChange={() => {}}
      {...props}
    />,
  );
}

function wheel(deltaY: number): void {
  fireEvent.wheel(screen.getByTestId('timeline-container'), { deltaY });
}

describe('TrajectoryTimeline span 合并', () => {
  it('一千条 sub-pixel span 合并成极少数色块（不逐条画 div）', () => {
    stubElementLayout({ width: 800 });
    renderTimeline({ turns: turnsOf(makeCells(1_000)) });
    const segments = screen.getAllByTestId('timeline-segment');
    // sequence 模式下每条 span = 800/1000 = 0.8px < 2px，全部合并；
    // message 全在泳道 1，故只剩 1 条色块
    expect(segments).toHaveLength(1);
  });

  it('少量宽 span 逐条渲染', () => {
    stubElementLayout({ width: 800 });
    renderTimeline({ turns: turnsOf(makeCells(3)) });
    expect(screen.getAllByTestId('timeline-segment')).toHaveLength(3);
  });

  it('窄视口下宽 span 也会被合并', () => {
    stubElementLayout({ width: 4 });
    renderTimeline({ turns: turnsOf(makeCells(50)) });
    // 800 单位挤进 4px，每条 0.008px，全部合并
    expect(screen.getAllByTestId('timeline-segment')).toHaveLength(1);
  });

  it('不同泳道的 span 各自合并', () => {
    stubElementLayout({ width: 400 });
    // 每泳道 300 条（各约 0.44px，全部进入合并路径）
    const cells = [
      ...makeCells(300, 'system'),
      ...makeCells(300, 'message'),
      ...makeCells(300, 'tool'),
    ];
    renderTimeline({ turns: turnsOf(cells) });
    // 泳道 0 / 1 / 2 各一条合并色块
    expect(screen.getAllByTestId('timeline-segment')).toHaveLength(3);
  });

  it('聚焦选区时未聚焦的色块降透明度', () => {
    stubElementLayout({ width: 400 });
    const cells = makeCells(500);
    renderTimeline({ turns: turnsOf(cells), focusIndexes: new Set([1]) });
    const segments = screen.getAllByTestId('timeline-segment');
    // 全部合并成一条，组成里只有 index 1 聚焦 → opacity 0.75（非 0.12）
    expect(segments).toHaveLength(1);
    expect(segments[0]?.style.opacity).toBe('0.75');
  });
});

describe('TrajectoryTimeline 交互', () => {
  it('sequence 模式滚轮切换到 duration（sequence 轴无时长可缩放）', () => {
    stubElementLayout({ width: 800 });
    const calls: string[] = [];
    renderTimeline({
      turns: turnsOf(makeCells(10)),
      mode: 'sequence',
      onTimelineModeChange: (mode) => calls.push(mode),
    });
    wheel(120);
    expect(calls).toEqual(['duration']);
  });

  it('sequence 模式滚轮幅度过小时不切换', () => {
    stubElementLayout({ width: 800 });
    const calls: string[] = [];
    renderTimeline({
      turns: turnsOf(makeCells(10)),
      mode: 'sequence',
      onTimelineModeChange: (mode) => calls.push(mode),
    });
    wheel(0.5);
    expect(calls).toHaveLength(0);
  });

  it('duration 模式滚轮进入缩放态，出现「重置缩放」', () => {
    stubElementLayout({ width: 800 });
    renderTimeline({ turns: turnsOf(makeCells(10)), mode: 'duration' });
    expect(screen.queryByText(translate('trajectory.resetZoom'))).toBeNull();
    wheel(-120);
    expect(screen.getByText(translate('trajectory.resetZoom'))).toBeInTheDocument();
  });

  it('重置缩放按钮清除视口与选区', () => {
    stubElementLayout({ width: 800 });
    const focusCalls: Array<ReadonlySet<number> | null> = [];
    renderTimeline({
      turns: turnsOf(makeCells(10)),
      mode: 'duration',
      onFocusChange: (indexes) => focusCalls.push(indexes),
    });
    wheel(-120);
    fireEvent.click(screen.getByText(translate('trajectory.resetZoom')));
    expect(focusCalls).toContain(null);
  });

  it('右键清除选区', () => {
    stubElementLayout({ width: 800 });
    const focusCalls: Array<ReadonlySet<number> | null> = [];
    renderTimeline({
      turns: turnsOf(makeCells(10)),
      mode: 'duration',
      onFocusChange: (indexes) => focusCalls.push(indexes),
    });
    fireEvent.contextMenu(screen.getByTestId('timeline-container'));
    expect(focusCalls).toContain(null);
  });

  it('无时序数据时显示提示', () => {
    renderTimeline({ turns: [] });
    expect(screen.getByText(translate('trajectory.noTiming'))).toBeInTheDocument();
  });
});
