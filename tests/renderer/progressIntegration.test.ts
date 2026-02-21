/**
 * Tests for Feature 8: Progress Tracking and Status Display Integration
 *
 * Tests the integration between AppController, ProgressTracker, and the
 * progress/error display workflow. Verifies that:
 * - Progress updates flow correctly from ProgressUpdate → AppController → UI state
 * - Error/skipped results are tracked by ProgressTracker during processing
 * - Error modal state management works with filter buttons
 * - View Errors / Export Error Log buttons visibility logic
 * - Cancel button stops processing and tracks skipped files
 * - Clear resets both AppController and ProgressTracker state
 * - Full lifecycle: select files → process → view errors → export → clear
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AppController,
  formatETA,
  getStatusText,
  getStatusIcon,
  getStatusLabel,
} from '../../src/renderer/appController';
import type { ProgressInfo } from '../../src/renderer/appController';
import { ProgressTracker, createErrorEntry } from '../../src/renderer/progressTracker';
import type { ErrorEntry, ErrorSummary } from '../../src/renderer/progressTracker';
import { FileListManager } from '../../src/renderer/fileListManager';
import type { ProcessingResult, ProgressUpdate } from '../../src/shared/types';
import { IPC_CHANNELS } from '../../src/shared/types';

// ─── Test Data Factories ────────────────────────────────────────────────────

function makeResult(overrides: Partial<ProcessingResult> = {}): ProcessingResult {
  return {
    originalPath: '/music/song.mp3',
    newPath: null,
    status: 'completed',
    error: null,
    originalMetadata: null,
    correctedMetadata: null,
    ...overrides,
  };
}

function makeProgressUpdate(overrides: Partial<ProgressUpdate> = {}): ProgressUpdate {
  return {
    totalFiles: 10,
    processedFiles: 5,
    successCount: 4,
    errorCount: 1,
    skippedCount: 0,
    currentFile: 'current-song.mp3',
    estimatedTimeRemaining: 30,
    ...overrides,
  };
}

// ─── Integration Tests ─────────────────────────────────────────────────────

describe('Feature 8: Progress Tracking and Status Display Integration', () => {
  let controller: AppController;
  let tracker: ProgressTracker;
  let fileListManager: FileListManager;

  beforeEach(() => {
    fileListManager = new FileListManager();
    controller = new AppController(fileListManager);
    tracker = new ProgressTracker();
  });

  // ─── Progress Updates Flow ──────────────────────────────────────────

  describe('progress update flow', () => {
    it('AppController correctly computes percentage from ProgressUpdate', () => {
      fileListManager.addFiles(['/a.mp3', '/b.mp3', '/c.mp3']);
      controller.startProcessing();

      controller.handleProgressUpdate(
        makeProgressUpdate({
          totalFiles: 3,
          processedFiles: 1,
        }),
      );

      const progress = controller.getProgress();
      expect(progress).not.toBeNull();
      expect(progress!.percentage).toBe(33);
    });

    it('AppController computes 100% when all files processed', () => {
      fileListManager.addFiles(['/a.mp3', '/b.mp3']);
      controller.startProcessing();

      controller.handleProgressUpdate(
        makeProgressUpdate({
          totalFiles: 2,
          processedFiles: 2,
        }),
      );

      const progress = controller.getProgress();
      expect(progress!.percentage).toBe(100);
    });

    it('AppController computes 0% when totalFiles is 0', () => {
      fileListManager.addFiles(['/a.mp3']);
      controller.startProcessing();

      controller.handleProgressUpdate(
        makeProgressUpdate({
          totalFiles: 0,
          processedFiles: 0,
        }),
      );

      const progress = controller.getProgress();
      expect(progress!.percentage).toBe(0);
    });

    it('progress listener receives real-time updates', () => {
      const progressCallback = vi.fn();
      controller.onProgress(progressCallback);

      fileListManager.addFiles(['/a.mp3', '/b.mp3']);
      controller.startProcessing();

      controller.handleProgressUpdate(
        makeProgressUpdate({
          processedFiles: 1,
          totalFiles: 2,
          currentFile: 'a.mp3',
        }),
      );

      expect(progressCallback).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const progress: ProgressInfo = progressCallback.mock.calls[0][0] as ProgressInfo;
      expect(progress.currentFile).toBe('a.mp3');
      expect(progress.processedFiles).toBe(1);
      expect(progress.totalFiles).toBe(2);
    });

    it('progress includes formatted ETA', () => {
      fileListManager.addFiles(['/a.mp3']);
      controller.startProcessing();

      controller.handleProgressUpdate(
        makeProgressUpdate({
          estimatedTimeRemaining: 150,
        }),
      );

      const progress = controller.getProgress();
      expect(progress!.etaText).toBe('2m 30s');
    });

    it('progress includes null ETA when not available', () => {
      fileListManager.addFiles(['/a.mp3']);
      controller.startProcessing();

      controller.handleProgressUpdate(
        makeProgressUpdate({
          estimatedTimeRemaining: null,
        }),
      );

      const progress = controller.getProgress();
      expect(progress!.etaText).toBeNull();
    });

    it('success/error/skipped counts passed through', () => {
      fileListManager.addFiles(['/a.mp3']);
      controller.startProcessing();

      controller.handleProgressUpdate(
        makeProgressUpdate({
          successCount: 7,
          errorCount: 2,
          skippedCount: 1,
        }),
      );

      const progress = controller.getProgress();
      expect(progress!.successCount).toBe(7);
      expect(progress!.errorCount).toBe(2);
      expect(progress!.skippedCount).toBe(1);
    });
  });

  // ─── Error Tracking During Processing ───────────────────────────────

  describe('error tracking during processing', () => {
    it('tracker records errors from onFileComplete results', () => {
      const errorResult = makeResult({
        status: 'error',
        error: 'Failed to read file',
        originalPath: '/music/bad.mp3',
      });

      tracker.recordSingleResult(errorResult);
      expect(tracker.errorCount).toBe(1);
      expect(tracker.hasErrors).toBe(true);
    });

    it('tracker records skipped files from onFileComplete results', () => {
      const skippedResult = makeResult({
        status: 'skipped',
        originalPath: '/music/unknown.mp3',
      });

      tracker.recordSingleResult(skippedResult);
      expect(tracker.errorCount).toBe(1);
      expect(tracker.getSummary().skippedCount).toBe(1);
    });

    it('tracker ignores completed results', () => {
      const completedResult = makeResult({
        status: 'completed',
        originalPath: '/music/good.mp3',
      });

      tracker.recordSingleResult(completedResult);
      expect(tracker.errorCount).toBe(0);
      expect(tracker.hasErrors).toBe(false);
    });

    it('tracker accumulates errors across multiple file completions', () => {
      tracker.recordSingleResult(
        makeResult({ status: 'error', error: 'err1', originalPath: '/a.mp3' }),
      );
      tracker.recordSingleResult(makeResult({ status: 'completed', originalPath: '/b.mp3' }));
      tracker.recordSingleResult(makeResult({ status: 'skipped', originalPath: '/c.mp3' }));
      tracker.recordSingleResult(
        makeResult({ status: 'error', error: 'err2', originalPath: '/d.mp3' }),
      );

      expect(tracker.errorCount).toBe(3);
      const summary = tracker.getSummary();
      expect(summary.failedCount).toBe(2);
      expect(summary.skippedCount).toBe(1);
    });

    it('tracker batch records from onProcessingComplete', () => {
      const results: ProcessingResult[] = [
        makeResult({ status: 'completed', originalPath: '/a.mp3' }),
        makeResult({ status: 'error', error: 'fail', originalPath: '/b.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/c.mp3' }),
        makeResult({ status: 'completed', originalPath: '/d.mp3' }),
      ];

      const added = tracker.recordResults(results);
      expect(added).toBe(2);
      expect(tracker.errorCount).toBe(2);
    });

    it('AppController updates file status on file completion', () => {
      fileListManager.addFiles(['/a.mp3', '/b.mp3']);
      controller.startProcessing();

      controller.handleFileComplete(
        makeResult({
          status: 'completed',
          originalPath: '/a.mp3',
          newPath: '/renamed-a.mp3',
        }),
      );

      const file = fileListManager.getFile('/a.mp3');
      expect(file!.status).toBe('completed');
      expect(file!.newPath).toBe('/renamed-a.mp3');
    });

    it('AppController updates file status for errors', () => {
      fileListManager.addFiles(['/a.mp3']);
      controller.startProcessing();

      controller.handleFileComplete(
        makeResult({
          status: 'error',
          error: 'Read failed',
          originalPath: '/a.mp3',
        }),
      );

      const file = fileListManager.getFile('/a.mp3');
      expect(file!.status).toBe('error');
      expect(file!.error).toBe('Read failed');
    });
  });

  // ─── Error Modal State Management ───────────────────────────────────

  describe('error modal state management', () => {
    it('modal starts closed', () => {
      expect(tracker.getModalState().isOpen).toBe(false);
    });

    it('openModal opens the modal', () => {
      tracker.openModal();
      expect(tracker.getModalState().isOpen).toBe(true);
    });

    it('closeModal closes the modal', () => {
      tracker.openModal();
      tracker.closeModal();
      expect(tracker.getModalState().isOpen).toBe(false);
    });

    it('filter defaults to "all"', () => {
      expect(tracker.getModalState().filter).toBe('all');
    });

    it('setFilter changes the filter', () => {
      tracker.setFilter('errors');
      expect(tracker.getModalState().filter).toBe('errors');
    });

    it('filtered entries respect the current filter', () => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'err', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
        makeResult({ status: 'error', error: 'err2', originalPath: '/c.mp3' }),
      ]);

      tracker.setFilter('errors');
      expect(tracker.getFilteredEntries().length).toBe(2);

      tracker.setFilter('skipped');
      expect(tracker.getFilteredEntries().length).toBe(1);

      tracker.setFilter('all');
      expect(tracker.getFilteredEntries().length).toBe(3);
    });

    it('modal state listener fires on open/close', () => {
      const listener = vi.fn();
      tracker.onModalStateChange(listener);

      tracker.openModal();
      expect(listener).toHaveBeenCalledWith({ isOpen: true, filter: 'all' });

      tracker.closeModal();
      expect(listener).toHaveBeenCalledWith({ isOpen: false, filter: 'all' });
    });

    it('entries listener fires when errors are added', () => {
      const listener = vi.fn();
      tracker.onEntriesChange(listener);

      tracker.recordSingleResult(
        makeResult({ status: 'error', error: 'fail', originalPath: '/a.mp3' }),
      );

      expect(listener).toHaveBeenCalledOnce();
      const [entries, summary] = listener.mock.calls[0] as [
        ReadonlyArray<ErrorEntry>,
        ErrorSummary,
      ];
      expect(entries.length).toBe(1);
      expect(summary.totalErrors).toBe(1);
    });
  });

  // ─── View Errors Button Visibility ──────────────────────────────────

  describe('view errors button visibility logic', () => {
    it('hasErrors is false when no errors recorded', () => {
      expect(tracker.hasErrors).toBe(false);
    });

    it('hasErrors is true after recording an error', () => {
      tracker.recordSingleResult(
        makeResult({ status: 'error', error: 'fail', originalPath: '/a.mp3' }),
      );
      expect(tracker.hasErrors).toBe(true);
    });

    it('hasErrors is true after recording a skipped file', () => {
      tracker.recordSingleResult(makeResult({ status: 'skipped', originalPath: '/a.mp3' }));
      expect(tracker.hasErrors).toBe(true);
    });

    it('hasErrors becomes false after clear', () => {
      tracker.recordSingleResult(
        makeResult({ status: 'error', error: 'fail', originalPath: '/a.mp3' }),
      );
      tracker.clear();
      expect(tracker.hasErrors).toBe(false);
    });
  });

  // ─── Export Error Log ───────────────────────────────────────────────

  describe('error log export', () => {
    it('exports empty message when no errors', () => {
      const text = tracker.getExportText();
      expect(text).toBe('No errors recorded.\n');
    });

    it('exports formatted error log with summary', () => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'File corrupt', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
      ]);

      const text = tracker.getExportText();
      expect(text).toContain('Audio Pipeline - Error Log');
      expect(text).toContain('Total issues: 2');
      expect(text).toContain('Failed: 1');
      expect(text).toContain('Skipped: 1');
      expect(text).toContain('a.mp3: File corrupt');
    });

    it('export includes all entries regardless of current filter', () => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'err', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
      ]);

      tracker.setFilter('errors'); // Only showing errors in modal
      const text = tracker.getExportText();
      expect(text).toContain('Total issues: 2'); // But export includes all
    });
  });

  // ─── Cancel and Skipped File Tracking ───────────────────────────────

  describe('cancel and skipped file tracking', () => {
    it('skipped files from cancellation are recorded', () => {
      const results: ProcessingResult[] = [
        makeResult({ status: 'completed', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3', error: 'Processing cancelled' }),
        makeResult({ status: 'skipped', originalPath: '/c.mp3', error: 'Processing cancelled' }),
      ];

      tracker.recordResults(results);
      expect(tracker.getSummary().skippedCount).toBe(2);
    });

    it('cancelled results appear in error modal', () => {
      tracker.recordResults([
        makeResult({ status: 'skipped', originalPath: '/b.mp3', error: 'Processing cancelled' }),
      ]);

      tracker.setFilter('skipped');
      const entries = tracker.getFilteredEntries();
      expect(entries.length).toBe(1);
      expect(entries[0].message).toBe('Processing cancelled');
    });
  });

  // ─── Clear Resets Both Controllers ──────────────────────────────────

  describe('clear resets both controllers', () => {
    it('clearing AppController resets state to idle', () => {
      fileListManager.addFiles(['/a.mp3']);
      controller.startProcessing();
      controller.clearFiles();

      expect(controller.getState()).toBe('idle');
      expect(controller.getProgress()).toBeNull();
      expect(controller.getProcessingResults().length).toBe(0);
    });

    it('clearing ProgressTracker removes all errors', () => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'fail', originalPath: '/a.mp3' }),
      ]);

      tracker.clear();
      expect(tracker.errorCount).toBe(0);
      expect(tracker.hasErrors).toBe(false);
      expect(tracker.getModalState().isOpen).toBe(false);
      expect(tracker.getModalState().filter).toBe('all');
    });

    it('new processing run starts fresh after clear', () => {
      // First run
      tracker.recordResults([
        makeResult({ status: 'error', error: 'fail', originalPath: '/a.mp3' }),
      ]);
      expect(tracker.errorCount).toBe(1);

      // Clear and start fresh
      tracker.clear();
      expect(tracker.errorCount).toBe(0);

      // Second run
      tracker.recordResults([makeResult({ status: 'completed', originalPath: '/b.mp3' })]);
      expect(tracker.errorCount).toBe(0);
    });
  });

  // ─── Status Display ─────────────────────────────────────────────────

  describe('status display', () => {
    it('status text shows "Processing: file (X/Y)" during processing', () => {
      const progress: ProgressInfo = {
        percentage: 50,
        currentFile: 'test-song.mp3',
        processedFiles: 5,
        totalFiles: 10,
        successCount: 4,
        errorCount: 1,
        skippedCount: 0,
        etaText: '30s',
      };

      const text = getStatusText('processing', 10, progress);
      expect(text).toContain('Processing: 5/10');
      expect(text).toContain('test-song.mp3');
      expect(text).toContain('30s remaining');
    });

    it('status text shows completion summary', () => {
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

      const text = getStatusText('completed', 10, progress);
      expect(text).toContain('Complete');
      expect(text).toContain('8 succeeded');
      expect(text).toContain('1 failed');
      expect(text).toContain('1 skipped');
    });

    it('status icons match expected characters', () => {
      expect(getStatusIcon('completed')).toBe('\u2713');
      expect(getStatusIcon('error')).toBe('\u2717');
      expect(getStatusIcon('skipped')).toBe('\u26A0');
      expect(getStatusIcon('pending')).toBe('\u25CB');
      expect(getStatusIcon('fingerprinting')).toBe('\u25CF');
    });

    it('status labels are human-readable', () => {
      expect(getStatusLabel('completed')).toBe('Completed');
      expect(getStatusLabel('error')).toBe('Error');
      expect(getStatusLabel('skipped')).toBe('Skipped');
      expect(getStatusLabel('pending')).toBe('Pending');
      expect(getStatusLabel('fingerprinting')).toBe('Fingerprinting');
      expect(getStatusLabel('fetching_metadata')).toBe('Fetching Metadata');
    });

    it('ETA formatting handles various durations', () => {
      expect(formatETA(30)).toBe('30s');
      expect(formatETA(90)).toBe('1m 30s');
      expect(formatETA(3600)).toBe('1h');
      expect(formatETA(3660)).toBe('1h 1m');
      expect(formatETA(null)).toBeNull();
      expect(formatETA(-1)).toBeNull();
      expect(formatETA(Infinity)).toBeNull();
    });
  });

  // ─── IPC Channel Constants ──────────────────────────────────────────

  describe('IPC channel constants for Feature 8', () => {
    it('FILE_COMPLETE channel exists', () => {
      expect(IPC_CHANNELS.FILE_COMPLETE).toBe('file-complete');
    });

    it('GET_FILE_METADATA channel exists', () => {
      expect(IPC_CHANNELS.GET_FILE_METADATA).toBe('get-file-metadata');
    });

    it('GET_ERRORS channel exists for error retrieval', () => {
      expect(IPC_CHANNELS.GET_ERRORS).toBe('get-errors');
    });

    it('EXPORT_ERROR_LOG channel exists for log export', () => {
      expect(IPC_CHANNELS.EXPORT_ERROR_LOG).toBe('export-error-log');
    });
  });

  // ─── Full Lifecycle Integration ─────────────────────────────────────

  describe('full lifecycle integration', () => {
    it('complete processing lifecycle: select → process → errors → clear', () => {
      // 1. Select files
      fileListManager.addFiles(['/a.mp3', '/b.mp3', '/c.mp3', '/d.mp3']);
      expect(controller.getState()).toBe('idle');
      expect(controller.getUIState().startEnabled).toBe(true);

      // 2. Start processing
      const filePaths = controller.startProcessing();
      expect(filePaths).toHaveLength(4);
      expect(controller.getState()).toBe('processing');
      expect(controller.getUIState().cancelEnabled).toBe(true);

      // 3. Receive progress updates
      controller.handleProgressUpdate(
        makeProgressUpdate({
          totalFiles: 4,
          processedFiles: 1,
          successCount: 1,
          errorCount: 0,
          skippedCount: 0,
          currentFile: 'a.mp3',
          estimatedTimeRemaining: 15,
        }),
      );

      expect(controller.getProgress()!.percentage).toBe(25);
      expect(controller.getProgress()!.etaText).toBe('15s');

      // 4. Receive file completions + record in tracker
      const result1 = makeResult({ status: 'completed', originalPath: '/a.mp3' });
      controller.handleFileComplete(result1);
      tracker.recordSingleResult(result1);

      const result2 = makeResult({
        status: 'error',
        error: 'File corrupt',
        originalPath: '/b.mp3',
      });
      controller.handleFileComplete(result2);
      tracker.recordSingleResult(result2);

      const result3 = makeResult({ status: 'skipped', originalPath: '/c.mp3' });
      controller.handleFileComplete(result3);
      tracker.recordSingleResult(result3);

      const result4 = makeResult({ status: 'completed', originalPath: '/d.mp3' });
      controller.handleFileComplete(result4);
      tracker.recordSingleResult(result4);

      // 5. Processing complete
      const allResults = [result1, result2, result3, result4];
      controller.handleProcessingComplete(allResults);
      tracker.recordResults(allResults);

      expect(controller.getState()).toBe('completed');
      expect(tracker.hasErrors).toBe(true);
      // 2 from single results + 2 from batch results = 4 total tracked
      expect(tracker.errorCount).toBe(4);

      // 6. View errors
      tracker.openModal();
      expect(tracker.getModalState().isOpen).toBe(true);

      // Filter to errors only
      tracker.setFilter('errors');
      const errorEntries = tracker.getFilteredEntries();
      expect(errorEntries.length).toBe(2);
      expect(errorEntries.every((e) => e.status === 'error')).toBe(true);

      // Filter to skipped only
      tracker.setFilter('skipped');
      const skippedEntries = tracker.getFilteredEntries();
      expect(skippedEntries.length).toBe(2);

      // 7. Export
      const exportText = tracker.getExportText();
      expect(exportText).toContain('Audio Pipeline - Error Log');
      expect(exportText).toContain('Total issues: 4');

      // 8. Close modal and clear
      tracker.closeModal();
      expect(tracker.getModalState().isOpen).toBe(false);

      controller.clearFiles();
      tracker.clear();

      expect(controller.getState()).toBe('idle');
      expect(tracker.errorCount).toBe(0);
      expect(tracker.hasErrors).toBe(false);
    });

    it('re-processing clears previous errors', () => {
      fileListManager.addFiles(['/a.mp3']);
      controller.startProcessing();

      // First run has error
      tracker.recordSingleResult(
        makeResult({ status: 'error', error: 'fail', originalPath: '/a.mp3' }),
      );
      expect(tracker.errorCount).toBe(1);

      // Clear tracker before next run (simulates what app.ts does)
      tracker.clear();
      expect(tracker.errorCount).toBe(0);

      // Second run succeeds
      controller.handleProcessingComplete([
        makeResult({ status: 'completed', originalPath: '/a.mp3' }),
      ]);
      tracker.recordResults([makeResult({ status: 'completed', originalPath: '/a.mp3' })]);

      expect(tracker.errorCount).toBe(0);
      expect(tracker.hasErrors).toBe(false);
    });

    it('file status icons update correctly through processing', () => {
      fileListManager.addFiles(['/a.mp3']);
      controller.startProcessing();

      // Initially pending
      expect(fileListManager.getFile('/a.mp3')!.status).toBe('pending');

      // Update to fingerprinting
      fileListManager.updateStatus('/a.mp3', 'fingerprinting');
      expect(getStatusIcon(fileListManager.getFile('/a.mp3')!.status)).toBe('\u25CF'); // ●

      // Update to completed
      controller.handleFileComplete(
        makeResult({
          status: 'completed',
          originalPath: '/a.mp3',
        }),
      );
      expect(getStatusIcon(fileListManager.getFile('/a.mp3')!.status)).toBe('\u2713'); // ✓
    });
  });

  // ─── Error Entry Creation ───────────────────────────────────────────

  describe('createErrorEntry integration', () => {
    it('creates error entry with correct filename from path', () => {
      const result = makeResult({
        status: 'error',
        error: 'Read failed',
        originalPath: '/music/folder/deep/song.mp3',
      });

      const entry = createErrorEntry(result);
      expect(entry).not.toBeNull();
      expect(entry!.fileName).toBe('song.mp3');
      expect(entry!.filePath).toBe('/music/folder/deep/song.mp3');
    });

    it('creates skipped entry with default message', () => {
      const result = makeResult({
        status: 'skipped',
        originalPath: '/music/unknown.mp3',
      });

      const entry = createErrorEntry(result);
      expect(entry).not.toBeNull();
      expect(entry!.message).toBe('File skipped (no match found)');
    });
  });

  // ─── Error Summary Computation ──────────────────────────────────────

  describe('computeErrorSummary integration', () => {
    it('computes correct summary from mixed entries', () => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'e1', originalPath: '/a.mp3' }),
        makeResult({ status: 'error', error: 'e2', originalPath: '/b.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/c.mp3' }),
        makeResult({ status: 'completed', originalPath: '/d.mp3' }),
      ]);

      const summary = tracker.getSummary();
      expect(summary.totalErrors).toBe(3);
      expect(summary.failedCount).toBe(2);
      expect(summary.skippedCount).toBe(1);
    });
  });

  // ─── Filter Error Entries ───────────────────────────────────────────

  describe('filterErrorEntries integration', () => {
    it('filters respect current modal filter state', () => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
        makeResult({ status: 'error', error: 'e2', originalPath: '/c.mp3' }),
      ]);

      // Default is 'all'
      expect(tracker.getFilteredEntries().length).toBe(3);

      tracker.setFilter('errors');
      expect(tracker.getFilteredEntries().length).toBe(2);

      tracker.setFilter('skipped');
      expect(tracker.getFilteredEntries().length).toBe(1);
    });
  });

  // ─── Error Log Formatting ──────────────────────────────────────────

  describe('formatErrorLog integration', () => {
    it('formats complete error log with header and entries', () => {
      tracker.recordResults([
        makeResult({
          status: 'error',
          error: 'Corrupt file header',
          originalPath: '/music/broken.mp3',
        }),
        makeResult({ status: 'skipped', originalPath: '/music/unknown.flac' }),
      ]);

      const text = tracker.getExportText();
      expect(text).toContain('Audio Pipeline - Error Log');
      expect(text).toContain('Total issues: 2');
      expect(text).toContain('Failed: 1');
      expect(text).toContain('Skipped: 1');
      expect(text).toContain('broken.mp3: Corrupt file header');
      expect(text).toContain('SKIPPED unknown.flac');
    });
  });

  // ─── Event Listener Cleanup ─────────────────────────────────────────

  describe('event listener cleanup', () => {
    it('unsubscribed tracker listeners do not fire', () => {
      const listener = vi.fn();
      const unsub = tracker.onEntriesChange(listener);

      unsub();
      tracker.recordSingleResult(
        makeResult({ status: 'error', error: 'fail', originalPath: '/a.mp3' }),
      );
      expect(listener).not.toHaveBeenCalled();
    });

    it('unsubscribed controller listeners do not fire', () => {
      const listener = vi.fn();
      const unsub = controller.onProgress(listener);

      unsub();
      fileListManager.addFiles(['/a.mp3']);
      controller.startProcessing();
      controller.handleProgressUpdate(makeProgressUpdate());
      expect(listener).not.toHaveBeenCalled();
    });

    it('unsubscribed modal listener does not fire', () => {
      const listener = vi.fn();
      const unsub = tracker.onModalStateChange(listener);

      unsub();
      tracker.openModal();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ─── Completion State ───────────────────────────────────────────────

  describe('completion state', () => {
    it('processing complete sets 100% and clears current file', () => {
      fileListManager.addFiles(['/a.mp3']);
      controller.startProcessing();

      controller.handleProgressUpdate(
        makeProgressUpdate({
          totalFiles: 1,
          processedFiles: 0,
          currentFile: 'a.mp3',
        }),
      );

      controller.handleProcessingComplete([
        makeResult({ status: 'completed', originalPath: '/a.mp3' }),
      ]);

      const progress = controller.getProgress();
      expect(progress!.percentage).toBe(100);
      expect(progress!.currentFile).toBeNull();
      expect(progress!.etaText).toBeNull();
      expect(controller.getState()).toBe('completed');
    });

    it('completion listener fires with results', () => {
      const listener = vi.fn();
      controller.onProcessingComplete(listener);

      fileListManager.addFiles(['/a.mp3']);
      controller.startProcessing();

      const results = [makeResult({ status: 'completed', originalPath: '/a.mp3' })];
      controller.handleProcessingComplete(results);

      expect(listener).toHaveBeenCalledWith(results);
    });

    it('status text shows completion summary', () => {
      fileListManager.addFiles(['/a.mp3', '/b.mp3']);
      controller.startProcessing();

      controller.handleProgressUpdate(
        makeProgressUpdate({
          successCount: 1,
          errorCount: 1,
        }),
      );

      controller.handleProcessingComplete([
        makeResult({ status: 'completed', originalPath: '/a.mp3' }),
        makeResult({ status: 'error', error: 'fail', originalPath: '/b.mp3' }),
      ]);

      const uiState = controller.getUIState();
      expect(uiState.statusText).toContain('Complete');
    });
  });
});
