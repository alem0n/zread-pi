/**
 * useVirtualList —— 自写窗口化（稳定 key + 视口窗口 + 有界 overscan）。
 *
 * 行高按「行种类」固定（dsh 同款策略）：变化量小、可预先算总高，
 * 滚动时只需算窗口起止与上下 spacer。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  trajectoryTotalHeight,
  trajectoryViewportWindow,
  VIRTUAL_OVERSCAN_ROWS,
  VIRTUALIZATION_THRESHOLD,
} from '@zread-pi/trajectory';

export interface VirtualRow {
  /** 稳定 key（跨分页插入不变） */
  key: string;
  /** 行高（像素） */
  height: number;
}

export interface VirtualListResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  startIndex: number;
  endIndex: number;
  topHeight: number;
  bottomHeight: number;
  totalHeight: number;
  scrollTop: number;
  /** 用户是否贴近底部（尾部跟随判据） */
  atBottom: boolean;
  scrollToIndex: (index: number, align?: 'start' | 'center') => void;
  scrollToBottom: () => void;
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
}

export function useVirtualList(rows: VirtualRow[]): VirtualListResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [scrollTop, setScrollTop] = useState(0);

  // 视口高度测量（ResizeObserver；窗口缩放立即重算）
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = (): void => {
      setViewportHeight(element.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const window = useMemo(() => {
    if (rows.length < VIRTUALIZATION_THRESHOLD) {
      return {
        startIndex: 0,
        endIndex: rows.length,
        topHeight: 0,
        bottomHeight: 0,
      };
    }
    return trajectoryViewportWindow(rows, scrollTop, viewportHeight, VIRTUAL_OVERSCAN_ROWS);
  }, [rows, scrollTop, viewportHeight]);

  const totalHeight = useMemo(
    () => (rows.length < VIRTUALIZATION_THRESHOLD ? 0 : trajectoryTotalHeight(rows)),
    [rows],
  );

  const atBottom = useMemo(() => {
    if (rows.length < VIRTUALIZATION_THRESHOLD) return true;
    return scrollTop + viewportHeight >= totalHeight - 2;
  }, [rows.length, scrollTop, viewportHeight, totalHeight]);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const rowOffset = useMemo(() => {
    const offsets = new Array<number>(rows.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < rows.length; index++) {
      offsets[index + 1] = offsets[index] + (rows[index]?.height ?? 0);
    }
    return offsets;
  }, [rows]);

  const scrollToIndex = useCallback(
    (index: number, align: 'start' | 'center' = 'center') => {
      const element = containerRef.current;
      if (element === null) return;
      const clamped = Math.max(0, Math.min(rows.length - 1, index));
      const offset = rowOffset[clamped] ?? 0;
      const height = rows[clamped]?.height ?? 0;
      const target = align === 'start' ? offset : offset - Math.max(0, (element.clientHeight - height) / 2);
      element.scrollTop = Math.max(0, target);
      setScrollTop(element.scrollTop);
    },
    [rows, rowOffset],
  );

  const scrollToBottom = useCallback(() => {
    const element = containerRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    setScrollTop(element.scrollTop);
  }, []);

  // 行集合变化时保持底部锚定（仅当用户原本在底部时）
  const atBottomRef = useRef(true);
  useEffect(() => {
    atBottomRef.current = atBottom;
  }, [atBottom]);
  const totalHeightRef = useRef(totalHeight);
  useEffect(() => {
    const wasAtBottom = atBottomRef.current;
    const grew = totalHeight > totalHeightRef.current;
    totalHeightRef.current = totalHeight;
    if (wasAtBottom && grew) scrollToBottom();
  }, [totalHeight, scrollToBottom]);

  return {
    containerRef,
    startIndex: window.startIndex,
    endIndex: window.endIndex,
    topHeight: window.topHeight,
    bottomHeight: window.bottomHeight,
    totalHeight,
    scrollTop,
    atBottom,
    scrollToIndex,
    scrollToBottom,
    onScroll,
  };
}
