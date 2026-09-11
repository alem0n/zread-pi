/**
 * FileModelsStore —— pi-ai ModelsStore 的落盘实现。
 *
 * 落盘位置：~/.zread/models-store.json
 *   { "<providerId>": { models, checkedAt, lastModified, etag } }
 *
 * 动态 Provider（如 opencode / vercel-ai-gateway / radius）刷新出的模型目录
 * 缓存在这里，离线启动时可以直接恢复上一次的列表。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from '@earendil-works/pi-ai';
import { getZreadModelsStorePath } from '@zread-pi/utils';

type StoreData = Record<string, ModelsStoreEntry>;

export class FileModelsStore implements ModelsStore {
  constructor(private readonly filePath: string = getZreadModelsStorePath()) {}

  private async readAll(): Promise<StoreData> {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as StoreData;
    } catch {
      return {};
    }
  }

  private async writeAll(data: StoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(data)}\n`, 'utf-8');
    await rename(temp, this.filePath);
  }

  async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
    options?.signal?.throwIfAborted();
    return (await this.readAll())[providerId];
  }

  async write(
    providerId: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    const data = await this.readAll();
    data[providerId] = entry;
    await this.writeAll(data);
  }

  async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    const data = await this.readAll();
    if (providerId in data) {
      delete data[providerId];
      await this.writeAll(data);
    }
  }
}
