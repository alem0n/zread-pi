/**
 * 全局记忆的二进制存储 —— 「追加日志 + 墓碑 + 压缩」的自描述记录文件。
 *
 * 历史记录只需要存一串项目绝对路径，读写模式固定为三件事，因此不需要
 * B 树 / 哈希索引，一个定长头部 + 变长记录的追加日志就能让三者都达到最优：
 *
 *  - 追加（每次开始生成文档时把当前项目移到末尾）：O(1)，新记录永远写在文件末尾；
 *  - 顺序遍历（history 命令 / 去重 / 压缩）：O(n)，`length` 即步长，一次顺序读完成；
 *  - 随机删除（清理已失效项目时按记录偏移删除）：O(1)，只把记录首字节写成墓碑。
 *
 * 文件布局（全部小端，无对齐填充）：
 *
 *   ┌──────────────────────── 头部 16 字节 ────────────────────────┐
 *   │ 0..3   magic      "ZRH1"（4 字节 ASCII）                     │
 *   │ 4..5   version    u16 = 1                                    │
 *   │ 6..7   flags      u16 = 0（保留，必须为 0）                   │
 *   │ 8..11  headerSize u32 = 16（保留，为将来扩展头部留路）        │
 *   │ 12..15 reserved   u32 = 0                                    │
 *   └──────────────────────────────────────────────────────────────┘
 *   ┌──────────────────────── 记录（连续追加） ────────────────────┐
 *   │ +0      tag    1 字节：0x01 = 有效，0x00 = 墓碑（已删除）     │
 *   │ +1..4   length 4 字节：路径的 UTF-8 字节数                    │
 *   │ +5..    path   length 字节：路径 UTF-8 编码，不含 NUL         │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * 空间回收：墓碑占比达到阈值时自动 `compact()`（重写只含有效记录的新文件，
 * 写临时文件后 rename 原子替换），也可手动调用。另外记录数有上限（默认 1000），
 * 超出后淘汰最旧的记录，因此文件体积有界。
 *
 * 健壮性：
 *  - 打开时识别「写了一半的尾部记录」（进程被杀 / 掉电），截断修复；
 *  - magic / version / tag / length 不合法时抛 `HistoryFormatError`，由上层备份重建；
 *  - 同一实例的读改写经内部 Promise 串行链，不会互相穿插；跨进程并发不做加锁
 *    （同一时刻多个 zread-pi 进程写同一份记忆属于异常用法，后写覆盖可容忍）。
 */

import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureDir } from '../file-io.js';

export const HISTORY_MAGIC = 'ZRH1';
export const HISTORY_VERSION = 1;
export const HISTORY_HEADER_SIZE = 16;
/** 记录头：tag(1) + length(4) */
export const HISTORY_RECORD_OVERHEAD = 5;
export const HISTORY_TAG_DELETED = 0x00;
export const HISTORY_TAG_LIVE = 0x01;
/** 单条路径的字节上限（Windows 长路径上限 32767） */
export const HISTORY_MAX_PATH_BYTES = 32_767;
/** 默认最多保留的记录数；超出后淘汰最旧的记录 */
export const HISTORY_DEFAULT_MAX_RECORDS = 1000;
/** 自动压缩阈值：墓碑数达到该值且墓碑字节不少于存活字节时才压缩 */
export const HISTORY_COMPACT_MIN_DELETED = 16;

/** 文件头 / 记录布局不合法（上层可据此备份重建） */
export class HistoryFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HistoryFormatError';
  }
}

export interface HistoryLogEntry {
  /** 记录内容（原始 UTF-8 文本；历史模块里是项目绝对路径） */
  path: string;
  /** 记录在文件中的起始偏移（随机删除 / 定位用） */
  offset: number;
}

export interface HistoryLogStats {
  /** 有效记录数 */
  live: number;
  /** 墓碑数 */
  deleted: number;
  /** 文件总字节数（含头部与墓碑） */
  bytes: number;
}

export interface HistoryLogOptions {
  /** 最多保留的记录数（默认 1000；<= 0 表示不限制） */
  maxRecords?: number;
  /** 打开时修复「写了一半的尾部记录」（默认 true） */
  repairTail?: boolean;
  /** 墓碑达到阈值时自动压缩（默认 true） */
  autoCompact?: boolean;
}

