import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isSupportedAudioFile,
  scanDirectoryForAudioFiles,
  sanitizeFilename,
  getUniqueFilePath,
} from '../../../src/main/utils/fileScanner';

describe('fileScanner', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-pipeline-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('isSupportedAudioFile', () => {
    it('should return true for supported audio extensions', () => {
      expect(isSupportedAudioFile('song.mp3')).toBe(true);
      expect(isSupportedAudioFile('song.flac')).toBe(true);
      expect(isSupportedAudioFile('song.m4a')).toBe(true);
      expect(isSupportedAudioFile('song.wav')).toBe(true);
      expect(isSupportedAudioFile('song.ogg')).toBe(true);
      expect(isSupportedAudioFile('song.wma')).toBe(true);
    });

    it('should return true for uppercase extensions', () => {
      expect(isSupportedAudioFile('song.MP3')).toBe(true);
      expect(isSupportedAudioFile('song.FLAC')).toBe(true);
      expect(isSupportedAudioFile('song.M4A')).toBe(true);
    });

    it('should return false for unsupported extensions', () => {
      expect(isSupportedAudioFile('document.pdf')).toBe(false);
      expect(isSupportedAudioFile('image.png')).toBe(false);
      expect(isSupportedAudioFile('video.mp4')).toBe(false);
      expect(isSupportedAudioFile('readme.txt')).toBe(false);
    });

    it('should return false for files with no extension', () => {
      expect(isSupportedAudioFile('noextension')).toBe(false);
    });

    it('should handle full file paths', () => {
      expect(isSupportedAudioFile('/music/artist/song.mp3')).toBe(true);
      expect(isSupportedAudioFile('C:\\Music\\song.flac')).toBe(true);
    });
  });

  describe('scanDirectoryForAudioFiles', () => {
    it('should find audio files in a directory', () => {
      // Create test audio files
      fs.writeFileSync(path.join(tempDir, 'song1.mp3'), '');
      fs.writeFileSync(path.join(tempDir, 'song2.flac'), '');
      fs.writeFileSync(path.join(tempDir, 'song3.m4a'), '');

      const result = scanDirectoryForAudioFiles(tempDir);

      expect(result).toHaveLength(3);
      expect(result.some((f) => f.endsWith('song1.mp3'))).toBe(true);
      expect(result.some((f) => f.endsWith('song2.flac'))).toBe(true);
      expect(result.some((f) => f.endsWith('song3.m4a'))).toBe(true);
    });

    it('should recursively scan subdirectories', () => {
      const subDir = path.join(tempDir, 'subdir');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(tempDir, 'root.mp3'), '');
      fs.writeFileSync(path.join(subDir, 'nested.mp3'), '');

      const result = scanDirectoryForAudioFiles(tempDir);

      expect(result).toHaveLength(2);
      expect(result.some((f) => f.endsWith('root.mp3'))).toBe(true);
      expect(result.some((f) => f.endsWith('nested.mp3'))).toBe(true);
    });

    it('should ignore non-audio files', () => {
      fs.writeFileSync(path.join(tempDir, 'song.mp3'), '');
      fs.writeFileSync(path.join(tempDir, 'readme.txt'), '');
      fs.writeFileSync(path.join(tempDir, 'cover.jpg'), '');

      const result = scanDirectoryForAudioFiles(tempDir);

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('song.mp3');
    });

    it('should return empty array for empty directory', () => {
      const result = scanDirectoryForAudioFiles(tempDir);
      expect(result).toHaveLength(0);
    });

    it('should return sorted results', () => {
      fs.writeFileSync(path.join(tempDir, 'c_song.mp3'), '');
      fs.writeFileSync(path.join(tempDir, 'a_song.mp3'), '');
      fs.writeFileSync(path.join(tempDir, 'b_song.mp3'), '');

      const result = scanDirectoryForAudioFiles(tempDir);

      expect(result[0]).toContain('a_song.mp3');
      expect(result[1]).toContain('b_song.mp3');
      expect(result[2]).toContain('c_song.mp3');
    });

    it('should handle non-existent directory gracefully', () => {
      const result = scanDirectoryForAudioFiles(path.join(tempDir, 'nonexistent'));
      expect(result).toHaveLength(0);
    });

    it('should find all supported formats', () => {
      fs.writeFileSync(path.join(tempDir, 'test.mp3'), '');
      fs.writeFileSync(path.join(tempDir, 'test.flac'), '');
      fs.writeFileSync(path.join(tempDir, 'test.m4a'), '');
      fs.writeFileSync(path.join(tempDir, 'test.wav'), '');
      fs.writeFileSync(path.join(tempDir, 'test.ogg'), '');
      fs.writeFileSync(path.join(tempDir, 'test.wma'), '');

      const result = scanDirectoryForAudioFiles(tempDir);
      expect(result).toHaveLength(6);
    });
  });

  describe('sanitizeFilename', () => {
    it('should remove Windows-invalid characters', () => {
      expect(sanitizeFilename('song/with:invalid*chars?.mp3')).toBe('songwithinvalidchars.mp3');
    });

    it('should remove quotes and angle brackets', () => {
      expect(sanitizeFilename('song"name"<test>.mp3')).toBe('songnametest.mp3');
    });

    it('should remove pipes and backslashes', () => {
      expect(sanitizeFilename('song|name\\test.mp3')).toBe('songnametest.mp3');
    });

    it('should collapse multiple spaces', () => {
      expect(sanitizeFilename('song   name   test.mp3')).toBe('song name test.mp3');
    });

    it('should trim whitespace', () => {
      expect(sanitizeFilename('  song name.mp3  ')).toBe('song name.mp3');
    });

    it('should not modify valid filenames', () => {
      expect(sanitizeFilename('Artist - Song Name.mp3')).toBe('Artist - Song Name.mp3');
    });
  });

  describe('getUniqueFilePath', () => {
    it('should return same path if file does not exist', () => {
      const filePath = path.join(tempDir, 'newfile.mp3');
      expect(getUniqueFilePath(filePath)).toBe(filePath);
    });

    it('should append (1) if file exists', () => {
      const filePath = path.join(tempDir, 'existing.mp3');
      fs.writeFileSync(filePath, '');

      const result = getUniqueFilePath(filePath);
      expect(result).toBe(path.join(tempDir, 'existing (1).mp3'));
    });

    it('should increment counter if multiple files exist', () => {
      const filePath = path.join(tempDir, 'song.mp3');
      fs.writeFileSync(filePath, '');
      fs.writeFileSync(path.join(tempDir, 'song (1).mp3'), '');
      fs.writeFileSync(path.join(tempDir, 'song (2).mp3'), '');

      const result = getUniqueFilePath(filePath);
      expect(result).toBe(path.join(tempDir, 'song (3).mp3'));
    });

    it('should preserve file extension', () => {
      const filePath = path.join(tempDir, 'song.flac');
      fs.writeFileSync(filePath, '');

      const result = getUniqueFilePath(filePath);
      expect(result).toMatch(/\.flac$/);
    });
  });
});
