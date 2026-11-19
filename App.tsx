import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform,
  Pressable, SafeAreaView, ScrollView, Share, StyleSheet,
  Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Device from 'expo-device';
import { initLlama, type LlamaContext } from 'llama.rn';
import { MODELS, type ModelId, type ModelSpec } from './src/models';
import { downloadModel, isModelReady, modelPath, removeModel } from './src/modelStore';
import { appendBenchmark, csvBenchmark, readBenchmarks, type Benchmark } from './src/bench';

type Message = { id: string; role: 'user' | 'assistant'; text: string };
type LiveMetrics = {
  ttftMs: number | null;
  tokens: number;
  speed: number;
  prefill: number | null;
  totalMs: number;
  status: string;
};

const BG = '#0b101c';
const PANEL = '#182238';
const ACCENT = '#8faaff';
const MUTED = '#9caac2';
const deviceName = Device.modelName ?? 'Unknown device';
const fmt = (n: number | null | undefined, decimals = 1) =>
  n == null || !Number.isFinite(n) ? '—' : n.toFixed(decimals);
const idFor = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const SYSTEM_PROMPT =
  'You are a friendly, concise multilingual conversation assistant. ' +
  'Reply in the same language as the user, normally Vietnamese or English. ' +
  'Keep answers brief (one to three sentences), useful, and conversational. ' +
  'Do not reveal hidden reasoning. If unsure, say so.';