export interface HistoryAppendOptions {
  /** 同内容已存在时先删旧记录再追加（默认 true，等价于「移到最近」） */
  dedupe?: boolean;
}

function createHistoryHeader(): Buffer {
  const header = Buffer.alloc(HISTORY_HEADER_SIZE);
  header.write(HISTORY_MAGIC, 0, 'ascii');
  header.writeUInt16LE(HISTORY_VERSION, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(HISTORY_HEADER_SIZE, 8);
  header.writeUInt32LE(0, 12);
  return header;
}

function encodeHistoryPath(path: string): Buffer {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('history: 记录内容不能为空字符串');
  }
  if (path.includes('\0')) {
    throw new TypeError('history: 记录内容不能包含 NUL 字符');
  }
  const bytes = Buffer.from(path, 'utf8');
  if (bytes.length > HISTORY_MAX_PATH_BYTES) {
    throw new RangeError(`history: 记录过长（${bytes.length} > ${HISTORY_MAX_PATH_BYTES} 字节）`);
  }
  return bytes;
}

/**
 * ZRH1 二进制记录文件。
 *
 * 实例在内存中持有整个文件缓冲（历史的体量在 KB 级），因此顺序遍历无需逐条 syscall；
 * 写入只落「新追加的记录」或「被删除的那 1 个 tag 字节」，不会整文件重写。
 */
export class HistoryLog {
  private buffer: Buffer;
  private persisted: boolean;
  private liveCount = 0;
  private deletedCount = 0;
  private deletedBytes = 0;
  private chain: Promise<unknown> = Promise.resolve();

  private readonly filePath: string;
  private readonly options: Required<HistoryLogOptions>;

  private constructor(
    filePath: string,
    options: Required<HistoryLogOptions>,
    buffer: Buffer,
    persisted: boolean,
  ) {
    this.filePath = filePath;
    this.options = options;
    this.buffer = buffer;
    this.persisted = persisted;
  }

  /**
   * 打开（不存在则视为空清单）。文件损坏时抛 `HistoryFormatError`；
   * 尾部半截记录在 `repairTail`（默认 true）时自动截断修复。
   */
  static async open(filePath: string, options: HistoryLogOptions = {}): Promise<HistoryLog> {
    const resolved: Required<HistoryLogOptions> = {
      maxRecords: options.maxRecords ?? HISTORY_DEFAULT_MAX_RECORDS,
      repairTail: options.repairTail ?? true,
      autoCompact: options.autoCompact ?? true,
    };

    let buffer: Buffer;
    let persisted: boolean;
    try {
      buffer = await readFile(filePath);
      persisted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      buffer = createHistoryHeader();
      persisted = false;
    }

    const log = new HistoryLog(filePath, resolved, buffer, persisted);
    const tailInvalid = log.parse();
    if (tailInvalid) {
      if (!resolved.repairTail) {
        throw new HistoryFormatError(`history: 文件尾部有未写完的记录：${filePath}`);
      }
      // 截断修复：把最后一条半截记录丢掉，保留之前所有有效数据
      log.buffer = log.buffer.subarray(0, log.validEnd);
      await writeFile(filePath, log.buffer);
    }
    return log;
  }

  private validEnd = HISTORY_HEADER_SIZE;

