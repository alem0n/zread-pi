/**
 * FileCredentialStore —— pi-ai CredentialStore 的 open_zread 实现。
 *
 * 落盘位置：~/.zread/auth.json（与 pi coding-agent 同格式）
 *   { "<providerId>": Credential }
 *
 * 为什么单独放一个文件：
 * - pi-ai 的 Models.login()/getAuth() 要求一个 CredentialStore，登录结果由它持久化；
 * - 多个 Provider 的凭据互不覆盖，天然支持「同时配置多个提供商」；
 * - 凭据（可能含 OAuth refresh token）不进 config.yaml。
 *
 * 写入策略：先写临时文件再 rename（原子替换），并按 Provider 串行化 read-modify-write。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';
import { getZreadAuthPath } from '@open-zread/utils';

type AuthFileData = Record<string, Credential>;

/** 一个 Provider 一个串行链，避免并发 login/refresh 互相覆盖 */
type Chain = Promise<unknown>;

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'api_key' || type === 'oauth';
}

export class FileCredentialStore implements CredentialStore {
  private chains = new Map<string, Chain>();

  constructor(private readonly filePath: string = getZreadAuthPath()) {}

  private async readAll(): Promise<AuthFileData> {
    if (!existsSync(this.filePath)) return {};
    const content = await readFile(this.filePath, 'utf-8');
    if (!content.trim()) return {};
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const result: AuthFileData = {};
      for (const [id, credential] of Object.entries(parsed as Record<string, unknown>)) {
        if (isCredential(credential)) result[id] = credential;
      }
      return result;
    } catch {
      // auth.json 损坏时自愈：备份原文件后从空表开始，避免整个 CLI 无法启动
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        await rename(this.filePath, backup);
      } catch {
        // 备份失败也不阻塞使用
      }
      return {};
    }
  }

  private async writeAll(data: AuthFileData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    await rename(temp, this.filePath);
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    const signal = options?.signal;
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const queued = (async () => {
      await previous.catch(() => {});
      signal?.throwIfAborted();
      return task();
    })();
    const tail = queued.catch(() => {});
    this.chains.set(providerId, tail);
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
    });
    if (signal) {
      return Promise.race([
        queued,
        new Promise<T>((_, reject) => {
          const abort = () => reject(signal.reason ?? new Error('aborted'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    }
    return queued;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const data = await this.readAll();
    return data[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const data = await this.readAll();
    return Object.entries(data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(
      providerId,
      async () => {
        const data = await this.readAll();
        const current = data[providerId];
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        if (next !== undefined) {
          data[providerId] = next;
          await this.writeAll(data);
        }
        return next ?? current;
      },
      options,
    );
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(
      providerId,
      async () => {
        const data = await this.readAll();
        if (providerId in data) {
          delete data[providerId];
          await this.writeAll(data);
        }
      },
      options,
    );
  }
}
