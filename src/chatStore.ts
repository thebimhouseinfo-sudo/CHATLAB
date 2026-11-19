import * as FS from 'expo-file-system/legacy';
import type { ModelId } from './models';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

export type ChatSession = {
  id: string;
  modelId: ModelId;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

const file = FS.documentDirectory + 'chats.json';
const MAX_SESSIONS = 40;
let saveQueue: Promise<void> = Promise.resolve();

export async function readChatSessions(): Promise<ChatSession[]> {
  try {
    const info = await FS.getInfoAsync(file);
    if (!info.exists) return [];
    const data: unknown = JSON.parse(await FS.readAsStringAsync(file));
    if (!Array.isArray(data)) return [];
    return data.filter((item): item is ChatSession => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Partial<ChatSession>;
      return typeof row.id === 'string' &&
        typeof row.modelId === 'string' &&
        typeof row.title === 'string' &&
        typeof row.createdAt === 'string' &&
        typeof row.updatedAt === 'string' &&
        Array.isArray(row.messages) &&
        row.messages.every(m =>
          m && typeof m.id === 'string' &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.text === 'string');
    }).slice(0, MAX_SESSIONS);
  } catch {
    return [];
  }
}

// Serial writes prevent an older chat snapshot from overwriting a newer one.
export function writeChatSessions(sessions: ChatSession[]): Promise<void> {
  const snapshot = JSON.stringify(sessions.slice(0, MAX_SESSIONS));
  saveQueue = saveQueue.catch(() => {}).then(() => FS.writeAsStringAsync(file, snapshot));
  return saveQueue;
}
