/**
 * Audio Pipeline - Electron Main Process Entry Point
 *
 * Initializes the Electron application, creates the main window,
 * and sets up IPC handlers for communication with the renderer process.
 */

import * as path from 'path';
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { IPC_CHANNELS, SUPPORTED_EXTENSIONS } from '../shared/types';
import type { ProcessingResult, ProgressUpdate } from '../shared/types';
import { scanDirectoryForAudioFiles } from './utils/fileScanner';
import { readAudioFile } from './services/audioReader';
import { BatchProcessor } from './services/batchProcessor';
import { Logger } from './services/logger';
import { SettingsManager } from './services/settingsManager';

let mainWindow: BrowserWindow | null = null;
let currentBatchProcessor: BatchProcessor | null = null;
let logger: Logger | null = null;
let settingsManager: SettingsManager | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
    },
    title: 'Audio Pipeline',
  });

  // Load the renderer HTML file
  void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Initialize logger
async function initializeLogger(): Promise<void> {
  logger = new Logger();
  await logger.initialize();
}

// Initialize settings manager
async function initializeSettings(): Promise<void> {
  settingsManager = new SettingsManager();
  await settingsManager.initialize();
}

// ─── IPC Handlers ──────────────────────────────────────────────────────────

// File selection: opens native file picker for audio files (multi-select)
ipcMain.handle(IPC_CHANNELS.SELECT_FILES, async () => {
  if (!mainWindow) return [];

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Audio Files',
        extensions: SUPPORTED_EXTENSIONS.map((ext) => ext.slice(1)), // Remove dot prefix
      },
    ],
  });

  return result.canceled ? [] : result.filePaths;
});

// Folder selection: opens folder picker and scans for audio files recursively
ipcMain.handle(IPC_CHANNELS.SELECT_FOLDER, async () => {
  if (!mainWindow) return [];

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return [];
  }

  return scanDirectoryForAudioFiles(result.filePaths[0]);
});

// Get metadata for a single audio file (for display in file list)
ipcMain.handle(IPC_CHANNELS.GET_FILE_METADATA, async (_event, filePath: string) => {
  try {
    const metadata = await readAudioFile(filePath);
    return {
      title: metadata.title,
      artist: metadata.artist,
      fileSize: metadata.fileSize,
    };
  } catch {
    return null;
  }
});

// Start batch processing
ipcMain.handle(IPC_CHANNELS.START_PROCESSING, async (_event, filePaths: string[]) => {
  if (!mainWindow) return;
  if (currentBatchProcessor?.isRunning()) return;

  // Get current settings for batch processor
  const currentSettings = settingsManager?.get();

  currentBatchProcessor = new BatchProcessor({
    logger: logger ?? undefined,
    concurrency: currentSettings?.concurrency,
    acoustIdApiKey: currentSettings?.acoustIdApiKey,
    settings: currentSettings,
    onProgress: (update: ProgressUpdate): void => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.PROGRESS_UPDATE, update);
      }
    },
    onFileComplete: (result: ProcessingResult): void => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.FILE_COMPLETE, result);
      }
    },
  });

  try {
    const results = await currentBatchProcessor.process(filePaths);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.PROCESSING_COMPLETE, results);
    }
  } catch (error) {
    if (logger) {
      logger.logError(error);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.PROCESSING_COMPLETE, []);
    }
  } finally {
    currentBatchProcessor = null;
  }
});

// Cancel processing
ipcMain.handle(IPC_CHANNELS.CANCEL_PROCESSING, () => {
  if (currentBatchProcessor?.isRunning()) {
    currentBatchProcessor.cancel();
  }
});

// Get error log entries from the Logger
ipcMain.handle(IPC_CHANNELS.GET_ERRORS, (_event, limit?: number) => {
  if (!logger) return [];
  return logger.getErrors(limit);
});

// Export error log to a user-selected file
ipcMain.handle(IPC_CHANNELS.EXPORT_ERROR_LOG, async () => {
  if (!mainWindow || !logger) return null;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Error Log',
    defaultPath: 'audio-pipeline-errors.log',
    filters: [
      { name: 'Log Files', extensions: ['log', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  const success = await logger.exportLog(result.filePath);
  return success ? result.filePath : null;
});

// Get application settings
ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, () => {
  if (!settingsManager) return null;
  return settingsManager.get();
});

// Save application settings (partial update)
ipcMain.handle(
  IPC_CHANNELS.SAVE_SETTINGS,
  async (_event, updates: Partial<import('../shared/types').AppSettings>) => {
    if (!settingsManager) return null;
    return settingsManager.save(updates);
  },
);

// Select output folder via native folder picker
ipcMain.handle(IPC_CHANNELS.SELECT_OUTPUT_FOLDER, async () => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Output Folder',
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

// Get cache statistics
ipcMain.handle(IPC_CHANNELS.GET_CACHE_STATS, () => {
  if (!currentBatchProcessor) {
    return {
      fingerprints: 0,
      metadata: 0,
      lyrics: 0,
      totalEntries: 0,
      sizeBytes: 0,
      isPersistent: false,
    };
  }
  return currentBatchProcessor.getCacheStats();
});

// Clear all caches
ipcMain.handle(IPC_CHANNELS.CLEAR_CACHE, () => {
  if (currentBatchProcessor) {
    currentBatchProcessor.clearCache();
    logger?.info('Cache cleared via user request');
  }
});

// ─── App Lifecycle ──────────────────────────────────────────────────────────

void app.whenReady().then(() => {
  void initializeLogger();
  void initializeSettings();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Close persistent cache database if open
  if (currentBatchProcessor) {
    currentBatchProcessor.close();
  }
});
