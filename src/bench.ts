import * as FS from 'expo-file-system/legacy';

export type Benchmark = {
  modelId: string;
  quant: string;
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

export async function appendBenchmark(entry: Benchmark): Promise<void> {
  const rows = await readBenchmarks();
  rows.push(entry);
  await FS.writeAsStringAsync(file, JSON.stringify(rows.slice(-500), null, 2));
}

export function csvBenchmark(rows: Benchmark[]): string {
  const fields: (keyof Benchmark)[] = [
    'date','device','platform','modelId','quant','status','loadMs','ttftMs',
    'promptTokens','prefillTokensPerSec','generatedTokens',
    'decodeTokensPerSec','generationMs','totalMs','gpu','error',
  ];
  const quote = (value: unknown): string => {
    const str = value == null ? '' : String(value);
    return '"' + str.replace(/"/g, '""') + '"';
  };
  return [fields.join(','), ...rows.map(r => fields.map(k => quote(r[k])).join(','))].join('\n');
}
