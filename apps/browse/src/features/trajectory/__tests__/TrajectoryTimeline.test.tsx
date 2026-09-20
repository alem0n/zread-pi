/**
 * TrajectoryTimeline 组件级测试：sub-pixel span 合并 / 滚轮缩放 / 模式切换。
 *
 * 核心回归是「span 数可达数万时不能逐条画 div」：宽度不足 2 CSS px 的 span
 * 必须合并，每泳道条数被视口宽度封顶。
 */

import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent, act, type RenderResult } from '@testing-library/react';
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

function renderTimeline(props: Partial<React.ComponentProps<typeof TrajectoryTimeline>> = {}): RenderResult {
  return render(
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

function wheel(deltaY: number, clientX = 400): void {
  // happy-dom 的 WheelEvent 不从 init 读 clientX（MouseEvent 会），手动塞进去；
  // 否则 valueAt(undefined) 算出 NaN，会把缩放视口设成 NaN
  const container = screen.getByTestId('timeline-container');
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', { value: clientX });
  // 原生 dispatch 不走 fireEvent，必须包 act，否则 React 的 setViewport 不同步刷新
  act(() => {
    container.dispatchEvent(event);
  });
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

  it('duration 模式：空闲压缩后薄 span 与相邻宽 span 合并（不留缝隙）', () => {
    stubElementLayout({ width: 800 });
    // duration 开启空闲压缩：A(极短) 与 B(长) 之间的 3000ms 空闲被抹掉，
    // 二者像素级相接 → 薄的 A 被包进宽的 B；C(极短) 与 D(长) 同理
    const cells: TrajectoryCellProps[] = [
      { index: 1, kind: 'message', text: 'A', timeSeconds: 0.001, startedAt: 1000, recordId: 'a' },
      { index: 2, kind: 'message', text: 'B', timeSeconds: 50, startedAt: 4000, recordId: 'b' },
      { index: 3, kind: 'message', text: 'C', timeSeconds: 0.001, startedAt: 4050, recordId: 'c' },
      { index: 4, kind: 'message', text: 'D', timeSeconds: 100, startedAt: 4050.001, recordId: 'd' },
    ];
    renderTimeline({ turns: turnsOf(cells), mode: 'duration' });
    // (A+B) 合成一条、(C+D) 合成一条
    expect(screen.getAllByTestId('timeline-segment')).toHaveLength(2);
  });

  it('actual 模式：不压缩空闲，薄 span 与远处的宽 span 分开渲染', () => {
    stubElementLayout({ width: 800 });
    // actual 不压缩空闲：A(极短) 与 B(长) 之间保留 3000ms 空隙 →
    // 先 flush 薄桶 A，再单独画宽 B；C(极短) 紧接 D(长) → 合并
    const cells: TrajectoryCellProps[] = [
      { index: 1, kind: 'message', text: 'A', timeSeconds: 0.001, startedAt: 1000, recordId: 'a' },
      { index: 2, kind: 'message', text: 'B', timeSeconds: 50, startedAt: 4000, recordId: 'b' },
      { index: 3, kind: 'message', text: 'C', timeSeconds: 0.001, startedAt: 4050, recordId: 'c' },
      { index: 4, kind: 'message', text: 'D', timeSeconds: 100, startedAt: 4050.001, recordId: 'd' },
    ];
    renderTimeline({ turns: turnsOf(cells), mode: 'actual' });
    // A / B / (C+D 合并) = 3 条
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
    // 缩放后段仍正常渲染（NaN 视口会让 10 条段塌成 1 条）
    expect(screen.getAllByTestId('timeline-segment')).toHaveLength(10);
  });

  it('连续缩放达到操作数阈值后计数器重置（语义不变，仍可缩放）', () => {
    stubElementLayout({ width: 800 });
    renderTimeline({ turns: turnsOf(makeCells(10)), mode: 'duration' });
    // MINIMUM_ZOOM_OPERATIONS = 4：连续 5 次滚轮，越过阈值后计数器归零但不切换模式
    for (let i = 0; i < 5; i += 1) wheel(-120);
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

describe('TrajectoryTimeline 拖拽与悬停', () => {
  it('点击（小于最小拖拽距离）选中该位置最近的记录', () => {
    stubElementLayout({ width: 800 });
    const cells = makeCells(10);
    const calls: number[] = [];
    renderTimeline({
      turns: turnsOf(cells),
      mode: 'duration',
      onSelectIndex: (index) => calls.push(index),
    });
    const container = screen.getByTestId('timeline-container');
    fireEvent.mouseDown(container, { button: 0, clientX: 100 });
    // 位移 0 < MINIMUM_DRAG_PX(3)，走点击分支而不是拖拽
    fireEvent.mouseUp(container, { clientX: 100 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(0);
  });

  it('拖拽超过最小距离产生选区过滤（选区遮罩出现 + onFocusChange）', () => {
    stubElementLayout({ width: 800 });
    const cells = makeCells(10);
    const focusCalls: Array<ReadonlySet<number> | null> = [];
    renderTimeline({
      turns: turnsOf(cells),
      mode: 'duration',
      onFocusChange: (indexes) => focusCalls.push(indexes),
    });
    const container = screen.getByTestId('timeline-container');
    fireEvent.mouseDown(container, { button: 0, clientX: 50 });
    fireEvent.mouseMove(container, { clientX: 300 });
    // 拖拽中的选区遮罩已渲染
    expect(screen.getByTestId('timeline-selection')).toBeInTheDocument();
    fireEvent.mouseUp(container, { clientX: 300 });
    expect(focusCalls).toHaveLength(1);
    expect((focusCalls[0] as Set<number>).size).toBeGreaterThan(0);
  });

  it('拖拽距离不足时不产生选区过滤（仍算点击）', () => {
    stubElementLayout({ width: 800 });
    const cells = makeCells(10);
    const focusCalls: Array<ReadonlySet<number> | null> = [];
    renderTimeline({
      turns: turnsOf(cells),
      mode: 'duration',
      onFocusChange: (indexes) => focusCalls.push(indexes),
    });
    const container = screen.getByTestId('timeline-container');
    fireEvent.mouseDown(container, { button: 0, clientX: 100 });
    fireEvent.mouseMove(container, { clientX: 102 });
    fireEvent.mouseUp(container, { clientX: 102 });
    expect(focusCalls).toHaveLength(0);
  });

  it('非左键按下不启动拖拽', () => {
    stubElementLayout({ width: 800 });
    const cells = makeCells(10);
    const focusCalls: Array<ReadonlySet<number> | null> = [];
    renderTimeline({
      turns: turnsOf(cells),
      mode: 'duration',
      onFocusChange: (indexes) => focusCalls.push(indexes),
    });
    const container = screen.getByTestId('timeline-container');
    fireEvent.mouseDown(container, { button: 2, clientX: 50 });
    fireEvent.mouseUp(container, { clientX: 300 });
    expect(focusCalls).toHaveLength(0);
  });

  it('悬停超过延迟后显示提示（含标签与偏移）', async () => {
    stubElementLayout({ width: 800 });
    const cells = makeCells(10);
    renderTimeline({ turns: turnsOf(cells), mode: 'duration' });
    const container = screen.getByTestId('timeline-container');
    fireEvent.mouseMove(container, { clientX: 100 });
    expect(screen.queryByTestId('timeline-tooltip')).toBeNull();
    // TIMELINE_TOOLTIP_DELAY_MS = 500，用真实定时器等到延迟之后
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(screen.getByTestId('timeline-tooltip')).toBeInTheDocument();
  });
});

describe('TrajectoryTimeline 视口生命周期', () => {
  it('模型边界漂移时保留缩放（钳进新边界而不是丢弃）', () => {
    stubElementLayout({ width: 800 });
    const cells = makeCells(10);
    const { rerender } = renderTimeline({ turns: turnsOf(cells), mode: 'duration' });
    // 先进入缩放态
    wheel(-120);
    expect(screen.getByText(translate('trajectory.resetZoom'))).toBeInTheDocument();
    // 模型增长（运行中的 run 每轮轮询都会追加事件）
    rerender(
      <TrajectoryTimeline
        turns={turnsOf(makeCells(20))}
        mode="duration"
        focusIndexes={null}
        onFocusChange={() => {}}
        selectedIndexes={new Set<number>()}
        onSelectIndex={() => {}}
        onTimelineModeChange={() => {}}
      />,
    );
    // 缩放视口被钳进新边界（而非丢弃），「重置缩放」仍在
    expect(screen.getByText(translate('trajectory.resetZoom'))).toBeInTheDocument();
  });

  it('模式切换重置缩放视口与选区', () => {
    stubElementLayout({ width: 800 });
    const cells = makeCells(10);
    const { rerender } = renderTimeline({ turns: turnsOf(cells), mode: 'duration' });
    wheel(-120);
    expect(screen.getByText(translate('trajectory.resetZoom'))).toBeInTheDocument();
    rerender(
      <TrajectoryTimeline
        turns={turnsOf(cells)}
        mode="sequence"
        focusIndexes={null}
        onFocusChange={() => {}}
        selectedIndexes={new Set<number>()}
        onSelectIndex={() => {}}
        onTimelineModeChange={() => {}}
      />,
    );
    expect(screen.queryByText(translate('trajectory.resetZoom'))).toBeNull();
  });
});
