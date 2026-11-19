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
  mode: 'text' | 'voice';
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
  { ready, generating, onTranscript, autoSend = false, mode }, ref,
) {
  const [locale, setLocale] = useState<VoiceLocale>('vi-VN');
  const [sttEngine, setSttEngine] = useState<'offline' | 'system'>('offline');
  const [sttInstalled, setSttInstalled] = useState(false);
  const [installingStt, setInstallingStt] = useState(false);
  const [sttInstallStatus, setSttInstallStatus] = useState('');
  const [sttBusy, setSttBusy] = useState(false);
  // Prefer real on-device PCM speech: OEM Android system TTS did not start on Beam Pro.
  const [ttsEngine, setTtsEngine] = useState<'system' | 'offline'>('offline');
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
      .then(installed => { if (active) { setTtsInstalled(installed); if (installed) setTtsEngine('offline'); } })
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
      const result = await recorder.stopAndTranscribe(locale === 'vi-VN' ? 'vi' : 'en');
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
        const msg = 'Chưa cài giọng Piper VI. Vào Voice Chat → ⚙ Giọng để tải model (~22 MB).';
        setSpeechError(msg); setStatus(msg);
        onTiming?.({ voiceTtsStatus: 'error', voiceTtsEngine: 'piper',
          voiceTtsModelId: OFFLINE_TTS_MODEL });
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

  if (mode === 'text') return null;

  return (
    <View style={styles.panel}>
      <Text style={styles.modeTitle}>VOICE CHAT · Local Qwen</Text>
      <Text style={styles.modeHint}>Nhấn mic để nói → nhấn lần nữa để kết thúc. Qwen trả lời bằng chữ và tự đọc tiếng.</Text>
      <View style={styles.micRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={listening ? 'Dừng ghi âm và gửi' : 'Bắt đầu ghi âm'}
          style={[styles.mic, listening && styles.micActive,
            (sttBusy || generating || installingStt) && styles.disabled]}
          disabled={sttBusy || generating || installingStt || (!listening && !ready)}
          onPress={() => listening ? stopMic() : void startMic()}>
          <Text style={styles.micIcon}>{listening ? '■' : '🎙'}</Text>
          <Text style={styles.micLabel}>{sttBusy ? 'Đang nhận dạng' : listening ? 'Dừng & gửi' : generating ? 'Qwen đang trả lời' : 'Nói'}</Text>
        </Pressable>
      </View>
      <Text style={styles.status} numberOfLines={4}>{status}</Text>
      <View style={styles.quickRow}>
        {(speaking || status.includes('đang tạo âm thanh')) &&
          <Pressable accessibilityRole="button" onPress={stopVoice} style={styles.quickButton}>
            <Text style={styles.quickLabel}>■ Dừng đọc</Text>
          </Pressable>}
        <Pressable accessibilityRole="button" onPress={() => setDetailsOpen(!detailsOpen)}
          style={styles.quickButton}>
          <Text style={styles.quickLabel}>⚙ Giọng {detailsOpen ? '▲' : '▼'}</Text>
        </Pressable>
      </View>
      {!sttInstalled && sttEngine === 'offline' &&
        <Pressable accessibilityRole="button" style={styles.download} disabled={installingStt}
          onPress={() => void installModel()}>
          <Text style={styles.downloadLabel}>{installingStt ? 'Đang tải STT…' : '↓ Cài STT tiếng Việt (Whisper)'}</Text>
        </Pressable>}
      {!ttsInstalled && ttsEngine === 'offline' &&
        <Pressable accessibilityRole="button" style={styles.download} disabled={installingTts}
          onPress={() => void installTtsModel()}>
          <Text style={styles.downloadLabel}>{installingTts ? 'Đang tải TTS…' : '↓ Cài giọng Việt (Piper)'}</Text>
        </Pressable>}
      {!!sttInstallStatus && <Text style={styles.progress} numberOfLines={2}>{sttInstallStatus}</Text>}
      {!!ttsInstallStatus && <Text style={styles.progress} numberOfLines={2}>{ttsInstallStatus}</Text>}
      {detailsOpen &&
        <View style={styles.details}>
          <Text style={styles.detailHeader}>THIẾT LẬP GIỌNG · DÙNG ĐỂ BENCHMARK</Text>
          <View style={styles.quickRow}>
            <Pressable accessibilityRole="button" style={styles.quickButton}
              disabled={listening || sttBusy}
              onPress={() => { setSttEngine(x => x === 'offline' ? 'system' : 'offline'); setStatus('Đã đổi STT.'); }}>
              <Text style={styles.quickLabel}>STT: {sttEngine === 'offline' ? 'Whisper local' : 'Android'} ⇄</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.quickButton}
              disabled={speaking || generating}
              onPress={() => { stopVoice(); setTtsEngine(x => x === 'offline' ? 'system' : 'offline'); setStatus('Đã đổi TTS.'); }}>
              <Text style={styles.quickLabel}>TTS: {ttsEngine === 'offline' ? 'Piper local' : 'Android'} ⇄</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.quickButton}
              disabled={listening || sttBusy}
              onPress={() => { setLocale(x => x === 'vi-VN' ? 'en-US' : 'vi-VN'); setVoiceIndex(0); }}>
              <Text style={styles.quickLabel}>{locale === 'vi-VN' ? 'Tiếng Việt' : 'English'} ⇄</Text>
            </Pressable>
          </View>
          <View style={styles.quickRow}>
            <Pressable accessibilityRole="button" style={styles.quickButton}
              onPress={() => speak('Xin chào. Đây là bản thử giọng tiếng Việt.')}>
              <Text style={styles.quickLabel}>🔊 Thử tiếng Việt</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.quickButton}
              onPress={() => speak('Hello. This is a speech test.', undefined, undefined, true)}>
              <Text style={styles.quickLabel}>🔊 Thử tiếng Anh</Text>
            </Pressable>
            {ttsEngine === 'system' &&
              <Pressable accessibilityRole="button" style={styles.quickButton}
                onPress={() => setVoiceIndex(i => i + 1)}>
                <Text style={styles.quickLabel}>Giọng: {voiceLabel}</Text>
              </Pressable>}
          </View>
          {!!speechError && <Text style={styles.errorText}>{speechError}</Text>}
          <Text style={styles.metrics}>STT: {fmt(sttMs)} · TTS start: {fmt(ttsStartMs)} · Mic→Loa: {fmt(roundtripMs)} · Audio: {fmt(ttsDurationMs)}</Text>
          <Text style={styles.note}>Nhận dạng: {sttEngine === 'offline' ? OFFLINE_STT_MODEL : 'SpeechRecognizer'}.
            Phát: {ttsEngine === 'offline' ? OFFLINE_TTS_MODEL : 'Android TTS'}.
            STT offline mặc định tiếng Việt; có thể chứa từ English. Không có VAD tự động dừng.</Text>
        </View>}
    </View>
  );
});

