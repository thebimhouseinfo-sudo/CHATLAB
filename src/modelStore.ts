import * as FS from 'expo-file-system/legacy';
import { ModelSpec, modelUrl } from './models';

const directory = FS.documentDirectory + 'models/';
export const modelPath = (m: ModelSpec) => directory + m.file;

export async function isModelReady(m: ModelSpec): Promise<boolean> {
  const info = await FS.getInfoAsync(modelPath(m), { size: true });
  return info.exists && 'size' in info &&
    typeof info.size === 'number' && info.size >= m.minimumBytes;
}

export async function downloadModel(
  m: ModelSpec, onProgress: (downloaded: number, total: number) => void,
): Promise<void> {
  if (await isModelReady(m)) return;
  await FS.makeDirectoryAsync(directory, { intermediates: true });
  const target = modelPath(m);
  const temporary = target + '.part';
  // An interrupted file is never regarded as a valid GGUF model.
  await FS.deleteAsync(temporary, { idempotent: true });
  const task = FS.createDownloadResumable(
    modelUrl(m), temporary, {},
    p => onProgress(p.totalBytesWritten, p.totalBytesExpectedToWrite),
  );
  try {
    const result = await task.downloadAsync();
    if (!result || result.status !== 200) {
      throw new Error('Download failed (HTTP ' + (result?.status ?? 'unknown') + ')');
    }
    const info = await FS.getInfoAsync(temporary, { size: true });
    if (!info.exists || !('size' in info) || !info.size || info.size < m.minimumBytes) {
      throw new Error('Downloaded file is smaller than expected; not loading it.');
    }
    await FS.deleteAsync(target, { idempotent: true });
    await FS.moveAsync({ from: temporary, to: target });
  } catch (error) {
    await FS.deleteAsync(temporary, { idempotent: true });
    throw error;
  }
}

export async function removeModel(m: ModelSpec): Promise<void> {
  await FS.deleteAsync(modelPath(m), { idempotent: true });
}
