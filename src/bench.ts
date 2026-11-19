import * as FS from 'expo-file-system/legacy';

export type Benchmark = {
  modelId: string;
  quant: string;
  chatId?: string;
  turnIndex?: number;
  contextWindow?: number;
  contextPromptTokens?: number;
  contextTruncated?: boolean;
  requestedMaxTokens?: number;
  voiceLocale?: string;
  voiceSttMs?: number;
  voiceTtsStartMs?: number;
  voiceTtsDurationMs?: number;
  voiceRoundtripToSpeechMs?: number;
  voiceTtsStatus?: 'completed' | 'stopped' | 'error';
  platform: string;
  device: string;
  date: string;
  loadMs: number;
  ttftMs: number | null;
  promptTokens: number;
  prefillTokensPerSec: number;
  generatedTokens: number;
  decodeTokensPerSec: number;
  generationMs: number;
  totalMs: number;
  gpu: boolean | null;
  status: 'completed' | 'stopped' | 'error';
  error?: string;
};

const file = FS.documentDirectory + 'benchmarks.json';

export async function readBenchmarks(): Promise<Benchmark[]> {
  const info = await FS.getInfoAsync(file);
  if (!info.exists) return [];
  try {
    const data: unknown = JSON.parse(await FS.readAsStringAsync(file));
    return Array.isArray(data) ? data as Benchmark[] : [];
  } catch {
    return [];
  }
}

// Serialized writes prevent late TTS callbacks overwriting newly saved chat turns.
let benchmarkWriteQueue: Promise<void> = Promise.resolve();

function modifyBenchmarks(updater: (rows: Benchmark[]) => Benchmark[]): Promise<void> {
  benchmarkWriteQueue = benchmarkWriteQueue.catch(() => {}).then(async () => {
    const rows = updater(await readBenchmarks());
    await FS.writeAsStringAsync(file, JSON.stringify(rows.slice(-500), null, 2));
  });
  return benchmarkWriteQueue;
}

export async function appendBenchmark(entry: Benchmark): Promise<void> {
  await modifyBenchmarks(rows => [...rows, entry]);
}

export type VoiceTimingUpdate = Pick<
  Benchmark,
  'voiceTtsStartMs' | 'voiceTtsDurationMs' |
  'voiceRoundtripToSpeechMs' | 'voiceTtsStatus'
>;

export async function updateVoiceBenchmark(
  chatId: string, turnIndex: number, changes: Partial<VoiceTimingUpdate>,
): Promise<void> {
  await modifyBenchmarks(rows => rows.map(row =>
    row.chatId === chatId && row.turnIndex === turnIndex ? { ...row, ...changes } : row));
}

export function csvBenchmark(rows: Benchmark[]): string {
  const fields: (keyof Benchmark)[] = [
    'date','device','platform','modelId','quant','chatId','turnIndex','contextWindow',
    'contextPromptTokens','contextTruncated','requestedMaxTokens',
    'voiceLocale','voiceSttMs','voiceTtsStartMs','voiceTtsDurationMs',
    'voiceRoundtripToSpeechMs','voiceTtsStatus',
    'status','loadMs','ttftMs',
    'promptTokens','prefillTokensPerSec','generatedTokens',
    'decodeTokensPerSec','generationMs','totalMs','gpu','error',
  ];
  const quote = (value: unknown): string => {
    const str = value == null ? '' : String(value);
    return '"' + str.replace(/"/g, '""') + '"';
  };
  return [fields.join(','), ...rows.map(r => fields.map(k => quote(r[k])).join(','))].join('\n');
}
