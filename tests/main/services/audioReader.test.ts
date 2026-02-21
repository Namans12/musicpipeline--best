import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { describe, it, expect } from 'vitest';
import {
  getAudioFormat,
  readAudioFile,
  readMultipleAudioFiles,
} from '../../../src/main/services/audioReader';
import type { AudioFileMetadata } from '../../../src/shared/types';

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'fixtures');

/**
 * Helper to get the path to a test fixture file.
 */
function fixture(filename: string): string {
  return path.join(FIXTURES_DIR, filename);
}

describe('audioReader', () => {
  // ─── getAudioFormat ──────────────────────────────────────────────────

  describe('getAudioFormat', () => {
    it('should return "mp3" for .mp3 files', () => {
      expect(getAudioFormat('song.mp3')).toBe('mp3');
    });

    it('should return "flac" for .flac files', () => {
      expect(getAudioFormat('song.flac')).toBe('flac');
    });

    it('should return "m4a" for .m4a files', () => {
      expect(getAudioFormat('song.m4a')).toBe('m4a');
    });

    it('should return "wav" for .wav files', () => {
      expect(getAudioFormat('song.wav')).toBe('wav');
    });

    it('should return "ogg" for .ogg files', () => {
      expect(getAudioFormat('song.ogg')).toBe('ogg');
    });

    it('should return "wma" for .wma files', () => {
      expect(getAudioFormat('song.wma')).toBe('wma');
    });

    it('should handle uppercase extensions', () => {
      expect(getAudioFormat('song.MP3')).toBe('mp3');
      expect(getAudioFormat('song.FLAC')).toBe('flac');
      expect(getAudioFormat('song.WAV')).toBe('wav');
    });

    it('should handle mixed case extensions', () => {
      expect(getAudioFormat('song.Mp3')).toBe('mp3');
      expect(getAudioFormat('song.FlaC')).toBe('flac');
    });

    it('should return null for unsupported formats', () => {
      expect(getAudioFormat('document.pdf')).toBeNull();
      expect(getAudioFormat('video.mp4')).toBeNull();
      expect(getAudioFormat('image.png')).toBeNull();
      expect(getAudioFormat('script.js')).toBeNull();
    });

    it('should return null for files without extension', () => {
      expect(getAudioFormat('noextension')).toBeNull();
    });

    it('should handle full file paths', () => {
      expect(getAudioFormat('/music/artist/song.mp3')).toBe('mp3');
      expect(getAudioFormat('C:\\Music\\song.flac')).toBe('flac');
    });

    it('should handle filenames with dots in path', () => {
      expect(getAudioFormat('/path/to/v2.0/song.mp3')).toBe('mp3');
    });
  });

  // ─── readAudioFile ───────────────────────────────────────────────────

  describe('readAudioFile', () => {
    describe('with valid MP3 files', () => {
      it('should read an untagged MP3 file and return metadata with null fields', async () => {
        const metadata = await readAudioFile(fixture('silence.mp3'));

        expect(metadata.filePath).toBe(fixture('silence.mp3'));
        expect(metadata.format).toBe('mp3');
        expect(metadata.fileSize).toBeGreaterThan(0);
        expect(metadata.duration).toBeGreaterThan(0);
        expect(metadata.title).toBeNull();
        expect(metadata.artist).toBeNull();
        expect(metadata.album).toBeNull();
        expect(metadata.year).toBeNull();
        expect(metadata.genre).toBeNull();
        expect(metadata.trackNumber).toBeNull();
        expect(metadata.discNumber).toBeNull();
        expect(metadata.albumArtist).toBeNull();
        expect(metadata.lyrics).toBeNull();
      });

      it('should read a fully tagged MP3 file', async () => {
        const metadata = await readAudioFile(fixture('tagged.mp3'));

        expect(metadata.filePath).toBe(fixture('tagged.mp3'));
        expect(metadata.format).toBe('mp3');
        expect(metadata.fileSize).toBeGreaterThan(0);
        expect(metadata.duration).toBeGreaterThan(0);
        expect(metadata.title).toBe('Test Song');
        expect(metadata.artist).toBe('Test Artist');
        expect(metadata.album).toBe('Test Album');
        expect(metadata.year).toBe(2024);
        expect(metadata.genre).toEqual(['Rock']);
        expect(metadata.trackNumber).toBe(1);
        expect(metadata.discNumber).toBe(1);
        expect(metadata.albumArtist).toBe('Test Artist');
      });

      it('should extract lyrics from USLT tags', async () => {
        const metadata = await readAudioFile(fixture('tagged.mp3'));

        expect(metadata.lyrics).not.toBeNull();
        expect(metadata.lyrics).toContain('These are test lyrics');
        expect(metadata.lyrics).toContain('Line two of lyrics');
      });

      it('should handle partial tags (missing fields return null)', async () => {
        const metadata = await readAudioFile(fixture('partial-tags.mp3'));

        expect(metadata.title).toBe('Only Title');
        expect(metadata.artist).toBeNull();
        expect(metadata.album).toBeNull();
        expect(metadata.year).toBeNull();
        expect(metadata.genre).toBeNull();
        expect(metadata.trackNumber).toBeNull();
        expect(metadata.lyrics).toBeNull();
      });

      it('should handle multiple genres', async () => {
        const metadata = await readAudioFile(fixture('multi-genre.mp3'));

        expect(metadata.genre).toBeDefined();
        expect(metadata.genre).not.toBeNull();
        expect(metadata.genre!.length).toBeGreaterThanOrEqual(1);
      });

      it('should handle unicode metadata', async () => {
        const metadata = await readAudioFile(fixture('unicode-tags.mp3'));

        expect(metadata.title).toBe('Über Straße');
        expect(metadata.artist).toBe('Ménage à Trois');
        expect(metadata.album).toBe('日本語テスト');
      });
    });

    describe('with WAV files', () => {
      it('should read WAV file and return correct format', async () => {
        const metadata = await readAudioFile(fixture('silence.wav'));

        expect(metadata.filePath).toBe(fixture('silence.wav'));
        expect(metadata.format).toBe('wav');
        expect(metadata.fileSize).toBeGreaterThan(0);
        expect(metadata.duration).toBeCloseTo(1, 0);
        // WAV files typically don't have tags unless we add them
        expect(metadata.title).toBeNull();
        expect(metadata.artist).toBeNull();
      });
    });

    describe('with FLAC files', () => {
      it('should read FLAC file and return correct format', async () => {
        const metadata = await readAudioFile(fixture('silence.flac'));

        expect(metadata.filePath).toBe(fixture('silence.flac'));
        expect(metadata.format).toBe('flac');
        expect(metadata.fileSize).toBeGreaterThan(0);
        expect(metadata.duration).toBeCloseTo(1, 0);
        expect(metadata.title).toBeNull();
        expect(metadata.artist).toBeNull();
      });
    });

    describe('return structure', () => {
      it('should return an object conforming to AudioFileMetadata interface', async () => {
        const metadata = await readAudioFile(fixture('tagged.mp3'));

        // Verify all required properties exist
        const requiredKeys: Array<keyof AudioFileMetadata> = [
          'filePath',
          'format',
          'fileSize',
          'duration',
          'title',
          'artist',
          'album',
          'year',
          'genre',
          'trackNumber',
          'discNumber',
          'albumArtist',
          'lyrics',
        ];

        for (const key of requiredKeys) {
          expect(metadata).toHaveProperty(key);
        }
      });

      it('should include the absolute file path', async () => {
        const metadata = await readAudioFile(fixture('silence.mp3'));
        expect(path.isAbsolute(metadata.filePath)).toBe(true);
      });

      it('should report file size accurately', async () => {
        const filePath = fixture('silence.mp3');
        const stats = fs.statSync(filePath);
        const metadata = await readAudioFile(filePath);

        expect(metadata.fileSize).toBe(stats.size);
      });
    });

    describe('error handling', () => {
      it('should throw an error for non-existent files', async () => {
        await expect(readAudioFile('/nonexistent/path/song.mp3')).rejects.toThrow('File not found');
      });

      it('should throw an error for unsupported formats', async () => {
        // Create a temp file with unsupported extension
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-test-'));
        const tempFile = path.join(tempDir, 'file.txt');
        fs.writeFileSync(tempFile, 'hello');

        try {
          await expect(readAudioFile(tempFile)).rejects.toThrow('Unsupported audio format');
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it('should throw a descriptive error for corrupt audio files', async () => {
        await expect(readAudioFile(fixture('corrupt.mp3'))).rejects.toThrow(
          'Failed to parse audio file',
        );
      });

      it('should throw a descriptive error for non-audio data with audio extension', async () => {
        await expect(readAudioFile(fixture('notaudio.mp3'))).rejects.toThrow(
          'Failed to parse audio file',
        );
      });
    });

    describe('performance', () => {
      it('should process file metadata in under 100ms', async () => {
        const start = performance.now();
        await readAudioFile(fixture('tagged.mp3'));
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
      });
    });
  });

  // ─── readMultipleAudioFiles ──────────────────────────────────────────

  describe('readMultipleAudioFiles', () => {
    it('should process multiple files and return results for each', async () => {
      const filePaths = [fixture('silence.mp3'), fixture('tagged.mp3'), fixture('silence.wav')];

      const results = await readMultipleAudioFiles(filePaths);

      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.metadata).not.toBeNull();
        expect(result.error).toBeNull();
      });
    });

    it('should include metadata for successfully parsed files', async () => {
      const results = await readMultipleAudioFiles([fixture('tagged.mp3')]);

      expect(results[0].metadata).not.toBeNull();
      expect(results[0].metadata!.title).toBe('Test Song');
      expect(results[0].error).toBeNull();
    });

    it('should include errors for failed files without stopping', async () => {
      const filePaths = [fixture('tagged.mp3'), fixture('corrupt.mp3'), fixture('silence.wav')];

      const results = await readMultipleAudioFiles(filePaths);

      expect(results).toHaveLength(3);

      // First file should succeed
      expect(results[0].metadata).not.toBeNull();
      expect(results[0].error).toBeNull();

      // Second file should fail
      expect(results[1].metadata).toBeNull();
      expect(results[1].error).not.toBeNull();

      // Third file should succeed
      expect(results[2].metadata).not.toBeNull();
      expect(results[2].error).toBeNull();
    });

    it('should include the file path in each result', async () => {
      const filePaths = [fixture('silence.mp3'), fixture('tagged.mp3')];

      const results = await readMultipleAudioFiles(filePaths);

      expect(results[0].filePath).toBe(filePaths[0]);
      expect(results[1].filePath).toBe(filePaths[1]);
    });

    it('should handle an empty array', async () => {
      const results = await readMultipleAudioFiles([]);
      expect(results).toHaveLength(0);
    });

    it('should handle all files failing', async () => {
      const filePaths = [fixture('corrupt.mp3'), fixture('notaudio.mp3')];

      const results = await readMultipleAudioFiles(filePaths);

      expect(results).toHaveLength(2);
      results.forEach((result) => {
        expect(result.metadata).toBeNull();
        expect(result.error).not.toBeNull();
      });
    });

    it('should handle non-existent files gracefully', async () => {
      const filePaths = [fixture('tagged.mp3'), '/nonexistent/file.mp3'];

      const results = await readMultipleAudioFiles(filePaths);

      expect(results).toHaveLength(2);
      expect(results[0].metadata).not.toBeNull();
      expect(results[1].metadata).toBeNull();
      expect(results[1].error).toContain('File not found');
    });
  });
});
