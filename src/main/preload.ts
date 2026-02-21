/**
 * Electron Preload Script
 *
 * Exposes a safe, typed API to the renderer process via contextBridge.
 * This is the only bridge between the sandboxed renderer and the main process.
 *
 * The renderer accesses these methods via `window.electronAPI`.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/types';
import type { AppSettings } from '../shared/types';

/**
 * The API exposed to the renderer process via contextBridge.
 * Methods correspond to IPC channels defined in shared/types.ts.
 */
export interface ElectronAPI {
  /** Opens native file picker for audio files (multi-select) */
  selectFiles(): Promise<string[]>;
  /** Opens native folder picker and scans for audio files */
  selectFolder(): Promise<string[]>;
  /** Starts batch processing on the given file paths */
  startProcessing(filePaths: string[]): Promise<void>;
  /** Cancels the current processing batch */
  cancelProcessing(): Promise<void>;
  /** Registers a callback for progress updates from the main process */
  onProgressUpdate(callback: (data: unknown) => void): () => void;
  /** Registers a callback for processing completion */
  onProcessingComplete(callback: (data: unknown) => void): () => void;
  /** Registers a callback for individual file completion */
  onFileComplete(callback: (data: unknown) => void): () => void;
  /** Reads metadata for a single audio file (for display in file list) */
  getFileMetadata(filePath: string): Promise<unknown>;
  /** Retrieves error log entries from the Logger */
  getErrors(limit?: number): Promise<unknown>;
  /** Exports error log to a user-selected file, returns the path or null if cancelled */
  exportErrorLog(): Promise<string | null>;
  /** Retrieves the current application settings */
  getSettings(): Promise<AppSettings>;
  /** Saves updated application settings (partial update) */
  saveSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  /** Opens a native folder picker for selecting an output folder, returns path or null */
  selectOutputFolder(): Promise<string | null>;
  /** Clears all cached fingerprints, metadata, and lyrics */
  clearCache(): Promise<void>;
  /** Gets cache statistics (entries count, size, etc.) */
  getCacheStats(): Promise<{
    fingerprints: number;
    metadata: number;
    lyrics: number;
    totalEntries: number;
    sizeBytes: number;
    isPersistent: boolean;
  }>;
}

const electronAPI: ElectronAPI = {
  selectFiles: () => ipcRenderer.invoke(IPC_CHANNELS.SELECT_FILES),

  selectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.SELECT_FOLDER),

  startProcessing: (filePaths: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.START_PROCESSING, filePaths),

  cancelProcessing: () => ipcRenderer.invoke(IPC_CHANNELS.CANCEL_PROCESSING),

  onProgressUpdate: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.PROGRESS_UPDATE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PROGRESS_UPDATE, handler);
    };
  },

  onProcessingComplete: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.PROCESSING_COMPLETE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PROCESSING_COMPLETE, handler);
    };
  },

  onFileComplete: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.FILE_COMPLETE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.FILE_COMPLETE, handler);
    };
  },

  getFileMetadata: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_FILE_METADATA, filePath),

  getErrors: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.GET_ERRORS, limit),

  exportErrorLog: () => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_ERROR_LOG),

  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS),

  saveSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_SETTINGS, settings),

  selectOutputFolder: () => ipcRenderer.invoke(IPC_CHANNELS.SELECT_OUTPUT_FOLDER),

  clearCache: () => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_CACHE),

  getCacheStats: () => ipcRenderer.invoke(IPC_CHANNELS.GET_CACHE_STATS),
};

// When contextIsolation is disabled, contextBridge.exposeInMainWorld throws.
// Fall back to direct assignment on the window object.
try {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
} catch {
  (window as unknown as Record<string, unknown>).electronAPI = electronAPI;
}
