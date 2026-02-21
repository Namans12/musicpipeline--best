/**
 * Tests for ProgressTracker and helper functions
 *
 * Comprehensive tests for the progress tracking and error display module.
 * Tests cover: helper functions, error entry management, modal state management,
 * filtering, export, event listeners, and integration scenarios.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProgressTracker,
  extractFileName,
  createErrorEntry,
  computeErrorSummary,
  filterErrorEntries,
  formatErrorEntry,
  formatErrorLog,
  type ErrorEntry,
  type ErrorSummary,
} from '../../src/renderer/progressTracker';
import type { ProcessingResult } from '../../src/shared/types';

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

function makeErrorEntry(overrides: Partial<ErrorEntry> = {}): ErrorEntry {
  return {
    filePath: '/music/song.mp3',
    fileName: 'song.mp3',
    message: 'File read error',
    status: 'error',
    timestamp: '2025-02-18T12:00:00.000Z',
    ...overrides,
  };
}

// ─── Helper Function Tests ──────────────────────────────────────────────────

describe('extractFileName', () => {
  it('extracts filename from Unix path', () => {
    expect(extractFileName('/music/folder/song.mp3')).toBe('song.mp3');
  });

  it('extracts filename from Windows path', () => {
    expect(extractFileName('C:\\Music\\folder\\song.mp3')).toBe('song.mp3');
  });

  it('returns the input if no slashes', () => {
    expect(extractFileName('song.mp3')).toBe('song.mp3');
  });

  it('handles path with both slash types', () => {
    expect(extractFileName('C:\\Music/folder\\song.mp3')).toBe('song.mp3');
  });

  it('handles empty string', () => {
    expect(extractFileName('')).toBe('');
  });

  it('handles path ending with slash', () => {
    expect(extractFileName('/music/')).toBe('');
  });
});

describe('createErrorEntry', () => {
  it('creates entry for error status', () => {
    const result = makeResult({
      status: 'error',
      error: 'Something failed',
      originalPath: '/music/bad.mp3',
    });

    const entry = createErrorEntry(result);
    expect(entry).not.toBeNull();
    expect(entry!.filePath).toBe('/music/bad.mp3');
    expect(entry!.fileName).toBe('bad.mp3');
    expect(entry!.message).toBe('Something failed');
    expect(entry!.status).toBe('error');
    expect(entry!.timestamp).toBeTruthy();
  });

  it('creates entry for skipped status', () => {
    const result = makeResult({
      status: 'skipped',
      error: null,
      originalPath: '/music/unknown.mp3',
    });

    const entry = createErrorEntry(result);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('skipped');
    expect(entry!.message).toBe('File skipped (no match found)');
  });

  it('returns null for completed status', () => {
    const result = makeResult({ status: 'completed' });
    expect(createErrorEntry(result)).toBeNull();
  });

  it('returns null for pending status', () => {
    const result = makeResult({ status: 'pending' });
    expect(createErrorEntry(result)).toBeNull();
  });

  it('returns null for in-progress status', () => {
    const result = makeResult({ status: 'fingerprinting' });
    expect(createErrorEntry(result)).toBeNull();
  });

  it('uses error message when available for skipped', () => {
    const result = makeResult({
      status: 'skipped',
      error: 'No fingerprint matches',
    });

    const entry = createErrorEntry(result);
    expect(entry!.message).toBe('No fingerprint matches');
  });

  it('uses default message when error is null for error status', () => {
    const result = makeResult({
      status: 'error',
      error: null,
    });

    const entry = createErrorEntry(result);
    expect(entry!.message).toBe('Unknown error');
  });

  it('extracts filename from Windows path', () => {
    const result = makeResult({
      status: 'error',
      error: 'fail',
      originalPath: 'C:\\Users\\Music\\song.mp3',
    });

    const entry = createErrorEntry(result);
    expect(entry!.fileName).toBe('song.mp3');
  });
});

describe('computeErrorSummary', () => {
  it('returns zeroes for empty array', () => {
    const summary = computeErrorSummary([]);
    expect(summary.totalErrors).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.skippedCount).toBe(0);
  });

  it('counts errors correctly', () => {
    const entries: ErrorEntry[] = [
      makeErrorEntry({ status: 'error' }),
      makeErrorEntry({ status: 'error' }),
    ];
    const summary = computeErrorSummary(entries);
    expect(summary.totalErrors).toBe(2);
    expect(summary.failedCount).toBe(2);
    expect(summary.skippedCount).toBe(0);
  });

  it('counts skipped correctly', () => {
    const entries: ErrorEntry[] = [
      makeErrorEntry({ status: 'skipped' }),
      makeErrorEntry({ status: 'skipped' }),
      makeErrorEntry({ status: 'skipped' }),
    ];
    const summary = computeErrorSummary(entries);
    expect(summary.totalErrors).toBe(3);
    expect(summary.failedCount).toBe(0);
    expect(summary.skippedCount).toBe(3);
  });

  it('counts mixed correctly', () => {
    const entries: ErrorEntry[] = [
      makeErrorEntry({ status: 'error' }),
      makeErrorEntry({ status: 'skipped' }),
      makeErrorEntry({ status: 'error' }),
    ];
    const summary = computeErrorSummary(entries);
    expect(summary.totalErrors).toBe(3);
    expect(summary.failedCount).toBe(2);
    expect(summary.skippedCount).toBe(1);
  });
});

describe('filterErrorEntries', () => {
  const entries: ErrorEntry[] = [
    makeErrorEntry({ status: 'error', fileName: 'a.mp3' }),
    makeErrorEntry({ status: 'skipped', fileName: 'b.mp3' }),
    makeErrorEntry({ status: 'error', fileName: 'c.mp3' }),
    makeErrorEntry({ status: 'skipped', fileName: 'd.mp3' }),
  ];

  it('returns all entries for "all" filter', () => {
    const result = filterErrorEntries(entries, 'all');
    expect(result.length).toBe(4);
  });

  it('returns only errors for "errors" filter', () => {
    const result = filterErrorEntries(entries, 'errors');
    expect(result.length).toBe(2);
    expect(result.every((e) => e.status === 'error')).toBe(true);
  });

  it('returns only skipped for "skipped" filter', () => {
    const result = filterErrorEntries(entries, 'skipped');
    expect(result.length).toBe(2);
    expect(result.every((e) => e.status === 'skipped')).toBe(true);
  });

  it('returns empty array when no matches', () => {
    const onlyErrors: ErrorEntry[] = [makeErrorEntry({ status: 'error' })];
    const result = filterErrorEntries(onlyErrors, 'skipped');
    expect(result.length).toBe(0);
  });

  it('returns empty array for empty input', () => {
    expect(filterErrorEntries([], 'all').length).toBe(0);
  });
});

describe('formatErrorEntry', () => {
  it('formats error entry correctly', () => {
    const entry = makeErrorEntry({
      timestamp: '2025-02-18T12:00:00.000Z',
      status: 'error',
      fileName: 'song.mp3',
      message: 'File read error',
    });

    const formatted = formatErrorEntry(entry);
    expect(formatted).toBe('[2025-02-18T12:00:00.000Z] ERROR song.mp3: File read error');
  });

  it('formats skipped entry correctly', () => {
    const entry = makeErrorEntry({
      timestamp: '2025-02-18T12:00:00.000Z',
      status: 'skipped',
      fileName: 'unknown.mp3',
      message: 'No match found',
    });

    const formatted = formatErrorEntry(entry);
    expect(formatted).toBe('[2025-02-18T12:00:00.000Z] SKIPPED unknown.mp3: No match found');
  });
});

describe('formatErrorLog', () => {
  it('returns "No errors" for empty entries', () => {
    const result = formatErrorLog([]);
    expect(result).toBe('No errors recorded.\n');
  });

  it('includes header with summary', () => {
    const entries = [makeErrorEntry({ status: 'error' }), makeErrorEntry({ status: 'skipped' })];

    const result = formatErrorLog(entries);
    expect(result).toContain('Audio Pipeline - Error Log');
    expect(result).toContain('Total issues: 2');
    expect(result).toContain('Failed: 1');
    expect(result).toContain('Skipped: 1');
  });

  it('includes formatted entries', () => {
    const entries = [
      makeErrorEntry({
        status: 'error',
        fileName: 'bad.mp3',
        message: 'Read failure',
        timestamp: '2025-02-18T12:00:00.000Z',
      }),
    ];

    const result = formatErrorLog(entries);
    expect(result).toContain('[2025-02-18T12:00:00.000Z] ERROR bad.mp3: Read failure');
  });

  it('ends with newline', () => {
    const entries = [makeErrorEntry()];
    const result = formatErrorLog(entries);
    expect(result.endsWith('\n')).toBe(true);
  });
});

// ─── ProgressTracker Class Tests ────────────────────────────────────────────

describe('ProgressTracker', () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker();
  });

  // ─── Initial State ──────────────────────────────────────────────────

  describe('initial state', () => {
    it('has no errors initially', () => {
      expect(tracker.hasErrors).toBe(false);
    });

    it('has zero error count', () => {
      expect(tracker.errorCount).toBe(0);
    });

    it('returns empty entries', () => {
      expect(tracker.getErrorEntries().length).toBe(0);
    });

    it('returns empty filtered entries', () => {
      expect(tracker.getFilteredEntries().length).toBe(0);
    });

    it('has modal closed', () => {
      expect(tracker.getModalState().isOpen).toBe(false);
    });

    it('has "all" filter by default', () => {
      expect(tracker.getModalState().filter).toBe('all');
    });

    it('returns empty summary', () => {
      const summary = tracker.getSummary();
      expect(summary.totalErrors).toBe(0);
      expect(summary.failedCount).toBe(0);
      expect(summary.skippedCount).toBe(0);
    });
  });

  // ─── recordResults ──────────────────────────────────────────────────

  describe('recordResults', () => {
    it('records error results', () => {
      const results = [makeResult({ status: 'error', error: 'fail', originalPath: '/a.mp3' })];

      const added = tracker.recordResults(results);
      expect(added).toBe(1);
      expect(tracker.errorCount).toBe(1);
    });

    it('records skipped results', () => {
      const results = [makeResult({ status: 'skipped', originalPath: '/b.mp3' })];

      const added = tracker.recordResults(results);
      expect(added).toBe(1);
      expect(tracker.errorCount).toBe(1);
    });

    it('ignores completed results', () => {
      const results = [
        makeResult({ status: 'completed', originalPath: '/a.mp3' }),
        makeResult({ status: 'error', error: 'fail', originalPath: '/b.mp3' }),
        makeResult({ status: 'completed', originalPath: '/c.mp3' }),
      ];

      const added = tracker.recordResults(results);
      expect(added).toBe(1);
      expect(tracker.errorCount).toBe(1);
    });

    it('records multiple errors from batch', () => {
      const results = [
        makeResult({ status: 'error', error: 'fail1', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
        makeResult({ status: 'error', error: 'fail2', originalPath: '/c.mp3' }),
      ];

      const added = tracker.recordResults(results);
      expect(added).toBe(3);
      expect(tracker.errorCount).toBe(3);
    });

    it('returns 0 for empty results', () => {
      expect(tracker.recordResults([])).toBe(0);
    });

    it('returns 0 for all-success results', () => {
      const results = [makeResult({ status: 'completed' }), makeResult({ status: 'completed' })];
      expect(tracker.recordResults(results)).toBe(0);
    });

    it('accumulates across multiple calls', () => {
      tracker.recordResults([makeResult({ status: 'error', error: 'e1', originalPath: '/a.mp3' })]);
      tracker.recordResults([makeResult({ status: 'error', error: 'e2', originalPath: '/b.mp3' })]);
      expect(tracker.errorCount).toBe(2);
    });

    it('notifies entries listeners', () => {
      const listener = vi.fn();
      tracker.onEntriesChange(listener);

      tracker.recordResults([makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' })]);
      expect(listener).toHaveBeenCalledOnce();
    });

    it('does not notify when no errors added', () => {
      const listener = vi.fn();
      tracker.onEntriesChange(listener);

      tracker.recordResults([makeResult({ status: 'completed' })]);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ─── recordSingleResult ────────────────────────────────────────────

  describe('recordSingleResult', () => {
    it('records an error result', () => {
      const result = tracker.recordSingleResult(
        makeResult({ status: 'error', error: 'fail', originalPath: '/a.mp3' }),
      );
      expect(result).toBe(true);
      expect(tracker.errorCount).toBe(1);
    });

    it('records a skipped result', () => {
      const result = tracker.recordSingleResult(
        makeResult({ status: 'skipped', originalPath: '/a.mp3' }),
      );
      expect(result).toBe(true);
      expect(tracker.errorCount).toBe(1);
    });

    it('returns false for completed result', () => {
      const result = tracker.recordSingleResult(makeResult({ status: 'completed' }));
      expect(result).toBe(false);
      expect(tracker.errorCount).toBe(0);
    });

    it('notifies listeners on error', () => {
      const listener = vi.fn();
      tracker.onEntriesChange(listener);

      tracker.recordSingleResult(
        makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' }),
      );
      expect(listener).toHaveBeenCalledOnce();
    });

    it('does not notify for non-error', () => {
      const listener = vi.fn();
      tracker.onEntriesChange(listener);

      tracker.recordSingleResult(makeResult({ status: 'completed' }));
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ─── getErrorEntries ───────────────────────────────────────────────

  describe('getErrorEntries', () => {
    it('returns all entries regardless of filter', () => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
      ]);

      tracker.setFilter('errors');
      expect(tracker.getErrorEntries().length).toBe(2);
    });

    it('preserves insertion order', () => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'e1', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
        makeResult({ status: 'error', error: 'e2', originalPath: '/c.mp3' }),
      ]);

      const entries = tracker.getErrorEntries();
      expect(entries[0].filePath).toBe('/a.mp3');
      expect(entries[1].filePath).toBe('/b.mp3');
      expect(entries[2].filePath).toBe('/c.mp3');
    });
  });

  // ─── getFilteredEntries ────────────────────────────────────────────

  describe('getFilteredEntries', () => {
    beforeEach(() => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'e1', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
        makeResult({ status: 'error', error: 'e2', originalPath: '/c.mp3' }),
      ]);
    });

    it('returns all entries with "all" filter', () => {
      tracker.setFilter('all');
      expect(tracker.getFilteredEntries().length).toBe(3);
    });

    it('returns only errors with "errors" filter', () => {
      tracker.setFilter('errors');
      const entries = tracker.getFilteredEntries();
      expect(entries.length).toBe(2);
      expect(entries.every((e) => e.status === 'error')).toBe(true);
    });

    it('returns only skipped with "skipped" filter', () => {
      tracker.setFilter('skipped');
      const entries = tracker.getFilteredEntries();
      expect(entries.length).toBe(1);
      expect(entries[0].status).toBe('skipped');
    });
  });

  // ─── getSummary ────────────────────────────────────────────────────

  describe('getSummary', () => {
    it('returns correct summary after recording', () => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'e1', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
        makeResult({ status: 'error', error: 'e2', originalPath: '/c.mp3' }),
      ]);

      const summary = tracker.getSummary();
      expect(summary.totalErrors).toBe(3);
      expect(summary.failedCount).toBe(2);
      expect(summary.skippedCount).toBe(1);
    });
  });

  // ─── hasErrors / errorCount ────────────────────────────────────────

  describe('hasErrors', () => {
    it('returns true when errors exist', () => {
      tracker.recordResults([makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' })]);
      expect(tracker.hasErrors).toBe(true);
    });

    it('returns false after clear', () => {
      tracker.recordResults([makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' })]);
      tracker.clear();
      expect(tracker.hasErrors).toBe(false);
    });
  });

  // ─── clear ─────────────────────────────────────────────────────────

  describe('clear', () => {
    it('clears all entries', () => {
      tracker.recordResults([makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' })]);

      tracker.clear();
      expect(tracker.errorCount).toBe(0);
      expect(tracker.getErrorEntries().length).toBe(0);
    });

    it('resets modal state', () => {
      tracker.openModal();
      tracker.setFilter('errors');
      tracker.clear();

      expect(tracker.getModalState().isOpen).toBe(false);
      expect(tracker.getModalState().filter).toBe('all');
    });

    it('notifies entries listeners', () => {
      const listener = vi.fn();
      tracker.onEntriesChange(listener);
      tracker.clear();
      expect(listener).toHaveBeenCalled();
    });

    it('notifies modal listeners', () => {
      const listener = vi.fn();
      tracker.onModalStateChange(listener);
      tracker.clear();
      expect(listener).toHaveBeenCalled();
    });
  });

  // ─── Modal State Management ────────────────────────────────────────

  describe('modal state', () => {
    it('opens modal', () => {
      tracker.openModal();
      expect(tracker.getModalState().isOpen).toBe(true);
    });

    it('closes modal', () => {
      tracker.openModal();
      tracker.closeModal();
      expect(tracker.getModalState().isOpen).toBe(false);
    });

    it('toggles modal from closed to open', () => {
      tracker.toggleModal();
      expect(tracker.getModalState().isOpen).toBe(true);
    });

    it('toggles modal from open to closed', () => {
      tracker.openModal();
      tracker.toggleModal();
      expect(tracker.getModalState().isOpen).toBe(false);
    });

    it('does not notify when already open', () => {
      tracker.openModal();
      const listener = vi.fn();
      tracker.onModalStateChange(listener);
      tracker.openModal();
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not notify when already closed', () => {
      const listener = vi.fn();
      tracker.onModalStateChange(listener);
      tracker.closeModal();
      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies on open', () => {
      const listener = vi.fn();
      tracker.onModalStateChange(listener);
      tracker.openModal();
      expect(listener).toHaveBeenCalledWith({ isOpen: true, filter: 'all' });
    });

    it('notifies on close', () => {
      tracker.openModal();
      const listener = vi.fn();
      tracker.onModalStateChange(listener);
      tracker.closeModal();
      expect(listener).toHaveBeenCalledWith({ isOpen: false, filter: 'all' });
    });

    it('returns a copy of modal state', () => {
      const state1 = tracker.getModalState();
      const state2 = tracker.getModalState();
      expect(state1).toEqual(state2);
      expect(state1).not.toBe(state2); // Different object references
    });
  });

  // ─── Filter Management ─────────────────────────────────────────────

  describe('setFilter', () => {
    it('changes filter to "errors"', () => {
      tracker.setFilter('errors');
      expect(tracker.getModalState().filter).toBe('errors');
    });

    it('changes filter to "skipped"', () => {
      tracker.setFilter('skipped');
      expect(tracker.getModalState().filter).toBe('skipped');
    });

    it('changes filter back to "all"', () => {
      tracker.setFilter('errors');
      tracker.setFilter('all');
      expect(tracker.getModalState().filter).toBe('all');
    });

    it('notifies modal listener on change', () => {
      const listener = vi.fn();
      tracker.onModalStateChange(listener);
      tracker.setFilter('errors');
      expect(listener).toHaveBeenCalled();
    });

    it('notifies entries listener on change', () => {
      const listener = vi.fn();
      tracker.onEntriesChange(listener);
      tracker.setFilter('errors');
      expect(listener).toHaveBeenCalled();
    });

    it('does not notify if same filter', () => {
      const modalListener = vi.fn();
      const entriesListener = vi.fn();
      tracker.onModalStateChange(modalListener);
      tracker.onEntriesChange(entriesListener);

      tracker.setFilter('all'); // Same as default
      expect(modalListener).not.toHaveBeenCalled();
      expect(entriesListener).not.toHaveBeenCalled();
    });
  });

  // ─── Export ─────────────────────────────────────────────────────────

  describe('getExportText', () => {
    it('returns "No errors" when empty', () => {
      expect(tracker.getExportText()).toBe('No errors recorded.\n');
    });

    it('includes entries in export', () => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'fail', originalPath: '/a.mp3' }),
      ]);

      const text = tracker.getExportText();
      expect(text).toContain('Audio Pipeline - Error Log');
      expect(text).toContain('a.mp3: fail');
    });

    it('includes all entries regardless of filter', () => {
      tracker.recordResults([
        makeResult({ status: 'error', error: 'e1', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
      ]);

      tracker.setFilter('errors'); // Filter should not affect export

      const text = tracker.getExportText();
      expect(text).toContain('Total issues: 2');
    });
  });

  // ─── Event Listeners ───────────────────────────────────────────────

  describe('event listeners', () => {
    it('unsubscribes modal listener', () => {
      const listener = vi.fn();
      const unsub = tracker.onModalStateChange(listener);

      unsub();
      tracker.openModal();
      expect(listener).not.toHaveBeenCalled();
    });

    it('unsubscribes entries listener', () => {
      const listener = vi.fn();
      const unsub = tracker.onEntriesChange(listener);

      unsub();
      tracker.recordResults([makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' })]);
      expect(listener).not.toHaveBeenCalled();
    });

    it('supports multiple modal listeners', () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      tracker.onModalStateChange(l1);
      tracker.onModalStateChange(l2);

      tracker.openModal();
      expect(l1).toHaveBeenCalledOnce();
      expect(l2).toHaveBeenCalledOnce();
    });

    it('supports multiple entries listeners', () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      tracker.onEntriesChange(l1);
      tracker.onEntriesChange(l2);

      tracker.recordResults([makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' })]);
      expect(l1).toHaveBeenCalledOnce();
      expect(l2).toHaveBeenCalledOnce();
    });

    it('entries listener receives filtered entries and summary', () => {
      tracker.setFilter('errors');

      const listener = vi.fn();
      tracker.onEntriesChange(listener);

      tracker.recordResults([
        makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
      ]);

      const [entries, summary] = listener.mock.calls[0] as [
        ReadonlyArray<ErrorEntry>,
        ErrorSummary,
      ];
      expect(entries.length).toBe(1); // Filtered to errors only
      expect(entries[0].status).toBe('error');
      expect(summary.totalErrors).toBe(2); // Summary counts all
      expect(summary.failedCount).toBe(1);
      expect(summary.skippedCount).toBe(1);
    });

    it('selective unsubscribe only removes target listener', () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      const unsub1 = tracker.onModalStateChange(l1);
      tracker.onModalStateChange(l2);

      unsub1();
      tracker.openModal();
      expect(l1).not.toHaveBeenCalled();
      expect(l2).toHaveBeenCalledOnce();
    });
  });

  // ─── Integration Tests ─────────────────────────────────────────────

  describe('integration', () => {
    it('full lifecycle: record, filter, view, export, clear', () => {
      // Record some results
      tracker.recordResults([
        makeResult({ status: 'completed', originalPath: '/a.mp3' }),
        makeResult({ status: 'error', error: 'File corrupt', originalPath: '/b.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/c.mp3' }),
        makeResult({ status: 'error', error: 'Permission denied', originalPath: '/d.mp3' }),
        makeResult({ status: 'completed', originalPath: '/e.mp3' }),
      ]);

      expect(tracker.errorCount).toBe(3);
      expect(tracker.hasErrors).toBe(true);

      // Check summary
      const summary = tracker.getSummary();
      expect(summary.totalErrors).toBe(3);
      expect(summary.failedCount).toBe(2);
      expect(summary.skippedCount).toBe(1);

      // Filter to errors only
      tracker.setFilter('errors');
      const errorEntries = tracker.getFilteredEntries();
      expect(errorEntries.length).toBe(2);
      expect(errorEntries[0].message).toBe('File corrupt');
      expect(errorEntries[1].message).toBe('Permission denied');

      // Filter to skipped only
      tracker.setFilter('skipped');
      const skippedEntries = tracker.getFilteredEntries();
      expect(skippedEntries.length).toBe(1);

      // Open modal
      tracker.openModal();
      expect(tracker.getModalState().isOpen).toBe(true);

      // Export includes all regardless of filter
      const exportText = tracker.getExportText();
      expect(exportText).toContain('Total issues: 3');
      expect(exportText).toContain('Failed: 2');
      expect(exportText).toContain('Skipped: 1');

      // Clear
      tracker.clear();
      expect(tracker.errorCount).toBe(0);
      expect(tracker.hasErrors).toBe(false);
      expect(tracker.getModalState().isOpen).toBe(false);
      expect(tracker.getModalState().filter).toBe('all');
    });

    it('incremental recording from onFileComplete', () => {
      // Simulate real-time file completion
      tracker.recordSingleResult(makeResult({ status: 'completed', originalPath: '/a.mp3' }));
      expect(tracker.errorCount).toBe(0);

      tracker.recordSingleResult(
        makeResult({ status: 'error', error: 'fail', originalPath: '/b.mp3' }),
      );
      expect(tracker.errorCount).toBe(1);

      tracker.recordSingleResult(makeResult({ status: 'skipped', originalPath: '/c.mp3' }));
      expect(tracker.errorCount).toBe(2);

      tracker.recordSingleResult(makeResult({ status: 'completed', originalPath: '/d.mp3' }));
      expect(tracker.errorCount).toBe(2);

      // Then batch recording from onProcessingComplete
      const batchResults = [
        makeResult({ status: 'completed', originalPath: '/a.mp3' }),
        makeResult({ status: 'error', error: 'fail', originalPath: '/b.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/c.mp3' }),
        makeResult({ status: 'completed', originalPath: '/d.mp3' }),
      ];

      tracker.recordResults(batchResults);
      // Both individual and batch recording accumulate
      expect(tracker.errorCount).toBe(4);
    });

    it('modal filter persists across entry updates', () => {
      tracker.setFilter('errors');
      tracker.openModal();

      tracker.recordResults([
        makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' }),
        makeResult({ status: 'skipped', originalPath: '/b.mp3' }),
      ]);

      // Filter should still be 'errors'
      expect(tracker.getModalState().filter).toBe('errors');
      expect(tracker.getFilteredEntries().length).toBe(1);
    });

    it('listeners fire in correct order during lifecycle', () => {
      const events: string[] = [];

      tracker.onModalStateChange(() => events.push('modal'));
      tracker.onEntriesChange(() => events.push('entries'));

      // Clear fires both
      tracker.clear();
      expect(events).toEqual(['entries', 'modal']);

      events.length = 0;

      // Record fires entries only
      tracker.recordResults([makeResult({ status: 'error', error: 'e', originalPath: '/a.mp3' })]);
      expect(events).toEqual(['entries']);

      events.length = 0;

      // Open modal fires modal only
      tracker.openModal();
      expect(events).toEqual(['modal']);

      events.length = 0;

      // Set filter fires both
      tracker.setFilter('errors');
      expect(events).toEqual(['modal', 'entries']);
    });
  });
});
