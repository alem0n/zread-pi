/**
 * TrajectoryTimeline —— Overview 时序条（三泳道 + 拖拽区间过滤 + 滚轮缩放 + 右键清除）。
 *
 * 移植自 dsh 的 TrajectoryTimeline，但渲染用绝对定位的 div（不引入 canvas）。
 * - 拖拽选择区间 → 过滤出台账里高亮 / 保留的记录（onFocusChange）；
 * - 滚轮缩放（time / duration / actual 模式；sequence 模式滚轮先切到 duration）；
 * - 右键清除选区；
 * - 悬停 500ms 显示该区间的摘要提示。
 *
 * 渲染要点：
 * - 滚轮缩放用原生非被动监听（React 的 onWheel 是被动监听，preventDefault 无效，
 *   缩放时整个台账会跟着滚动）；
 * - 宽度不足 2 CSS px 的 span 合并成一条（一次 run 的 span 可达数万，逐条画 div
 *   会让浏览器卡死；合并后每泳道的条数被视口宽度封顶）；
 * - 泳道树单独 memo：拖拽选区时只有选区遮罩重绘，泳道不重绘。
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
  type TrajectoryTimelineSpan,
  type TrajectoryTurnModel,
} from '@zread-pi/trajectory';
import { useT } from '@/i18n/I18nContext';

const LANE_COLORS: Record<number, string> = {
  0: '#a39e98', // system / user / context
  1: '#0075de', // message / compacted
  2: '#2a9d99', // tool
};

const HEIGHT_PX = 64;
const LANE_HEIGHT_PX = 16;
const LANE_GAP_PX = 4;
const LANES = [0, 1, 2];
/** 宽度小于此值（CSS px）的 span 与相邻薄 span 合并成一条，避免视口内出现成千上万条 div */
const SPAN_MERGE_PX = 2;

interface TrajectoryTimelineProps {
  turns: readonly TrajectoryTurnModel[];
  mode: TrajectoryTimelineMode;
  /** 当前选中的记录索引集合（null = 无过滤） */
  focusIndexes: ReadonlySet<number> | null;
  onFocusChange: (indexes: ReadonlySet<number> | null) => void;
  selectedIndexes: ReadonlySet<number>;
  onSelectIndex: (index: number) => void;
  /** 滚轮在 sequence 轴上触发模式切换（sequence 无时长，缩放无意义） */
  onTimelineModeChange: (mode: TrajectoryTimelineMode) => void;
}

/** 一条合并后的泳道色块（可能由多个 sub-pixel span 聚合而成） */
interface LaneSegment {
  left: number;
  width: number;
  isError: boolean;
  focused: boolean;
  selected: boolean;
}

interface SegmentFlags {
  isError: boolean;
  focused: boolean;
  selected: boolean;
  count: number;
}

/** 把同一泳道里连续的 sub-pixel span 合并；色块条数被视口宽度封顶 */
function mergeLaneSpans(
  spans: readonly TrajectoryTimelineSpan[],
  positionOf: (value: number) => number,
  width: number,
  focusIndexes: ReadonlySet<number> | null,
  selectedIndexes: ReadonlySet<number>,
): LaneSegment[] {
  const segments: LaneSegment[] = [];
  let bucketLeft = 0;
  let bucketRight = 0;
  let bucket: SegmentFlags | null = null;

  const flagsOf = (span: TrajectoryTimelineSpan): SegmentFlags => ({
    isError: span.isError,
    focused: focusIndexes === null || focusIndexes.has(span.index),
    selected: selectedIndexes.has(span.index),
    count: 1,
  });
  const mergeInto = (target: SegmentFlags, span: TrajectoryTimelineSpan): SegmentFlags => {
    target.isError = target.isError || span.isError;
    target.focused = target.focused || focusIndexes === null || focusIndexes.has(span.index);
    target.selected = target.selected || selectedIndexes.has(span.index);
    target.count += 1;
    return target;
  };
  const emit = (left: number, right: number, flags: SegmentFlags): void => {
    segments.push({
      left,
      width: Math.max(1, right - left),
      isError: flags.isError,
      focused: flags.focused,
      selected: flags.selected,
    });
  };

  for (const span of spans) {
    const left = Math.max(0, positionOf(span.start));
    const right = Math.min(width, positionOf(span.end));
    if (right - left >= SPAN_MERGE_PX) {
      // 宽 span：若与待合并的薄 span 相接 / 重叠则并成一条（避免紧贴的缝隙）
      if (bucket !== null && bucketRight > left - SPAN_MERGE_PX) {
        emit(Math.min(bucketLeft, left), Math.max(bucketRight, right), mergeInto(bucket, span));
        bucket = null;
      } else {
        if (bucket !== null) {
          emit(bucketLeft, bucketRight, bucket);
          bucket = null;
        }
        emit(left, right, flagsOf(span));
      }
      continue;
    }
    if (bucket === null) {
      bucket = flagsOf(span);
      bucketLeft = left;
      bucketRight = right;
    } else {
      mergeInto(bucket, span);
      bucketLeft = Math.min(bucketLeft, left);
      bucketRight = Math.max(bucketRight, right);
    }
  }
  if (bucket !== null) emit(bucketLeft, bucketRight, bucket);
  return segments;
}

