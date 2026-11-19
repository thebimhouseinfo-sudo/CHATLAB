import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Keyboard, Modal, Platform,
  Pressable, SafeAreaView, ScrollView, Share, StyleSheet,
  Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Device from 'expo-device';
import { initLlama, type LlamaContext } from 'llama.rn';
import { MODELS, type ModelId, type ModelSpec } from './src/models';
import { downloadModel, isModelReady, modelPath, removeModel } from './src/modelStore';
import { appendBenchmark, csvBenchmark, readBenchmarks, updateVoiceBenchmark, type Benchmark } from './src/bench';
import { VoiceTest, type VoiceTestHandle, type VoiceRequest } from './src/VoiceTest';
import { readChatSessions, writeChatSessions, type ChatMessage, type ChatSession } from './src/chatStore';
import {
  buildCloudReport, clearCloudConfig, getInstallationId, pushCloudReport,
  readCloudConfig, saveCloudConfig,
} from './src/cloudReport';

type Message = ChatMessage;
type ContextSize = 2048 | 4096 | 8192;
const CONTEXT_OPTIONS: readonly ContextSize[] = [2048, 4096, 8192];
const MAX_PREDICT = 160;
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
  const [contextWindow, setContextWindow] = useState<ContextSize>(2048);
  const [loadedWindow, setLoadedWindow] = useState<ContextSize | null>(null);
  const [promptTokens, setPromptTokens] = useState<number | null>(null);
  const [peakPromptTokens, setPeakPromptTokens] = useState(0);
  const [contextTruncated, setContextTruncated] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<'chat' | 'settings'>('chat');
  const [benchExpanded, setBenchExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeChatId, setActiveChatId] = useState(idFor);
  const [chatModelId, setChatModelId] = useState<ModelId>('qwen08-q4');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [storageWarning, setStorageWarning] = useState('');
  const [cloudConfigured, setCloudConfigured] = useState(false);
  const [cloudSettingsOpen, setCloudSettingsOpen] = useState(false);
  const [cloudEndpoint, setCloudEndpoint] = useState('');
  const [cloudKey, setCloudKey] = useState('');
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [pushingReport, setPushingReport] = useState(false);
  const [pushStatus, setPushStatus] = useState('');
  const [loadMs, setLoadMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [draftVoiceRequest, setDraftVoiceRequest] = useState<VoiceRequest | null>(null);
  const [live, setLive] = useState<LiveMetrics | null>(null);
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const contextRef = useRef<LlamaContext | null>(null);
  const voiceRef = useRef<VoiceTestHandle>(null);
  const loadedRef = useRef<ModelId | null>(null);
  const stopRef = useRef(false);
  const lastRenderedRef = useRef(0);
  const listRef = useRef<FlatList<Message>>(null);
  const messagesRef = useRef<Message[]>([]);
  const sessionsRef = useRef<ChatSession[]>([]);
  const chatIdRef = useRef(activeChatId);
  const chatModelRef = useRef(chatModelId);

  useEffect(() => {
    void refreshModels();
    void readBenchmarks().then(setBenchmarks);
    void readCloudConfig().then(config => {
      setCloudConfigured(!!config);
      setCloudEndpoint(config?.endpoint ?? '');
    }).catch(() => setCloudConfigured(false));
    void readChatSessions().then(rows => {
      const valid = rows.filter(row => MODELS.some(m => m.id === row.modelId));
      sessionsRef.current = valid;
      setSessions(valid);
      if (valid[0]) {
        chatIdRef.current = valid[0].id;
        chatModelRef.current = valid[0].modelId;
        setActiveChatId(valid[0].id);
        setChatModelId(valid[0].modelId);
        setSelectedId(valid[0].modelId);
        displayMessages(valid[0].messages);
      }
    });
    return () => {
      void contextRef.current?.release();
    };
  }, []);

  function displayMessages(next: Message[]) {
    messagesRef.current = next;
    setMessages(next);
  }

  function saveChatSnapshot(items: Message[], modelId: ModelId, chatId: string) {
    if (!items.some(m => m.role === 'user')) return;
    const now = new Date().toISOString();
    const previous = sessionsRef.current.find(row => row.id === chatId);
    const snapshot: ChatSession = {
      id: chatId, modelId, createdAt: previous?.createdAt ?? now, updatedAt: now,
      title: items.find(m => m.role === 'user')?.text.slice(0, 50) || 'New Chat',
      messages: items.filter(m => m.text.trim().length > 0),
    };
    const next = [snapshot, ...sessionsRef.current.filter(row => row.id !== chatId)].slice(0, 40);
    sessionsRef.current = next;
    setSessions(next);
    void writeChatSessions(next).catch(() => setStorageWarning('Không lưu được lịch sử chat trên thiết bị.'));
  }

  function newChat(modelId: ModelId = chatModelRef.current) {
    if (generating || busy) return;
    const id = idFor();
    chatIdRef.current = id;
    chatModelRef.current = modelId;
    setActiveChatId(id);
    setChatModelId(modelId);
    displayMessages([]);
    setInput('');
    setLive(null);
    setPromptTokens(null);
    setPeakPromptTokens(0);
    setContextTruncated(false);
    setHistoryOpen(false);
    setPushStatus('');
    setComposerExpanded(false);
    setDraftVoiceRequest(null);
    setActiveTab('chat');
    voiceRef.current?.stop();
  }

  function openChat(session: ChatSession) {
    if (generating || busy || downloadId) return;
    chatIdRef.current = session.id;
    chatModelRef.current = session.modelId;
    setActiveChatId(session.id);
    setChatModelId(session.modelId);
    setSelectedId(session.modelId);
    displayMessages(session.messages);
    setInput('');
    setLive(null);
    setPromptTokens(null);
    setPeakPromptTokens(0);
    setContextTruncated(false);
    setHistoryOpen(false);
    setPushStatus('');
    setComposerExpanded(false);
    setDraftVoiceRequest(null);
    setActiveTab('chat');
    voiceRef.current?.stop();
  }

  async function refreshModels() {
    const states = await Promise.all(MODELS.map(async m => [m.id, await isModelReady(m)] as const));
    setReady(Object.fromEntries(states) as Partial<Record<ModelId, boolean>>);
  }

  function chooseModel(m: ModelSpec) {
    if (busy || generating || downloadId) return;
    setSelectedId(m.id);
    setModelsOpen(false);
    // One tap switches already-downloaded models; never hold two contexts at once.
    if (ready[m.id]) {
      if (loadedRef.current !== m.id || loadedWindow !== contextWindow) {
        void loadSelected(m);
      } else if (chatModelRef.current !== m.id) {
        newChat(m.id);
      }
    }
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

  async function loadSelected(model: ModelSpec = selected) {
    if (busy || generating || downloadId) return;
    if (!ready[model.id]) {
      Alert.alert('Chưa có model', 'Hãy tải GGUF trước khi nạp.');
      return;
    }
    setBusy(true);
    try {
      // Releasing before loading is essential on 4–8 GB devices.
      if (contextRef.current) {
        await contextRef.current.release();
        contextRef.current = null;
        loadedRef.current = null;
        setLoadedId(null);
        setLoadedWindow(null);
      }
      const start = Date.now();
      const context = await initLlama({
        model: modelPath(model),
        n_ctx: contextWindow,
        n_batch: 256,
        n_threads: 4,
        n_gpu_layers: Platform.OS === 'ios' ? 99 : 0,
        use_mmap: true,
        use_mlock: false,
        ctx_shift: false, // Do not silently discard history in the long-chat test.
      });
      contextRef.current = context;
      loadedRef.current = model.id;
      setLoadedId(model.id);
      setLoadedWindow(contextWindow);
      setLoadMs(Date.now() - start);
      if (chatModelRef.current !== model.id) {
        const id = idFor();
        chatIdRef.current = id;
        chatModelRef.current = model.id;
        setActiveChatId(id);
        setChatModelId(model.id);
        displayMessages([]);
        setInput('');
        setPeakPromptTokens(0);
      }
      setPromptTokens(null);
      setContextTruncated(false);
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
      setLoadedWindow(null);
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

  async function send(override?: string, voiceRequest?: VoiceRequest) {
    const prompt = (override ?? input).trim().slice(0, 1000);
    const context = contextRef.current;
    if (!prompt || !context || generating || busy ||
        loadedRef.current !== selectedId || loadedWindow !== contextWindow ||
        chatModelRef.current !== selectedId) return;
    const speechRequest = voiceRequest ?? draftVoiceRequest ?? undefined;
    setGenerating(true);
    stopRef.current = false;

    const next = [...messagesRef.current, { id: idFor(), role: 'user' as const, text: prompt }];
    const chatMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...next.map(m => ({ role: m.role, content: m.text })),
    ];
    let measuredTokens: number;
    try {
      const formatted = await context.getFormattedChat(chatMessages, undefined, {
        jinja: true, enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
      });
      measuredTokens = (await context.tokenize(formatted.prompt)).tokens.length;
      setPromptTokens(measuredTokens);
      setPeakPromptTokens(old => Math.max(old, measuredTokens));
      if (measuredTokens >= contextWindow - 32) {
        Alert.alert(
          'Context đã đầy',
          'Prompt dùng ' + measuredTokens + '/' + contextWindow +
          ' tokens. Đã giữ nguyên hội thoại, không tự cắt tin nhắn. ' +
          'Hãy chọn CTX lớn hơn rồi nạp lại model hoặc tạo New Chat.',
        );
        setGenerating(false);
        return;
      }
    } catch (error) {
      Alert.alert('Không đếm được token', errorText(error));
      setGenerating(false);
      return;
    }

    setInput('');
    setDraftVoiceRequest(null);
    setComposerExpanded(false);
    Keyboard.dismiss();
    const currentId = chatIdRef.current;
    const currentModel = chatModelRef.current;
    const assistantId = idFor();
    displayMessages([...next, { id: assistantId, role: 'assistant', text: '' }]);
    saveChatSnapshot(next, currentModel, currentId);
    setLive({ ttftMs: null, tokens: 0, speed: 0, prefill: null, totalMs: 0, status: 'Generating' });
    const allowedPredict = Math.min(MAX_PREDICT, contextWindow - measuredTokens - 16);
    const start = Date.now();
    let firstToken: number | null = null;
    let emitted = 0;
    let streamText = '';
    const baseRecord = {
      modelId: selectedId, quant: selected.quant,
      platform: Platform.OS + ' ' + String(Platform.Version),
      device: deviceName, date: new Date().toISOString(),
      loadMs, gpu: context.gpu ?? null,
      ...(speechRequest ? {
        voiceLocale: speechRequest.locale,
        voiceSttMs: speechRequest.sttMs,
      } : {}),
    };

    try {
      const result = await context.completion(
        {
          messages: chatMessages,
          n_predict: allowedPredict,
          temperature: 0.7,
          top_p: 0.8,
          top_k: 20,
          min_p: 0,
          penalty_repeat: 1.05,
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
      const finalText = result.content || result.text || streamText || '(Không có nội dung phản hồi)';
      const completed = [...next, { id: assistantId, role: 'assistant' as const, text: finalText }];
      displayMessages(completed);
      saveChatSnapshot(completed, currentModel, currentId);
      setContextTruncated(!!result.truncated);
      const timings = result.timings;
      const record: Benchmark = {
        ...baseRecord,
        chatId: currentId, turnIndex: next.filter(m => m.role === 'user').length,
        contextWindow, contextPromptTokens: measuredTokens,
        contextTruncated: !!result.truncated, requestedMaxTokens: allowedPredict,
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
        totalMs: record.totalMs, status: (result.truncated ? 'TRUNCATED' : record.status) + ' · native timings',
      });
      await appendBenchmark(record);
      setBenchmarks(rows => [...rows, record]);
      if (speechRequest && !stopRef.current) {
        const turnIndex = next.filter(m => m.role === 'user').length;
        voiceRef.current?.speak(finalText, speechRequest, patch => {
          void updateVoiceBenchmark(currentId, turnIndex, patch)
            .then(() => readBenchmarks().then(setBenchmarks))
            .catch(() => {});
        });
      }
    } catch (error) {
      const message = errorText(error);
      const failed = [...next, { id: assistantId, role: 'assistant' as const, text: 'Lỗi: ' + message }];
      displayMessages(failed);
      saveChatSnapshot(failed, currentModel, currentId);
      const record: Benchmark = {
        ...baseRecord,
        chatId: currentId, turnIndex: next.filter(m => m.role === 'user').length,
        contextWindow, contextPromptTokens: measuredTokens,
        contextTruncated: false, requestedMaxTokens: allowedPredict,
        ttftMs: firstToken, promptTokens: 0, prefillTokensPerSec: 0,
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

  async function saveCloudSettings() {
    try {
      if (!cloudKey.trim()) {
        Alert.alert('Thiếu access key', 'Nhập key được cấp cho CHATLAB report endpoint.');
        return;
      }
      await saveCloudConfig(cloudEndpoint, cloudKey);
      setCloudKey('');
      setCloudConfigured(true);
      setCloudSettingsOpen(false);
      setPushStatus('Cloud đã cấu hình. Chưa gửi báo cáo.');
    } catch (error) {
      Alert.alert('Không lưu được Cloud', errorText(error));
    }
  }

  async function disconnectCloud() {
    try {
      await clearCloudConfig();
      setCloudConfigured(false);
      setCloudEndpoint('');
      setCloudKey('');
      setPushStatus('Đã ngắt kết nối cloud; các báo cáo đã gửi không tự bị xóa.');
    } catch (error) {
      Alert.alert('Không xóa được cấu hình Cloud', errorText(error));
    }
  }

  async function doPushReport() {
    if (generating || busy || pushingReport) return;
    const currentSession = sessionsRef.current.find(row => row.id === chatIdRef.current);
    if (!currentSession || !currentSession.messages.some(m => m.role === 'user')) {
      Alert.alert('Chưa có báo cáo', 'Hãy chat ít nhất một lượt trước khi Push.');
      return;
    }
    setPushingReport(true);
    setPushStatus('Đang gửi báo cáo của session này...');
    try {
      const config = await readCloudConfig();
      if (!config) {
        setCloudSettingsOpen(true);
        setPushStatus('Chưa cấu hình Cloud; không có dữ liệu nào được gửi.');
        return;
      }
      // Fresh read covers completed turns even before the UI benchmark list updates.
      const records = await readBenchmarks();
      const installationId = await getInstallationId();
      const report = buildCloudReport(currentSession, records, installationId, includeTranscript);
      await pushCloudReport(report, config);
      const sentAt = new Date().toLocaleString();
      setPushStatus('Đã Push ' + sentAt + ' · ' + report.session.turns +
        ' lượt · ' + report.summary.measuredTurns + ' phép đo' +
        (report.includeTranscript ? ' · có hội thoại' : ' · chỉ số liệu') +
        '. Push lại sẽ cập nhật bản này.');
    } catch (error) {
      setPushStatus('Push thất bại. Chưa xóa dữ liệu local.');
      Alert.alert('Lỗi Push Report', errorText(error));
    } finally {
      setPushingReport(false);
    }
  }

  function confirmPushReport() {
    if (includeTranscript) {
      Alert.alert(
        'Gửi cả nội dung hội thoại?',
        'Toàn bộ câu hỏi và câu trả lời của session này sẽ lên cloud. ' +
        'Nhấn Push lần nữa sẽ ghi đè bản báo cáo trước (kể cả tùy chọn nội dung).',
        [
          { text: 'Hủy', style: 'cancel' },
          { text: 'Push', onPress: () => { void doPushReport(); } },
        ],
      );
    } else {
      void doPushReport();
    }
  }

  const modelIsReady = !!ready[selectedId];
  const changing = busy || generating || !!downloadId;
  const currentDownload = downloadId === selectedId;
  const percentage = downloadTotal > 0
    ? Math.min(100, Math.round(downloadBytes * 100 / downloadTotal)) : null;
  const deviceText = deviceName + ' · ' + Platform.OS;
  const chatReady = loadedId === selectedId && loadedWindow === contextWindow &&
    chatModelId === selectedId && !busy;
  const turns = messages.filter(m => m.role === 'user').length;
  const usage = promptTokens === null ? null : Math.round(promptTokens / contextWindow * 100);

  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="light" />
      <View style={s.header}>
        <View>
          <Text style={s.title}>CHATLAB</Text>
          <Text style={s.subtitle}>LOCAL · NATIVE LLM · {deviceText}</Text>
        </View>
        <View style={s.headerActions}>
          <Action title={historyOpen ? 'Ẩn chat' : 'Lịch sử'} subtle
            onPress={() => { setHistoryOpen(!historyOpen); setModelsOpen(false); }} disabled={generating} />
          <Action title="+ New Chat" onPress={() => newChat(loadedRef.current ?? selectedId)}
            disabled={generating || busy} />
        </View>
      </View>

      {activeTab === 'chat' && historyOpen && (
        <View style={s.historyPanel}>
          <Text style={s.sectionTitle}>HỘI THOẠI ĐÃ LƯU · {sessions.length}</Text>
          <ScrollView style={s.historyList} nestedScrollEnabled>
            {sessions.length === 0 && <Text style={s.small}>Chưa có hội thoại nào.</Text>}
            {sessions.map(session => (
              <Pressable key={session.id} onPress={() => openChat(session)}
                accessibilityRole="button" style={s.historyItem}>
                <Text style={s.historyTitle} numberOfLines={1}>{session.title}</Text>
                <Text style={s.small}>{MODELS.find(m => m.id === session.modelId)?.name ?? session.modelId}
                  {' · '}{session.messages.filter(m => m.role === 'user').length} lượt</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}


      {activeTab === 'settings' ? (
        <ScrollView style={s.settingsScroll} contentContainerStyle={s.settingsContent}
          keyboardShouldPersistTaps="handled">
          <Text style={s.settingsHeading}>Cài đặt & quản lý model</Text>
          <Text style={s.settingsHint}>Tải/nạp model, chọn CTX và cấu hình báo cáo. Chat vẫn được giữ nguyên.</Text>
      <View style={s.catalogue}>
        <Pressable accessibilityRole="button" disabled={changing}
          style={s.modelHeader} onPress={() => { setModelsOpen(!modelsOpen); setHistoryOpen(false); }}>
          <View style={{ flex: 1 }}>
            <Text style={s.sectionTitle}>MODEL · {loadedId === selectedId ? 'ĐANG NẠP' : 'CHỌN MODEL'}</Text>
            <Text style={s.activeModel} numberOfLines={1}>{selected.name} · {selected.quant}</Text>
          </View>
          <Text style={s.switchHint}>{modelsOpen ? '▲ Đóng' : '⇄ Đổi model'}</Text>
        </Pressable>
        {modelsOpen && <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.modelStrip}>
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
        </ScrollView>}
        {modelsOpen && <Text style={s.modelDescription}>{selected.description}</Text>}
        <View style={s.contextBar}>
          <Text style={s.small}>CTX (nạp lại nếu đổi): </Text>
          {CONTEXT_OPTIONS.map(size => (
            <Pressable key={size} disabled={changing} accessibilityRole="button"
              onPress={() => setContextWindow(size)}
              style={[s.contextChip, contextWindow === size && s.contextChipActive]}>
              <Text style={s.contextChipText}>{size / 1024}K</Text>
            </Pressable>
          ))}
        </View>
        <View style={s.actionRow}>
          {!modelIsReady
            ? <Action title={currentDownload ? 'Đang tải...' : '↓ Tải GGUF'}
                onPress={() => void downloadSelected()} disabled={changing} />
            : loadedId === selectedId && loadedWindow === contextWindow
              ? <Action title="✓ Đang chạy" onPress={() => {}} disabled />
              : <Action title={loadedId === selectedId ? '↻ Nạp lại CTX' : '▶ Nạp model'}
                  onPress={() => void loadSelected()} disabled={changing} />}
          {loadedId && <Action title="Thoát model" subtle onPress={() => void unload()} disabled={changing} />}
          {modelIsReady && loadedId !== selectedId &&
            <Action title="Xóa file" subtle onPress={() => void deleteSelected()} disabled={changing} />}
        </View>
        {currentDownload && (
          <View style={s.progress}>
            <View style={[s.progressFill, { width: ((percentage ?? 4) + '%') as `${number}%` }]} />
            <Text style={s.progressText}>
              {Math.round(downloadBytes / 1_000_000)} MB
              {downloadTotal > 0 ? ' / ' + Math.round(downloadTotal / 1_000_000) + ' MB' : ''}
              {percentage !== null ? ' · ' + percentage + '%' : ''}
            </Text>
          </View>
        )}
        {busy && <View style={s.loading}><ActivityIndicator color={ACCENT}/><Text style={s.small}>Đang nạp / giải phóng model...</Text></View>}
      </View>
      <View style={s.cloudPanel}>
        <View style={s.cloudTop}>
          <View style={{ flex: 1 }}>
            <Text style={s.sectionTitle}>CLOUD REPORT · THỦ CÔNG</Text>
            <Text style={s.small}>
              1 report / chat · Push lại cập nhật cùng bản · Không tự đồng bộ
            </Text>
          </View>
          <Action title={cloudSettingsOpen ? 'Đóng' : cloudConfigured ? 'Cài đặt' : 'Kết nối'}
            subtle onPress={() => setCloudSettingsOpen(!cloudSettingsOpen)} disabled={pushingReport} />
        </View>
        {cloudSettingsOpen && (
          <View style={s.cloudSettings}>
            <Text style={s.small}>Cloud endpoint HTTPS (Supabase Edge Function)</Text>
            <TextInput style={s.cloudInput} autoCapitalize="none" autoCorrect={false}
              keyboardType="url" placeholder="https://.../functions/v1/chatlab-report"
              placeholderTextColor={MUTED} value={cloudEndpoint} onChangeText={setCloudEndpoint} />
            <Text style={s.small}>Access key riêng, lưu mã hóa trên thiết bị</Text>
            <TextInput style={s.cloudInput} autoCapitalize="none" autoCorrect={false}
              secureTextEntry placeholder={cloudConfigured ? 'Nhập key mới để thay đổi' : 'Access key'}
              placeholderTextColor={MUTED} value={cloudKey} onChangeText={setCloudKey} />
            <View style={s.actionRow}>
              <Action title="Lưu kết nối" onPress={() => void saveCloudSettings()} />
              {cloudConfigured && <Action title="Ngắt kết nối" subtle
                onPress={() => void disconnectCloud()} />}
            </View>
          </View>
        )}
        <View style={s.cloudBottom}>
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: includeTranscript }}
            onPress={() => setIncludeTranscript(!includeTranscript)}
            disabled={pushingReport} style={s.cloudConsent}>
            <Text style={s.cloudCheck}>{includeTranscript ? '☑' : '☐'}</Text>
            <Text style={s.cloudConsentLabel}>Kèm nội dung chat</Text>
          </Pressable>
          <Action title={pushingReport ? 'Đang Push...' : '↑ Push Report'}
            onPress={confirmPushReport}
            disabled={pushingReport || generating || !messages.some(m => m.role === 'user')} />
        </View>
        {!!pushStatus && <Text style={s.cloudStatus}>{pushStatus}</Text>}
      </View>
          <View style={s.settingsExtras}>
            <Text style={s.sectionTitle}>BENCHMARK DATA</Text>
            <View style={s.actionRow}>
              <Action title={'Export CSV (' + benchmarks.length + ')'}
                onPress={() => void exportResults()} disabled={!benchmarks.length || generating} />
            </View>
            <Text style={s.small}>Push Report chỉ chạy khi bạn nhấn nút và chỉ áp dụng cho chat đang chọn.</Text>
          </View>
        </ScrollView>
      ) : (
        <View style={s.chatWorkspace}>
          <Pressable accessibilityRole="button" style={s.chatModelBar}
            onPress={() => setActiveTab('settings')}>
            <Text style={s.chatModelLabel} numberOfLines={1}>
              {loadedId === selectedId && loadedWindow === contextWindow ? '● ' : '○ '}
              {selected.name} · {selected.quant}
            </Text>
            <Text style={s.chatModelAction}>⇄ Model / CTX</Text>
          </Pressable>
      <View style={s.metricsPanel}>
        <View style={s.contextInfo}>
          <Text style={s.small}>CHAT #{turns} lượt · CTX {loadedWindow ? loadedWindow / 1024 + 'K' : '—'}
            {' · '}Prompt {promptTokens === null ? '—' : promptTokens} / {contextWindow} tokens
            {usage === null ? '' : ' (' + usage + '%)'}
            {' · '}Peak {peakPromptTokens}</Text>
          {(contextTruncated || (usage !== null && usage >= 85)) &&
            <Text style={s.contextDanger}>{contextTruncated ? 'ĐÃ TRUNCATE' : 'SẮP ĐẦY CONTEXT'}</Text>}
        </View>
        {storageWarning ? <Text style={s.contextDanger}>{storageWarning}</Text> : null}
        <Pressable accessibilityRole="button" style={s.metricsHeader}
          onPress={() => setBenchExpanded(!benchExpanded)}>
          <Text style={s.sectionTitle}>BENCHMARK · {fmt(live?.speed)} tok/s · TTFT {fmt(live?.ttftMs,0)} ms</Text>
          <Text style={s.metricsStatus}>{benchExpanded ? '▲ Thu gọn' : '▼ Chi tiết'}</Text>
        </Pressable>
        {benchExpanded && <View style={s.metricsRow}>
          <Metric label="FIRST TOKEN" value={fmt(live?.ttftMs, 0)} unit="ms" />
          <Metric label="DECODE" value={fmt(live?.speed)} unit="tok/s" />
          <Metric label="PREFILL" value={fmt(live?.prefill)} unit="tok/s" />
          <Metric label="TOKENS" value={fmt(live?.tokens, 0)} />
        </View>}
        {benchExpanded && <View style={s.metricsBottom}>
          <Text style={s.small}>Load: {loadedId ? fmt(loadMs, 0) + ' ms' : '—'} · Total: {fmt(live?.totalMs, 0)} ms</Text>

        </View>}
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
            <Text style={s.bubbleRole}>{item.role === 'user' ? 'YOU' : 'QWEN · ' + chatModelId}</Text>
            <Text style={s.bubbleText}>{item.text || (generating ? '● ● ●' : '')}</Text>
            {item.role === 'assistant' && !!item.text && !generating && (
              <Pressable accessibilityRole="button" style={s.speakAnswer}
                onPress={() => voiceRef.current?.speak(item.text)}>
                <Text style={s.speakAnswerLabel}>🔊 Đọc trả lời</Text>
              </Pressable>
            )}
          </View>
        )}
      />
      <VoiceTest ref={voiceRef} ready={chatReady} generating={generating}
        onTranscript={(text, request, autoSend) => {
          setInput(text);
          setDraftVoiceRequest(request);
          if (autoSend) {
            void send(text, request);
          } else {
            setComposerExpanded(true);
          }
        }} />
      <View style={s.composer}>
        <Pressable accessibilityRole="button" onPress={() => setComposerExpanded(true)}
          disabled={generating || !chatReady} style={s.composerPreview}>
          <Text style={[s.inputPreview, !input && s.inputHint]} numberOfLines={2}>
            {input || (chatReady ? 'Nhấn để soạn / sửa tin nhắn...' : 'Nạp model để chat')}
          </Text>
          <Text style={s.composeExpand}>↗ Sửa</Text>
        </Pressable>
        {generating
          ? <Action title="■ Dừng" onPress={() => void stop()} />
          : <Action title="Gửi" onPress={() => void send()}
              disabled={!input.trim() || !chatReady} />}
      </View>
      <Text style={s.footer}>Giữ bản nháp khi sửa · Context {contextWindow / 1024}K · tối đa {MAX_PREDICT} tokens/lượt</Text>
        </View>
      )}
      <View style={s.tabBar}>
        <Pressable accessibilityRole="tab" accessibilityState={{selected: activeTab === 'chat'}}
          style={[s.tabButton, activeTab === 'chat' && s.tabSelected]}
          onPress={() => setActiveTab('chat')}>
          <Text style={[s.tabLabel, activeTab === 'chat' && s.tabLabelSelected]}>◉ Chat</Text>
        </Pressable>
        <Pressable accessibilityRole="tab" accessibilityState={{selected: activeTab === 'settings'}}
          disabled={generating}
          style={[s.tabButton, activeTab === 'settings' && s.tabSelected]}
          onPress={() => { setActiveTab('settings'); setHistoryOpen(false); }}>
          <Text style={[s.tabLabel, activeTab === 'settings' && s.tabLabelSelected]}>⚙ Cài đặt</Text>
        </Pressable>
      </View>
      <Modal visible={composerExpanded} animationType="slide" presentationStyle="fullScreen"
        onRequestClose={() => { Keyboard.dismiss(); setComposerExpanded(false); }}>
        <SafeAreaView style={s.editorPage}>
          <View style={s.editorHeader}>
            <View style={{ flex: 1 }}>
              <Text style={s.editorTitle}>Soạn / sửa tin nhắn</Text>
              <Text style={s.editorSubtitle}>{input.length}/1000 ký tự · không tự gửi</Text>
            </View>
            <Action title="Đóng" subtle onPress={() => { Keyboard.dismiss(); setComposerExpanded(false); }} />
          </View>
          <KeyboardAvoidingView style={s.editorBody}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TextInput style={s.editorInput} value={input} onChangeText={setInput}
              autoFocus multiline maxLength={1000} textAlignVertical="top"
              placeholder="Nhập hoặc sửa nội dung đã nhận dạng từ mic..."
              placeholderTextColor={MUTED} scrollEnabled
              editable={!generating && chatReady}
              accessibilityLabel="Nội dung tin nhắn có thể chỉnh sửa trước khi gửi" />
            <View style={s.editorActions}>
              <Action title="Giữ nháp" subtle
                onPress={() => { Keyboard.dismiss(); setComposerExpanded(false); }} />
              <Action title="Gửi tin nhắn" onPress={() => void send()}
                disabled={!input.trim() || generating || !chatReady} />
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  chatWorkspace: { flex: 1, minHeight: 0 },
  settingsScroll: { flex: 1 },
  settingsContent: { paddingBottom: 26 },
  settingsHeading: { color: '#f4f7ff', fontSize: 18, fontWeight: '800', paddingHorizontal: 14, paddingTop: 14 },
  settingsHint: { color: MUTED, fontSize: 11, paddingHorizontal: 14, paddingTop: 5, paddingBottom: 8 },
  settingsExtras: { paddingHorizontal: 14, paddingTop: 15, paddingBottom: 20 },
  chatModelBar: { minHeight: 42, backgroundColor: PANEL, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  chatModelLabel: { color: '#eff4ff', fontSize: 12, fontWeight: '700', flex: 1 },
  chatModelAction: { color: ACCENT, fontSize: 11, fontWeight: '800' },
  tabBar: { flexDirection: 'row', backgroundColor: '#151f32',
    paddingHorizontal: 18, paddingTop: 7, paddingBottom: 7, gap: 10,
    borderTopWidth: 1, borderTopColor: '#30405e' },
  tabButton: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 10 },
  tabSelected: { backgroundColor: '#31466c' },
  tabLabel: { fontSize: 13, fontWeight: '700', color: MUTED },
  tabLabelSelected: { color: '#f0f4ff' },
  header: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: '#f4f7ff', fontSize: 23, fontWeight: '800', letterSpacing: 2.5 },
  subtitle: { color: MUTED, fontSize: 9, marginTop: 2 },
  headerActions: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  historyPanel: { padding: 12, backgroundColor: '#131f33', maxHeight: 190 },
  historyList: { marginTop: 7 },
  historyItem: { borderBottomColor: '#34415b', borderBottomWidth: 1, paddingVertical: 8 },
  historyTitle: { color: '#f5f7ff', fontSize: 13, marginBottom: 4 },
  contextInfo: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 8, flexWrap: 'wrap', gap: 4 },
  contextDanger: { color: '#ffb3a6', fontSize: 10, fontWeight: '700' },
  modelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  activeModel: { color: '#f1f5ff', fontSize: 14, fontWeight: '700', marginTop: 4 },
  switchHint: { color: ACCENT, fontSize: 12, fontWeight: '700', paddingLeft: 12 },
  contextBar: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6 },
  contextChip: { paddingVertical: 5, paddingHorizontal: 10,
    backgroundColor: '#2c3952', borderRadius: 8 },
  contextChipActive: { borderColor: ACCENT, borderWidth: 1, backgroundColor: '#30477c' },
  contextChipText: { color: '#f3f6ff', fontSize: 11, fontWeight: '700' },
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
  cloudPanel: { backgroundColor: '#162037', paddingHorizontal: 14, paddingVertical: 9,
    borderBottomColor: '#263247', borderBottomWidth: 1 },
  cloudTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  cloudBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 7 },
  cloudConsent: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, gap: 6 },
  cloudConsentLabel: { color: '#e2e9f8', fontSize: 11 },
  cloudCheck: { color: ACCENT, fontSize: 20 },
  cloudSettings: { marginTop: 8, gap: 5 },
  cloudInput: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 8, backgroundColor: '#26354f',
    color: '#f5f7ff', fontSize: 12 },
  cloudStatus: { color: '#a7d9ca', fontSize: 10, marginTop: 6 },
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
  speakAnswer: { alignSelf: 'flex-start', marginTop: 7 },
  speakAnswerLabel: { color: ACCENT, fontSize: 11, fontWeight: '700' },
  composer: { backgroundColor: '#141e31', flexDirection: 'row', alignItems: 'center',
    gap: 9, paddingHorizontal: 12, paddingTop: 9, paddingBottom: 7 },
  composerPreview: { flex: 1, minHeight: 50, maxHeight: 80, borderRadius: 11,
    backgroundColor: '#25324b', flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingHorizontal: 12, gap: 6 },
  inputPreview: { flex: 1, color: '#f6f7ff', fontSize: 14, lineHeight: 20 },
  inputHint: { color: MUTED },
  composeExpand: { color: ACCENT, fontSize: 12, fontWeight: '700' },
  editorPage: { flex: 1, backgroundColor: BG },
  editorHeader: { flexDirection: 'row', alignItems: 'center',
    backgroundColor: PANEL, paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  editorTitle: { color: '#f6f7ff', fontSize: 16, fontWeight: '800' },
  editorSubtitle: { color: MUTED, fontSize: 11, paddingTop: 5 },
  editorBody: { flex: 1, padding: 12 },
  editorInput: { flex: 1, minHeight: 160, borderRadius: 12,
    backgroundColor: '#25324b', color: '#f6f7ff', padding: 14,
    fontSize: 16, lineHeight: 24 },
  editorActions: { flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingTop: 12, paddingBottom: 8, gap: 8 },
  footer: { backgroundColor: '#141e31', color: MUTED, textAlign: 'center',
    fontSize: 9, paddingBottom: 10 },
});