  /**
   * 解析头部与全部记录，统计存活 / 墓碑。
   *
   * @returns 是否存在「写了一半的尾部记录」
   */
  private parse(): boolean {
    if (this.buffer.length < HISTORY_HEADER_SIZE) {
      throw new HistoryFormatError(
        `history: 文件头不完整（${this.buffer.length} < ${HISTORY_HEADER_SIZE} 字节）：${this.filePath}`,
      );
    }
    const magic = this.buffer.toString('ascii', 0, 4);
    if (magic !== HISTORY_MAGIC) {
      throw new HistoryFormatError(
        `history: magic 不匹配（期望 ${HISTORY_MAGIC}，实际 ${JSON.stringify(magic)}）：${this.filePath}`,
      );
    }
    const version = this.buffer.readUInt16LE(4);
    if (version !== HISTORY_VERSION) {
      throw new HistoryFormatError(
        `history: 版本不支持（期望 v${HISTORY_VERSION}，实际 v${version}）：${this.filePath}`,
      );
    }
    const headerSize = this.buffer.readUInt32LE(8);
    if (headerSize !== HISTORY_HEADER_SIZE) {
      throw new HistoryFormatError(
        `history: 头部长度不支持（期望 ${HISTORY_HEADER_SIZE}，实际 ${headerSize}）：${this.filePath}`,
      );
    }

    this.liveCount = 0;
    this.deletedCount = 0;
    this.deletedBytes = 0;
    this.validEnd = HISTORY_HEADER_SIZE;

    let offset = HISTORY_HEADER_SIZE;
    while (offset < this.buffer.length) {
      if (offset + HISTORY_RECORD_OVERHEAD > this.buffer.length) return true;
      const tag = this.buffer[offset];
      if (tag !== HISTORY_TAG_LIVE && tag !== HISTORY_TAG_DELETED) {
        throw new HistoryFormatError(
          `history: 记录 tag 非法（0x${tag.toString(16)} @ ${offset}）：${this.filePath}`,
        );
      }
      const length = this.buffer.readUInt32LE(offset + 1);
      if (length > HISTORY_MAX_PATH_BYTES) {
        throw new HistoryFormatError(
          `history: 记录长度非法（${length} > ${HISTORY_MAX_PATH_BYTES} @ ${offset}）：${this.filePath}`,
        );
      }
      const end = offset + HISTORY_RECORD_OVERHEAD + length;
      if (end > this.buffer.length) return true;
      if (tag === HISTORY_TAG_LIVE) {
        this.liveCount += 1;
      } else {
        this.deletedCount += 1;
        this.deletedBytes += end - offset;
      }
      offset = end;
      this.validEnd = end;
    }
    return false;
  }

  get path(): string {
    return this.filePath;
  }

  stats(): HistoryLogStats {
    return { live: this.liveCount, deleted: this.deletedCount, bytes: this.buffer.length };
  }

  /** 顺序遍历全部有效记录（文件顺序 = 追加顺序，最旧的在前） */
  entries(): HistoryLogEntry[] {
    const result: HistoryLogEntry[] = [];
    let offset = HISTORY_HEADER_SIZE;
    while (offset < this.buffer.length) {
      const length = this.buffer.readUInt32LE(offset + 1);
      const end = offset + HISTORY_RECORD_OVERHEAD + length;
      if (this.buffer[offset] === HISTORY_TAG_LIVE) {
        result.push({
          path: this.buffer.toString('utf8', offset + HISTORY_RECORD_OVERHEAD, end),
          offset,
        });
      }
      offset = end;
    }
    return result;
  }

  /** 追加一条记录；`dedupe`（默认 true）时同内容只保留最近一条 */
  append(path: string, options: HistoryAppendOptions = {}): Promise<HistoryLogEntry> {
    return this.enqueue(async () => {
      const payload = encodeHistoryPath(path);
      if (options.dedupe !== false) {
        for (const entry of this.entries()) {
          if (entry.path === path) {
            await this.markDeleted(entry);
            break;
          }
        }
      }

      const offset = this.buffer.length;
      const record = Buffer.allocUnsafe(HISTORY_RECORD_OVERHEAD + payload.length);
      record[0] = HISTORY_TAG_LIVE;
      record.writeUInt32LE(payload.length, 1);
      payload.copy(record, HISTORY_RECORD_OVERHEAD);

      this.buffer = Buffer.concat([this.buffer, record]);
      this.liveCount += 1;
      await this.writeRange(offset, record);
      await this.postMutation();
      return { path, offset };
    });
  }

  /** 随机删除：按记录（偏移）或内容删除一条有效记录；返回是否真的删掉了 */
  remove(target: HistoryLogEntry | string): Promise<boolean> {
    return this.enqueue(async () => {
      const entry =
        typeof target === 'string'
          ? this.entries().find((candidate) => candidate.path === target)
          : target;
      if (!entry) return false;
      const changed = await this.markDeleted(entry);
      if (changed) await this.postMutation();
      return changed;
    });
  }

