/**
 * Application Controller
 *
 * Pure TypeScript class that manages the application state for the Electron GUI.
 * This class is framework-agnostic and can be tested without any DOM or Electron dependencies.
 *
 * Responsibilities:
 * - Managing application state (idle, loading files, processing, completed)
 * - Coordinating between FileListManager and UI updates
 * - Processing file selection results
 * - Handling start/cancel processing commands
 * - Computing UI state (button enabled/disabled, status text)
 * - Tracking progress updates
 */

import type { ProcessingResult, ProcessingStatus, ProgressUpdate } from '../shared/types';
import { FileListManager, type FileEntry } from './fileListManager';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Application state */
export type AppState = 'idle' | 'loading_files' | 'processing' | 'completed';

/** UI state computed from application state */
export interface UIState {
  /** Whether the "Select Files" button should be enabled */
  selectFilesEnabled: boolean;
  /** Whether the "Select Folder" button should be enabled */
  selectFolderEnabled: boolean;
  /** Whether the "Start Processing" button should be enabled */
  startEnabled: boolean;
  /** Whether the "Clear" button should be enabled */
  clearEnabled: boolean;
  /** Whether the "Cancel" button should be visible/enabled */
  cancelEnabled: boolean;
  /** Status bar text */
  statusText: string;
  /** Whether the file list empty message should be shown */
  showEmptyMessage: boolean;
}

/** Progress info for display */
export interface ProgressInfo {
  /** Percentage complete (0-100) */
  percentage: number;
  /** Currently processing file */
  currentFile: string | null;
  /** Number processed */
  processedFiles: number;
  /** Total files */
  totalFiles: number;
  /** Success count */
  successCount: number;
  /** Error count */
  errorCount: number;
  /** Skipped count */
  skippedCount: number;
  /** Estimated time remaining (formatted string) */
  etaText: string | null;
}

/** Callback for state changes */
export type StateChangeListener = (uiState: UIState) => void;

/** Callback for progress updates */
export type ProgressListener = (progress: ProgressInfo) => void;

/** Callback for file list changes */
export type FileListListener = (files: ReadonlyArray<FileEntry>) => void;

/** Callback for processing results */
export type ProcessingCompleteListener = (results: ProcessingResult[]) => void;

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Formats seconds into a human-readable time string.
 * @param seconds - Number of seconds
 * @returns Formatted string (e.g. "2m 30s", "45s", "1h 5m")
 */
export function formatETA(seconds: number | null): string | null {
  if (seconds === null || seconds < 0 || !isFinite(seconds)) return null;

  const roundedSeconds = Math.ceil(seconds);

  if (roundedSeconds < 60) {
    return `${roundedSeconds}s`;
  }

  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;

  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Generates a status bar text from the current state and file count.
 */
export function getStatusText(state: AppState, fileCount: number, progress?: ProgressInfo): string {
  switch (state) {
    case 'idle':
      if (fileCount === 0) return 'Ready - No files selected';
      return `${fileCount} file${fileCount !== 1 ? 's' : ''} selected`;

    case 'loading_files':
      return 'Loading files...';

    case 'processing': {
      if (!progress) return 'Processing...';
      const parts: string[] = [];
      parts.push(`Processing: ${progress.processedFiles}/${progress.totalFiles}`);
      if (progress.currentFile) {
        parts.push(`- ${progress.currentFile}`);
      }
      if (progress.etaText) {
        parts.push(`(${progress.etaText} remaining)`);
      }
      return parts.join(' ');
    }

    case 'completed': {
      if (!progress) return 'Processing complete';
      const parts: string[] = ['Complete:'];
      parts.push(`${progress.successCount} succeeded`);
      if (progress.errorCount > 0) {
        parts.push(`${progress.errorCount} failed`);
      }
      if (progress.skippedCount > 0) {
        parts.push(`${progress.skippedCount} skipped`);
      }
      return parts.join(', ').replace('Complete:, ', 'Complete: ');
    }
  }
}

/**
 * Returns the status icon character for a processing status.
 */
export function getStatusIcon(status: ProcessingStatus): string {
  switch (status) {
    case 'completed':
      return '\u2713'; // ✓
    case 'error':
      return '\u2717'; // ✗
    case 'skipped':
      return '\u26A0'; // ⚠
    case 'pending':
      return '\u25CB'; // ○
    default:
      // In-progress statuses
      return '\u25CF'; // ●
  }
}

/**
 * Returns a human-readable label for a processing status.
 */
export function getStatusLabel(status: ProcessingStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'fingerprinting':
      return 'Fingerprinting';
    case 'identifying':
      return 'Identifying';
    case 'fetching_metadata':
      return 'Fetching Metadata';
    case 'fetching_lyrics':
      return 'Fetching Lyrics';
    case 'writing_tags':
      return 'Writing Tags';
    case 'renaming':
      return 'Renaming';
    case 'completed':
      return 'Completed';
    case 'error':
      return 'Error';
    case 'skipped':
      return 'Skipped';
  }
}

