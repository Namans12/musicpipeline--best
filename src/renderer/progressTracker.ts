/**
 * Progress Tracker
 *
 * Pure TypeScript class that manages progress tracking state and error display
 * for the Audio Pipeline GUI. This class is framework-agnostic and can be tested
 * without any DOM or Electron dependencies.
 *
 * Responsibilities:
 * - Tracking processing progress (bar percentage, counts, ETA)
 * - Managing error entries collected during processing
 * - Computing error summary statistics
 * - Managing error modal state (open/closed, filtered view)
 * - Formatting error entries for display
 * - Supporting error log export
 */

import type { ProcessingResult, ProcessingStatus } from '../shared/types';

// ─── Types ───────────────────────────────────────────────────────────────────

/** An error entry for display in the error modal */
export interface ErrorEntry {
  /** File path where the error occurred */
  filePath: string;
  /** Filename (without directory) */
  fileName: string;
  /** Error message */
  message: string;
  /** Processing status that caused the error (error or skipped) */
  status: ProcessingStatus;
  /** Timestamp when the error was recorded */
  timestamp: string;
}

/** Error summary statistics */
export interface ErrorSummary {
  /** Total number of error entries */
  totalErrors: number;
  /** Number of 'error' status entries */
  failedCount: number;
  /** Number of 'skipped' status entries */
  skippedCount: number;
}

/** State of the error modal */
export interface ErrorModalState {
  /** Whether the error modal is currently open */
  isOpen: boolean;
  /** Current filter for error display: 'all', 'errors', or 'skipped' */
  filter: ErrorFilter;
}

/** Filter options for the error modal */
export type ErrorFilter = 'all' | 'errors' | 'skipped';

/** Callback for error modal state changes */
export type ErrorModalListener = (state: ErrorModalState) => void;

/** Callback for error entries changes */
export type ErrorEntriesListener = (
  entries: ReadonlyArray<ErrorEntry>,
  summary: ErrorSummary,
) => void;

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Extracts the filename from a file path (cross-platform).
 * @param filePath - Absolute file path
 * @returns The filename with extension
 */
export function extractFileName(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
}

/**
 * Creates an ErrorEntry from a ProcessingResult.
 * Only creates entries for 'error' or 'skipped' statuses.
 *
 * @param result - The processing result
 * @returns An ErrorEntry, or null if the result is not an error/skipped status
 */
