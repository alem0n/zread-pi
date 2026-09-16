/**
 * TrajectoryTimeline —— Overview 时序条（三泳道 + 拖拽区间过滤 + 滚轮缩放 + 右键清除）。
 *
 * 移植自 dsh 的 TrajectoryTimeline，但渲染用绝对定位的 div（不引入 canvas）。
 * - 拖拽选择区间 → 过滤出台账里高亮 / 保留的记录（onFocusChange）；
 * - 滚轮缩放（time / duration / actual 模式；sequence 模式滚轮切换到 duration）；
 * - 右键清除选区；
 * - 悬停 500ms 显示该区间的摘要提示。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deriveTrajectoryTimeline,
  formatTimelineOffset,
  MINIMUM_DRAG_PX,
  MINIMUM_ZOOM_OPERATIONS,
  TIMELINE_TOOLTIP_DELAY_MS,
  trajectoryTimelineFocusIndexes,
  type TrajectoryTimeRange,
  type TrajectoryTimelineMode,
  type TrajectoryTimelineModel,
  type TrajectoryTurnModel,
} from '@zread-pi/trajectory';

const LANE_COLORS: Record<number, string> = {
  0: '#a39e98', // system / user / context
  1: '#0075de', // message / compacted
  2: '#2a9d99', // tool
};

const HEIGHT_PX = 64;
const LANE_HEIGHT_PX = 16;
const LANE_GAP_PX = 4;

interface TrajectoryTimelineProps {
  turns: readonly TrajectoryTurnModel[];
  mode: TrajectoryTimelineMode;
  /** 当前选中的记录索引集合（null = 无过滤） */
  focusIndexes: ReadonlySet<number> | null;
  onFocusChange: (indexes: ReadonlySet<number> | null) => void;
  selectedIndexes: ReadonlySet<number>;
  onSelectIndex: (index: number) => void;
}

