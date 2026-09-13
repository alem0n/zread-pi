/**
 * 极简异步队列：把 harness 的订阅式事件转成 AsyncGenerator 的 yield 序列。
 *
 * 与裸 agent loop 时期保持同一实现：每个 run 段一个队列，段结束后 close()，
 * `for await (const message of queue)` 自然收敛。
 */

export class AsyncQueue<T> implements AsyncIterable<T> {
	private readonly items: T[] = [];
	private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
	private closed = false;

	push(item: T): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: item, done: false });
		else this.items.push(item);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter({ value: undefined as unknown as T, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: (): Promise<IteratorResult<T>> => {
				const item = this.items.shift();
				if (item !== undefined) return Promise.resolve({ value: item, done: false });
				if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
				return new Promise((resolve) => this.waiters.push(resolve));
			},
		};
	}
}
