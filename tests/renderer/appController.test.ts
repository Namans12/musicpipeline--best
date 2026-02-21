/**
 * Tests for AppController and helper functions
 *
 * Comprehensive tests for the application state controller.
 * Tests cover: state management, UI state computation, progress tracking,
 * file handling, event listeners, and helper functions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AppController,
  formatETA,
  getStatusText,
  getStatusIcon,
  getStatusLabel,
  type ProgressInfo,
} from '../../src/renderer/appController';
import { FileListManager } from '../../src/renderer/fileListManager';
import type { ProcessingResult, ProgressUpdate } from '../../src/shared/types';

// ─── Helper Function Tests ──────────────────────────────────────────────────

describe('formatETA', () => {
  it('returns null for null input', () => {
    expect(formatETA(null)).toBeNull();
  });

  it('returns null for negative seconds', () => {
    expect(formatETA(-5)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(formatETA(Infinity)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(formatETA(NaN)).toBeNull();
  });

  it('formats zero seconds', () => {
    expect(formatETA(0)).toBe('0s');
  });

  it('formats seconds under 60', () => {
    expect(formatETA(45)).toBe('45s');
  });

  it('formats fractional seconds (rounds up)', () => {
    expect(formatETA(45.3)).toBe('46s');
  });

  it('formats exact minutes', () => {
    expect(formatETA(120)).toBe('2m');
  });

  it('formats minutes with seconds', () => {
    expect(formatETA(150)).toBe('2m 30s');
  });

  it('formats exact hours', () => {
    expect(formatETA(3600)).toBe('1h');
  });

  it('formats hours with minutes', () => {
    expect(formatETA(3900)).toBe('1h 5m');
  });
});

describe('getStatusText', () => {
  it('returns "Ready - No files selected" when idle with no files', () => {
    expect(getStatusText('idle', 0)).toBe('Ready - No files selected');
  });

  it('returns file count when idle with files', () => {
    expect(getStatusText('idle', 5)).toBe('5 files selected');
  });

  it('uses singular "file" for one file', () => {
    expect(getStatusText('idle', 1)).toBe('1 file selected');
  });

  it('returns "Loading files..." when loading', () => {
    expect(getStatusText('loading_files', 0)).toBe('Loading files...');
  });

  it('returns "Processing..." when processing without progress', () => {
    expect(getStatusText('processing', 3)).toBe('Processing...');
  });

  it('returns processing detail with progress', () => {
    const progress: ProgressInfo = {
      percentage: 50,
      currentFile: 'song.mp3',
      processedFiles: 5,
      totalFiles: 10,
      successCount: 4,
      errorCount: 1,
      skippedCount: 0,
      etaText: '30s',
    };
    const result = getStatusText('processing', 10, progress);
    expect(result).toContain('Processing: 5/10');
    expect(result).toContain('song.mp3');
    expect(result).toContain('30s remaining');
  });

  it('returns processing status without current file', () => {
    const progress: ProgressInfo = {
      percentage: 50,
      currentFile: null,
      processedFiles: 5,
      totalFiles: 10,
      successCount: 5,
      errorCount: 0,
      skippedCount: 0,
      etaText: null,
    };
    const result = getStatusText('processing', 10, progress);
    expect(result).toContain('Processing: 5/10');
    expect(result).not.toContain('null');
  });

  it('returns "Processing complete" when completed without progress', () => {
    expect(getStatusText('completed', 5)).toBe('Processing complete');
  });

  it('returns completion summary with progress', () => {
    const progress: ProgressInfo = {
      percentage: 100,
      currentFile: null,
      processedFiles: 10,
      totalFiles: 10,
      successCount: 8,
      errorCount: 1,
      skippedCount: 1,
      etaText: null,
    };
    const result = getStatusText('completed', 10, progress);
    expect(result).toContain('Complete');
    expect(result).toContain('8 succeeded');
    expect(result).toContain('1 failed');
    expect(result).toContain('1 skipped');
  });

  it('omits zero error/skip counts in completion summary', () => {
    const progress: ProgressInfo = {
      percentage: 100,
      currentFile: null,
      processedFiles: 10,
      totalFiles: 10,
      successCount: 10,
      errorCount: 0,
      skippedCount: 0,
      etaText: null,
    };
    const result = getStatusText('completed', 10, progress);
    expect(result).toContain('10 succeeded');
    expect(result).not.toContain('failed');
    expect(result).not.toContain('skipped');
  });
});

describe('getStatusIcon', () => {
  it('returns checkmark for completed', () => {
    expect(getStatusIcon('completed')).toBe('\u2713');
  });

  it('returns cross for error', () => {
    expect(getStatusIcon('error')).toBe('\u2717');
  });

  it('returns warning for skipped', () => {
    expect(getStatusIcon('skipped')).toBe('\u26A0');
  });

  it('returns circle for pending', () => {
    expect(getStatusIcon('pending')).toBe('\u25CB');
  });

  it('returns filled circle for in-progress statuses', () => {
    expect(getStatusIcon('fingerprinting')).toBe('\u25CF');
    expect(getStatusIcon('identifying')).toBe('\u25CF');
    expect(getStatusIcon('fetching_metadata')).toBe('\u25CF');
    expect(getStatusIcon('fetching_lyrics')).toBe('\u25CF');
    expect(getStatusIcon('writing_tags')).toBe('\u25CF');
    expect(getStatusIcon('renaming')).toBe('\u25CF');
  });
});

describe('getStatusLabel', () => {
  it('returns "Pending" for pending', () => {
    expect(getStatusLabel('pending')).toBe('Pending');
  });

  it('returns "Fingerprinting" for fingerprinting', () => {
    expect(getStatusLabel('fingerprinting')).toBe('Fingerprinting');
  });

  it('returns "Identifying" for identifying', () => {
    expect(getStatusLabel('identifying')).toBe('Identifying');
  });

  it('returns "Fetching Metadata" for fetching_metadata', () => {
    expect(getStatusLabel('fetching_metadata')).toBe('Fetching Metadata');
  });

  it('returns "Fetching Lyrics" for fetching_lyrics', () => {
    expect(getStatusLabel('fetching_lyrics')).toBe('Fetching Lyrics');
  });

  it('returns "Writing Tags" for writing_tags', () => {
    expect(getStatusLabel('writing_tags')).toBe('Writing Tags');
  });

  it('returns "Renaming" for renaming', () => {
    expect(getStatusLabel('renaming')).toBe('Renaming');
  });

  it('returns "Completed" for completed', () => {
    expect(getStatusLabel('completed')).toBe('Completed');
  });

  it('returns "Error" for error', () => {
    expect(getStatusLabel('error')).toBe('Error');
  });

  it('returns "Skipped" for skipped', () => {
    expect(getStatusLabel('skipped')).toBe('Skipped');
  });
});

// ─── AppController Tests ────────────────────────────────────────────────────

describe('AppController', () => {
  let controller: AppController;
  let fileListManager: FileListManager;

  beforeEach(() => {
    fileListManager = new FileListManager();
    controller = new AppController(fileListManager);
  });

  // ─── Constructor / Initial State ─────────────────────────────────────

  describe('initial state', () => {
    it('starts in idle state', () => {
      expect(controller.getState()).toBe('idle');
    });

    it('starts with no progress', () => {
      expect(controller.getProgress()).toBeNull();
    });

    it('starts with empty processing results', () => {
      expect(controller.getProcessingResults()).toEqual([]);
    });

    it('returns the file list manager', () => {
      expect(controller.getFileListManager()).toBe(fileListManager);
    });

    it('creates its own FileListManager if none provided', () => {
      const ctrl = new AppController();
      expect(ctrl.getFileListManager()).toBeInstanceOf(FileListManager);
    });
  });

  // ─── getUIState ──────────────────────────────────────────────────────

  describe('getUIState', () => {
    it('returns correct initial UI state', () => {
      const uiState = controller.getUIState();
      expect(uiState.selectFilesEnabled).toBe(true);
      expect(uiState.selectFolderEnabled).toBe(true);
      expect(uiState.startEnabled).toBe(false); // no files
      expect(uiState.clearEnabled).toBe(false); // no files
      expect(uiState.cancelEnabled).toBe(false);
      expect(uiState.statusText).toBe('Ready - No files selected');
      expect(uiState.showEmptyMessage).toBe(true);
    });

    it('enables start and clear when files are added', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      const uiState = controller.getUIState();
      expect(uiState.startEnabled).toBe(true);
      expect(uiState.clearEnabled).toBe(true);
      expect(uiState.showEmptyMessage).toBe(false);
    });

    it('disables file selection during loading', () => {
      controller.setLoadingFiles();
      const uiState = controller.getUIState();
      expect(uiState.selectFilesEnabled).toBe(false);
      expect(uiState.selectFolderEnabled).toBe(false);
      expect(uiState.startEnabled).toBe(false);
      expect(uiState.showEmptyMessage).toBe(false); // loading, not showing empty
    });

    it('disables all buttons except cancel during processing', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      const uiState = controller.getUIState();
      expect(uiState.selectFilesEnabled).toBe(false);
      expect(uiState.selectFolderEnabled).toBe(false);
      expect(uiState.startEnabled).toBe(false);
      expect(uiState.clearEnabled).toBe(false);
      expect(uiState.cancelEnabled).toBe(true);
    });
  });

  // ─── handleFilesSelected ─────────────────────────────────────────────

  describe('handleFilesSelected', () => {
    it('adds files and returns count', () => {
      const added = controller.handleFilesSelected(['/path/a.mp3', '/path/b.mp3']);
      expect(added).toBe(2);
      expect(fileListManager.count).toBe(2);
    });

    it('transitions from loading_files to idle', () => {
      controller.setLoadingFiles();
      controller.handleFilesSelected(['/path/song.mp3']);
      expect(controller.getState()).toBe('idle');
    });

    it('stays idle if not in loading state', () => {
      controller.handleFilesSelected(['/path/song.mp3']);
      expect(controller.getState()).toBe('idle');
    });

    it('handles empty selection', () => {
      const added = controller.handleFilesSelected([]);
      expect(added).toBe(0);
    });

    it('deduplicates files', () => {
      controller.handleFilesSelected(['/path/song.mp3']);
      const added = controller.handleFilesSelected(['/path/song.mp3']);
      expect(added).toBe(0);
      expect(fileListManager.count).toBe(1);
    });
  });

  // ─── setLoadingFiles / setIdle ───────────────────────────────────────

  describe('setLoadingFiles', () => {
    it('sets state to loading_files', () => {
      controller.setLoadingFiles();
      expect(controller.getState()).toBe('loading_files');
    });

    it('notifies state listeners', () => {
      const listener = vi.fn();
      controller.onStateChange(listener);
      controller.setLoadingFiles();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          selectFilesEnabled: false,
          selectFolderEnabled: false,
        }),
      );
    });
  });

  describe('setIdle', () => {
    it('sets state to idle', () => {
      controller.setLoadingFiles();
      controller.setIdle();
      expect(controller.getState()).toBe('idle');
    });
  });

  // ─── handleMetadataLoaded ────────────────────────────────────────────

  describe('handleMetadataLoaded', () => {
    it('updates metadata in file list manager', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.handleMetadataLoaded('/path/song.mp3', {
        title: 'My Song',
        artist: 'My Artist',
        fileSize: 5242880,
      });

      const entry = fileListManager.getFile('/path/song.mp3')!;
      expect(entry.currentTitle).toBe('My Song');
      expect(entry.currentArtist).toBe('My Artist');
      expect(entry.fileSize).toBe(5242880);
      expect(entry.metadataLoaded).toBe(true);
    });
  });

  // ─── startProcessing ─────────────────────────────────────────────────

  describe('startProcessing', () => {
    it('returns file paths for processing', () => {
      fileListManager.addFiles(['/path/a.mp3', '/path/b.mp3']);
      const paths = controller.startProcessing();
      expect(paths).toEqual(['/path/a.mp3', '/path/b.mp3']);
    });

    it('sets state to processing', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      expect(controller.getState()).toBe('processing');
    });

    it('initializes progress', () => {
      fileListManager.addFiles(['/path/a.mp3', '/path/b.mp3']);
      controller.startProcessing();
      const progress = controller.getProgress()!;
      expect(progress.percentage).toBe(0);
      expect(progress.totalFiles).toBe(2);
      expect(progress.processedFiles).toBe(0);
      expect(progress.successCount).toBe(0);
      expect(progress.errorCount).toBe(0);
      expect(progress.skippedCount).toBe(0);
      expect(progress.currentFile).toBeNull();
      expect(progress.etaText).toBeNull();
    });

    it('resets previous processing results', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();

      const result: ProcessingResult = {
        originalPath: '/path/song.mp3',
        newPath: null,
        status: 'completed',
        error: null,
        originalMetadata: null,
        correctedMetadata: null,
      };
      controller.handleFileComplete(result);
      expect(controller.getProcessingResults()).toHaveLength(1);

      // Start processing again
      controller.startProcessing();
      expect(controller.getProcessingResults()).toEqual([]);
    });

    it('resets all file statuses', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      fileListManager.updateStatus('/path/song.mp3', 'completed');
      controller.startProcessing();
      expect(fileListManager.getFile('/path/song.mp3')!.status).toBe('pending');
    });
  });

  // ─── handleProgressUpdate ────────────────────────────────────────────

  describe('handleProgressUpdate', () => {
    it('updates progress info', () => {
      fileListManager.addFiles(['/path/a.mp3', '/path/b.mp3']);
      controller.startProcessing();

      const update: ProgressUpdate = {
        totalFiles: 2,
        processedFiles: 1,
        successCount: 1,
        errorCount: 0,
        skippedCount: 0,
        currentFile: 'b.mp3',
        estimatedTimeRemaining: 30,
      };
      controller.handleProgressUpdate(update);

      const progress = controller.getProgress()!;
      expect(progress.percentage).toBe(50);
      expect(progress.currentFile).toBe('b.mp3');
      expect(progress.processedFiles).toBe(1);
      expect(progress.totalFiles).toBe(2);
      expect(progress.successCount).toBe(1);
      expect(progress.etaText).toBe('30s');
    });

    it('calculates percentage correctly', () => {
      fileListManager.addFiles(['/a.mp3', '/b.mp3', '/c.mp3']);
      controller.startProcessing();

      controller.handleProgressUpdate({
        totalFiles: 3,
        processedFiles: 2,
        successCount: 2,
        errorCount: 0,
        skippedCount: 0,
        currentFile: 'c.mp3',
        estimatedTimeRemaining: 10,
      });

      expect(controller.getProgress()!.percentage).toBe(67); // Math.round(2/3 * 100)
    });

    it('handles zero total files', () => {
      controller.handleProgressUpdate({
        totalFiles: 0,
        processedFiles: 0,
        successCount: 0,
        errorCount: 0,
        skippedCount: 0,
        currentFile: null,
        estimatedTimeRemaining: null,
      });

      expect(controller.getProgress()!.percentage).toBe(0);
    });

    it('notifies progress listeners', () => {
      const listener = vi.fn();
      controller.onProgress(listener);
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();

      controller.handleProgressUpdate({
        totalFiles: 1,
        processedFiles: 0,
        successCount: 0,
        errorCount: 0,
        skippedCount: 0,
        currentFile: 'song.mp3',
        estimatedTimeRemaining: 5,
      });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          currentFile: 'song.mp3',
          etaText: '5s',
        }),
      );
    });

    it('notifies state listeners for status text update', () => {
      const listener = vi.fn();
      controller.onStateChange(listener);
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();

      // Reset call count from startProcessing
      listener.mockClear();

      controller.handleProgressUpdate({
        totalFiles: 1,
        processedFiles: 0,
        successCount: 0,
        errorCount: 0,
        skippedCount: 0,
        currentFile: 'song.mp3',
        estimatedTimeRemaining: 5,
      });

      expect(listener).toHaveBeenCalled();
    });
  });

  // ─── handleFileComplete ──────────────────────────────────────────────

  describe('handleFileComplete', () => {
    it('adds result to processing results', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();

      const result: ProcessingResult = {
        originalPath: '/path/song.mp3',
        newPath: '/path/Artist - Song.mp3',
        status: 'completed',
        error: null,
        originalMetadata: null,
        correctedMetadata: null,
      };
      controller.handleFileComplete(result);

      expect(controller.getProcessingResults()).toHaveLength(1);
      expect(controller.getProcessingResults()[0]).toEqual(result);
    });

    it('updates file status in file list manager', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();

      controller.handleFileComplete({
        originalPath: '/path/song.mp3',
        newPath: '/path/Artist - Song.mp3',
        status: 'completed',
        error: null,
        originalMetadata: null,
        correctedMetadata: null,
      });

      const entry = fileListManager.getFile('/path/song.mp3')!;
      expect(entry.status).toBe('completed');
      expect(entry.newPath).toBe('/path/Artist - Song.mp3');
    });

    it('handles error results', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();

      controller.handleFileComplete({
        originalPath: '/path/song.mp3',
        newPath: null,
        status: 'error',
        error: 'Failed to read file',
        originalMetadata: null,
        correctedMetadata: null,
      });

      const entry = fileListManager.getFile('/path/song.mp3')!;
      expect(entry.status).toBe('error');
      expect(entry.error).toBe('Failed to read file');
    });
  });

  // ─── handleProcessingComplete ────────────────────────────────────────

  describe('handleProcessingComplete', () => {
    it('sets state to completed', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      controller.handleProcessingComplete([]);
      expect(controller.getState()).toBe('completed');
    });

    it('stores processing results', () => {
      const results: ProcessingResult[] = [
        {
          originalPath: '/path/song.mp3',
          newPath: null,
          status: 'completed',
          error: null,
          originalMetadata: null,
          correctedMetadata: null,
        },
      ];

      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      controller.handleProcessingComplete(results);

      expect(controller.getProcessingResults()).toEqual(results);
    });

    it('updates progress to 100%', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      controller.handleProcessingComplete([]);
      expect(controller.getProgress()!.percentage).toBe(100);
    });

    it('clears current file in progress', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      controller.handleProgressUpdate({
        totalFiles: 1,
        processedFiles: 0,
        successCount: 0,
        errorCount: 0,
        skippedCount: 0,
        currentFile: 'song.mp3',
        estimatedTimeRemaining: 5,
      });
      controller.handleProcessingComplete([]);
      expect(controller.getProgress()!.currentFile).toBeNull();
      expect(controller.getProgress()!.etaText).toBeNull();
    });

    it('notifies completion listeners', () => {
      const listener = vi.fn();
      controller.onProcessingComplete(listener);

      const results: ProcessingResult[] = [];
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      controller.handleProcessingComplete(results);

      expect(listener).toHaveBeenCalledWith(results);
    });
  });

  // ─── clearFiles ──────────────────────────────────────────────────────

  describe('clearFiles', () => {
    it('clears all files', () => {
      fileListManager.addFiles(['/path/a.mp3', '/path/b.mp3']);
      controller.clearFiles();
      expect(fileListManager.count).toBe(0);
    });

    it('resets state to idle', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      controller.handleProcessingComplete([]);
      controller.clearFiles();
      expect(controller.getState()).toBe('idle');
    });

    it('clears progress', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      controller.clearFiles();
      expect(controller.getProgress()).toBeNull();
    });

    it('clears processing results', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      controller.handleProcessingComplete([
        {
          originalPath: '/path/song.mp3',
          newPath: null,
          status: 'completed',
          error: null,
          originalMetadata: null,
          correctedMetadata: null,
        },
      ]);
      controller.clearFiles();
      expect(controller.getProcessingResults()).toEqual([]);
    });
  });

  // ─── removeFile ──────────────────────────────────────────────────────

  describe('removeFile', () => {
    it('removes file from list', () => {
      fileListManager.addFiles(['/path/a.mp3', '/path/b.mp3']);
      const result = controller.removeFile('/path/a.mp3');
      expect(result).toBe(true);
      expect(fileListManager.count).toBe(1);
    });

    it('returns false for non-existent file', () => {
      expect(controller.removeFile('/nonexistent.mp3')).toBe(false);
    });

    it('sets state to idle when last file removed', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.removeFile('/path/song.mp3');
      expect(controller.getState()).toBe('idle');
    });
  });

  // ─── Event Listeners ─────────────────────────────────────────────────

  describe('event listeners', () => {
    it('onStateChange listener can be unsubscribed', () => {
      const listener = vi.fn();
      const unsub = controller.onStateChange(listener);
      unsub();
      controller.setLoadingFiles();
      expect(listener).not.toHaveBeenCalled();
    });

    it('onProgress listener can be unsubscribed', () => {
      const listener = vi.fn();
      const unsub = controller.onProgress(listener);
      unsub();
      controller.handleProgressUpdate({
        totalFiles: 1,
        processedFiles: 0,
        successCount: 0,
        errorCount: 0,
        skippedCount: 0,
        currentFile: null,
        estimatedTimeRemaining: null,
      });
      expect(listener).not.toHaveBeenCalled();
    });

    it('onFileListChange listener receives file changes', () => {
      const listener = vi.fn();
      controller.onFileListChange(listener);
      fileListManager.addFiles(['/path/song.mp3']);
      expect(listener).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ filePath: '/path/song.mp3' })]),
      );
    });

    it('onFileListChange listener can be unsubscribed', () => {
      const listener = vi.fn();
      const unsub = controller.onFileListChange(listener);
      unsub();
      fileListManager.addFiles(['/path/song.mp3']);
      expect(listener).not.toHaveBeenCalled();
    });

    it('onProcessingComplete listener can be unsubscribed', () => {
      const listener = vi.fn();
      const unsub = controller.onProcessingComplete(listener);
      unsub();
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      controller.handleProcessingComplete([]);
      expect(listener).not.toHaveBeenCalled();
    });

    it('supports multiple listeners of the same type', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      controller.onStateChange(listener1);
      controller.onStateChange(listener2);
      controller.setLoadingFiles();
      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });
  });

  // ─── Integration Tests ───────────────────────────────────────────────

  describe('integration', () => {
    it('full processing lifecycle', () => {
      const stateListener = vi.fn();
      const progressListener = vi.fn();
      const completionListener = vi.fn();

      controller.onStateChange(stateListener);
      controller.onProgress(progressListener);
      controller.onProcessingComplete(completionListener);

      // 1. Add files
      controller.handleFilesSelected(['/path/a.mp3', '/path/b.mp3']);
      expect(controller.getState()).toBe('idle');
      expect(fileListManager.count).toBe(2);

      // 2. Load metadata
      controller.handleMetadataLoaded('/path/a.mp3', { title: 'Song A', artist: 'Artist A' });
      controller.handleMetadataLoaded('/path/b.mp3', { title: 'Song B', artist: 'Artist B' });

      // 3. Start processing
      const paths = controller.startProcessing();
      expect(paths).toEqual(['/path/a.mp3', '/path/b.mp3']);
      expect(controller.getState()).toBe('processing');

      // 4. Progress update
      controller.handleProgressUpdate({
        totalFiles: 2,
        processedFiles: 1,
        successCount: 1,
        errorCount: 0,
        skippedCount: 0,
        currentFile: 'b.mp3',
        estimatedTimeRemaining: 5,
      });
      expect(progressListener).toHaveBeenCalled();

      // 5. File completion
      controller.handleFileComplete({
        originalPath: '/path/a.mp3',
        newPath: '/path/Artist A - Song A.mp3',
        status: 'completed',
        error: null,
        originalMetadata: null,
        correctedMetadata: null,
      });

      controller.handleFileComplete({
        originalPath: '/path/b.mp3',
        newPath: '/path/Artist B - Song B.mp3',
        status: 'completed',
        error: null,
        originalMetadata: null,
        correctedMetadata: null,
      });

      // 6. Processing complete
      const results: ProcessingResult[] = [
        {
          originalPath: '/path/a.mp3',
          newPath: '/path/Artist A - Song A.mp3',
          status: 'completed',
          error: null,
          originalMetadata: null,
          correctedMetadata: null,
        },
        {
          originalPath: '/path/b.mp3',
          newPath: '/path/Artist B - Song B.mp3',
          status: 'completed',
          error: null,
          originalMetadata: null,
          correctedMetadata: null,
        },
      ];
      controller.handleProcessingComplete(results);
      expect(controller.getState()).toBe('completed');
      expect(completionListener).toHaveBeenCalledWith(results);
    });

    it('file selection flow with loading state', () => {
      controller.setLoadingFiles();
      expect(controller.getState()).toBe('loading_files');

      controller.handleFilesSelected(['/path/song.mp3']);
      expect(controller.getState()).toBe('idle');
      expect(fileListManager.count).toBe(1);
    });

    it('clear resets entire state', () => {
      // Set up some state
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      controller.handleProgressUpdate({
        totalFiles: 1,
        processedFiles: 1,
        successCount: 1,
        errorCount: 0,
        skippedCount: 0,
        currentFile: null,
        estimatedTimeRemaining: null,
      });
      controller.handleProcessingComplete([
        {
          originalPath: '/path/song.mp3',
          newPath: null,
          status: 'completed',
          error: null,
          originalMetadata: null,
          correctedMetadata: null,
        },
      ]);

      // Clear everything
      controller.clearFiles();
      expect(controller.getState()).toBe('idle');
      expect(controller.getProgress()).toBeNull();
      expect(controller.getProcessingResults()).toEqual([]);
      expect(fileListManager.count).toBe(0);
    });

    it('getProcessingResults returns a copy', () => {
      fileListManager.addFiles(['/path/song.mp3']);
      controller.startProcessing();
      const result: ProcessingResult = {
        originalPath: '/path/song.mp3',
        newPath: null,
        status: 'completed',
        error: null,
        originalMetadata: null,
        correctedMetadata: null,
      };
      controller.handleFileComplete(result);

      const results1 = controller.getProcessingResults();
      const results2 = controller.getProcessingResults();
      expect(results1).toEqual(results2);
      expect(results1).not.toBe(results2); // Different array instances
    });
  });
});