  /** 清空全部记录（写回空头部） */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      this.buffer = createHistoryHeader();
      this.liveCount = 0;
      this.deletedCount = 0;
      this.deletedBytes = 0;
      this.validEnd = HISTORY_HEADER_SIZE;
      this.persisted = false;
      await this.writeWhole();
    });
  }

  /** 压缩：重写只含有效记录的文件（临时文件 + rename 原子替换） */
  compact(): Promise<HistoryLogStats> {
    return this.enqueue(async () => {
      await this.compactNow();
      return this.stats();
    });
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => task());
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 把某条有效记录改成墓碑（O(1)，只写 1 个字节） */
  private async markDeleted(entry: HistoryLogEntry): Promise<boolean> {
    // 快照偏移可能因中途 compact 而失效：先验位置，验不过再按内容重新定位
    const target = this.isLiveEntry(entry)
      ? entry
      : this.entries().find((candidate) => candidate.path === entry.path);
    if (!target) return false;

    const { offset } = target;
    const length = this.buffer.readUInt32LE(offset + 1);
    const end = offset + HISTORY_RECORD_OVERHEAD + length;

    this.buffer[offset] = HISTORY_TAG_DELETED;
    this.liveCount -= 1;
    this.deletedCount += 1;
    this.deletedBytes += end - offset;
    await this.writeRange(offset, Buffer.from([HISTORY_TAG_DELETED]));
    return true;
  }

  /** 偏移处是否确实是一条内容匹配的有效记录（防御 compact 后偏移失效） */
  private isLiveEntry(entry: HistoryLogEntry): boolean {
    const { offset } = entry;
    if (offset < HISTORY_HEADER_SIZE || offset >= this.buffer.length) return false;
    if (this.buffer[offset] !== HISTORY_TAG_LIVE) return false;
    const length = this.buffer.readUInt32LE(offset + 1);
    const end = offset + HISTORY_RECORD_OVERHEAD + length;
    if (end > this.buffer.length) return false;
    return this.buffer.toString('utf8', offset + HISTORY_RECORD_OVERHEAD, end) === entry.path;
  }

  /** 写范围：首次写（文件不存在）时整文件落盘，之后只写改动区间 */
  private async writeRange(offset: number, bytes: Buffer): Promise<void> {
    if (!this.persisted) {
      await this.writeWhole();
      return;
    }
    const handle = await open(this.filePath, 'r+');
    try {
      await handle.write(bytes, 0, bytes.length, offset);
    } finally {
      await handle.close();
    }
  }

  private async writeWhole(): Promise<void> {
    await ensureDir(dirname(this.filePath));
    await writeFile(this.filePath, this.buffer);
    this.persisted = true;
  }

  /** 每次增删后的维护：淘汰超限的最旧记录 + 按需压缩 */
  private async postMutation(): Promise<void> {
    if (this.options.maxRecords > 0) {
      while (this.liveCount > this.options.maxRecords) {
        const oldest = this.entries()[0];
        if (!oldest) break;
        await this.markDeleted(oldest);
      }
    }
    if (this.options.autoCompact && this.shouldCompact()) {
      await this.compactNow();
    }
  }

  private liveBytes(): number {
    return this.buffer.length - HISTORY_HEADER_SIZE - this.deletedBytes;
  }

  private shouldCompact(): boolean {
    return this.deletedCount >= HISTORY_COMPACT_MIN_DELETED && this.deletedBytes >= this.liveBytes();
  }

  private async compactNow(): Promise<void> {
    if (this.deletedCount === 0) return;
    const chunks: Buffer[] = [this.buffer.subarray(0, HISTORY_HEADER_SIZE)];
    let offset = HISTORY_HEADER_SIZE;
    let live = 0;
    while (offset < this.buffer.length) {
      const length = this.buffer.readUInt32LE(offset + 1);
      const end = offset + HISTORY_RECORD_OVERHEAD + length;
      if (this.buffer[offset] === HISTORY_TAG_LIVE) {
        chunks.push(this.buffer.subarray(offset, end));
        live += 1;
      }
      offset = end;
    }

    const next = Buffer.concat(chunks);
    const temp = `${this.filePath}.compact-${process.pid}-${Date.now()}`;
    await ensureDir(dirname(this.filePath));
    await writeFile(temp, next);
    // rename 原子替换（Windows / Linux / macOS 均支持覆盖已存在文件）
    await rename(temp, this.filePath);
    this.buffer = next;
    this.liveCount = live;
    this.deletedCount = 0;
    this.deletedBytes = 0;
    this.validEnd = next.length;
    this.persisted = true;
  }
}