export function createErrorEntry(result: ProcessingResult): ErrorEntry | null {
  if (result.status !== 'error' && result.status !== 'skipped') {
    return null;
  }

  return {
    filePath: result.originalPath,
    fileName: extractFileName(result.originalPath),
    message:
      result.error ??
      (result.status === 'skipped' ? 'File skipped (no match found)' : 'Unknown error'),
    status: result.status,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Computes an ErrorSummary from an array of ErrorEntries.
 *
 * @param entries - Array of error entries
 * @returns An ErrorSummary with counts
 */
export function computeErrorSummary(entries: ReadonlyArray<ErrorEntry>): ErrorSummary {
  let failedCount = 0;
  let skippedCount = 0;

  for (const entry of entries) {
    if (entry.status === 'error') {
      failedCount++;
    } else if (entry.status === 'skipped') {
      skippedCount++;
    }
  }

  return {
    totalErrors: entries.length,
    failedCount,
    skippedCount,
  };
}

/**
 * Filters error entries based on the given filter.
 *
 * @param entries - Array of error entries
 * @param filter - The filter to apply
 * @returns Filtered array of error entries
 */
export function filterErrorEntries(
  entries: ReadonlyArray<ErrorEntry>,
  filter: ErrorFilter,
): ReadonlyArray<ErrorEntry> {
  switch (filter) {
    case 'all':
      return entries;
    case 'errors':
      return entries.filter((e) => e.status === 'error');
    case 'skipped':
      return entries.filter((e) => e.status === 'skipped');
  }
}

/**
 * Formats an ErrorEntry as a single line of text for export.
 *
 * @param entry - The error entry to format
 * @returns Formatted string
 */
export function formatErrorEntry(entry: ErrorEntry): string {
  const statusLabel = entry.status === 'error' ? 'ERROR' : 'SKIPPED';
  return `[${entry.timestamp}] ${statusLabel} ${entry.fileName}: ${entry.message}`;
}

/**
 * Formats all error entries as a complete export text.
 *
 * @param entries - Array of error entries
 * @returns Complete formatted text ready for file export
 */
export function formatErrorLog(entries: ReadonlyArray<ErrorEntry>): string {
  if (entries.length === 0) {
    return 'No errors recorded.\n';
  }

  const summary = computeErrorSummary(entries);
  const header = [
    'Audio Pipeline - Error Log',
    '═'.repeat(40),
    `Total issues: ${summary.totalErrors}`,
    `Failed: ${summary.failedCount}`,
    `Skipped: ${summary.skippedCount}`,
    '═'.repeat(40),
    '',
  ];

  const lines = entries.map(formatErrorEntry);
  return header.join('\n') + lines.join('\n') + '\n';
}

// ─── ProgressTracker Class ──────────────────────────────────────────────────

/**
 * Manages progress tracking state and error display for the GUI.
 *
 * Tracks error/skipped entries from processing results, manages error modal
 * state, and provides filtered views of errors for display.
 */
export class ProgressTracker {
  private errorEntries: ErrorEntry[] = [];
  private modalState: ErrorModalState = { isOpen: false, filter: 'all' };

  // Listeners
  private modalListeners: ErrorModalListener[] = [];
  private entriesListeners: ErrorEntriesListener[] = [];

  // ─── Error Entry Management ──────────────────────────────────────────

  /**
   * Records errors/skipped results from a batch of processing results.
   * Only entries with 'error' or 'skipped' status are recorded.
   *
   * @param results - Array of processing results
   * @returns Number of new error entries added
   */
  recordResults(results: ProcessingResult[]): number {
    let added = 0;
    for (const result of results) {
      const entry = createErrorEntry(result);
      if (entry) {
        this.errorEntries.push(entry);
        added++;
      }
    }

    if (added > 0) {
      this.notifyEntriesListeners();
    }

    return added;
  }

  /**
   * Records a single processing result as an error entry.
   *
   * @param result - A single processing result
   * @returns true if an error entry was added
   */
  recordSingleResult(result: ProcessingResult): boolean {
    const entry = createErrorEntry(result);
    if (entry) {
      this.errorEntries.push(entry);
      this.notifyEntriesListeners();
      return true;
    }
    return false;
  }

  /**
   * Returns all error entries.
   */
  getErrorEntries(): ReadonlyArray<ErrorEntry> {
    return this.errorEntries;
  }

  /**
   * Returns filtered error entries based on the current modal filter.
   */
  getFilteredEntries(): ReadonlyArray<ErrorEntry> {
    return filterErrorEntries(this.errorEntries, this.modalState.filter);
  }

  /**
   * Returns the current error summary.
   */
  getSummary(): ErrorSummary {
    return computeErrorSummary(this.errorEntries);
  }

  /**
   * Returns whether there are any error entries.
   */
  get hasErrors(): boolean {
    return this.errorEntries.length > 0;
  }

  /**
   * Returns the total number of error entries.
   */
  get errorCount(): number {
    return this.errorEntries.length;
  }

  /**
   * Clears all error entries and resets modal state.
   */
  clear(): void {
    this.errorEntries = [];
    this.modalState = { isOpen: false, filter: 'all' };
    this.notifyEntriesListeners();
    this.notifyModalListeners();
  }

  // ─── Modal State Management ──────────────────────────────────────────

  /**
   * Returns the current modal state.
   */
  getModalState(): ErrorModalState {
    return { ...this.modalState };
  }

  /**
   * Opens the error modal.
   */
  openModal(): void {
    if (!this.modalState.isOpen) {
      this.modalState.isOpen = true;
      this.notifyModalListeners();
    }
  }

  /**
   * Closes the error modal.
   */
  closeModal(): void {
    if (this.modalState.isOpen) {
      this.modalState.isOpen = false;
      this.notifyModalListeners();
    }
  }

  /**
   * Toggles the error modal open/closed state.
   */
  toggleModal(): void {
    this.modalState.isOpen = !this.modalState.isOpen;
    this.notifyModalListeners();
  }

  /**
   * Sets the error filter for the modal display.
   *
   * @param filter - The filter to apply
   */
  setFilter(filter: ErrorFilter): void {
    if (this.modalState.filter !== filter) {
      this.modalState.filter = filter;
      this.notifyModalListeners();
      this.notifyEntriesListeners();
    }
  }

  // ─── Export ───────────────────────────────────────────────────────────

  /**
   * Generates the export text for all error entries.
   *
   * @returns Formatted error log text
   */
  getExportText(): string {
    return formatErrorLog(this.errorEntries);
  }

  // ─── Event Listeners ─────────────────────────────────────────────────

  /**
   * Registers a listener for error modal state changes.
   * @returns Unsubscribe function
   */
  onModalStateChange(listener: ErrorModalListener): () => void {
    this.modalListeners.push(listener);
    return () => {
      this.modalListeners = this.modalListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Registers a listener for error entries changes.
   * @returns Unsubscribe function
   */
  onEntriesChange(listener: ErrorEntriesListener): () => void {
    this.entriesListeners.push(listener);
    return () => {
      this.entriesListeners = this.entriesListeners.filter((l) => l !== listener);
    };
  }

  // ─── Private Methods ─────────────────────────────────────────────────

  private notifyModalListeners(): void {
    const state = this.getModalState();
    for (const listener of this.modalListeners) {
      listener(state);
    }
  }

  private notifyEntriesListeners(): void {
    const entries = this.getFilteredEntries();
    const summary = this.getSummary();
    for (const listener of this.entriesListeners) {
      listener(entries, summary);
    }
  }
}
