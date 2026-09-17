/**
 * JsonTree 组件级测试 —— 也是组件测试基建的冒烟用例（happy-dom + RTL + jest-dom）。
 *
 * 注意：RTL 的文本查询只匹配元素的「直接文本子节点」，JsonTree 的键名冒号在
 * 嵌套 span 里（"name" 与 ":" 分开），所以按键名 / 值分别断言，不要拼成
 * `"name":`。
 */

import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { JsonTree } from '../JsonTree';

describe('JsonTree', () => {
  it('渲染原始字符串（带引号）', () => {
    render(<JsonTree value="hello" />);
    expect(screen.getByText('"hello"')).toBeInTheDocument();
  });

  it('渲染数字与布尔', () => {
    render(<JsonTree value={42} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('空对象渲染为 {}', () => {
    render(<JsonTree value={{}} />);
    expect(screen.getByText('{}')).toBeInTheDocument();
  });

  it('defaultExpandedDepth=1 时展开第一层', () => {
    render(<JsonTree value={{ name: 'pi', count: 3 }} defaultExpandedDepth={1} />);
    expect(screen.getByText('"name"')).toBeInTheDocument();
    expect(screen.getByText('"pi"')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('默认折叠时只显示摘要，点击后展开', () => {
    render(<JsonTree value={{ name: 'pi' }} defaultExpandedDepth={0} />);
    // 折叠态：键值对不渲染，只显示 {1} 摘要
    expect(screen.getByText('{1}')).toBeInTheDocument();
    expect(screen.queryByText('"pi"')).not.toBeInTheDocument();

    // 点击折叠按钮展开（fireEvent 会同步刷新 React 状态）
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('"pi"')).toBeInTheDocument();
  });

  it('长字符串节点带 break-all（不横向溢出）', () => {
    const long = 'x'.repeat(2_000);
    const { container } = render(<JsonTree value={long} />);
    // 原始值节点是 break-all 的 span（修复解析失败的巨型 JSON 溢出）
    const valueNode = container.querySelector('.break-all');
    expect(valueNode).not.toBeNull();
    expect(valueNode?.textContent).toBe(`"${long}"`);
  });

  it('数组渲染为 [N] 摘要并可展开', () => {
    render(<JsonTree value={[1, 2, 3]} defaultExpandedDepth={0} />);
    expect(screen.getByText('[3]')).toBeInTheDocument();
  });

  it('嵌套对象递归渲染', () => {
    render(<JsonTree value={{ outer: { inner: 'deep' } }} defaultExpandedDepth={3} />);
    expect(screen.getByText('"inner"')).toBeInTheDocument();
    expect(screen.getByText('"deep"')).toBeInTheDocument();
  });

  it('null 与 undefined 的区分', () => {
    render(<JsonTree value={null} />);
    expect(screen.getByText('null')).toBeInTheDocument();
  });
});
