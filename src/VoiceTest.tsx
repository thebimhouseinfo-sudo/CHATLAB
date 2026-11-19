import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Speech from 'expo-speech';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import type { VoiceTimingUpdate } from './bench';
import { OFFLINE_STT_MODEL, OfflineSttRecorder, installOfflineStt, offlineSttReady } from './offlineStt';
import { OFFLINE_TTS_MODEL, OfflineTtsPlayer, installOfflineTts, offlineTtsReady } from './offlineTts';

export type VoiceLocale = 'vi-VN' | 'en-US';
export type VoiceRequest = {
  startedAt: number;
  sttMs: number;
  locale: VoiceLocale;
  engine?: 'system' | 'whisper-tiny';
  sttDecodeMs?: number;
  sttAudioMs?: number;
  sttModelLoadMs?: number;
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
  onTranscript: (text: string, request: VoiceRequest, autoSend: boolean) => void;
  autoSend?: boolean;
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
  { ready, generating, onTranscript, autoSend = false }, ref,
) {
  const [locale, setLocale] = useState<VoiceLocale>('vi-VN');
  const [sttEngine, setSttEngine] = useState<'offline' | 'system'>('offline');
  const [sttInstalled, setSttInstalled] = useState(false);
  const [installingStt, setInstallingStt] = useState(false);
  const [sttInstallStatus, setSttInstallStatus] = useState('');
  const [sttBusy, setSttBusy] = useState(false);
  const [ttsEngine, setTtsEngine] = useState<'system' | 'offline'>('system');
  const [ttsInstalled, setTtsInstalled] = useState(false);
  const [installingTts, setInstallingTts] = useState(false);
  const [ttsInstallStatus, setTtsInstallStatus] = useState('');
  const [systemVoices, setSystemVoices] = useState<Speech.Voice[]>([]);
  const [voiceIndex, setVoiceIndex] = useState(0);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState('Nhấn Mic để chạy STT → Qwen → TTS');
  const [sttMs, setSttMs] = useState<number | null>(null);
  const [ttsStartMs, setTtsStartMs] = useState<number | null>(null);
  const [roundtripMs, setRoundtripMs] = useState<number | null>(null);
  const [ttsDurationMs, setTtsDurationMs] = useState<number | null>(null);
  const [speechError, setSpeechError] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sttServices, setSttServices] = useState<string[]>([]);
  const micRef = useRef<MicRun | null>(null);
  const offlineRecorder = useRef<OfflineSttRecorder | null>(null);
  const offlineSpeaker = useRef(new OfflineTtsPlayer());
  const offlineMicStarted = useRef(0);
  const speechRun = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const available = systemVoices.filter(voice =>
    voice.language.toLowerCase().startsWith(locale.slice(0, 2)));
  const chosenVoice = available.length ? available[voiceIndex % available.length] : undefined;
  const voiceLabel = chosenVoice?.name ?? 'Giọng mặc định ' + locale;

  useEffect(() => {
    let active = true;
    void (async () => {
      if (Platform.OS !== 'android') return;
      try {
        const services = ExpoSpeechRecognitionModule.getSpeechRecognitionServices();
        if (active) setSttServices(services);
      } catch { /* Service enumeration may not be supported on some OEM builds. */ }
    })();
    void offlineSttReady()
      .then(installed => { if (active) setSttInstalled(installed); })
      .catch(() => {});
    void offlineTtsReady()
      .then(installed => { if (active) setTtsInstalled(installed); })
      .catch(() => {});
    void Speech.getAvailableVoicesAsync()
      .then(voices => { if (active) setSystemVoices(voices); })
      .catch(() => setStatus('Không đọc được danh sách voice pack. Đang dùng giọng mặc định.'));
    return () => {
      active = false;
      void offlineRecorder.current?.close();
      void offlineSpeaker.current.stop();
    };
  }, []);

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('result', event => {
    const text = event.results?.[0]?.transcript?.trim() ?? '';
    if (!text) return;
    if (micRef.current) {
      // OEM recognizers may only emit partial results and then onEnd.
      micRef.current.finalText = text;
      if (event.isFinal) micRef.current.sttMs = Date.now() - micRef.current.startedAt;
    }
    setStatus((event.isFinal ? 'STT xong: ' : 'Đang nghe: ') + text.slice(0, 70));
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
    if (!run.finalText) {
      setStatus('SpeechRecognizer không trả văn bản. Thử STT offline Whisper trong phần Giọng / lỗi.');
      return;
    }
    run.sttMs ??= Date.now() - run.startedAt;
    setSttMs(run.sttMs);
    setTtsStartMs(null);
    setTtsDurationMs(null);
    setRoundtripMs(null);
    setStatus('Đã nhận dạng · Qwen đang trả lời...');
    onTranscriptRef.current(run.finalText, {
      startedAt: run.startedAt,
      sttMs: run.sttMs,
      locale: run.locale,
      engine: 'system',
    }, autoSend);
  });

  async function installTtsModel() {
    if (installingTts || speaking || generating) return;
    setInstallingTts(true);
    setTtsInstallStatus('Đang lấy model Piper tiếng Việt...');
    try {
      await installOfflineTts((phase, percent) =>
        setTtsInstallStatus(phase + (percent == null ? '' : ' ' + Math.round(percent) + '%')));
      setTtsInstalled(true);
      setTtsEngine('offline');
      setTtsInstallStatus('Piper tiếng Việt sẵn sàng. Nhấn Thử loa VI.');
    } catch (error) {
      setTtsInstallStatus('TTS offline lỗi tải: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setInstallingTts(false);
    }
  }

  async function installModel() {
    if (installingStt || listening || generating) return;
    setInstallingStt(true);
    setSttInstallStatus('Đang chuẩn bị tải Whisper Tiny...');
    try {
      await installOfflineStt((phase, percent) => {
        setSttInstallStatus(phase + (percent == null ? '' : ' ' + Math.round(percent) + '%'));
      });
      setSttInstalled(true);
      setSttEngine('offline');
      setSttInstallStatus('Whisper Tiny đa ngôn ngữ đã sẵn sàng để nhận dạng offline.');
    } catch (error) {
      setSttInstallStatus('Tải STT thất bại: ' + (error instanceof Error ? error.message : String(error)));
    } finally { setInstallingStt(false); }
  }

  async function startOfflineMic() {
    if (sttBusy || installingStt) return;
    if (!sttInstalled) {
      setStatus('Hãy bấm ↓ Tải STT offline trước (Whisper Tiny ~116 MB).');
      return;
    }
    setSttBusy(true);
    setStatus('Đang mở microphone PCM offline...');
    try {
      await Speech.stop();
      setSpeaking(false);
      const recorder = new OfflineSttRecorder();
      offlineRecorder.current = recorder;
      await recorder.start();
      offlineMicStarted.current = Date.now();
      setListening(true);
      setStatus('Đang ghi âm trực tiếp 16 kHz · nhấn Chốt Mic (tối đa 24 giây).');
    } catch (error) {
      setStatus('STT offline lỗi mở mic: ' + (error instanceof Error ? error.message : String(error)));
      void offlineRecorder.current?.close();
      offlineRecorder.current = null;
      setListening(false);
    } finally { setSttBusy(false); }
  }

  async function stopOfflineMic() {
    const recorder = offlineRecorder.current;
    if (!recorder || sttBusy) return;
    offlineRecorder.current = null;
    setListening(false);
    setSttBusy(true);
    setStatus('Whisper đang nhận dạng tiếng Việt / English trên thiết bị...');
    const startAt = offlineMicStarted.current;
    try {
      const result = await recorder.stopAndTranscribe();
      if (!result.text) {
        setStatus('Whisper chưa nhận được câu rõ ràng; thử nói sát mic hơn.');
        return;
      }
      setSttMs(Date.now() - startAt);
      setTtsStartMs(null);
      setTtsDurationMs(null);
      setRoundtripMs(null);
      setStatus('Whisper nhận dạng: ' + result.text.slice(0, 80));
      onTranscriptRef.current(result.text, {
        startedAt: startAt,
        sttMs: Date.now() - startAt,
        locale, engine: 'whisper-tiny',
        sttDecodeMs: result.inferenceMs,
        sttAudioMs: result.audioDurationMs,
        sttModelLoadMs: result.modelLoadMs,
      }, autoSend);
    } catch (error) {
      setStatus('Whisper STT lỗi: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setSttBusy(false);
    }
  }

  async function startMic() {
    if (!ready || generating || listening || micRef.current || sttBusy) return;
    if (sttEngine === 'offline') return startOfflineMic();
    try {
      speechRun.current += 1;
      await Speech.stop();
      setSpeaking(false);
      const available = ExpoSpeechRecognitionModule.isRecognitionAvailable();
      if (!available) {
        setStatus('Android chưa xác nhận SpeechRecognizer. Đang thử trực tiếp để lấy lỗi cụ thể...');
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
    if (sttEngine === 'offline') {
      void stopOfflineMic();
    } else {
      setStatus('Đang chốt nhận dạng hệ thống...');
      ExpoSpeechRecognitionModule.stop();
    }
  }

  function stopVoice() {
    speechRun.current += 1;
    if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
    void Speech.stop();
    void offlineSpeaker.current.stop();
    setSpeaking(false);
    setStatus('Đã dừng đọc.');
  }

  function speak(
    rawAnswer: string, request?: VoiceRequest,
    onTiming?: (patch: Partial<VoiceTimingUpdate>) => void,
    testDefaultEnglish = false,
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
    if (ttsEngine === 'offline' && !testDefaultEnglish) {
      if ((request?.locale ?? locale) === 'en-US') {
        setStatus('Piper hiện là model tiếng Việt; chuyển TTS hệ thống để nghe tiếng Anh.');
        return;
      }
      if (!ttsInstalled) {
        setStatus('Hãy tải Piper VI (~22 MB) trước khi chọn TTS offline.');
        return;
      }
      if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
      const run = ++speechRun.current;
      const startedAt = Date.now();
      setSpeechError('');
      setStatus('Piper native đang tạo âm thanh...');
      void offlineSpeaker.current.speak(spoken, () => {
        if (run !== speechRun.current) return;
        setSpeaking(true);
        const startupMs = Date.now() - startedAt;
        setTtsStartMs(startupMs);
        setStatus('Piper đang phát âm thanh qua PCM native...');
        const patch: Partial<VoiceTimingUpdate> = {
          voiceTtsEngine: 'piper',
          voiceTtsModelId: OFFLINE_TTS_MODEL,
          voiceTtsStartMs: startupMs,
        };
        if (request) {
          const roundtripMs = Date.now() - request.startedAt;
          setRoundtripMs(roundtripMs);
          patch.voiceRoundtripToSpeechMs = roundtripMs;
        }
        onTiming?.(patch);
      }).then(result => {
        if (run !== speechRun.current) return;
        setSpeaking(false);
        setTtsDurationMs(result.audioDurationMs);
        setStatus('Piper hoàn tất · sinh ' + Math.round(result.synthesisMs) +
          ' ms · RTF ' + result.realTimeFactor.toFixed(2));
        onTiming?.({
          voiceTtsEngine: 'piper', voiceTtsModelId: OFFLINE_TTS_MODEL,
          voiceTtsModelLoadMs: result.loadMs, voiceTtsSynthesisMs: result.synthesisMs,
          voiceTtsAudioDurationMs: result.audioDurationMs,
          voiceTtsRealTimeFactor: result.realTimeFactor,
          voiceTtsDurationMs: result.audioDurationMs, voiceTtsStatus: 'completed',
        });
      }).catch(error => {
        if (run !== speechRun.current) return;
        setSpeaking(false);
        const msg = error instanceof Error ? error.message : String(error);
        setSpeechError(msg);
        setStatus('Piper TTS lỗi: ' + msg.slice(0, 160));
        onTiming?.({ voiceTtsStatus: 'error' });
      });
      return;
    }
    const speechText = spoken.slice(0, Math.min(3000, Speech.maxSpeechInputLength));
    if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
    const run = ++speechRun.current;
    setSpeechError('');
    setStatus('Đang khởi động giọng đọc' +
      (testDefaultEnglish ? ' mặc định en-US...' : ' ' + (request?.locale ?? locale) + '...'));
    let beganAt: number | null = null;
    void Speech.stop().then(() => {
      if (run !== speechRun.current) return;
      const requestedAt = Date.now();
      const resolvedLocale = testDefaultEnglish ? 'en-US' : request?.locale ?? locale;
      const chosen = testDefaultEnglish ? undefined : chosenVoice;
      try {
        watchdogRef.current = setTimeout(() => {
          if (run !== speechRun.current || beganAt !== null) return;
          void Speech.isSpeakingAsync().then(active => {
            if (run !== speechRun.current || beganAt !== null) return;
            const diagnostic = 'TTS không báo bắt đầu sau 8 giây; engine ' +
              (active ? 'đang chạy nhưng không phát callback' : 'không chạy') +
              '. Thử loa en-US, kiểm tra voice pack và Media volume của Android.';
            setStatus(diagnostic);
            setSpeechError(diagnostic);
            onTiming?.({ voiceTtsStatus: 'error' });
          }).catch(() => {
            setStatus('TTS không phát callback sau 8 giây. Hãy thử loa en-US.');
            onTiming?.({ voiceTtsStatus: 'error' });
          });
        }, 8000);
        Speech.speak(speechText, {
          language: resolvedLocale,
          ...(chosen ? { voice: chosen.identifier } : {}),
          rate: 1,
          onStart: () => {
            if (run !== speechRun.current) return;
            beganAt = Date.now();
            if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
            watchdogRef.current = null;
            setSpeaking(true);
            setStatus('Đang đọc câu trả lời...');
            const startMs = beganAt - requestedAt;
            setTtsStartMs(startMs);
            const patch: Partial<VoiceTimingUpdate> = {
              voiceTtsStartMs: startMs, voiceTtsEngine: 'system',
              voiceTtsModelId: chosenVoice?.identifier ?? 'OS-' + (request?.locale ?? locale),
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
            if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
            watchdogRef.current = null;
            setStatus('Voice Test xong · nhấn Mic để thử lượt tiếp');
            const duration = beganAt === null ? null : Date.now() - beganAt;
            setTtsDurationMs(duration);
            onTiming?.({
              ...(duration !== null ? { voiceTtsDurationMs: duration } : {}),
              voiceTtsStatus: 'completed',
              voiceTtsEngine: 'system',
              voiceTtsModelId: chosenVoice?.identifier ?? 'OS-' + (request?.locale ?? locale),
            });
          },
          onStopped: () => {
            if (run !== speechRun.current) return;
            if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
            watchdogRef.current = null;
            setSpeaking(false);
            setStatus('Đã dừng TTS.');
            onTiming?.({ voiceTtsStatus: 'stopped' });
          },
          onError: error => {
            if (run !== speechRun.current) return;
            if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
            watchdogRef.current = null;
            setSpeaking(false);
            const detail = error && typeof error === 'object' ? JSON.stringify(error) : String(error);
            setSpeechError(detail);
            setStatus('Android TTS lỗi: ' + detail.slice(0, 160));
            onTiming?.({ voiceTtsStatus: 'error' });
          },
        });
      } catch (error) {
        if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
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
          disabled={generating || sttBusy || installingStt || (!listening && !ready)}
          style={[styles.button, (generating || sttBusy || installingStt || (!listening && !ready)) && styles.disabled]}>
          <Text style={styles.buttonText}>{sttBusy ? 'STT...' : listening ? '■ Chốt Mic' : '🎙 ' + (sttEngine === 'offline' ? 'Whisper' : 'Hệ thống')}</Text>
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
      <View style={styles.audioTests}>
        <Pressable accessibilityRole="button" style={styles.audioTestButton}
          disabled={speaking || installingTts} onPress={() => {
            setTtsEngine(x => x === 'offline' ? 'system' : 'offline');
            setStatus('TTS engine đã chuyển. Nhấn Thử loa VI.');
          }}>
          <Text style={styles.audioTestLabel}>TTS: {ttsEngine === 'offline' ? 'Piper AI' : 'Hệ thống'} ⇄</Text>
        </Pressable>
        {ttsEngine === 'offline' && !ttsInstalled &&
          <Pressable accessibilityRole="button" style={styles.audioTestButton}
            disabled={installingTts} onPress={() => void installTtsModel()}>
            <Text style={styles.audioTestLabel}>{installingTts ? 'Đang tải TTS...' : '↓ Tải Piper VI (~22 MB)'}</Text>
          </Pressable>}
        {!sttInstalled && <Pressable accessibilityRole="button"
          disabled={installingStt || generating} style={styles.audioTestButton}
          onPress={() => void installModel()}>
          <Text style={styles.audioTestLabel}>{installingStt ? 'Đang tải STT...' : '↓ Tải STT offline (~116 MB)'}</Text>
        </Pressable>}
        <Pressable accessibilityRole="button" style={styles.audioTestButton}
          disabled={listening || sttBusy}
          onPress={() => {
            setSttEngine(x => x === 'offline' ? 'system' : 'offline');
            setStatus('STT engine đã chuyển, nhấn Mic để thử.');
          }}>
          <Text style={styles.audioTestLabel}>STT: {sttEngine === 'offline' ? 'Whisper (offline)' : 'Android'} ⇄</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.audioTestButton}
          disabled={generating} onPress={() => speak('Xin chào. Đây là thử nghiệm giọng tiếng Việt.')}>
          <Text style={styles.audioTestLabel}>🔊 Thử loa VI</Text>
        </Pressable>
        {detailsOpen && <Pressable accessibilityRole="button" style={styles.audioTestButton}
          disabled={generating} onPress={() => speak('Hello. This is the English voice test.', undefined, undefined, true)}>
          <Text style={styles.audioTestLabel}>🔊 Thử loa EN</Text>
        </Pressable>}
        <Pressable accessibilityRole="button" style={styles.audioTestButton}
          onPress={() => setDetailsOpen(!detailsOpen)}>
          <Text style={styles.audioTestLabel}>{detailsOpen ? '▲ Ẩn chi tiết' : '⚙ Giọng / lỗi'}</Text>
        </Pressable>
        {(speaking || status.includes('Đang khởi động')) &&
          <Pressable accessibilityRole="button" style={styles.audioTestButton} onPress={stopVoice}>
            <Text style={styles.audioTestLabel}>■ Dừng</Text>
          </Pressable>}
      </View>
      {detailsOpen && <Pressable accessibilityRole="button" style={styles.voicePicker}
        disabled={speaking || generating} onPress={() => setVoiceIndex(i => i + 1)}>
        <Text style={styles.voicePickerText}>Giọng hệ thống: {voiceLabel} ({locale})
          {available.length > 1 ? ' · Nhấn để đổi (' + available.length + ')' : ''}
        </Text>
      </Pressable>}
      {!!sttInstallStatus && <Text style={styles.status}>{sttInstallStatus}</Text>}
      {!!ttsInstallStatus && <Text style={styles.status}>{ttsInstallStatus}</Text>}
      <Text style={styles.status} numberOfLines={3}>{status}</Text>
      {detailsOpen && <Text style={styles.metrics}>
        Mic → chữ: {fmt(sttMs)} · TTS start: {fmt(ttsStartMs)} ·
        {' '}Mic → TTS: {fmt(roundtripMs)} · Đọc: {fmt(ttsDurationMs)}
      </Text>}
      {detailsOpen && !!speechError && <Text style={styles.errorText}>{speechError}</Text>}
      {detailsOpen && <Text style={styles.note}>
        STT services: {sttServices.length ? sttServices.join(', ') : 'không tìm thấy qua API'}.
        Đây là APK native: STT/TTS qua hệ thống; Qwen local.
        Thời gian Mic → chữ gồm cả lúc nói; TTS start đo callback, không phải mẫu âm thanh đầu tiên.
      </Text>}
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
  audioTests: { flexDirection: 'row', gap: 6, paddingTop: 6, flexWrap: 'wrap' },
  audioTestButton: { backgroundColor: '#253d5e', paddingVertical: 7,
    paddingHorizontal: 10, borderRadius: 8 },
  audioTestLabel: { color: '#e8f0ff', fontSize: 11, fontWeight: '700' },
  errorText: { color: '#ffb7ab', fontSize: 11, paddingTop: 5 },
  voicePicker: { backgroundColor: '#263653', borderRadius: 7, padding: 7, marginTop: 4 },
  voicePickerText: { color: FG, fontSize: 11 },
  status: { color: '#bdcfff', marginTop: 5, fontSize: 11 },
  metrics: { color: FG, marginTop: 5, fontSize: 10 },
  note: { color: MUTED, marginTop: 4, fontSize: 9, lineHeight: 13 },
});
