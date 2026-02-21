/**
 * File List Manager
 *
 * Pure TypeScript class that manages the list of audio files selected for processing.
 * This class is framework-agnostic and can be tested without any DOM or Electron dependencies.
 *
 * Responsibilities:
 * - Adding/removing files from the list
 * - Deduplication by file path
 * - Tracking file metadata (name, format, size, current metadata)
 * - Tracking processing status per file
 * - Providing file list for batch processing
 * - Clearing all files
 */

import * as path from 'path';
import type { ProcessingStatus } from '../shared/types';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Represents a single file entry in the file list */
export interface FileEntry {
  /** Absolute path to the file */
  filePath: string;
  /** Filename with extension (no directory) */
  fileName: string;
  /** File extension (with dot, lowercase) */
  extension: string;
  /** Audio format string (e.g. "MP3", "FLAC") */
  formatLabel: string;
  /** File size in bytes (0 if unknown) */
  fileSize: number;
  /** File size formatted for display (e.g. "4.2 MB") */
  fileSizeFormatted: string;
  /** Current metadata from the file (if loaded) */
  currentTitle: string | null;
  /** Current artist from metadata (if loaded) */
  currentArtist: string | null;
  /** Whether metadata has been loaded for this file */
  metadataLoaded: boolean;
  /** Processing status (pending, completed, error, etc.) */
  status: ProcessingStatus;
  /** Error message if status is 'error' */
  error: string | null;
  /** Pipeline step where the error occurred (e.g. 'fingerprinting', 'fetching_metadata') */
  failedStep: string | null;
  /** New file path after processing (if renamed) */
  newPath: string | null;
}

/** Listener callback for file list changes */
export type FileListChangeListener = (files: ReadonlyArray<FileEntry>) => void;

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Formats a file size in bytes to a human-readable string.
 * @param bytes - File size in bytes
 * @returns Formatted string (e.g. "4.2 MB")
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 0) return '0 B';
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Gets the format label from a file extension.
 * @param ext - File extension (with or without dot)
 * @returns Uppercase format label (e.g. "MP3", "FLAC")
 */
export function getFormatLabel(ext: string): string {
  const cleaned = ext.startsWith('.') ? ext.slice(1) : ext;
  return cleaned.toUpperCase();
}

/**
 * Extracts the file extension from a file path (lowercase, with dot).
 * @param filePath - Path to the file
 * @returns Lowercase extension with dot (e.g. ".mp3")
 */
export function getExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

// ─── FileListManager Class ──────────────────────────────────────────────────

/**
 * Manages the list of audio files for processing.
 * Supports adding files, removing files, updating status,
 * and notifying listeners when the list changes.
 */
export class FileListManager {
  private files: Map<string, FileEntry> = new Map();
  private insertionOrder: string[] = [];
  private listeners: FileListChangeListener[] = [];

  /**
   * Returns the current number of files in the list.
   */
  get count(): number {
    return this.files.size;
  }

  /**
   * Returns true if the file list is empty.
   */
  get isEmpty(): boolean {
    return this.files.size === 0;
  }

  /**
   * Returns all file entries in insertion order.
   */
  getFiles(): ReadonlyArray<FileEntry> {
    return this.insertionOrder.filter((fp) => this.files.has(fp)).map((fp) => this.files.get(fp)!);
  }

  /**
   * Returns all file paths in insertion order.
   */
  getFilePaths(): string[] {
    return this.insertionOrder.filter((fp) => this.files.has(fp));
  }

  /**
   * Returns a single file entry by path, or undefined if not found.
   */
  getFile(filePath: string): FileEntry | undefined {
    return this.files.get(filePath);
  }

  /**
   * Checks if a file path is already in the list.
   */
  hasFile(filePath: string): boolean {
    return this.files.has(filePath);
  }

