/**
 * RunLogSink 工厂 —— 绑定 Agent 身份。
 *
 * `sessionRoot` 是 pi 会话落盘根目录（`<runDir>/sessions/`），传给适配层，
 * 让本次 Agent 的完整会话写进该目录（方案 C：会话 = 唯一完整事实源）。
 * pi 会话 id 由适配层在 query 时生成，经 system/init 流回后由
 * create-agent 写进 agent_config 事件，投影层据此 join 会话文件。
 */

import type { RunEventAgentMeta } from '@zread-pi/types';
import type { AppendRunEvent, RunLogWriter } from '@zread-pi/utils';
import type { RunLogSink } from './create-agent.js';

/**
 * 把 Agent 身份绑定到一个 sink 上。
 * runLog 缺省时返回 undefined（兼容不记录轨迹的旧调用方）。
 *
 * 方案 C 后 sink 不再生成 sessionId（会话由 pi 的 JsonlSessionRepo 落盘，
 * 一个 Agent 一个文件，事件归属结构性成立）。agent_config 会把适配层
 * 生成的 pi 会话 id 带在事件上，append 时与这里的绑定身份合并。
 */
export function createRunLogSink(
  runLog: RunLogWriter | undefined,
  agent: Omit<RunEventAgentMeta, 'sessionId'>,
): RunLogSink | undefined {
  if (runLog === undefined) return undefined;
  const identity: RunEventAgentMeta = { ...agent };
  return {
    sessionRoot: runLog.sessionsRoot,
    append: (event: AppendRunEvent): void => {
      // 事件自带的 agent 字段（如 agent_config 的 sessionId）优先于绑定身份
      runLog.append({
        ...event,
        agent: { ...identity, ...(event.agent ?? {}) },
      });
    },
  };
}
