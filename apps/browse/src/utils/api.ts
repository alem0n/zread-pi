// apps/browse/src/utils/api.ts
import axios from 'axios';
import type {
  ChatHistoryPayload,
  ChatRequest,
  ChatResponse,
} from '@/features/chat/types';
import type { BlueprintDetailLevel, WikiOutput, WikiVariantsResponse } from '@/types/wiki';
import type { LanguageCode } from '@/i18n/types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
export const API_TIMEOUT_MS = 30000;

/**
 * `?detail=` 参数的编码：
 * - undefined / null → 不带参数（服务端按配置档位解析；null = 尚未加载）
 * - 档位名 → 原值
 */
function detailParams(detail?: BlueprintDetailLevel | null): Record<string, string> | undefined {
  if (!detail) return undefined;
  return { detail };
}

export interface WikiContentResponse {
  content: string;
}

export interface WikiSourceResponse {
  code: string;
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT_MS,
});

export const wikiApi = {
  /** 可浏览的档位变体清单 */
  getVariants: async () => {
    const response = await api.get<WikiVariantsResponse>('/wiki/variants');
    return response.data;
  },

  getCatalog: async (detail?: BlueprintDetailLevel | null) => {
    const response = await api.get<WikiOutput>('/wiki/catalog', { params: detailParams(detail) });
    return response.data;
  },

  getContent: async (slug: string, detail?: BlueprintDetailLevel | null) => {
    const response = await api.get<WikiContentResponse>(`/wiki/content/${slug}`, {
      params: detailParams(detail),
    });
    return response.data;
  },

  getSource: async (
    filePath: string,
    startLine?: number,
    endLine?: number,
    detail?: BlueprintDetailLevel | null,
  ) => {
    const params = new URLSearchParams();
    params.append('file', filePath);
    if (startLine !== undefined) params.append('startLine', String(startLine));
    if (endLine !== undefined) params.append('endLine', String(endLine));
    const detailQuery = detailParams(detail);
    if (detailQuery) params.append('detail', detailQuery.detail);
    const response = await api.get<WikiSourceResponse>(`/wiki/source?${params.toString()}`);
    return response.data;
  },
};

export const i18nApi = {
  /** 界面语言（由 CLI 配置的 language 字段解析，见 browse-server 的 /api/i18n） */
  getLocale: async (): Promise<LanguageCode> => {
    const response = await api.get<{ locale: LanguageCode }>('/i18n');
    return response.data.locale;
  },
};

export const chatApi = {
  send: async (request: ChatRequest, signal?: AbortSignal) => {
    const response = await api.post<ChatResponse>('/chat', request, { signal });
    return response.data;
  },
};

export const chatHistoryApi = {
  load: async () => {
    const response = await api.get<ChatHistoryPayload>('/chat/history');
    return response.data;
  },

  save: async (payload: ChatHistoryPayload) => {
    const response = await api.put<ChatHistoryPayload>('/chat/history', payload);
    return response.data;
  },

  deleteSession: async (sessionId: string) => {
    const response = await api.delete<ChatHistoryPayload>(
      `/chat/history/${encodeURIComponent(sessionId)}`,
    );
    return response.data;
  },
};

export default api;