// ─── AppController Class ─────────────────────────────────────────────────────

/**
 * Controls the application state and coordinates between
 * the file list manager and UI layer.
 */
export class AppController {
  private state: AppState = 'idle';
  private readonly fileListManager: FileListManager;
  private currentProgress: ProgressInfo | null = null;
  private processingResults: ProcessingResult[] = [];

  // Listeners
  private stateListeners: StateChangeListener[] = [];
  private progressListeners: ProgressListener[] = [];
  private fileListListeners: FileListListener[] = [];
  private completionListeners: ProcessingCompleteListener[] = [];

  constructor(fileListManager?: FileListManager) {
    this.fileListManager = fileListManager ?? new FileListManager();

    // Forward file list changes
    this.fileListManager.onChange((files) => {
      this.notifyFileListListeners(files);
      this.notifyStateListeners();
    });
  }

  // ─── State Accessors ───────────────────────────────────────────────────

  /** Returns the current application state */
  getState(): AppState {
    return this.state;
  }

  /** Returns the file list manager instance */
  getFileListManager(): FileListManager {
    return this.fileListManager;
  }

  /** Returns the current progress info (null if not processing) */
  getProgress(): ProgressInfo | null {
    return this.currentProgress;
  }

  /** Returns the latest processing results */
  getProcessingResults(): ProcessingResult[] {
    return [...this.processingResults];
  }

  /** Computes the current UI state from application state */
  getUIState(): UIState {
    const fileCount = this.fileListManager.count;
    const isProcessing = this.state === 'processing';
    const isLoading = this.state === 'loading_files';

    return {
      selectFilesEnabled: !isProcessing && !isLoading,
      selectFolderEnabled: !isProcessing && !isLoading,
      startEnabled: !isProcessing && !isLoading && fileCount > 0,
      clearEnabled: !isProcessing && !isLoading && fileCount > 0,
      cancelEnabled: isProcessing,
      statusText: getStatusText(this.state, fileCount, this.currentProgress ?? undefined),
      showEmptyMessage: fileCount === 0 && !isLoading,
    };
  }

  // ─── Actions ───────────────────────────────────────────────────────────

  /**
   * Called when files are selected via the file picker or folder scanner.
   * @param filePaths - Array of file paths selected
   * @returns Number of new files added (excludes duplicates)
   */
  handleFilesSelected(filePaths: string[]): number {
    const added = this.fileListManager.addFiles(filePaths);
    if (this.state === 'loading_files') {
      this.setState('idle');
    } else {
      this.notifyStateListeners();
    }
    return added;
  }

  /**
   * Sets the state to loading (before file picker opens).
   */
  setLoadingFiles(): void {
    this.setState('loading_files');
  }

  /**
   * Sets the state back to idle (after file picker canceled or completed).
   */
  setIdle(): void {
    this.setState('idle');
  }

  /**
   * Updates metadata for a file after it's been read by the audio reader.
   */
  handleMetadataLoaded(
    filePath: string,
    metadata: { title?: string | null; artist?: string | null; fileSize?: number },
  ): void {
    this.fileListManager.updateMetadata(filePath, metadata);
  }

