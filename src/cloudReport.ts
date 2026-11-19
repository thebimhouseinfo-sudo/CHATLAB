import * as SecureStore from 'expo-secure-store';
import type { Benchmark } from './bench';
import type { ChatSession } from './chatStore';
import { MODELS } from './models';

const ENDPOINT_KEY = 'chatlab.cloud.endpoint';
const TOKEN_KEY = 'chatlab.cloud.token';
const INSTALL_KEY = 'chatlab.cloud.install';
const MAX_REPORT_BYTES = 750_000;

export type CloudConfig = { endpoint: string; token: string };

export type CloudReport = {
  schemaVersion: 1;
  reportId: string;
  sessionId: string;
  generatedAt: string;
  includeTranscript: boolean;
  session: {
    title: string;
    createdAt: string;
    updatedAt: string;
    model: { id: string; name: string; quant: string };
    device: string;
    platform: string;
    turns: number;
    messages: number;
    textCharacters: number;
  };
  summary: {
    measuredTurns: number;
    missingMeasurements: number;
    completedTurns: number;
    maxContextWindow: number | null;
    peakPromptTokens: number | null;
    lastPromptTokens: number | null;
    averagePrefillTokensPerSecond: number | null;
    averageDecodeTokensPerSecond: number | null;
    totalGeneratedTokens: number;
    totalPromptTokens: number;
    contextTruncated: boolean;
  };
  benchmarks: Benchmark[];
  transcript: Array<{ role: 'user' | 'assistant'; text: string }> | null;
};

const average = (values: number[]): number | null => {
  const valid = values.filter(v => Number.isFinite(v) && v > 0);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
};

export function buildCloudReport(
  session: ChatSession,
  records: Benchmark[],
  installationId: string,
  includeTranscript: boolean,
): CloudReport {
  const model = MODELS.find(m => m.id === session.modelId);
  const benchmarks = records
    .filter(row => row.chatId === session.id && row.modelId === session.modelId)
    .sort((a, b) => a.date.localeCompare(b.date));
  const turns = session.messages.filter(m => m.role === 'user').length;
  const completed = benchmarks.filter(row => row.status === 'completed');
  const contextRows = benchmarks.filter(row => typeof row.contextPromptTokens === 'number');
  const promptSizes = contextRows.map(row => row.contextPromptTokens!);
  const windows = benchmarks.map(row => row.contextWindow).filter((v): v is number => typeof v === 'number');
  const sorted = [...contextRows].sort((a, b) => a.date.localeCompare(b.date));
  return {
    schemaVersion: 1,
    reportId: installationId + ':' + session.id,
    sessionId: session.id,
    generatedAt: new Date().toISOString(),
    includeTranscript,
    session: {
      title: includeTranscript ? session.title : 'Chat session',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      model: {
        id: session.modelId,
        name: model?.name ?? session.modelId,
        quant: model?.quant ?? 'unknown',
      },
      device: benchmarks[0]?.device ?? 'Unknown device',
      platform: benchmarks[0]?.platform ?? 'Unknown platform',
      turns,
      messages: session.messages.length,
      textCharacters: session.messages.reduce((sum, m) => sum + m.text.length, 0),
    },
    summary: {
      measuredTurns: benchmarks.length,
      missingMeasurements: Math.max(0, turns - benchmarks.length),
      completedTurns: completed.length,
      maxContextWindow: windows.length ? Math.max(...windows) : null,
      peakPromptTokens: promptSizes.length ? Math.max(...promptSizes) : null,
      lastPromptTokens: sorted.length ? sorted[sorted.length - 1].contextPromptTokens ?? null : null,
      averagePrefillTokensPerSecond: average(completed.map(r => r.prefillTokensPerSec)),
      averageDecodeTokensPerSecond: average(completed.map(r => r.decodeTokensPerSec)),
      totalGeneratedTokens: completed.reduce((sum, row) => sum + row.generatedTokens, 0),
      totalPromptTokens: completed.reduce((sum, row) => sum + row.promptTokens, 0),
      contextTruncated: benchmarks.some(r => r.contextTruncated === true),
    },
    benchmarks,
    transcript: includeTranscript
      ? session.messages.map(m => ({ role: m.role, text: m.text }))
      : null,
  };
}

export async function readCloudConfig(): Promise<CloudConfig | null> {
  const [endpoint, token] = await Promise.all([
    SecureStore.getItemAsync(ENDPOINT_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  return endpoint && token ? { endpoint, token } : null;
}

export async function saveCloudConfig(endpoint: string, token: string): Promise<void> {
  const url = endpoint.trim();
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Endpoint phải là URL HTTPS hợp lệ.'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error('Cloud endpoint phải dùng HTTPS, không chứa username/password.');
  }
  if (!token.trim() || token.trim().length < 24) {
    throw new Error('Access key phải có ít nhất 24 ký tự.');
  }
  await SecureStore.setItemAsync(ENDPOINT_KEY, url);
  await SecureStore.setItemAsync(TOKEN_KEY, token.trim());
}

export async function clearCloudConfig(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ENDPOINT_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY),
  ]);
}

export async function getInstallationId(): Promise<string> {
  const current = await SecureStore.getItemAsync(INSTALL_KEY);
  if (current) return current;
  // This identifier is for stable upsert only; it is NOT an authentication token.
  const generated = 'device-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  await SecureStore.setItemAsync(INSTALL_KEY, generated);
  return generated;
}

// The only network transmission path. Never call from effects, timers or background jobs.
export async function pushCloudReport(report: CloudReport, config: CloudConfig): Promise<void> {
  const body = JSON.stringify(report);
  if (body.length > MAX_REPORT_BYTES) {
    throw new Error('Report quá lớn. Bỏ chọn nội dung chat, hoặc tạo phiên ngắn hơn.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-chatlab-report-key': config.token,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      // Never echo response bodies: a proxy could reflect credentials.
      throw new Error('Cloud trả HTTP ' + response.status + '. Báo cáo local vẫn được giữ.');
    }
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' ||
      (result as { ok?: unknown }).ok !== true ||
      (result as { reportId?: unknown }).reportId !== report.reportId) {
      throw new Error('Cloud không xác nhận đúng mã báo cáo.');
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Hết thời gian kết nối. Kiểm tra mạng rồi nhấn Push lại.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
