/**
 * Select - 选择列表组件（对齐 ink-select-input 的行为）
 *
 * - ↑ / k：上移（到顶后回绕到底部）
 * - ↓ / j：下移（到底后回绕到顶部）
 * - Enter：确认选中
 * - 列表项值发生变化时，选中项重置为第一项
 *
 * 每一项由调用方通过 renderItem 渲染（可能是多行，例如配置首页）。
 */

import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { style } from "../ansi";
import { clampLine, padRight } from "../text-layout";

export interface SelectOption {
  value: string;
}

export interface SelectConfig<T extends SelectOption> {
  items: T[];
  /** 可见区域大小；不设置时渲染全部（与 ink-select-input 默认一致） */
  viewportSize?: number;
  /** 渲染列表项，返回一行或多行 */
  renderItem: (item: T, isSelected: boolean, width: number) => string[];
  onSelect?: (item: T) => void;
  onHighlight?: (item: T) => void;
  /** 初始选中下标 */
  initialIndex?: number;
}

export class Select<T extends SelectOption> implements Component {
  protected items: T[];
  private selectedIndex: number;
  private viewportSize?: number;
  private renderItemFn: (item: T, isSelected: boolean, width: number) => string[];
  private lastValues: string[] = [];

  onSelect?: (item: T) => void;
  onHighlight?: (item: T) => void;

  constructor(config: SelectConfig<T>) {
    this.items = config.items;
    this.viewportSize = config.viewportSize;
    this.renderItemFn = config.renderItem;
    this.onSelect = config.onSelect;
    this.onHighlight = config.onHighlight;
    this.selectedIndex = this.clampIndex(config.initialIndex ?? 0);
    this.lastValues = this.items.map((item) => item.value);
  }

  /** 更新列表数据（值变化时重置选中项，与 ink-select-input 的 useEffect 等价） */
  setItems(items: T[]): void {
    this.items = items;
    const values = items.map((item) => item.value);
    const changed =
      values.length !== this.lastValues.length ||
      values.some((value, index) => value !== this.lastValues[index]);
    this.lastValues = values;
    if (changed) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
    }
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  setSelectedIndex(index: number): void {
    this.selectedIndex = this.clampIndex(index);
  }

  getSelectedItem(): T | undefined {
    return this.items[this.selectedIndex];
  }

  invalidate(): void {
    // 无缓存状态
  }

  render(width: number): string[] {
    if (this.items.length === 0) return [];

    const { start, end } = this.getVisibleRange();
    const lines: string[] = [];
    for (let index = start; index < end; index++) {
      const item = this.items[index];
      if (!item) continue;
      const isSelected = index === this.selectedIndex;
      const itemLines = this.renderItemFn(item, isSelected, width);
      for (const line of itemLines) {
        lines.push(padRight(clampLine(line, width), width));
      }
    }

    if (this.viewportSize !== undefined && this.items.length > this.viewportSize) {
      lines.push(
        padRight(style(`(${this.selectedIndex + 1}/${this.items.length})`, { dim: true }), width),
      );
    }

    return lines;
  }

  /** 处理按键；返回 true 表示已消费（ESC 不在此处理） */
  handleInput(data: string): boolean {
    if (this.items.length === 0) return false;

    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex =
        this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      this.notifyChange();
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex =
        this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      this.notifyChange();
      return true;
    }
    if (matchesKey(data, "return")) {
      const selected = this.items[this.selectedIndex];
      if (selected && this.onSelect) this.onSelect(selected);
      return true;
    }
    return false;
  }

  private notifyChange(): void {
    const selected = this.items[this.selectedIndex];
    if (selected && this.onHighlight) this.onHighlight(selected);
  }

  private clampIndex(index: number): number {
    if (this.items.length === 0) return 0;
    return Math.max(0, Math.min(index, this.items.length - 1));
  }

  private getVisibleRange(): { start: number; end: number } {
    if (this.viewportSize === undefined) {
      return { start: 0, end: this.items.length };
    }
    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.viewportSize / 2),
        this.items.length - this.viewportSize,
      ),
    );
    return { start, end: Math.min(start + this.viewportSize, this.items.length) };
  }
}

/** ink-select-input 默认行：选中蓝色 ❯ + 蓝色文本 */
export function defaultRow(label: string, isSelected: boolean): string {
  const indicator = isSelected ? style("❯", { color: "blue" }) : " ";
  const text = isSelected ? style(label, { color: "blue" }) : label;
  return indicator + " " + text;
}

/** 列表行左侧指示条（原各个页面自定义的 `│ ` / `  `，选中青色） */
export function barIndicator(isSelected: boolean): string {
  return isSelected ? style("│ ", { color: "cyan" }) : style("  ", { color: "gray" });
}
