import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Speech from 'expo-speech';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import type { VoiceTimingUpdate } from './bench';

export type VoiceLocale = 'vi-VN' | 'en-US';
export type VoiceRequest = {
  startedAt: number;
  sttMs: number;
  locale: VoiceLocale;
};

export type VoiceTestHandle = {
  speak: (
    text: string,
    request?: VoiceRequest,
    onTiming?: (patch: Partial<VoiceTimingUpdate>) => void,
  ) => void;
  stop: () => void;
};

type Props = {
  ready: boolean;
  generating: boolean;
  onTranscript: (text: string, request: VoiceRequest) => void;
};
type MicRun = {
  startedAt: number;
  locale: VoiceLocale;
  finalText: string | null;
  sttMs: number | null;
  error: boolean;
};

type TtsEngine = 'system' | 'kevoice';
type BridgeRun = {
  id: string;
  requestedAt: number;
  request?: VoiceRequest;
  onTiming?: (patch: Partial<VoiceTimingUpdate>) => void;
};
const KEVOICE_BRIDGE_URL =
  'https://kevoice-playground-git-fe-37ddda-thebimhouseinfo-sudos-projects.vercel.app/bridge.html';
const BRIDGE_PROTOCOL = 'chatlab-kevoice-1';
const KEVOICE_MODEL_VI = 'Xenova/mms-tts-vie';
const KEVOICE_MODEL_EN = 'KittenML/kitten-tts-nano-0.8-int8';

const BG = '#131f33';
const FG = '#e6efff';
const MUTED = '#9daec7';
const fmt = (value: number | null) => value == null ? '—' : Math.round(value) + ' ms';

