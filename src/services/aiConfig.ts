/**
 * AI 配置管理 — 读写 localStorage
 * 支持 DeepSeek / OpenAI / Ollama / 通义千问 等兼容 OpenAI 协议的 provider
 */

export interface AIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 深度模式开关（Bangumi 评论挖掘） */
  deepMode: boolean;
}

const CONFIG_KEY = 'anime_diary_ai_config';

const DEFAULT_CONFIG: AIConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  deepMode: false,
};

export function loadAIConfig(): AIConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const saved = JSON.parse(raw);
    return {
      baseUrl: saved.baseUrl || DEFAULT_CONFIG.baseUrl,
      apiKey: saved.apiKey || '',
      model: saved.model || DEFAULT_CONFIG.model,
      deepMode: saved.deepMode ?? false,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveAIConfig(config: AIConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

/** 是否已配置 API Key */
export function hasAIConfig(): boolean {
  return loadAIConfig().apiKey.length > 0;
}
