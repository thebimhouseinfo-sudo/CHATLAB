import {
  ModelCategory, ensureModel, isModelDownloaded, refreshModels,
} from 'react-native-sherpa-onnx/download';
import { createTTS, type TtsEngine } from 'react-native-sherpa-onnx/tts';

// Separate Vietnamese ONNX VITS model. This is NOT the browser MMS checkpoint from KEVoice.
// The WAV/PCM remains in the native app; no remote WebView or TTS API.
export const OFFLINE_TTS_MODEL = 'vits-piper-vi_VN-vais1000-medium-int8';
const MAX_SPOKEN_CHARS = 450;

export async function offlineTtsReady(): Promise<boolean> {
  return isModelDownloaded(ModelCategory.Tts, OFFLINE_TTS_MODEL);
}

export async function installOfflineTts(
  onProgress?: (phase: string, percent: number | null) => void,
): Promise<void> {
  onProgress?.('Đang lấy danh sách TTS...', null);
  await refreshModels(ModelCategory.Tts);
  await ensureModel(ModelCategory.Tts, OFFLINE_TTS_MODEL, {
    onProgress: p => onProgress?.(p.phase, typeof p.percent === 'number' ? p.percent : null),
  });
  if (!(await offlineTtsReady())) throw new Error('Model Piper TTS chưa tải hoàn chỉnh.');
}

export type OfflineTtsResult = {
  loadMs: number;
  synthesisMs: number;
  toPlaybackMs: number; // native player enqueue/start, not hardware first PCM timestamp
  audioDurationMs: number;
  elapsedMs: number;
  realTimeFactor: number;
};

export class OfflineTtsPlayer {
  private engine: TtsEngine | null = null;
  private token = 0;

  async speak(text: string, onPlaybackStart?: () => void): Promise<OfflineTtsResult> {
    const run = ++this.token;
    if (!text.trim()) throw new Error('Không có chữ để đọc.');
    if (!(await offlineTtsReady())) throw new Error('Chưa tải Piper TTS tiếng Việt.');
    const started = Date.now();
    const installed = await ensureModel(ModelCategory.Tts, OFFLINE_TTS_MODEL);
    const loadStart = Date.now();
    const engine = await createTTS({
      modelPath: { type: 'file', path: installed.localPath },
      modelType: 'vits',
      numThreads: 2,
    });
    this.engine = engine;
    const loadMs = Date.now() - loadStart;
    try {
      const synthStart = Date.now();
      const audio = await engine.generateSpeech(text.slice(0, MAX_SPOKEN_CHARS), { sid: 0 });
      const synthesisMs = Date.now() - synthStart;
      if (run !== this.token) throw new Error('Đã dừng TTS.');
      if (!audio.samples.length || !audio.sampleRate) throw new Error('TTS không tạo được mẫu âm thanh.');
      const durationMs = Math.round(audio.samples.length / audio.sampleRate * 1000);
      await engine.startPcmPlayer(audio.sampleRate, 1);
      if (run !== this.token) throw new Error('Đã dừng TTS.');
      // Player queues PCM natively; this is a timestamp proxy, not physical speaker measurement.
      onPlaybackStart?.();
      const timeAtPlayback = Date.now() - started;
      const chunkSize = 12000;
      for (let i = 0; i < audio.samples.length; i += chunkSize) {
        if (run !== this.token) throw new Error('Đã dừng TTS.');
        await engine.writePcmChunk(audio.samples.slice(i, i + chunkSize));
      }
      // The API has no playback-complete callback. Leave time for native audio output.
      const deadline = Date.now() + Math.min(durationMs + 300, 45000);
      while (Date.now() < deadline && run === this.token) {
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      if (run !== this.token) throw new Error('Đã dừng TTS.');
      return {
        loadMs, synthesisMs, toPlaybackMs: timeAtPlayback,
        audioDurationMs: durationMs, elapsedMs: Date.now() - started,
        realTimeFactor: durationMs ? synthesisMs / durationMs : 0,
      };
    } finally {
      try { await engine.stopPcmPlayer(); } catch { /* player may never have started */ }
      await engine.destroy();
      if (this.engine === engine) this.engine = null;
    }
  }

  async stop(): Promise<void> {
    this.token += 1;
    const current = this.engine;
    try { await current?.stopPcmPlayer(); } catch { /* already finished */ }
  }
}