export const VoiceTest = forwardRef<VoiceTestHandle, Props>(function VoiceTest(
  { ready, generating, onTranscript }, ref,
) {
  const [locale, setLocale] = useState<VoiceLocale>('vi-VN');
  const [ttsEngine, setTtsEngine] = useState<TtsEngine>('system');
  const [systemVoices, setSystemVoices] = useState<Speech.Voice[]>([]);
  const [voiceIndex, setVoiceIndex] = useState(0);
  const [kevoiceReady, setKevoiceReady] = useState(false);
  const [kevoiceUnlocked, setKevoiceUnlocked] = useState(false);
  const [ttsModel, setTtsModel] = useState('Android/iOS system TTS');
  const [modelLoadMs, setModelLoadMs] = useState<number | null>(null);
  const [synthesisMs, setSynthesisMs] = useState<number | null>(null);
  const [rtf, setRtf] = useState<number | null>(null);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState('Nhấn Mic để chạy STT → Qwen → TTS');
  const [sttMs, setSttMs] = useState<number | null>(null);
  const [ttsStartMs, setTtsStartMs] = useState<number | null>(null);
  const [roundtripMs, setRoundtripMs] = useState<number | null>(null);
  const [ttsDurationMs, setTtsDurationMs] = useState<number | null>(null);
  const micRef = useRef<MicRun | null>(null);
  const speechRun = useRef(0);
  const webView = useRef<WebView>(null);
  const bridgeRun = useRef<BridgeRun | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const matchedVoices = systemVoices.filter(v =>
    v.language.toLowerCase().startsWith(locale.slice(0, 2).toLowerCase()));
  const systemVoice = matchedVoices.length
    ? matchedVoices[voiceIndex % matchedVoices.length] : undefined;
  const systemVoiceLabel = systemVoice
    ? systemVoice.name + ' · ' + systemVoice.language : 'Giọng mặc định ' + locale;
  useEffect(() => {
    let active = true;
    void Speech.getAvailableVoicesAsync()
      .then(rows => { if (active) setSystemVoices(rows); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('result', event => {
    const text = event.results?.[0]?.transcript?.trim() ?? '';
    if (!text) return;
    if (event.isFinal && micRef.current) {
      micRef.current.finalText = text;
      micRef.current.sttMs = Date.now() - micRef.current.startedAt;
      setStatus('STT xong: ' + text.slice(0, 70));
    } else {
      setStatus('Đang nghe: ' + text.slice(0, 70));
    }
  });
  useSpeechRecognitionEvent('error', event => {
    if (micRef.current) micRef.current.error = true;
    setListening(false);
    setStatus('STT lỗi: ' + (event.message || event.error));
  });
  useSpeechRecognitionEvent('end', () => {
    setListening(false);
    const run = micRef.current;
    micRef.current = null;
    if (!run || run.error) return;
    if (!run.finalText || run.sttMs == null) {
      setStatus('Không nhận được câu hoàn chỉnh. Nhấn Mic để thử lại.');
      return;
    }
    setSttMs(run.sttMs);
    setTtsStartMs(null);
    setTtsDurationMs(null);
    setRoundtripMs(null);
    setStatus('Đã nhận dạng · Qwen đang trả lời...');
    onTranscriptRef.current(run.finalText, {
      startedAt: run.startedAt,
      sttMs: run.sttMs,
      locale: run.locale,
    });
  });

  async function startMic() {
    if (!ready || generating || listening || micRef.current) return;
    try {
      speechRun.current += 1;
      if (bridgeRun.current) {
        sendToBridge({ type: 'stop', requestId: bridgeRun.current.id });
        bridgeRun.current = null;
      }
      await Speech.stop();
      setSpeaking(false);
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        Alert.alert('Không có SpeechRecognizer', 'Cần bật hoặc cài dịch vụ Speech Recognition của Android / iOS.');
        return;
      }
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        setStatus('Chưa được cấp quyền microphone / nhận dạng giọng nói.');
        return;
      }
      const startedAt = Date.now();
      micRef.current = { startedAt, locale, finalText: null, sttMs: null, error: false };
      setListening(true);
      setStatus('Đang nghe ' + locale + '...');
      ExpoSpeechRecognitionModule.start({
        lang: locale,
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
        // The phone's selected speech service may use a network connection.
        requiresOnDeviceRecognition: false,
      });
    } catch (error) {
      micRef.current = null;
      setListening(false);
      setStatus('Không mở được mic: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  function stopMic() {
    if (!listening) return;
    setStatus('Đang kết thúc nhận dạng...');
    ExpoSpeechRecognitionModule.stop();
  }

  function stopVoice() {
    speechRun.current += 1;
    void Speech.stop();
    if (bridgeRun.current) {
      sendToBridge({ type: 'stop', requestId: bridgeRun.current.id });
      bridgeRun.current = null;
    }
    setSpeaking(false);
    setStatus('Đã dừng đọc.');
  }

  function sendToBridge(data: Record<string, unknown>) {
    // The argument is serialized as a JS literal. Never evaluate remote payloads.
    webView.current?.injectJavaScript(
      'window.__chatlabKeVoice?.(' + JSON.stringify(data) + '); true;',
    );
  }

  function onKevoiceMessage(event: WebViewMessageEvent) {
    if (!event.nativeEvent.url.startsWith(KEVOICE_BRIDGE_URL)) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.nativeEvent.data) as Record<string, unknown>;
    } catch { return; }
    if (msg.protocol !== BRIDGE_PROTOCOL || typeof msg.type !== 'string') return;
    if (msg.type === 'ready') {
      setKevoiceReady(true);
      setKevoiceUnlocked(msg.unlocked === true);
      setStatus('KEVoice đã tải trang. Nhấn Bật âm thanh để thử model.');
      return;
    }
    if (msg.type === 'unlocked') {
      setKevoiceUnlocked(true);
      setStatus('KEVoice sẵn sàng, model sẽ tải trong lần phát đầu.');
      return;
    }
    const run = bridgeRun.current;
    if (!run || msg.requestId !== run.id) return;
    if (msg.type === 'synthesizing') {
      setStatus('KEVoice đang sinh tiếng trên thiết bị...');
    } else if (msg.type === 'audio_start') {
      const elapsed = Date.now() - run.requestedAt;
      setTtsStartMs(elapsed);
      setSpeaking(true);
      setStatus('KEVoice đang đọc câu trả lời...');
      const modelId = typeof msg.modelId === 'string' ? msg.modelId :
        (run.request?.locale === 'en-US' ? KEVOICE_MODEL_EN : KEVOICE_MODEL_VI);
      const patch: Partial<VoiceTimingUpdate> = {
        voiceTtsEngine: 'kevoice', voiceTtsModelId: modelId,
        voiceTtsStartMs: elapsed,
      };
      setTtsModel(modelId);
      if (run.request) {
        const roundtrip = Date.now() - run.request.startedAt;
        setRoundtripMs(roundtrip);
        patch.voiceRoundtripToSpeechMs = roundtrip;
      }
      run.onTiming?.(patch);
    } else if (msg.type === 'completed') {
      const numberOrNull = (v: unknown) =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      const synthesis = numberOrNull(msg.synthesisMs);
      const load = numberOrNull(msg.modelLoadMs);
      const audioDuration = numberOrNull(msg.audioDurationMs);
      const factor = numberOrNull(msg.realTimeFactor);
      const onStartElapsed = numberOrNull(msg.firstAudioMs);
      const totalElapsed = numberOrNull(msg.elapsedMs);
      const speakingMs = onStartElapsed !== null && totalElapsed !== null
        ? Math.max(0, totalElapsed - onStartElapsed) : null;
      setSpeaking(false);
      setModelLoadMs(load);
      setSynthesisMs(synthesis);
      setRtf(factor);
      setTtsDurationMs(speakingMs);
      setStatus('KEVoice hoàn thành · ' + (run.request?.locale ?? locale));
      run.onTiming?.({
        voiceTtsEngine: 'kevoice',
        voiceTtsModelId: typeof msg.modelId === 'string' ? msg.modelId : KEVOICE_MODEL_VI,
        ...(synthesis === null ? {} : { voiceTtsSynthesisMs: synthesis }),
        ...(load === null ? {} : { voiceTtsModelLoadMs: load }),
        ...(audioDuration === null ? {} : { voiceTtsAudioDurationMs: audioDuration }),
        ...(factor === null ? {} : { voiceTtsRealTimeFactor: factor }),
        ...(speakingMs === null ? {} : { voiceTtsDurationMs: speakingMs }),
        voiceTtsStatus: 'completed',
      });
      bridgeRun.current = null;
    } else if (msg.type === 'error' || msg.type === 'stopped') {
      setSpeaking(false);
      setStatus(msg.type === 'error'
        ? 'KEVoice lỗi: ' + String(msg.error ?? 'Không rõ lỗi')
        : 'Đã dừng KEVoice.');
      run.onTiming?.({
        voiceTtsEngine: 'kevoice',
        voiceTtsStatus: msg.type === 'error' ? 'error' : 'stopped',
      });
      bridgeRun.current = null;
    }
  }

  function chooseTtsEngine(next: TtsEngine) {
    if (ttsEngine === next) return;
    stopVoice();
    setTtsEngine(next);
    setModelLoadMs(null);
    setSynthesisMs(null);
    setTtsStartMs(null);
    setTtsDurationMs(null);
    setRtf(null);
    setTtsModel(next === 'system' ? 'Android/iOS system TTS' :
      (locale === 'vi-VN' ? KEVOICE_MODEL_VI : KEVOICE_MODEL_EN));
    setStatus(next === 'kevoice'
      ? 'Đang kết nối với trang KEVoice WebView...'
      : 'TTS hệ thống sẵn sàng; sử dụng voice pack ' + locale);
  }

  function speak(
    rawAnswer: string, request?: VoiceRequest,
    onTiming?: (patch: Partial<VoiceTimingUpdate>) => void,
  ) {
    // Presentation-only cleanup; stored model text, prompt and inference are not modified.
    const spoken = rawAnswer
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\|[^>]+\|>/g, '')
      .trim();
    if (!spoken) {
      setStatus('Không có chữ để TTS đọc.');
      return;
    }
    if (ttsEngine === 'kevoice') {
      if (!kevoiceReady || !kevoiceUnlocked || !webView.current) {
        setStatus('Nhấn Bật âm thanh KEVoice trong cửa sổ WebView trước.');
        return;
      }
      if (spoken.length > 1500) {
        setStatus('Câu trả lời dài hơn 1500 ký tự, chưa thể thử KEVoice trong một lượt.');
        return;
      }
      const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
      bridgeRun.current = { id, requestedAt: Date.now(), request, onTiming };
      setSpeaking(true);
      setTtsStartMs(null);
      setTtsDurationMs(null);
      setSynthesisMs(null);
      setRtf(null);
      setTtsModel((request?.locale ?? locale) === 'vi-VN' ? KEVOICE_MODEL_VI : KEVOICE_MODEL_EN);
      setStatus('Đã gửi nội dung đến KEVoice local WebView...');
      sendToBridge({
        type: 'speak', requestId: id, text: spoken,
        language: (request?.locale ?? locale) === 'vi-VN' ? 'vi' : 'en',
      });
      return;
    }
    const speechText = spoken.slice(0, Math.min(3000, Speech.maxSpeechInputLength));
    const run = ++speechRun.current;
    setTtsModel('System TTS · ' + systemVoiceLabel);
    setSynthesisMs(null);
    setModelLoadMs(null);
    setRtf(null);
    setStatus('Đang khởi động giọng đọc...');
    let beganAt: number | null = null;
    void Speech.stop().then(() => {
      if (run !== speechRun.current) return;
      const requestedAt = Date.now();
      try {
        Speech.speak(speechText, {
          language: request?.locale ?? locale,
          ...(systemVoice ? { voice: systemVoice.identifier } : {}),
          rate: 1,
          onStart: () => {
            if (run !== speechRun.current) return;
            beganAt = Date.now();
            setSpeaking(true);
            setStatus('Đang đọc câu trả lời...');
            const startMs = beganAt - requestedAt;
            setTtsStartMs(startMs);
            const patch: Partial<VoiceTimingUpdate> = {
              voiceTtsEngine: 'system', voiceTtsModelId: systemVoiceLabel,
              voiceTtsStartMs: startMs,
            };
            if (request) {
              const elapsed = beganAt - request.startedAt;
              setRoundtripMs(elapsed);
              patch.voiceRoundtripToSpeechMs = elapsed;
            }
            onTiming?.(patch);
          },
          onDone: () => {
            if (run !== speechRun.current) return;
            setSpeaking(false);
            setStatus('Voice Test xong · nhấn Mic để thử lượt tiếp');
            const duration = beganAt === null ? null : Date.now() - beganAt;
            setTtsDurationMs(duration);
            onTiming?.({
              voiceTtsEngine: 'system', voiceTtsModelId: systemVoiceLabel,
              ...(duration !== null ? { voiceTtsDurationMs: duration } : {}),
              voiceTtsStatus: 'completed',
            });
          },
          onStopped: () => {
            if (run !== speechRun.current) return;
            setSpeaking(false);
            setStatus('Đã dừng TTS.');
            onTiming?.({ voiceTtsStatus: 'stopped' });
          },
          onError: () => {
            if (run !== speechRun.current) return;
            setSpeaking(false);
            setStatus('TTS lỗi: kiểm tra cài đặt giọng đọc trên thiết bị.');
            onTiming?.({ voiceTtsStatus: 'error' });
          },
        });
      } catch (error) {
        setSpeaking(false);
        setStatus('TTS lỗi: ' + (error instanceof Error ? error.message : String(error)));
        onTiming?.({ voiceTtsStatus: 'error' });
      }
    }).catch(error => setStatus('Không thể khởi động TTS: ' + String(error)));
  }

  useImperativeHandle(ref, () => ({ speak, stop: stopVoice }));

  return (
    <View style={styles.panel}>
      <View style={styles.controls}>
        <Text style={styles.engineHeading}>TTS:</Text>
        <Pressable accessibilityRole="button" disabled={generating}
          onPress={() => chooseTtsEngine('system')}
          style={[styles.engine, ttsEngine === 'system' && styles.engineActive]}>
          <Text style={styles.engineLabel}>Hệ thống</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={generating}
          onPress={() => chooseTtsEngine('kevoice')}
          style={[styles.engine, ttsEngine === 'kevoice' && styles.engineActive]}>
          <Text style={styles.engineLabel}>KEVoice AI</Text>
        </Pressable>
      </View>
      <View style={styles.controls}>
        <Pressable accessibilityRole="button" onPress={() => listening ? stopMic() : void startMic()}
          disabled={generating || (!listening && !ready)}
          style={[styles.button, (generating || (!listening && !ready)) && styles.disabled]}>
          <Text style={styles.buttonText}>{listening ? '■ Chốt Mic' : '🎙 Voice Test'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => {
            setLocale(locale === 'vi-VN' ? 'en-US' : 'vi-VN');
            setVoiceIndex(0);
          }}
          disabled={listening || generating} style={styles.locale}>
          <Text style={styles.localeText}>{locale} ⇄</Text>
        </Pressable>
        {speaking && (
          <Pressable accessibilityRole="button" onPress={stopVoice} style={styles.locale}>
            <Text style={styles.localeText}>■ Dừng đọc</Text>
          </Pressable>
        )}
      </View>
      {ttsEngine === 'system' && (
        <Pressable accessibilityRole="button" disabled={speaking || generating}
          onPress={() => setVoiceIndex(v => v + 1)} style={styles.voicePicker}>
          <Text style={styles.voicePickerText}>
            Giọng hệ thống: {systemVoiceLabel}
            {matchedVoices.length > 1 ? ' · Đổi (' + matchedVoices.length + ')' : ''}
          </Text>
        </Pressable>
      )}
      {ttsEngine === 'kevoice' && (
        <View style={styles.webBox}>
          <WebView
            ref={webView}
            source={{ uri: KEVOICE_BRIDGE_URL }}
            onMessage={onKevoiceMessage}
            onError={() => { setKevoiceReady(false); setKevoiceUnlocked(false);
              setStatus('Không tải được KEVoice WebView. Cần mạng khi tải trang/model lần đầu.'); }}
            onHttpError={() => setStatus('KEVoice WebView trả lỗi HTTP. Kiểm tra deploy trên Vercel.')}
            onShouldStartLoadWithRequest={e => e.url === KEVOICE_BRIDGE_URL ||
              e.url === 'about:blank'}
            javaScriptEnabled
            domStorageEnabled
            cacheEnabled
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback
            mixedContentMode="never"
            style={styles.webview}
          />
          <Text style={styles.bridgeState}>
            {kevoiceUnlocked ? '● Audio đã mở' : kevoiceReady ? '● Chạm Bật âm thanh trong khung' :
              '● Đang tải bridge...'}
          </Text>
        </View>
      )}
      <Text style={styles.status} numberOfLines={2}>{status}</Text>
      <Text style={styles.metrics}>
        Mic → chữ: {fmt(sttMs)} · TTS start: {fmt(ttsStartMs)} ·
        {' '}Mic → TTS: {fmt(roundtripMs)} · Đọc: {fmt(ttsDurationMs)}
      </Text>
      <Text style={styles.note}>
        {ttsModel}{ttsEngine === 'kevoice' && synthesisMs !== null
          ? ' · Sinh ' + Math.round(synthesisMs) + ' ms · Load ' +
            (modelLoadMs === null ? '—' : Math.round(modelLoadMs) + ' ms') +
            ' · RTF ' + (rtf === null ? '—' : rtf.toFixed(2))
          : ''}
      </Text>
      <Text style={styles.note}>
        STT có thể dùng mạng; Qwen vẫn local. KeVoice AI chạy WASM trong WebView,
        tải model trên thiết bị và cần kích hoạt audio. Callback bắt đầu đọc không phải PCM đo vật lý.
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  panel: { backgroundColor: BG, paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: '#34415c' },
  controls: { flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 5, flexWrap: 'wrap' },
  engineHeading: { color: MUTED, fontSize: 11, fontWeight: '700' },
  engine: { borderRadius: 7, backgroundColor: '#2c3c57', paddingHorizontal: 10, paddingVertical: 7 },
  engineActive: { backgroundColor: '#5269a8' },
  engineLabel: { color: FG, fontSize: 11, fontWeight: '700' },
  webBox: { backgroundColor: BG, borderRadius: 8, overflow: 'hidden', marginVertical: 5 },
  voicePicker: { paddingVertical: 5, paddingHorizontal: 7,
    borderRadius: 8, backgroundColor: '#25354d' },
  voicePickerText: { color: FG, fontSize: 10 },
  webview: { height: 104, backgroundColor: BG },
  bridgeState: { color: MUTED, fontSize: 10, padding: 4 },
  button: { backgroundColor: '#8faaff', paddingHorizontal: 11, paddingVertical: 9, borderRadius: 9 },
  buttonText: { color: '#091528', fontSize: 12, fontWeight: '800' },
  disabled: { opacity: 0.4 },
  locale: { backgroundColor: '#31405f', paddingHorizontal: 9, paddingVertical: 9, borderRadius: 9 },
  localeText: { color: FG, fontSize: 11, fontWeight: '700' },
  status: { color: '#bdcfff', marginTop: 5, fontSize: 11 },
  metrics: { color: FG, marginTop: 5, fontSize: 10 },
  note: { color: MUTED, marginTop: 4, fontSize: 9, lineHeight: 13 },
});
