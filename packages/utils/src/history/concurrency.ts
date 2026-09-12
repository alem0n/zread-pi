/**
 * 固定并发的异步映射（零依赖，不引入 p-limit 之外的额外包）。
 *
 * 文件系统探测（stat）是 I/O 等待型任务，单线程逐个 await 会白白串行；
 * 用固定数量 worker 并发执行可显著加快「遍历全部历史记录检查目录是否存在」。
 * 结果数组与输入顺序一一对应（与并发度无关），便于稳定地在 UI 展示。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const normalized = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const workerCount = Math.min(Math.max(1, normalized), items.length);
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
