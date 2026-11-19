import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Speech from 'expo-speech';
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

const BG = '#131f33';
const FG = '#e6efff';
const MUTED = '#9daec7';
const fmt = (value: number | null) => value == null ? '—' : Math.round(value) + ' ms';

export const VoiceTest = forwardRef<VoiceTestHandle, Props>(function VoiceTest(
  { ready, generating, onTranscript }, ref,
) {
  const [locale, setLocale] = useState<VoiceLocale>('vi-VN');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState('Nhấn Mic để chạy STT → Qwen → TTS');
  const [sttMs, setSttMs] = useState<number | null>(null);
  const [ttsStartMs, setTtsStartMs] = useState<number | null>(null);
  const [roundtripMs, setRoundtripMs] = useState<number | null>(null);
  const [ttsDurationMs, setTtsDurationMs] = useState<number | null>(null);
  const micRef = useRef<MicRun | null>(null);
  const speechRun = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

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
    setSpeaking(false);
    setStatus('Đã dừng đọc.');
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
    const speechText = spoken.slice(0, Math.min(3000, Speech.maxSpeechInputLength));
    const run = ++speechRun.current;
    setStatus('Đang khởi động giọng đọc...');
    let beganAt: number | null = null;
    void Speech.stop().then(() => {
      if (run !== speechRun.current) return;
      const requestedAt = Date.now();
      try {
        Speech.speak(speechText, {
          language: request?.locale ?? locale,
          rate: 1,
          onStart: () => {
            if (run !== speechRun.current) return;
            beganAt = Date.now();
            setSpeaking(true);
            setStatus('Đang đọc câu trả lời...');
            const startMs = beganAt - requestedAt;
            setTtsStartMs(startMs);
            const patch: Partial<VoiceTimingUpdate> = { voiceTtsStartMs: startMs };
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
        <Pressable accessibilityRole="button" onPress={() => listening ? stopMic() : void startMic()}
          disabled={generating || (!listening && !ready)}
          style={[styles.button, (generating || (!listening && !ready)) && styles.disabled]}>
          <Text style={styles.buttonText}>{listening ? '■ Chốt Mic' : '🎙 Voice Test'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setLocale(locale === 'vi-VN' ? 'en-US' : 'vi-VN')}
          disabled={listening || generating} style={styles.locale}>
          <Text style={styles.localeText}>{locale} ⇄</Text>
        </Pressable>
        {speaking && (
          <Pressable accessibilityRole="button" onPress={stopVoice} style={styles.locale}>
            <Text style={styles.localeText}>■ Dừng đọc</Text>
          </Pressable>
        )}
      </View>
      <Text style={styles.status} numberOfLines={2}>{status}</Text>
      <Text style={styles.metrics}>
        Mic → chữ: {fmt(sttMs)} · TTS start: {fmt(ttsStartMs)} ·
        {' '}Mic → TTS: {fmt(roundtripMs)} · Đọc: {fmt(ttsDurationMs)}
      </Text>
      <Text style={styles.note}>
        STT có thể dùng mạng tùy cài đặt hệ thống; Qwen vẫn chạy local.
        Thời gian Mic → chữ gồm cả lúc nói; TTS start đo callback, không phải mẫu âm thanh đầu tiên.
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  panel: { backgroundColor: BG, paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: '#34415c' },
  controls: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  button: { backgroundColor: '#8faaff', paddingHorizontal: 11, paddingVertical: 9, borderRadius: 9 },
  buttonText: { color: '#091528', fontSize: 12, fontWeight: '800' },
  disabled: { opacity: 0.4 },
  locale: { backgroundColor: '#31405f', paddingHorizontal: 9, paddingVertical: 9, borderRadius: 9 },
  localeText: { color: FG, fontSize: 11, fontWeight: '700' },
  status: { color: '#bdcfff', marginTop: 5, fontSize: 11 },
  metrics: { color: FG, marginTop: 5, fontSize: 10 },
  note: { color: MUTED, marginTop: 4, fontSize: 9, lineHeight: 13 },
});