  /**
   * Adds file paths to the list. Duplicates are skipped.
   * Returns the number of new files actually added.
   *
   * @param filePaths - Array of absolute file paths to add
   * @param fileSize - Optional file size (defaults to 0)
   * @returns Number of new files added (excludes duplicates)
   */
  addFiles(filePaths: string[], fileSize: number = 0): number {
    let addedCount = 0;

    for (const filePath of filePaths) {
      if (this.files.has(filePath)) {
        continue; // Skip duplicates
      }

      const ext = getExtension(filePath);
      const entry: FileEntry = {
        filePath,
        fileName: path.basename(filePath),
        extension: ext,
        formatLabel: getFormatLabel(ext),
        fileSize,
        fileSizeFormatted: formatFileSize(fileSize),
        currentTitle: null,
        currentArtist: null,
        metadataLoaded: false,
        status: 'pending',
        error: null,
        failedStep: null,
        newPath: null,
      };

      this.files.set(filePath, entry);
      this.insertionOrder.push(filePath);
      addedCount++;
    }

    if (addedCount > 0) {
      this.notifyListeners();
    }

    return addedCount;
  }

  /**
   * Removes a file from the list by its path.
   * Returns true if the file was found and removed.
   */
  removeFile(filePath: string): boolean {
    if (!this.files.has(filePath)) {
      return false;
    }

    this.files.delete(filePath);
    this.insertionOrder = this.insertionOrder.filter((fp) => fp !== filePath);
    this.notifyListeners();
    return true;
  }

  /**
   * Clears all files from the list.
   */
  clear(): void {
    const hadFiles = this.files.size > 0;
    this.files.clear();
    this.insertionOrder = [];
    if (hadFiles) {
      this.notifyListeners();
    }
  }

  /**
   * Updates the metadata for a file entry.
   * Used after loading metadata from the audio reader.
   */
  updateMetadata(
    filePath: string,
    metadata: {
      title?: string | null;
      artist?: string | null;
      fileSize?: number;
    },
  ): void {
    const entry = this.files.get(filePath);
    if (!entry) return;

    if (metadata.title !== undefined) entry.currentTitle = metadata.title;
    if (metadata.artist !== undefined) entry.currentArtist = metadata.artist;
    if (metadata.fileSize !== undefined) {
      entry.fileSize = metadata.fileSize;
      entry.fileSizeFormatted = formatFileSize(metadata.fileSize);
    }
    entry.metadataLoaded = true;

    this.notifyListeners();
  }

  /**
   * Updates the processing status for a file.
   */
  updateStatus(
    filePath: string,
    status: ProcessingStatus,
    options?: { error?: string | null; failedStep?: string | null; newPath?: string | null },
  ): void {
    const entry = this.files.get(filePath);
    if (!entry) return;

    entry.status = status;
    if (options?.error !== undefined) entry.error = options.error;
    if (options?.failedStep !== undefined) entry.failedStep = options.failedStep;
    if (options?.newPath !== undefined) entry.newPath = options.newPath;

    this.notifyListeners();
  }

  /**
   * Resets all file statuses to 'pending' (for re-processing).
   */
  resetAllStatuses(): void {
    for (const entry of this.files.values()) {
      entry.status = 'pending';
      entry.error = null;
      entry.failedStep = null;
      entry.newPath = null;
    }
    this.notifyListeners();
  }

  /**
   * Returns summary counts of file statuses.
   */
  getStatusSummary(): {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    error: number;
    skipped: number;
  } {
    let pending = 0;
    let processing = 0;
    let completed = 0;
    let error = 0;
    let skipped = 0;

    for (const entry of this.files.values()) {
      switch (entry.status) {
        case 'pending':
          pending++;
          break;
        case 'completed':
          completed++;
          break;
        case 'error':
          error++;
          break;
        case 'skipped':
          skipped++;
          break;
        default:
          // Any in-progress status
          processing++;
          break;
      }
    }

    return {
      total: this.files.size,
      pending,
      processing,
      completed,
      error,
      skipped,
    };
  }

  /**
   * Registers a listener that will be called whenever the file list changes.
   * Returns a function to unsubscribe the listener.
   */
  onChange(listener: FileListChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Notifies all registered listeners of the current file list state.
   */
  private notifyListeners(): void {
    const files = this.getFiles();
    for (const listener of this.listeners) {
      listener(files);
    }
  }
}
