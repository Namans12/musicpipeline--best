/**
 * Tests for FileListManager
 *
 * Comprehensive tests for the file list management class.
 * Tests cover: adding files, removing files, deduplication, metadata updates,
 * status tracking, change listeners, status summary, and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FileListManager,
  formatFileSize,
  getFormatLabel,
  getExtension,
} from '../../src/renderer/fileListManager';

// ─── Helper Function Tests ──────────────────────────────────────────────────

describe('formatFileSize', () => {
  it('returns "0 B" for zero bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('returns "0 B" for negative bytes', () => {
    expect(formatFileSize(-100)).toBe('0 B');
  });

  it('formats bytes correctly', () => {
    expect(formatFileSize(500)).toBe('500 B');
  });

  it('formats kilobytes correctly', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats megabytes correctly', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(4.2 * 1024 * 1024)).toBe('4.2 MB');
  });

  it('formats gigabytes correctly', () => {
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
});

describe('getFormatLabel', () => {
  it('returns uppercase format for extension with dot', () => {
    expect(getFormatLabel('.mp3')).toBe('MP3');
    expect(getFormatLabel('.flac')).toBe('FLAC');
  });

  it('returns uppercase format for extension without dot', () => {
    expect(getFormatLabel('mp3')).toBe('MP3');
    expect(getFormatLabel('wav')).toBe('WAV');
  });

  it('handles mixed case', () => {
    expect(getFormatLabel('.Mp3')).toBe('MP3');
    expect(getFormatLabel('Flac')).toBe('FLAC');
  });
});

describe('getExtension', () => {
  it('returns lowercase extension with dot', () => {
    expect(getExtension('/path/to/file.mp3')).toBe('.mp3');
    expect(getExtension('C:\\Music\\song.FLAC')).toBe('.flac');
  });

  it('returns empty string for no extension', () => {
    expect(getExtension('/path/to/file')).toBe('');
  });

  it('handles multiple dots', () => {
    expect(getExtension('/path/to/my.song.mp3')).toBe('.mp3');
  });
});

// ─── FileListManager Tests ──────────────────────────────────────────────────

describe('FileListManager', () => {
  let manager: FileListManager;

  beforeEach(() => {
    manager = new FileListManager();
  });

  // ─── Constructor / Initial State ─────────────────────────────────────

  describe('initial state', () => {
    it('starts with zero files', () => {
      expect(manager.count).toBe(0);
    });

    it('starts empty', () => {
      expect(manager.isEmpty).toBe(true);
    });

    it('returns empty file list', () => {
      expect(manager.getFiles()).toEqual([]);
    });

    it('returns empty file paths', () => {
      expect(manager.getFilePaths()).toEqual([]);
    });
  });

  // ─── addFiles ────────────────────────────────────────────────────────

  describe('addFiles', () => {
    it('adds files to the list', () => {
      const added = manager.addFiles(['/path/to/song.mp3']);
      expect(added).toBe(1);
      expect(manager.count).toBe(1);
      expect(manager.isEmpty).toBe(false);
    });

    it('returns correct file entry structure', () => {
      manager.addFiles(['/path/to/song.mp3']);
      const files = manager.getFiles();
      expect(files).toHaveLength(1);

      const entry = files[0];
      expect(entry.filePath).toBe('/path/to/song.mp3');
      expect(entry.fileName).toBe('song.mp3');
      expect(entry.extension).toBe('.mp3');
      expect(entry.formatLabel).toBe('MP3');
      expect(entry.fileSize).toBe(0);
      expect(entry.fileSizeFormatted).toBe('0 B');
      expect(entry.currentTitle).toBeNull();
      expect(entry.currentArtist).toBeNull();
      expect(entry.metadataLoaded).toBe(false);
      expect(entry.status).toBe('pending');
      expect(entry.error).toBeNull();
      expect(entry.newPath).toBeNull();
    });

    it('adds multiple files', () => {
      const added = manager.addFiles(['/path/song1.mp3', '/path/song2.flac', '/path/song3.wav']);
      expect(added).toBe(3);
      expect(manager.count).toBe(3);
    });

    it('preserves insertion order', () => {
      manager.addFiles(['/path/b.mp3', '/path/a.mp3', '/path/c.mp3']);
      const paths = manager.getFilePaths();
      expect(paths).toEqual(['/path/b.mp3', '/path/a.mp3', '/path/c.mp3']);
    });

    it('deduplicates by file path', () => {
      manager.addFiles(['/path/song.mp3']);
      const added = manager.addFiles(['/path/song.mp3']);
      expect(added).toBe(0);
      expect(manager.count).toBe(1);
    });

    it('deduplicates within a single call', () => {
      const added = manager.addFiles(['/path/song.mp3', '/path/song.mp3', '/path/song.mp3']);
      expect(added).toBe(1);
      expect(manager.count).toBe(1);
    });

    it('accepts custom file size', () => {
      manager.addFiles(['/path/song.mp3'], 5242880);
      const files = manager.getFiles();
      expect(files[0].fileSize).toBe(5242880);
      expect(files[0].fileSizeFormatted).toBe('5.0 MB');
    });

    it('handles empty array', () => {
      const added = manager.addFiles([]);
      expect(added).toBe(0);
      expect(manager.count).toBe(0);
    });

    it('detects format from extension', () => {
      manager.addFiles(['/path/song.flac']);
      expect(manager.getFiles()[0].formatLabel).toBe('FLAC');
    });

    it('notifies listeners when files are added', () => {
      const listener = vi.fn();
      manager.onChange(listener);
      manager.addFiles(['/path/song.mp3']);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ filePath: '/path/song.mp3' })]),
      );
    });

    it('does not notify listeners when no new files added (all duplicates)', () => {
      manager.addFiles(['/path/song.mp3']);
      const listener = vi.fn();
      manager.onChange(listener);
      manager.addFiles(['/path/song.mp3']);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ─── getFile / hasFile ───────────────────────────────────────────────

  describe('getFile', () => {
    it('returns file entry for existing path', () => {
      manager.addFiles(['/path/song.mp3']);
      const entry = manager.getFile('/path/song.mp3');
      expect(entry).toBeDefined();
      expect(entry!.filePath).toBe('/path/song.mp3');
    });

    it('returns undefined for non-existent path', () => {
      expect(manager.getFile('/nonexistent.mp3')).toBeUndefined();
    });
  });

  describe('hasFile', () => {
    it('returns true for existing file', () => {
      manager.addFiles(['/path/song.mp3']);
      expect(manager.hasFile('/path/song.mp3')).toBe(true);
    });

    it('returns false for non-existent file', () => {
      expect(manager.hasFile('/nonexistent.mp3')).toBe(false);
    });
  });

  // ─── removeFile ──────────────────────────────────────────────────────

  describe('removeFile', () => {
    it('removes an existing file', () => {
      manager.addFiles(['/path/song.mp3']);
      const result = manager.removeFile('/path/song.mp3');
      expect(result).toBe(true);
      expect(manager.count).toBe(0);
      expect(manager.isEmpty).toBe(true);
    });

    it('returns false for non-existent file', () => {
      const result = manager.removeFile('/nonexistent.mp3');
      expect(result).toBe(false);
    });

    it('removes from insertion order', () => {
      manager.addFiles(['/path/a.mp3', '/path/b.mp3', '/path/c.mp3']);
      manager.removeFile('/path/b.mp3');
      expect(manager.getFilePaths()).toEqual(['/path/a.mp3', '/path/c.mp3']);
    });

    it('notifies listeners', () => {
      manager.addFiles(['/path/song.mp3']);
      const listener = vi.fn();
      manager.onChange(listener);
      manager.removeFile('/path/song.mp3');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ─── clear ───────────────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all files', () => {
      manager.addFiles(['/path/a.mp3', '/path/b.mp3']);
      manager.clear();
      expect(manager.count).toBe(0);
      expect(manager.isEmpty).toBe(true);
      expect(manager.getFiles()).toEqual([]);
    });

    it('notifies listeners when had files', () => {
      manager.addFiles(['/path/song.mp3']);
      const listener = vi.fn();
      manager.onChange(listener);
      manager.clear();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not notify when already empty', () => {
      const listener = vi.fn();
      manager.onChange(listener);
      manager.clear();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ─── updateMetadata ──────────────────────────────────────────────────

  describe('updateMetadata', () => {
    it('updates title and artist', () => {
      manager.addFiles(['/path/song.mp3']);
      manager.updateMetadata('/path/song.mp3', {
        title: 'Bohemian Rhapsody',
        artist: 'Queen',
      });

      const entry = manager.getFile('/path/song.mp3')!;
      expect(entry.currentTitle).toBe('Bohemian Rhapsody');
      expect(entry.currentArtist).toBe('Queen');
      expect(entry.metadataLoaded).toBe(true);
    });

    it('updates file size', () => {
      manager.addFiles(['/path/song.mp3']);
      manager.updateMetadata('/path/song.mp3', { fileSize: 1048576 });

      const entry = manager.getFile('/path/song.mp3')!;
      expect(entry.fileSize).toBe(1048576);
      expect(entry.fileSizeFormatted).toBe('1.0 MB');
    });

    it('ignores non-existent file', () => {
      // Should not throw
      manager.updateMetadata('/nonexistent.mp3', { title: 'Test' });
    });

    it('sets metadataLoaded to true', () => {
      manager.addFiles(['/path/song.mp3']);
      expect(manager.getFile('/path/song.mp3')!.metadataLoaded).toBe(false);
      manager.updateMetadata('/path/song.mp3', {});
      expect(manager.getFile('/path/song.mp3')!.metadataLoaded).toBe(true);
    });

    it('allows null values for title and artist', () => {
      manager.addFiles(['/path/song.mp3']);
      manager.updateMetadata('/path/song.mp3', {
        title: null,
        artist: null,
      });

      const entry = manager.getFile('/path/song.mp3')!;
      expect(entry.currentTitle).toBeNull();
      expect(entry.currentArtist).toBeNull();
    });

    it('notifies listeners', () => {
      manager.addFiles(['/path/song.mp3']);
      const listener = vi.fn();
      manager.onChange(listener);
      manager.updateMetadata('/path/song.mp3', { title: 'Test' });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ─── updateStatus ────────────────────────────────────────────────────

  describe('updateStatus', () => {
    it('updates the processing status', () => {
      manager.addFiles(['/path/song.mp3']);
      manager.updateStatus('/path/song.mp3', 'fingerprinting');
      expect(manager.getFile('/path/song.mp3')!.status).toBe('fingerprinting');
    });

    it('updates error message', () => {
      manager.addFiles(['/path/song.mp3']);
      manager.updateStatus('/path/song.mp3', 'error', { error: 'File corrupted' });
      const entry = manager.getFile('/path/song.mp3')!;
      expect(entry.status).toBe('error');
      expect(entry.error).toBe('File corrupted');
    });

    it('updates new path', () => {
      manager.addFiles(['/path/song.mp3']);
      manager.updateStatus('/path/song.mp3', 'completed', {
        newPath: '/path/Artist - Song.mp3',
      });
      expect(manager.getFile('/path/song.mp3')!.newPath).toBe('/path/Artist - Song.mp3');
    });

    it('ignores non-existent file', () => {
      manager.updateStatus('/nonexistent.mp3', 'completed');
      // Should not throw
    });

    it('notifies listeners', () => {
      manager.addFiles(['/path/song.mp3']);
      const listener = vi.fn();
      manager.onChange(listener);
      manager.updateStatus('/path/song.mp3', 'completed');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ─── resetAllStatuses ────────────────────────────────────────────────

  describe('resetAllStatuses', () => {
    it('resets all statuses to pending', () => {
      manager.addFiles(['/path/a.mp3', '/path/b.mp3']);
      manager.updateStatus('/path/a.mp3', 'completed');
      manager.updateStatus('/path/b.mp3', 'error', { error: 'Failed' });

      manager.resetAllStatuses();

      expect(manager.getFile('/path/a.mp3')!.status).toBe('pending');
      expect(manager.getFile('/path/b.mp3')!.status).toBe('pending');
    });

    it('clears error messages', () => {
      manager.addFiles(['/path/song.mp3']);
      manager.updateStatus('/path/song.mp3', 'error', { error: 'Failed' });
      manager.resetAllStatuses();
      expect(manager.getFile('/path/song.mp3')!.error).toBeNull();
    });

    it('clears new paths', () => {
      manager.addFiles(['/path/song.mp3']);
      manager.updateStatus('/path/song.mp3', 'completed', { newPath: '/new/path.mp3' });
      manager.resetAllStatuses();
      expect(manager.getFile('/path/song.mp3')!.newPath).toBeNull();
    });

    it('notifies listeners', () => {
      manager.addFiles(['/path/song.mp3']);
      const listener = vi.fn();
      manager.onChange(listener);
      manager.resetAllStatuses();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ─── getStatusSummary ────────────────────────────────────────────────

  describe('getStatusSummary', () => {
    it('returns all zeros for empty list', () => {
      const summary = manager.getStatusSummary();
      expect(summary).toEqual({
        total: 0,
        pending: 0,
        processing: 0,
        completed: 0,
        error: 0,
        skipped: 0,
      });
    });

    it('counts all as pending initially', () => {
      manager.addFiles(['/path/a.mp3', '/path/b.mp3', '/path/c.mp3']);
      const summary = manager.getStatusSummary();
      expect(summary.total).toBe(3);
      expect(summary.pending).toBe(3);
    });

    it('counts mixed statuses correctly', () => {
      manager.addFiles(['/a.mp3', '/b.mp3', '/c.mp3', '/d.mp3', '/e.mp3']);
      manager.updateStatus('/a.mp3', 'completed');
      manager.updateStatus('/b.mp3', 'error');
      manager.updateStatus('/c.mp3', 'skipped');
      manager.updateStatus('/d.mp3', 'fingerprinting');
      // '/e.mp3' stays as 'pending'

      const summary = manager.getStatusSummary();
      expect(summary.total).toBe(5);
      expect(summary.completed).toBe(1);
      expect(summary.error).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(summary.processing).toBe(1);
      expect(summary.pending).toBe(1);
    });

    it('counts in-progress statuses as processing', () => {
      manager.addFiles(['/a.mp3', '/b.mp3', '/c.mp3']);
      manager.updateStatus('/a.mp3', 'fingerprinting');
      manager.updateStatus('/b.mp3', 'fetching_metadata');
      manager.updateStatus('/c.mp3', 'writing_tags');

      const summary = manager.getStatusSummary();
      expect(summary.processing).toBe(3);
    });
  });

  // ─── onChange ─────────────────────────────────────────────────────────

  describe('onChange', () => {
    it('registers a listener', () => {
      const listener = vi.fn();
      manager.onChange(listener);
      manager.addFiles(['/path/song.mp3']);
      expect(listener).toHaveBeenCalled();
    });

    it('supports multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      manager.onChange(listener1);
      manager.onChange(listener2);
      manager.addFiles(['/path/song.mp3']);
      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('returns unsubscribe function', () => {
      const listener = vi.fn();
      const unsub = manager.onChange(listener);
      unsub();
      manager.addFiles(['/path/song.mp3']);
      expect(listener).not.toHaveBeenCalled();
    });

    it('only unsubscribes the specific listener', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = manager.onChange(listener1);
      manager.onChange(listener2);
      unsub1();
      manager.addFiles(['/path/song.mp3']);
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('passes current file list to listener', () => {
      manager.addFiles(['/path/a.mp3']);
      const listener = vi.fn();
      manager.onChange(listener);
      manager.addFiles(['/path/b.mp3']);
      expect(listener).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ filePath: '/path/a.mp3' }),
          expect.objectContaining({ filePath: '/path/b.mp3' }),
        ]),
      );
    });
  });
});