const styles = StyleSheet.create({
  panel: { backgroundColor: '#111b30', paddingHorizontal: 14, paddingVertical: 12,
    borderTopWidth: 1, borderTopColor: '#2e3c5a', alignItems: 'center' },
  modeTitle: { color: FG, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  modeHint: { color: MUTED, fontSize: 11, textAlign: 'center', marginTop: 5 },
  micRow: { alignItems: 'center', justifyContent: 'center', paddingVertical: 13 },
  mic: { width: 112, height: 112, borderRadius: 56, backgroundColor: '#384d85',
    justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#829bef' },
  micActive: { backgroundColor: '#8b3e58', borderColor: '#ffa5bc' },
  micIcon: { fontSize: 31, color: FG },
  micLabel: { fontSize: 12, color: FG, fontWeight: '800', paddingTop: 5 },
  disabled: { opacity: 0.5 },
  status: { color: '#d7e5ff', fontSize: 12, textAlign: 'center', lineHeight: 18, marginBottom: 8 },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, justifyContent: 'center', marginVertical: 4 },
  quickButton: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 9, backgroundColor: '#2e3d59' },
  quickLabel: { color: FG, fontSize: 11, fontWeight: '700' },
  download: { backgroundColor: '#3f598e', borderRadius: 9, padding: 9, marginTop: 7 },
  downloadLabel: { color: FG, fontSize: 12, fontWeight: '800' },
  progress: { color: '#a8c7ff', fontSize: 11, marginTop: 6, textAlign: 'center' },
  details: { alignItems: 'center', width: '100%', borderTopColor: '#314362',
    borderTopWidth: 1, marginTop: 8, paddingTop: 10 },
  detailHeader: { color: MUTED, fontWeight: '700', fontSize: 10, marginBottom: 5 },
  errorText: { color: '#ffb7ab', fontSize: 11, marginTop: 7 },
  metrics: { color: FG, fontSize: 10, paddingVertical: 7 },
  note: { color: MUTED, fontSize: 10, lineHeight: 15, textAlign: 'center' },
});