/** 模型边界漂移（流式新事件到达）时把缩放视口钳到新边界内，而不是丢弃 */
function clampViewport(current: TrajectoryTimeRange, model: TrajectoryTimeRange): TrajectoryTimeRange {
  if (current.start >= model.start && current.end <= model.end) return current;
  const span = Math.max(1, current.end - current.start);
  let start = Math.max(model.start, current.start);
  let end = start + span;
  if (end > model.end) {
    end = model.end;
    start = Math.max(model.start, end - span);
  }
  if (start >= end) return { start: model.start, end: model.end };
  return { start, end };
}

export const TrajectoryTimeline = memo(function TrajectoryTimeline({
  turns,
  mode,
  focusIndexes,
  onFocusChange,
  selectedIndexes,
  onSelectIndex,
  onTimelineModeChange,
}: TrajectoryTimelineProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
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
  const modeRef = useRef(mode);
  useEffect(() => {
    if (model === null) {
      setViewport(null);
      setSelection(null);
      return;
    }
    // 模式切换会改变坐标轴语义，必须丢弃旧的缩放 / 选区
    if (mode !== modeRef.current) {
      modeRef.current = mode;
      setViewport(null);
      setSelection(null);
      return;
    }
    // 模型边界漂移（运行中的 run 每轮轮询都会增长）：钳进新边界，保留用户的缩放
    setViewport((current) => (current === null ? null : clampViewport(current, model)));
  }, [model, mode]);

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

  // 滚轮缩放（以光标位置为中心）。用原生非被动监听：React 的 onWheel 走被动委托，
  // preventDefault() 不生效，缩放时父级台账会跟着滚动。
  const handleWheel = useCallback(
    (event: WheelEvent): void => {
      if (model === null || effective === null) return;
      if (mode === 'sequence') {
        // sequence 轴没有时长可缩放：滚轮先切到 duration（它有真实墙钟跨度）。
        if (Math.abs(event.deltaY) < 1) return;
        event.preventDefault();
        onTimelineModeChange('duration');
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
    [model, effective, span, mode, valueAt, onTimelineModeChange],
  );
  const wheelHandlerRef = useRef(handleWheel);
  useEffect(() => {
    wheelHandlerRef.current = handleWheel;
  }, [handleWheel]);
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const listener = (event: WheelEvent): void => wheelHandlerRef.current(event);
    element.addEventListener('wheel', listener, { passive: false });
    return () => element.removeEventListener('wheel', listener);
  }, []);

  // 缩放操作数达到阈值后重置计数（渐进式缩放语义）
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

  // 泳道色块：sub-pixel span 合并后按泳道分组。依赖里不含 selection，
  // 拖拽选区时泳道树不重绘（只有选区遮罩重绘）。
  const lanes = useMemo(() => {
    if (model === null || effective === null) return [];
    return LANES.map((lane) => {
      const laneSpans = model.spans.filter(
        (entry) => entry.lane === lane && entry.end >= effective.start && entry.start <= effective.end,
      );
      return mergeLaneSpans(laneSpans, positionOf, width, focusIndexes, selectedIndexes);
    });
  }, [model, effective, positionOf, width, focusIndexes, selectedIndexes]);

  const lanesElement = useMemo(
    () =>
      lanes.map((segments, lane) => (
        <div
          key={lane}
          className="absolute left-0 right-0"
          style={{
            top: 6 + lane * (LANE_HEIGHT_PX + LANE_GAP_PX),
            height: LANE_HEIGHT_PX,
          }}
        >
          {segments.map((segment, index) => (
            <div
              key={`${lane}-${index}`}
              data-testid="timeline-segment"
              className="absolute rounded-sm"
              style={{
                left: segment.left,
                width: segment.width,
                height: LANE_HEIGHT_PX,
                backgroundColor: segment.isError ? '#e54847' : LANE_COLORS[lane] ?? '#a39e98',
                opacity: segment.focused ? (segment.selected ? 1 : 0.75) : 0.12,
                outline: segment.selected ? '1.5px solid #31302e' : 'none',
              }}
            />
          ))}
        </div>
      )),
    [lanes],
  );

  if (model === null) {
    return (
      <div className="px-3 py-1.5 text-xs text-[#a39e98] border-b border-gray-200 bg-white">
        {t('trajectory.noTiming')}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="timeline-container"
      className="relative select-none overflow-hidden border-b border-gray-200 bg-white"
      style={{ height: HEIGHT_PX }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onContextMenu={handleContextMenu}
    >
      {/* 泳道 */}
      {lanesElement}

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

      {/* 缩放态的重置入口 */}
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
          {t('trajectory.resetZoom')}
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