function Metric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={s.metric}>
      <Text style={s.metricLabel}>{label}</Text>
      <Text style={s.metricValue}>{value}<Text style={s.metricUnit}> {unit ?? ''}</Text></Text>
    </View>
  );
}
function Action({
  title, onPress, disabled, subtle = false,
}: { title: string; onPress: () => void; disabled?: boolean; subtle?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[s.action, subtle && s.actionSubtle, disabled && s.disabled]}
    >
      <Text style={[s.actionLabel, subtle && s.actionLabelSubtle]}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const [selectedId, setSelectedId] = useState<ModelId>('qwen08-q4');
  const selected = MODELS.find(m => m.id === selectedId)!;
  const [ready, setReady] = useState<Partial<Record<ModelId, boolean>>>({});
  const [downloadId, setDownloadId] = useState<ModelId | null>(null);
  const [downloadBytes, setDownloadBytes] = useState(0);
  const [downloadTotal, setDownloadTotal] = useState(0);
  const [loadedId, setLoadedId] = useState<ModelId | null>(null);
  const [loadMs, setLoadMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [live, setLive] = useState<LiveMetrics | null>(null);
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const contextRef = useRef<LlamaContext | null>(null);
  const loadedRef = useRef<ModelId | null>(null);
  const stopRef = useRef(false);
  const lastRenderedRef = useRef(0);
  const listRef = useRef<FlatList<Message>>(null);

  useEffect(() => {
    void refreshModels();
    void readBenchmarks().then(setBenchmarks);
    return () => {
      void contextRef.current?.release();
    };
  }, []);

  async function refreshModels() {
    const states = await Promise.all(MODELS.map(async m => [m.id, await isModelReady(m)] as const));
    setReady(Object.fromEntries(states) as Partial<Record<ModelId, boolean>>);
  }

  function chooseModel(m: ModelSpec) {
    if (busy || generating || downloadId) return;
    setSelectedId(m.id);
    setMessages([]);
    setLive(null);
  }

  async function downloadSelected() {
    if (busy || downloadId || generating) return;
    setDownloadId(selected.id);
    setDownloadBytes(0);
    setDownloadTotal(0);
    try {
      await downloadModel(selected, (bytes, total) => {
        setDownloadBytes(bytes);
        setDownloadTotal(total > 0 ? total : 0);
      });
      await refreshModels();
      Alert.alert('Đã tải model', selected.name + ' có thể nạp để chat offline.');
    } catch (error) {
      Alert.alert('Lỗi tải model', errorText(error));
    } finally {
      setDownloadId(null);
    }
  }

  async function loadSelected() {
    if (busy || generating || downloadId) return;
    if (!ready[selectedId]) {
      Alert.alert('Chưa có model', 'Hãy tải GGUF trước khi nạp.');
      return;
    }
    setBusy(true);
    try {
      // Never keep two contexts in memory simultaneously on a low-RAM phone.
      if (contextRef.current) {
        await contextRef.current.release();
        contextRef.current = null;
        loadedRef.current = null;
        setLoadedId(null);
      }
      const start = Date.now();
      const context = await initLlama({
        model: modelPath(selected),
        n_ctx: 2048,
        n_batch: 256,
        n_threads: 4,
        n_gpu_layers: Platform.OS === 'ios' ? 99 : 0,
        use_mmap: true,
        use_mlock: false,
      });
      contextRef.current = context;
      loadedRef.current = selectedId;
      setLoadedId(selectedId);
      setLoadMs(Date.now() - start);
      setMessages([]);
      setLive(null);
    } catch (error) {
      Alert.alert('Không nạp được GGUF', errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function unload() {
    if (busy || generating || downloadId) return;
    setBusy(true);
    try {
      await contextRef.current?.release();
      contextRef.current = null;
      loadedRef.current = null;
      setLoadedId(null);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (busy || generating || downloadId) return;
    if (loadedRef.current === selectedId) {
      Alert.alert('Model đang chạy', 'Hãy nhấn Thoát model trước khi xóa.');
      return;
    }
    Alert.alert('Xóa GGUF?', selected.name, [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Xóa', style: 'destructive', onPress: () => {
        void removeModel(selected).then(refreshModels).catch(e =>
          Alert.alert('Lỗi', errorText(e)));
      }},
    ]);
  }

  async function stop() {
    if (!generating) return;
    stopRef.current = true;
    try {
      await contextRef.current?.stopCompletion();
    } catch (error) {
      Alert.alert('Không thể dừng', errorText(error));
    }
  }

  async function send() {
    const prompt = input.trim().slice(0, 1000);
    const context = contextRef.current;
    if (!prompt || !context || generating || busy || loadedRef.current !== selectedId) return;
    setInput('');
    setGenerating(true);
    stopRef.current = false;
    const next = [...messages, { id: idFor(), role: 'user' as const, text: prompt }];
    const assistantId = idFor();
    setMessages([...next, { id: assistantId, role: 'assistant', text: '' }]);
    setLive({ ttftMs: null, tokens: 0, speed: 0, prefill: null, totalMs: 0, status: 'Generating' });
    const start = Date.now();
    let firstToken: number | null = null;
    let emitted = 0;
    let streamText = '';
    const baseRecord = {
      modelId: selectedId, quant: selected.quant,
      platform: Platform.OS + ' ' + String(Platform.Version),
      device: deviceName, date: new Date().toISOString(),
      loadMs, gpu: context.gpu ?? null,
    };

    try {
      const result = await context.completion(
        {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...next.slice(-8).map(m => ({ role: m.role, content: m.text })),
          ],
          n_predict: 160,
          n_ctx: undefined,
          temperature: 0.7,
          top_p: 0.8,
          top_k: 20,
          min_p: 0,
          repeat_penalty: 1.05,
          jinja: true,
          enable_thinking: false,
          chat_template_kwargs: { enable_thinking: false },
          stop: ['<|im_end|>', '<|endoftext|>'],
        },
        data => {
          if (firstToken === null) firstToken = Date.now() - start;
          emitted += 1;
          if (typeof data.accumulated_text === 'string') {
            streamText = data.accumulated_text;
          } else {
            streamText += data.content ?? data.token ?? '';
          }
          const now = Date.now();
          // Throttle UI updates: do not make JS rendering the benchmark bottleneck.
          if (now - lastRenderedRef.current > 110) {
            lastRenderedRef.current = now;
            const elapsed = now - start;
            setMessages(rows => rows.map(m =>
              m.id === assistantId ? { ...m, text: streamText } : m,
            ));
            const decodeSeconds = (elapsed - (firstToken ?? elapsed)) / 1000;
            setLive({
              ttftMs: firstToken,
              tokens: emitted,
              speed: decodeSeconds > 0 ? Math.max(0, emitted - 1) / decodeSeconds : 0,
              prefill: null,
              totalMs: elapsed,
              status: 'Live · estimated rate',
            });
          }
        },
      );
      const finalText = result.text || streamText || '(Không có nội dung phản hồi)';
      setMessages(rows => rows.map(m =>
        m.id === assistantId ? { ...m, text: finalText } : m,
      ));
      const timings = result.timings;
      const record: Benchmark = {
        ...baseRecord,
        ttftMs: firstToken,
        promptTokens: timings?.prompt_n ?? 0,
        prefillTokensPerSec: timings?.prompt_per_second ?? 0,
        generatedTokens: timings?.predicted_n ?? 0,
        decodeTokensPerSec: timings?.predicted_per_second ?? 0,
        generationMs: timings?.predicted_ms ?? 0,
        totalMs: Date.now() - start,
        status: stopRef.current ? 'stopped' : 'completed',
      };
      setLive({
        ttftMs: record.ttftMs, tokens: record.generatedTokens,
        speed: record.decodeTokensPerSec, prefill: record.prefillTokensPerSec,
        totalMs: record.totalMs, status: record.status + ' · native timings',
      });
      await appendBenchmark(record);
      setBenchmarks(rows => [...rows, record]);
    } catch (error) {
      const message = errorText(error);
      setMessages(rows => rows.map(m =>
        m.id === assistantId ? { ...m, text: 'Lỗi: ' + message } : m,
      ));
      const record: Benchmark = {
        ...baseRecord, ttftMs: firstToken, promptTokens: 0, prefillTokensPerSec: 0,
        generatedTokens: emitted, decodeTokensPerSec: 0, generationMs: 0,
        totalMs: Date.now() - start, status: 'error', error: message,
      };
      setLive({ ttftMs: firstToken, tokens: emitted, speed: 0, prefill: null,
        totalMs: record.totalMs, status: 'Error' });
      await appendBenchmark(record).catch(() => {});
      setBenchmarks(rows => [...rows, record]);
    } finally {
      setGenerating(false);
    }
  }

  async function exportResults() {
    const data = csvBenchmark(benchmarks);
    await Share.share({ message: data, title: 'CHATLAB native benchmark CSV' });
  }

  const modelIsReady = !!ready[selectedId];
  const changing = busy || generating || !!downloadId;
  const currentDownload = downloadId === selectedId;
  const percentage = downloadTotal > 0
    ? Math.min(100, Math.round(downloadBytes * 100 / downloadTotal)) : null;
  const deviceText = deviceName + ' · ' + Platform.OS;

  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="light" />
      <View style={s.header}>
        <View>
          <Text style={s.title}>CHATLAB</Text>
          <Text style={s.subtitle}>LOCAL · NATIVE LLM · {deviceText}</Text>
        </View>
        <Text style={s.offline}>OFFLINE CHAT</Text>
      </View>

      <View style={s.catalogue}>
        <Text style={s.sectionTitle}>MODEL LAB · 0.8B / 2B</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.modelStrip}>
          {MODELS.map(m => (
            <Pressable
              key={m.id} accessibilityRole="button" disabled={changing}
              onPress={() => chooseModel(m)}
              style={[s.chip, selectedId === m.id && s.chipActive]}
            >
              <Text style={[s.chipText, selectedId === m.id && s.chipTextActive]}>
                {m.name}
              </Text>
              <Text style={s.chipCaption}>
                {m.quant} · {ready[m.id] ? 'Downloaded' : '~' + m.approximateMB + ' MB'}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <Text style={s.modelDescription}>{selected.description}</Text>
        <View style={s.actionRow}>
          {!modelIsReady
            ? <Action title={currentDownload ? 'Đang tải...' : '↓ Tải GGUF'}
                onPress={() => void downloadSelected()} disabled={changing} />
            : loadedId === selectedId
              ? <Action title="✓ Đang chạy" onPress={() => {}} disabled />
              : <Action title="▶ Nạp model" onPress={() => void loadSelected()} disabled={changing} />}
          {loadedId && <Action title="Thoát model" subtle onPress={() => void unload()} disabled={changing} />}
          {modelIsReady && loadedId !== selectedId &&
            <Action title="Xóa file" subtle onPress={() => void deleteSelected()} disabled={changing} />}
        </View>
        {currentDownload && (
          <View style={s.progress}>
            <View style={[s.progressFill, { width: (percentage ?? 4) + '%' }]} />
            <Text style={s.progressText}>
              {Math.round(downloadBytes / 1_000_000)} MB
              {downloadTotal > 0 ? ' / ' + Math.round(downloadTotal / 1_000_000) + ' MB' : ''}
              {percentage !== null ? ' · ' + percentage + '%' : ''}
            </Text>
          </View>
        )}
        {busy && <View style={s.loading}><ActivityIndicator color={ACCENT}/><Text style={s.small}>Đang nạp / giải phóng model...</Text></View>}
      </View>

      <View style={s.metricsPanel}>
        <View style={s.metricsHeader}>
          <Text style={s.sectionTitle}>LIVE BENCHMARK</Text>
          <Text style={s.metricsStatus}>{live?.status ?? 'Chưa có lượt chat'}</Text>
        </View>
        <View style={s.metricsRow}>
          <Metric label="FIRST TOKEN" value={fmt(live?.ttftMs, 0)} unit="ms" />
          <Metric label="DECODE" value={fmt(live?.speed)} unit="tok/s" />
          <Metric label="PREFILL" value={fmt(live?.prefill)} unit="tok/s" />
          <Metric label="TOKENS" value={fmt(live?.tokens, 0)} />
        </View>
        <View style={s.metricsBottom}>
          <Text style={s.small}>Load: {loadedId ? fmt(loadMs, 0) + ' ms' : '—'} · Total: {fmt(live?.totalMs, 0)} ms</Text>
          <Pressable disabled={!benchmarks.length || generating} onPress={() => void exportResults()}>
            <Text style={[s.export, !benchmarks.length && s.muted]}>Export CSV ({benchmarks.length})</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        ref={listRef} style={s.chat} contentContainerStyle={s.chatInner}
        data={messages} keyExtractor={m => m.id}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyTitle}>Chat trực tiếp với model local</Text>
            <Text style={s.emptyDescription}>
              Tải một GGUF, nhấn Nạp model, rồi chat tiếng Việt hoặc English.
              TTFT và token/s sẽ hiện khi model sinh câu trả lời.
            </Text>
            <Text style={s.small}>Không có API cloud · Không có tốc độ giả lập</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[s.bubble, item.role === 'user' ? s.userBubble : s.aiBubble]}>
            <Text style={s.bubbleRole}>{item.role === 'user' ? 'YOU' : 'QWEN · ' + (loadedId ?? selectedId)}</Text>
            <Text style={s.bubbleText}>{item.text || (generating ? '● ● ●' : '')}</Text>
          </View>
        )}
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.composer}>
          <TextInput
            style={s.input} value={input} onChangeText={setInput}
            placeholder={loadedId === selectedId ? 'Nhắn tin...' : 'Hãy nạp model để bắt đầu'}
            placeholderTextColor={MUTED}
            editable={!generating && loadedId === selectedId}
            multiline maxLength={1000}
          />
          {generating
            ? <Action title="■ Dừng" onPress={() => void stop()} />
            : <Action title="Gửi" onPress={() => void send()}
                disabled={!input.trim() || busy || loadedId !== selectedId} />}
        </View>
        <Text style={s.footer}>Context 2K · max 160 tokens · non-thinking · iOS Metal / Android CPU baseline</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  header: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: '#f4f7ff', fontSize: 23, fontWeight: '800', letterSpacing: 2.5 },
  subtitle: { color: MUTED, fontSize: 9, marginTop: 2 },
  offline: { color: '#9ae7c4', borderColor: '#2e6754', borderWidth: 1,
    borderRadius: 6, padding: 6, fontSize: 9, fontWeight: '700' },
  catalogue: { backgroundColor: PANEL, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12 },
  sectionTitle: { color: MUTED, fontSize: 10, fontWeight: '700', letterSpacing: 1.3 },
  modelStrip: { marginTop: 9, flexGrow: 0 },
  chip: { borderWidth: 1, borderColor: '#324059', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9, marginRight: 8, minWidth: 138 },
  chipActive: { borderColor: ACCENT, backgroundColor: '#26355b' },
  chipText: { color: '#d4dcf0', fontSize: 12, fontWeight: '700' },
  chipTextActive: { color: '#f5f7ff' },
  chipCaption: { color: MUTED, fontSize: 10, marginTop: 3 },
  modelDescription: { color: MUTED, fontSize: 11, marginTop: 9 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10, gap: 8 },
  action: { backgroundColor: ACCENT, borderRadius: 9, paddingHorizontal: 14,
    paddingVertical: 9, alignItems: 'center', justifyContent: 'center' },
  actionSubtle: { backgroundColor: '#34415b' },
  actionLabel: { color: '#0c172f', fontWeight: '800', fontSize: 12 },
  actionLabelSubtle: { color: '#e0e8fa' },
  disabled: { opacity: 0.4 },
  progress: { height: 27, marginTop: 10, backgroundColor: '#10182b', borderRadius: 7,
    justifyContent: 'center', overflow: 'hidden' },
  progressFill: { position: 'absolute', top: 0, left: 0, bottom: 0, backgroundColor: '#5269b3' },
  progressText: { color: '#fff', textAlign: 'center', fontSize: 11 },
  loading: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 },
  small: { color: MUTED, fontSize: 10 },
  metricsPanel: { backgroundColor: '#111a2c', paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#263247' },
  metricsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  metricsStatus: { color: '#7fcbac', fontSize: 10 },
  metricsRow: { flexDirection: 'row', marginTop: 9, gap: 7 },
  metric: { flex: 1, backgroundColor: '#1a2740', paddingVertical: 8,
    paddingHorizontal: 7, borderRadius: 8 },
  metricLabel: { color: MUTED, fontSize: 8, letterSpacing: 0.6, marginBottom: 4 },
  metricValue: { color: '#f1f5ff', fontSize: 16, fontWeight: '800' },
  metricUnit: { color: MUTED, fontSize: 9, fontWeight: '400' },
  metricsBottom: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  export: { color: ACCENT, fontSize: 11, fontWeight: '700' },
  muted: { color: MUTED },
  chat: { flex: 1 },
  chatInner: { padding: 13, flexGrow: 1 },
  empty: { flex: 1, justifyContent: 'center', padding: 22, alignItems: 'center' },
  emptyTitle: { color: '#ebf0ff', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  emptyDescription: { color: MUTED, fontSize: 13, lineHeight: 20,
    marginTop: 10, marginBottom: 12, textAlign: 'center' },
  bubble: { borderRadius: 14, padding: 12, marginBottom: 11, maxWidth: '92%' },
  userBubble: { backgroundColor: '#344777', alignSelf: 'flex-end' },
  aiBubble: { backgroundColor: '#1b2943', alignSelf: 'flex-start' },
  bubbleRole: { color: '#a7baf2', fontSize: 9, fontWeight: '700', marginBottom: 5 },
  bubbleText: { color: '#f6f7fb', fontSize: 14, lineHeight: 21 },
  composer: { backgroundColor: '#141e31', flexDirection: 'row', alignItems: 'flex-end',
    gap: 9, padding: 12, paddingBottom: 5 },
  input: { flex: 1, color: '#f6f7ff', backgroundColor: '#25324b', borderRadius: 11,
    fontSize: 14, paddingHorizontal: 12, paddingVertical: 9, maxHeight: 110 },
  footer: { backgroundColor: '#141e31', color: MUTED, textAlign: 'center',
    fontSize: 9, paddingBottom: 10 },
});
