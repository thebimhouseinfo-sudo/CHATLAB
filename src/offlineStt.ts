import { PermissionsAndroid, Platform } from 'react-native';
import {
  ModelCategory,
  ensureModel,
  isModelDownloaded,
  refreshModels,
} from 'react-native-sherpa-onnx/download';
import { createPcmLiveStream, type PcmLiveStreamHandle } from 'react-native-sherpa-onnx/audio';
import { createSTT } from 'react-native-sherpa-onnx/stt';

// First multilingual baseline. NOT the English-only tiny.en checkpoint.
// ~116 MB compressed, downloaded once on demand; never bundled in the APK.
export const OFFLINE_STT_MODEL = 'sherpa-onnx-whisper-tiny';
const SAMPLE_RATE = 16000;
const MAX_AUDIO_SECONDS = 24;
const MAX_SAMPLES = SAMPLE_RATE * MAX_AUDIO_SECONDS;

export async function offlineSttReady(): Promise<boolean> {
  return isModelDownloaded(ModelCategory.Stt, OFFLINE_STT_MODEL);
}

export async function installOfflineStt(
  onProgress?: (phase: string, percent: number | null) => void,
): Promise<void> {
  // Explicit user action only. No background model downloads.
  onProgress?.('Đang lấy danh sách model STT...', null);
  await refreshModels(ModelCategory.Stt);
  await ensureModel(ModelCategory.Stt, OFFLINE_STT_MODEL, {
    onProgress: p => onProgress?.(p.phase, typeof p.percent === 'number' ? p.percent : null),
  });
  if (!(await offlineSttReady())) throw new Error('Tải xong nhưng model STT chưa được xác nhận đầy đủ.');
}

async function requireMicrophone(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: 'Microphone cho STT offline',
    message: 'CHATLAB ghi âm trên thiết bị để chuyển giọng nói thành chữ bằng model Whisper local.',
    buttonPositive: 'Cho phép',
    buttonNegative: 'Không',
  });
  if (result !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Chưa cấp quyền RECORD_AUDIO.');
}

export type OfflineSttResult = {
  text: string;
  audioDurationMs: number;
  inferenceMs: number;
  modelLoadMs: number;
  totalMs: number;
  language: string;
};

export class OfflineSttRecorder {
  private pcm: PcmLiveStreamHandle | null = null;
  private unsubscribeData: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private chunks: Float32Array[] = [];
  private sampleCount = 0;
  private captureError: string | null = null;
  private startedAt = 0;
  private stopped = false;

  async start(): Promise<void> {
    if (this.pcm || this.startedAt) throw new Error('STT đã bắt đầu ghi âm.');
    if (!(await offlineSttReady())) throw new Error('Chưa tải Whisper Tiny đa ngôn ngữ.');
    await requireMicrophone();
    this.chunks = [];
    this.sampleCount = 0;
    this.stopped = false;
    this.captureError = null;
    const pcm = createPcmLiveStream({ sampleRate: SAMPLE_RATE, channelCount: 1 });
    this.pcm = pcm;
    this.unsubscribeData = pcm.onData((samples, rate) => {
      if (this.stopped || this.captureError) return;
      if (rate !== SAMPLE_RATE) {
        this.captureError = 'Sample rate không đúng 16 kHz: ' + rate;
        return;
      }
      if (this.sampleCount >= MAX_SAMPLES) return;
      const remaining = MAX_SAMPLES - this.sampleCount;
      const used = samples.length > remaining ? samples.slice(0, remaining) : samples;
      this.chunks.push(used);
      this.sampleCount += used.length;
    });
    this.unsubscribeError = pcm.onError(message => { this.captureError = message; });
    try {
      await pcm.start();
      this.startedAt = Date.now();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async stopAndTranscribe(language: 'vi' | 'en' = 'vi'): Promise<OfflineSttResult> {
    const startedAt = this.startedAt;
    if (!startedAt) throw new Error('Mic chưa bắt đầu ghi âm.');
    await this.close();
    if (this.captureError) throw new Error('Không thu được PCM: ' + this.captureError);
    if (this.sampleCount < SAMPLE_RATE / 4) {
      throw new Error('Âm thanh quá ngắn; hãy nói ít nhất 0,3 giây.');
    }
    const samples = new Array<number>(this.sampleCount);
    let position = 0;
    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.length; i++) samples[position++] = chunk[i];
    }
    const durationMs = Math.round(this.sampleCount / SAMPLE_RATE * 1000);
    this.chunks = []; // free recording buffers before native decode

    const modelInfo = await ensureModel(ModelCategory.Stt, OFFLINE_STT_MODEL);
    const loadStart = Date.now();
    const stt = await createSTT({
      modelPath: { type: 'file', path: modelInfo.localPath },
      modelType: 'whisper',
      preferInt8: true,
      // sherpa-onnx's Whisper default is ENGLISH even for multilingual weights.
      // Force VI by default; the model still transcribes embedded English words.
      modelOptions: { whisper: { language, task: 'transcribe' } },
    });
    const modelLoadMs = Date.now() - loadStart;
    try {
      const decodeStart = Date.now();
      const result = await stt.transcribeSamples(samples, SAMPLE_RATE);
      const inferenceMs = Date.now() - decodeStart;
      return {
        text: result.text.trim(), audioDurationMs: durationMs,
        inferenceMs, modelLoadMs, totalMs: Date.now() - startedAt,
        language: result.lang || 'auto',
      };
    } finally {
      await stt.destroy(); // avoid keeping STT AND Qwen model loaded in RAM
    }
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const pcm = this.pcm;
    this.pcm = null;
    try { await pcm?.stop(); } finally {
      this.unsubscribeData?.();
      this.unsubscribeError?.();
      this.unsubscribeData = null;
      this.unsubscribeError = null;
    }
  }
}
