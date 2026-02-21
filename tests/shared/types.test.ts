import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_EXTENSIONS,
  DEFAULT_SETTINGS,
  IPC_CHANNELS,
  type AudioFileMetadata,
  type AudioFormat,
  type ProcessingStatus,
  type FingerprintResult,
  type MusicBrainzMetadata,
  type ProcessingResult,
  type ProgressUpdate,
} from '../../src/shared/types';

describe('Shared Types', () => {
  describe('SUPPORTED_EXTENSIONS', () => {
    it('should include all required audio formats', () => {
      expect(SUPPORTED_EXTENSIONS).toContain('.mp3');
      expect(SUPPORTED_EXTENSIONS).toContain('.flac');
      expect(SUPPORTED_EXTENSIONS).toContain('.m4a');
      expect(SUPPORTED_EXTENSIONS).toContain('.wav');
      expect(SUPPORTED_EXTENSIONS).toContain('.ogg');
      expect(SUPPORTED_EXTENSIONS).toContain('.wma');
    });

    it('should have exactly 6 supported formats', () => {
      expect(SUPPORTED_EXTENSIONS).toHaveLength(6);
    });

    it('should have extensions with dot prefix', () => {
      for (const ext of SUPPORTED_EXTENSIONS) {
        expect(ext).toMatch(/^\./);
      }
    });
  });

  describe('DEFAULT_SETTINGS', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_SETTINGS.outputFolder).toBeNull();
      expect(DEFAULT_SETTINGS.namingTemplate).toBe('{artist} - {title}');
      expect(DEFAULT_SETTINGS.concurrency).toBe(5);
      expect(DEFAULT_SETTINGS.fetchLyrics).toBe(true);
      expect(DEFAULT_SETTINGS.overwriteExistingTags).toBe(false);
      expect(DEFAULT_SETTINGS.usePersistentCache).toBe(true);
      expect(DEFAULT_SETTINGS.acoustIdApiKey).toBe('');
      expect(DEFAULT_SETTINGS.useSpotify).toBe(false);
      expect(DEFAULT_SETTINGS.spotifyClientId).toBe('');
      expect(DEFAULT_SETTINGS.spotifyClientSecret).toBe('');
      expect(DEFAULT_SETTINGS.useGenius).toBe(false);
      expect(DEFAULT_SETTINGS.geniusAccessToken).toBe('');
    });

    it('should have concurrency between 1 and 10', () => {
      expect(DEFAULT_SETTINGS.concurrency).toBeGreaterThanOrEqual(1);
      expect(DEFAULT_SETTINGS.concurrency).toBeLessThanOrEqual(10);
    });
  });

  describe('IPC_CHANNELS', () => {
    it('should define all required channel names', () => {
      expect(IPC_CHANNELS.SELECT_FILES).toBe('select-files');
      expect(IPC_CHANNELS.SELECT_FOLDER).toBe('select-folder');
      expect(IPC_CHANNELS.START_PROCESSING).toBe('start-processing');
      expect(IPC_CHANNELS.CANCEL_PROCESSING).toBe('cancel-processing');
      expect(IPC_CHANNELS.PROGRESS_UPDATE).toBe('progress-update');
      expect(IPC_CHANNELS.PROCESSING_COMPLETE).toBe('processing-complete');
      expect(IPC_CHANNELS.GET_SETTINGS).toBe('get-settings');
      expect(IPC_CHANNELS.SAVE_SETTINGS).toBe('save-settings');
    });

    it('should define FILE_COMPLETE channel', () => {
      expect(IPC_CHANNELS.FILE_COMPLETE).toBe('file-complete');
    });

    it('should define GET_FILE_METADATA channel', () => {
      expect(IPC_CHANNELS.GET_FILE_METADATA).toBe('get-file-metadata');
    });

    it('should define GET_ERRORS channel for error log retrieval', () => {
      expect(IPC_CHANNELS.GET_ERRORS).toBe('get-errors');
    });

    it('should define EXPORT_ERROR_LOG channel for log export', () => {
      expect(IPC_CHANNELS.EXPORT_ERROR_LOG).toBe('export-error-log');
    });

    it('should have unique channel names', () => {
      const channelValues = Object.values(IPC_CHANNELS);
      const uniqueValues = new Set(channelValues);
      expect(uniqueValues.size).toBe(channelValues.length);
    });

    it('should define SELECT_OUTPUT_FOLDER channel for output folder selection', () => {
      expect(IPC_CHANNELS.SELECT_OUTPUT_FOLDER).toBe('select-output-folder');
    });

    it('should have 15 total channels', () => {
      const channelValues = Object.values(IPC_CHANNELS);
      expect(channelValues.length).toBe(15);
    });
  });

  describe('Type Structure Validation', () => {
    it('should create valid AudioFileMetadata object', () => {
      const metadata: AudioFileMetadata = {
        filePath: '/path/to/song.mp3',
        format: 'mp3',
        fileSize: 5242880,
        duration: 210.5,
        title: 'Test Song',
        artist: 'Test Artist',
        album: 'Test Album',
        year: 2024,
        genre: ['Rock'],
        trackNumber: 1,
        discNumber: 1,
        albumArtist: 'Test Artist',
        lyrics: 'Test lyrics here',
      };

      expect(metadata.filePath).toBe('/path/to/song.mp3');
      expect(metadata.format).toBe('mp3');
      expect(metadata.title).toBe('Test Song');
      expect(metadata.artist).toBe('Test Artist');
    });

    it('should allow null values in AudioFileMetadata', () => {
      const metadata: AudioFileMetadata = {
        filePath: '/path/to/unknown.mp3',
        format: 'mp3',
        fileSize: 1024,
        duration: 0,
        title: null,
        artist: null,
        album: null,
        year: null,
        genre: null,
        trackNumber: null,
        discNumber: null,
        albumArtist: null,
        lyrics: null,
      };

      expect(metadata.title).toBeNull();
      expect(metadata.artist).toBeNull();
    });

    it('should create valid FingerprintResult object', () => {
      const result: FingerprintResult = {
        score: 0.95,
        acoustId: 'abc-123',
        recordingIds: ['mbid-1', 'mbid-2'],
      };

      expect(result.score).toBe(0.95);
      expect(result.recordingIds).toHaveLength(2);
    });

    it('should create valid MusicBrainzMetadata object', () => {
      const metadata: MusicBrainzMetadata = {
        recordingId: 'mbid-123',
        title: 'Song Title',
        artist: 'Main Artist',
        featuredArtists: ['Featured Artist'],
        album: 'Album Name',
        year: 2024,
        genres: ['Pop', 'Rock'],
      };

      expect(metadata.recordingId).toBe('mbid-123');
      expect(metadata.featuredArtists).toHaveLength(1);
      expect(metadata.genres).toContain('Pop');
    });

    it('should create valid ProcessingResult object', () => {
      const result: ProcessingResult = {
        originalPath: '/path/to/original.mp3',
        newPath: '/path/to/Artist - Song.mp3',
        status: 'completed',
        error: null,
        originalMetadata: null,
        correctedMetadata: null,
      };

      expect(result.status).toBe('completed');
      expect(result.error).toBeNull();
    });

    it('should create valid ProgressUpdate object', () => {
      const update: ProgressUpdate = {
        totalFiles: 100,
        processedFiles: 42,
        successCount: 40,
        errorCount: 2,
        skippedCount: 0,
        currentFile: 'current-song.mp3',
        estimatedTimeRemaining: 120,
      };

      expect(update.processedFiles).toBe(42);
      expect(update.totalFiles).toBe(100);
    });

    it('should validate AudioFormat type', () => {
      const validFormats: AudioFormat[] = ['mp3', 'flac', 'm4a', 'wav', 'ogg', 'wma'];
      expect(validFormats).toHaveLength(6);
    });

    it('should validate ProcessingStatus type', () => {
      const validStatuses: ProcessingStatus[] = [
        'pending',
        'fingerprinting',
        'identifying',
        'fetching_metadata',
        'fetching_lyrics',
        'writing_tags',
        'renaming',
        'completed',
        'error',
        'skipped',
      ];
      expect(validStatuses).toHaveLength(10);
    });
  });
});