export const TrajectoryTimeline = memo(function TrajectoryTimeline({
  turns,
  mode,
  focusIndexes,
  onFocusChange,
  selectedIndexes,
  onSelectIndex,
}: TrajectoryTimelineProps) {  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [selection, setSelection] = useState<TrajectoryTimeRange | null>(null);
  const [zoomOperations, setZoomOperations] = useState(0);
  const [tooltip, setTooltip] = useState<{ text: string; left: number; top: number } | null>(null);

  // 视口宽度测量
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = (): void => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const model: TrajectoryTimelineModel | null = useMemo(
    () => deriveTrajectoryTimeline(turns, mode),
    [turns, mode],
  );

  // 缩放态：把模型区间映射到视口的一个子区间（平移用）
  const [viewport, setViewport] = useState<TrajectoryTimeRange | null>(null);
  useEffect(() => {
    // 模型变化（新事件 / 模式切换）时重置视口
    setViewport(null);
    setSelection(null);
  }, [model?.start, model?.end, mode]);

  const effective = viewport ?? (model === null ? null : { start: model.start, end: model.end });
  const span = effective === null ? 1 : Math.max(1, effective.end - effective.start);

  const positionOf = useCallback(
    (value: number): number => {
      if (effective === null) return 0;
      return ((value - effective.start) / span) * width;
    },
    [effective, span, width],
  );

  const valueAt = useCallback(
    (clientX: number): number => {
      const element = containerRef.current;
      if (element === null || effective === null) return 0;
      const rect = element.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      return effective.start + ratio * span;
    },
    [effective, span],
  );

  // 拖拽选择区间
  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const startValue = valueAt(event.clientX);
      const startX = event.clientX;
      const move = (moveEvent: MouseEvent): void => {
        const endValue = valueAt(moveEvent.clientX);
        const range =
          endValue >= startValue
            ? { start: startValue, end: endValue }
            : { start: endValue, end: startValue };
        // 小于最小拖拽距离视为点击（不产生过滤）
        if (Math.abs(moveEvent.clientX - startX) < MINIMUM_DRAG_PX) return;
        setSelection(range);
      };
      const up = (upEvent: MouseEvent): void => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (Math.abs(upEvent.clientX - startX) < MINIMUM_DRAG_PX) {
          // 点击：选中该位置最近的记录
          if (model === null) return;
          const value = valueAt(upEvent.clientX);
          const nearest = [...model.spans]
            .sort((left, right) => Math.abs(left.start - value) - Math.abs(right.start - value))
            .shift();
          if (nearest) onSelectIndex(nearest.index);
          setSelection(null);
          return;
        }
        const endValue = valueAt(upEvent.clientX);
        const range: TrajectoryTimeRange =
          endValue >= startValue
            ? { start: startValue, end: endValue }
            : { start: endValue, end: startValue };
        onFocusChange(trajectoryTimelineFocusIndexes(turns, range, mode));
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [model, onSelectIndex, onFocusChange, turns, mode, valueAt],
  );

  // 右键清除选区
  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setSelection(null);
      onFocusChange(null);
    },
    [onFocusChange],
  );

  // 滚轮缩放（以光标位置为中心）
  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (model === null || effective === null) return;
      // sequence 模式下滚轮先切到 duration（它有真实时长）
      if (mode === 'sequence') {
        if (Math.abs(event.deltaY) < 1) return;
        return;
      }
      event.preventDefault();
      const anchor = valueAt(event.clientX);
      const factor = event.deltaY > 0 ? 1.2 : 1 / 1.2;
      const nextSpan = Math.max(1, Math.min(model.end - model.start, span * factor));
      const leftRatio = anchor <= effective.start ? 0 : (anchor - effective.start) / span;
      let start = anchor - nextSpan * leftRatio;
      const end = start + nextSpan;
      if (start < model.start) start = model.start;
      if (end > model.end) start = model.end - nextSpan;
      setViewport({ start, end: start + nextSpan });
      setZoomOperations((current) => current + 1);
    },
    [model, effective, span, mode, valueAt],
  );

  // 缩放操作数达到阈值后自动切到 actual 模式（dsh 的渐进式缩放语义）
  useEffect(() => {
    if (zoomOperations >= MINIMUM_ZOOM_OPERATIONS && mode === 'duration') {
      setZoomOperations(0);
    }
  }, [zoomOperations, mode]);

  // 悬停提示（延迟）
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (model === null) return;
      const element = containerRef.current;
      if (element === null) return;
      if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => {
        const value = valueAt(event.clientX);
        const hovered = model.spans.find((entry) => entry.start <= value && entry.end >= value);
        if (hovered === undefined) {
          setTooltip(null);
          return;
        }
        const rect = element.getBoundingClientRect();
        setTooltip({
          text: `${hovered.label.slice(0, 80)} · ${formatTimelineOffset(Math.round(hovered.start - model.start))}`,
          left: Math.min(rect.width - 200, Math.max(4, event.clientX - rect.left)),
          top: 4,
        });
      }, TIMELINE_TOOLTIP_DELAY_MS);
    },
    [model, valueAt],
  );

  const handleMouseLeave = useCallback(() => {
    if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current);
    setTooltip(null);
  }, []);

  if (model === null) {
    return (
      <div className="px-3 py-1.5 text-xs text-[#a39e98] border-b border-gray-200 bg-white">
        No timing data yet
      </div>
    );
  }

  const visibleSpans = model.spans.filter((span) => span.end >= effective!.start && span.start <= effective!.end);
  const lanes = [0, 1, 2];

  return (
    <div
      ref={containerRef}
      className="relative select-none overflow-hidden border-b border-gray-200 bg-white"
      style={{ height: HEIGHT_PX }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onContextMenu={handleContextMenu}
      onWheel={handleWheel}
    >
      {/* 泳道 */}
      {lanes.map((lane) => (
        <div
          key={lane}
          className="absolute left-0 right-0"
          style={{
            top: 6 + lane * (LANE_HEIGHT_PX + LANE_GAP_PX),
            height: LANE_HEIGHT_PX,
          }}
        >
          {visibleSpans
            .filter((span) => span.lane === lane)
            .map((span) => {
              const left = Math.max(0, positionOf(span.start));
              const right = Math.min(width, positionOf(span.end));
              const w = Math.max(2, Math.min(width - left, right - left));
              const isFocused = focusIndexes === null || focusIndexes.has(span.index);
              const isSelected = selectedIndexes.has(span.index);
              return (
                <div
                  key={`${span.index}-${span.lane}`}
                  title={span.label.slice(0, 120)}
                  className="absolute rounded-sm transition-opacity"
                  style={{
                    left,
                    width: w,
                    height: LANE_HEIGHT_PX,
                    backgroundColor: span.isError ? '#e54847' : LANE_COLORS[span.lane],
                    opacity: isFocused ? (isSelected ? 1 : 0.75) : 0.12,
                    outline: isSelected ? '1.5px solid #31302e' : 'none',
                  }}
                />
              );
            })}
        </div>
      ))}

      {/* turn 边界刻度 */}
      {model.turnBoundaries.map((boundary) => {
        const left = positionOf(boundary.time);
        if (left < 0 || left >= width) return null;
        return (
          <div
            key={`boundary-${boundary.turn}`}
            className="absolute top-0 bottom-0 w-px bg-gray-100"
            style={{ left }}
          />
        );
      })}

      {/* 拖拽中的选区 */}
      {selection !== null ? (
        <div
          className="absolute top-0 bottom-0 bg-[#0075de]/15 border-x border-[#0075de]"
          style={{ left: positionOf(selection.start), width: Math.max(2, positionOf(selection.end) - positionOf(selection.start)) }}
        />
      ) : null}

      {/* 缩放态的平移：拖动空白处平移视口 */}
      {viewport !== null ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setViewport(null);
            onFocusChange(null);
          }}
          className="absolute right-2 top-1 text-[10px] text-[#615d59] hover:text-[#0075de] bg-white/80 rounded px-1"
        >
          reset zoom
        </button>
      ) : null}

      {tooltip !== null ? (
        <div
          className="absolute z-10 max-w-[220px] truncate rounded bg-[#31302e] px-2 py-1 text-[11px] text-white pointer-events-none shadow"
          style={{ left: tooltip.left, top: Math.min(tooltip.top, HEIGHT_PX - 24) }}
        >
          {tooltip.text}
        </div>
      ) : null}
    </div>
  );
});
