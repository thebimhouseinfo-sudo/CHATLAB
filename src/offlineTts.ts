import {
  ModelCategory, ensureModel, isModelDownloaded, refreshModels,
} from 'react-native-sherpa-onnx/download';
import { createStreamingTTS, type StreamingTtsEngine } from 'react-native-sherpa-onnx/tts';

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
  private engine: StreamingTtsEngine | null = null;
  private token = 0;

  async speak(text: string, onPlaybackStart?: () => void): Promise<OfflineTtsResult> {
    const run = ++this.token;
    if (!text.trim()) throw new Error('Không có chữ để đọc.');
    if (!(await offlineTtsReady())) throw new Error('Chưa tải Piper TTS tiếng Việt.');
    const started = Date.now();
    const installed = await ensureModel(ModelCategory.Tts, OFFLINE_TTS_MODEL);
    const loadStart = Date.now();
    const engine = await createStreamingTTS({
      modelPath: { type: 'file', path: installed.localPath },
      modelType: 'vits', numThreads: 2,
    });
    this.engine = engine;
    const loadMs = Date.now() - loadStart;
    let audioSamples = 0;
    let firstPlaybackMs: number | null = null;
    let writeQueue: Promise<void> = Promise.resolve();
    try {
      const sampleRate = await engine.getSampleRate();
      if (!sampleRate) throw new Error('Piper không trả sample rate.');
      await engine.startPcmPlayer(sampleRate, 1);
      const synthStart = Date.now();
      let settleDone!: () => void;
      let settleError!: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => {
        settleDone = resolve;
        settleError = reject;
      });
      const timeout = setTimeout(() => {
        settleError(new Error('Piper native quá 45 giây chưa kết thúc synthesis.'));
        void engine.cancelSpeechStream();
      }, 45000);
      try {
        await engine.generateSpeechStream(text.slice(0, MAX_SPOKEN_CHARS), { sid: 0 }, {
          onChunk: chunk => {
            if (run !== this.token || !chunk.samples.length) return;
            audioSamples += chunk.samples.length;
            if (firstPlaybackMs === null) {
              firstPlaybackMs = Date.now() - started;
              onPlaybackStart?.(); // native enqueue proxy, not first hardware PCM
            }
            writeQueue = writeQueue.then(() => engine.writePcmChunk(chunk.samples));
            // Rejections are forwarded after generator completes.
          },
          onEnd: () => settleDone(),
          onError: e => settleError(new Error(e.message ?? 'Piper streaming error')),
        });
        await done;
        await writeQueue;
      } finally {
        clearTimeout(timeout);
      }
      if (run !== this.token) throw new Error('Đã dừng TTS.');
      if (!audioSamples) throw new Error('Piper trả về 0 mẫu âm thanh.');
      const synthesisMs = Date.now() - synthStart;
      const audioDurationMs = Math.round(audioSamples / sampleRate * 1000);
      // Native player has no end callback; let buffered audio drain before stopping it.
      const waitedUntil = Date.now() + Math.min(audioDurationMs + 200, 30000);
      while (Date.now() < waitedUntil && run === this.token) {
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      if (run !== this.token) throw new Error('Đã dừng TTS.');
      return {
        loadMs, synthesisMs, toPlaybackMs: firstPlaybackMs ?? synthesisMs,
        audioDurationMs, elapsedMs: Date.now() - started,
        realTimeFactor: audioDurationMs ? synthesisMs / audioDurationMs : 0,
      };
    } finally {
      try { await engine.stopPcmPlayer(); } catch { /* player may not be started */ }
      await engine.destroy();
      if (this.engine === engine) this.engine = null;
    }
  }

  async stop(): Promise<void> {
    this.token += 1;
    const current = this.engine;
    try { await current?.cancelSpeechStream(); } catch { /* no stream */ }
    try { await current?.stopPcmPlayer(); } catch { /* already finished */ }
  }
}
