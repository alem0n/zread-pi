/**
 * TextField - 单行输入框（对齐 ink-text-input 的按键语义）
 *
 * ink-text-input 的行为：
 * - ↑/↓/Tab/Shift+Tab 不处理（交给页面）
 * - Enter：提交
 * - ←/→：移动光标
 * - Backspace / Delete：删除光标前一个字符
 * - 其余按键：插入到光标处
 *
 * 内部复用 pi-tui 的 Input（水平滚动、Emacs 快捷键、括号粘贴、CURSOR_MARKER）。
 */

import { Input, matchesKey, type Component } from "@earendil-works/pi-tui";
import { style } from "../ansi";

const BACKSPACE = "\x7f";
/** 真实的 End 键序列：用于把光标移到文本末尾 */
const END_KEY = "\x1b[F";

export interface TextFieldOptions {
  value?: string;
  placeholder?: string;
  /** 值变化回调（等价 ink-text-input 的 onChange） */
  onChange?: (value: string) => void;
  /** 回车回调（等价 ink-text-input 的 onSubmit） */
  onSubmit?: (value: string) => void;
}

export class TextField implements Component {
  private input: Input;

  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;

  constructor(options: TextFieldOptions = {}) {
    this.input = new Input({
      prompt: "",
      placeholder: options.placeholder ?? "",
      // ink-text-input 用 chalk.grey 渲染 placeholder
      placeholderStyle: (text) => style(text, { color: "gray" }),
    });
    if (options.value) this.input.setValue(options.value);
    this.onChange = options.onChange;
    this.onSubmit = options.onSubmit;
    this.input.onSubmit = (value) => this.onSubmit?.(value);
    this.input.focused = true;
  }

  getValue(): string {
    return this.input.getValue();
  }

  setValue(value: string): void {
    this.input.setValue(value);
    // pi-tui 的 Input.setValue 不会移动光标（光标保持在最小位置），
    // 而 ink-text-input 始终把光标放在文本末尾；这里补一个 End 键保持行为一致。
    this.input.handleInput(END_KEY);
  }

  /** 只有当前激活的输入框才输出硬件光标标记（IME 定位） */
  setFocused(focused: boolean): void {
    this.input.focused = focused;
  }

  setPlaceholder(placeholder: string): void {
    // Input 的 placeholder 为只读，重建代价高；这里直接改内部字段以保持行为一致
    (this.input as unknown as { placeholder: string }).placeholder = placeholder;
    this.input.invalidate();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  /** 处理按键；返回值无实际意义（页面自行决定是否消费 ESC） */
  handleKey(data: string): void {
    // ink-text-input 显式忽略这些按键
    if (
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      data === "\t" ||
      matchesKey(data, "shift+tab")
    ) {
      return;
    }

    const before = this.input.getValue();

    if (matchesKey(data, "delete")) {
      // ink-text-input 中 Delete 与 Backspace 同为「向前删除」
      this.input.handleInput(BACKSPACE);
    } else {
      this.input.handleInput(data);
    }

    const after = this.input.getValue();
    if (after !== before) {
      this.onChange?.(after);
    }
  }

  render(width: number): string[] {
    return this.input.render(width);
  }
}
