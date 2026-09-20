/**
 * RunLogSink 工厂 —— 绑定 Agent 身份并生成全局唯一的 sessionId。
 *
 * `sessionId` 一物三用：
 * 1. 传给适配层，作为 **pi 会话的 sessionId**（`HarnessQueryRequest.sessionId`，
 *    经 `system/init` 事件原样流回）；
 * 2. 写进该 Agent **每条轨迹事件的 `agent.sessionId`**；
 * 3. replay 折叠时作为**事件的归属键**。
 *
 * 为什么需要它：并发 Agent（topics 按 section 并发、page 按 p-limit 并发）
 * 的事件在 events.jsonl 里必然交错。若靠「最近一个 agent_start」的单一指针
 * 归属，后来的 Agent 会吞掉前面 Agent 的事件，某个 agent_end 更会把指针清空、
 * 导致仍在跑的其他 Agent 后续消息整条丢失。每条事件自带全局唯一的 sessionId
 * 后，归属只看事件自己，与到达顺序无关。
 */

import type { RunEventAgentMeta } from '@zread-pi/types';
import type { AppendRunEvent, RunLogWriter } from '@zread-pi/utils';
import type { RunLogSink } from './create-agent.js';

/**
 * 生成一个全局唯一的 session id（可读、文件系统安全）。
 * 时间戳保证大体有序（与 run 内事件时序一致），随机后缀避免同一毫秒
 * 并发启动的 Agent 撞车。
 */
export function generateSessionId(now: Date = new Date()): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  const milli = String(now.getUTCMilliseconds()).padStart(3, '0');
  const stamp =
    `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}` +
    `${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}${milli}`;
  const rand = Math.random().toString(16).slice(2, 10);
  return `zread-pi-${stamp}-${rand}`;
}

/**
 * 把 Agent 身份（含新生成的 sessionId）绑定到一个 sink 上。
 * runLog 缺省时返回 undefined（兼容不记录轨迹的旧调用方）。
 */
export function createRunLogSink(
  runLog: RunLogWriter | undefined,
  agent: Omit<RunEventAgentMeta, 'sessionId'>,
): RunLogSink | undefined {
  if (runLog === undefined) return undefined;
  const sessionId = generateSessionId();
  const identity: RunEventAgentMeta = { ...agent, sessionId };
  return {
    sessionId,
    // pi 会话落盘根目录（`<runDir>/sessions/`）：传给适配层，
    // 让本次 Agent 的完整会话写进该目录（方案 C：会话 = 唯一完整事实源）
    sessionRoot: runLog.sessionsRoot,
    append: (event: AppendRunEvent): void => {
      runLog.append({ ...event, agent: identity });
    },
  };
}