  /**
   * Called when processing starts.
   * Resets progress and sets state to 'processing'.
   * @returns The list of file paths to process
   */
  startProcessing(): string[] {
    this.fileListManager.resetAllStatuses();
    this.processingResults = [];
    this.currentProgress = {
      percentage: 0,
      currentFile: null,
      processedFiles: 0,
      totalFiles: this.fileListManager.count,
      successCount: 0,
      errorCount: 0,
      skippedCount: 0,
      etaText: null,
    };
    this.setState('processing');
    return this.fileListManager.getFilePaths();
  }

  /**
   * Handles a progress update from the batch processor.
   */
  handleProgressUpdate(update: ProgressUpdate): void {
    this.currentProgress = {
      percentage:
        update.totalFiles > 0 ? Math.round((update.processedFiles / update.totalFiles) * 100) : 0,
      currentFile: update.currentFile,
      processedFiles: update.processedFiles,
      totalFiles: update.totalFiles,
      successCount: update.successCount,
      errorCount: update.errorCount,
      skippedCount: update.skippedCount,
      etaText: formatETA(update.estimatedTimeRemaining),
    };

    this.notifyProgressListeners();
    this.notifyStateListeners();
  }

  /**
   * Handles a single file completion from the batch processor.
   */
  handleFileComplete(result: ProcessingResult): void {
    this.processingResults.push(result);

    // Update file status in the file list manager
    this.fileListManager.updateStatus(result.originalPath, result.status, {
      error: result.error,
      failedStep: result.failedStep ?? null,
      newPath: result.newPath,
    });
  }

  /**
   * Called when batch processing is complete.
   */
  handleProcessingComplete(results: ProcessingResult[]): void {
    this.processingResults = results;

    // Update progress to 100%
    if (this.currentProgress) {
      this.currentProgress.percentage = 100;
      this.currentProgress.processedFiles = this.currentProgress.totalFiles;
      this.currentProgress.currentFile = null;
      this.currentProgress.etaText = null;
    }

    this.setState('completed');
    this.notifyCompletionListeners(results);
  }

  /**
   * Clears the file list and resets state to idle.
   */
  clearFiles(): void {
    this.fileListManager.clear();
    this.currentProgress = null;
    this.processingResults = [];
    this.setState('idle');
  }

  /**
   * Removes a single file from the list.
   * @returns true if the file was found and removed
   */
  removeFile(filePath: string): boolean {
    const removed = this.fileListManager.removeFile(filePath);
    if (removed && this.fileListManager.isEmpty) {
      this.setState('idle');
    }
    return removed;
  }

  // ─── Event Listeners ───────────────────────────────────────────────────

  /** Register a listener for state changes */
  onStateChange(listener: StateChangeListener): () => void {
    this.stateListeners.push(listener);
    return () => {
      this.stateListeners = this.stateListeners.filter((l) => l !== listener);
    };
  }

  /** Register a listener for progress updates */
  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.push(listener);
    return () => {
      this.progressListeners = this.progressListeners.filter((l) => l !== listener);
    };
  }

  /** Register a listener for file list changes */
  onFileListChange(listener: FileListListener): () => void {
    this.fileListListeners.push(listener);
    return () => {
      this.fileListListeners = this.fileListListeners.filter((l) => l !== listener);
    };
  }

  /** Register a listener for processing completion */
  onProcessingComplete(listener: ProcessingCompleteListener): () => void {
    this.completionListeners.push(listener);
    return () => {
      this.completionListeners = this.completionListeners.filter((l) => l !== listener);
    };
  }

  // ─── Private Methods ───────────────────────────────────────────────────

  private setState(newState: AppState): void {
    this.state = newState;
    this.notifyStateListeners();
  }

  private notifyStateListeners(): void {
    const uiState = this.getUIState();
    for (const listener of this.stateListeners) {
      listener(uiState);
    }
  }

  private notifyProgressListeners(): void {
    if (this.currentProgress) {
      for (const listener of this.progressListeners) {
        listener(this.currentProgress);
      }
    }
  }

  private notifyFileListListeners(files: ReadonlyArray<FileEntry>): void {
    for (const listener of this.fileListListeners) {
      listener(files);
    }
  }

  private notifyCompletionListeners(results: ProcessingResult[]): void {
    for (const listener of this.completionListeners) {
      listener(results);
    }
  }
}
