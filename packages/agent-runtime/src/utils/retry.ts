/**
 * 兼容垫片：旧的 agent-sdk 类型文件里以 `import('./utils/retry.js').RetryConfig`
 * 的形式引用重试配置；适配层把重试实现收敛在 src/retry.ts，这里只做类型转发。
 */

export type { RetryConfig, RetryConfig as RetryConfigType } from "../retry.js";
