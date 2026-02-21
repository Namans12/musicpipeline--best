import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import NodeID3 from 'node-id3';
import {
  getFormatFromPath,
  buildId3Tags,
  writeMp3Tags,
  writeTags,
  generateFilename,
  toTitleCase,
  renameAudioFile,
  writeTagsAndRename,
  writeTagsAndRenameMultiple,
} from '../../../src/main/services/tagWriter';
import type { WriteTagsInput } from '../../../src/main/services/tagWriter';

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'fixtures');

function fixture(filename: string): string {
  return path.join(FIXTURES_DIR, filename);
}

/**
 * Creates a temporary directory with a copy of the specified fixture file.
 * Returns { tempDir, tempFile } for use in tests.
 * Caller is responsible for cleanup.
 */
function createTempCopy(fixtureFilename: string): { tempDir: string; tempFile: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagwriter-test-'));
  const tempFile = path.join(tempDir, fixtureFilename);
  fs.copyFileSync(fixture(fixtureFilename), tempFile);
  return { tempDir, tempFile };
}

/**
 * Recursively removes a directory and all its contents.
 */
function cleanupTempDir(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

describe('tagWriter', () => {
  // ─── getFormatFromPath ────────────────────────────────────────────────

  describe('getFormatFromPath', () => {
    it('should return "mp3" for .mp3 files', () => {
      expect(getFormatFromPath('song.mp3')).toBe('mp3');
    });

    it('should return "flac" for .flac files', () => {
      expect(getFormatFromPath('song.flac')).toBe('flac');
    });

    it('should return "m4a" for .m4a files', () => {
      expect(getFormatFromPath('song.m4a')).toBe('m4a');
    });

    it('should return "wav" for .wav files', () => {
      expect(getFormatFromPath('song.wav')).toBe('wav');
    });

    it('should return "ogg" for .ogg files', () => {
      expect(getFormatFromPath('song.ogg')).toBe('ogg');
    });

    it('should return "wma" for .wma files', () => {
      expect(getFormatFromPath('song.wma')).toBe('wma');
    });

    it('should handle uppercase extensions', () => {
      expect(getFormatFromPath('song.MP3')).toBe('mp3');
      expect(getFormatFromPath('song.FLAC')).toBe('flac');
    });

    it('should return null for unsupported formats', () => {
      expect(getFormatFromPath('file.pdf')).toBeNull();
      expect(getFormatFromPath('file.mp4')).toBeNull();
      expect(getFormatFromPath('file.txt')).toBeNull();
    });

    it('should return null for files without extension', () => {
      expect(getFormatFromPath('noextension')).toBeNull();
    });

    it('should handle full file paths', () => {
      expect(getFormatFromPath('/music/artist/song.mp3')).toBe('mp3');
      expect(getFormatFromPath('C:\\Music\\song.flac')).toBe('flac');
    });
  });

  // ─── buildId3Tags ─────────────────────────────────────────────────────

  describe('buildId3Tags', () => {
    it('should build tags with title', () => {
      const tags = buildId3Tags({ title: 'My Song' });
      expect(tags.title).toBe('My Song');
    });

    it('should build tags with artist', () => {
      const tags = buildId3Tags({ artist: 'My Artist' });
      expect(tags.artist).toBe('My Artist');
    });

    it('should build tags with album', () => {
      const tags = buildId3Tags({ album: 'My Album' });
      expect(tags.album).toBe('My Album');
    });

    it('should convert year to string', () => {
      const tags = buildId3Tags({ year: 2024 });
      expect(tags.year).toBe('2024');
    });

    it('should join genres with /', () => {
      const tags = buildId3Tags({ genre: ['Rock', 'Pop'] });
      expect(tags.genre).toBe('Rock/Pop');
    });

    it('should handle single genre', () => {
      const tags = buildId3Tags({ genre: ['Electronic'] });
      expect(tags.genre).toBe('Electronic');
    });

    it('should convert trackNumber to string', () => {
      const tags = buildId3Tags({ trackNumber: 5 });
      expect(tags.trackNumber).toBe('5');
    });

    it('should set albumArtist as performerInfo', () => {
      const tags = buildId3Tags({ albumArtist: 'Various Artists' });
      expect(tags.performerInfo).toBe('Various Artists');
    });

    it('should build unsynchronisedLyrics with language', () => {
      const tags = buildId3Tags({ lyrics: 'Hello world\nLine two' });
      expect(tags.unsynchronisedLyrics).toEqual({
        language: 'eng',
        text: 'Hello world\nLine two',
      });
    });

    it('should build all fields at once', () => {
      const input: WriteTagsInput = {
        title: 'Test',
        artist: 'Artist',
        album: 'Album',
        year: 2023,
        genre: ['Jazz'],
        trackNumber: 3,
        albumArtist: 'Album Artist',
        lyrics: 'Lyrics here',
      };
      const tags = buildId3Tags(input);

      expect(tags.title).toBe('Test');
      expect(tags.artist).toBe('Artist');
      expect(tags.album).toBe('Album');
      expect(tags.year).toBe('2023');
      expect(tags.genre).toBe('Jazz');
      expect(tags.trackNumber).toBe('3');
      expect(tags.performerInfo).toBe('Album Artist');
      expect(tags.unsynchronisedLyrics).toEqual({
        language: 'eng',
        text: 'Lyrics here',
      });
    });

    it('should only include defined fields', () => {
      const tags = buildId3Tags({ title: 'Only Title' });
      expect(tags.title).toBe('Only Title');
      expect(tags.artist).toBeUndefined();
      expect(tags.album).toBeUndefined();
      expect(tags.year).toBeUndefined();
      expect(tags.genre).toBeUndefined();
      expect(tags.trackNumber).toBeUndefined();
      expect(tags.performerInfo).toBeUndefined();
      expect(tags.unsynchronisedLyrics).toBeUndefined();
    });

    it('should return empty tags object for empty input', () => {
      const tags = buildId3Tags({});
      expect(Object.keys(tags)).toHaveLength(0);
    });
  });

  // ─── writeMp3Tags ─────────────────────────────────────────────────────

  describe('writeMp3Tags', () => {
    let tempDir: string;
    let tempFile: string;

    beforeEach(() => {
      const temp = createTempCopy('silence.mp3');
      tempDir = temp.tempDir;
      tempFile = temp.tempFile;
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should write title tag to MP3 file', () => {
      const result = writeMp3Tags(tempFile, { title: 'New Title' });

      expect(result.success).toBe(true);
      expect(result.error).toBeNull();

      // Verify by reading back
      const readTags = NodeID3.read(tempFile);
      expect(readTags.title).toBe('New Title');
    });

    it('should write artist tag to MP3 file', () => {
      const result = writeMp3Tags(tempFile, { artist: 'New Artist' });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.artist).toBe('New Artist');
    });

    it('should write album tag', () => {
      const result = writeMp3Tags(tempFile, { album: 'New Album' });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.album).toBe('New Album');
    });

    it('should write year tag', () => {
      const result = writeMp3Tags(tempFile, { year: 2024 });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.year).toBe('2024');
    });

    it('should write genre tag', () => {
      const result = writeMp3Tags(tempFile, { genre: ['Rock', 'Pop'] });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.genre).toBe('Rock/Pop');
    });

    it('should write track number tag', () => {
      const result = writeMp3Tags(tempFile, { trackNumber: 7 });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.trackNumber).toBe('7');
    });

    it('should write album artist (performerInfo) tag', () => {
      const result = writeMp3Tags(tempFile, { albumArtist: 'Various Artists' });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.performerInfo).toBe('Various Artists');
    });

    it('should write USLT lyrics tag', () => {
      const lyrics = 'First line of lyrics\nSecond line of lyrics';
      const result = writeMp3Tags(tempFile, { lyrics });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.unsynchronisedLyrics).toBeDefined();
      if (readTags.unsynchronisedLyrics && typeof readTags.unsynchronisedLyrics === 'object') {
        expect(readTags.unsynchronisedLyrics.language).toBe('eng');
        expect(readTags.unsynchronisedLyrics.text).toBe(lyrics);
      }
    });

    it('should write multiple tags at once', () => {
      const input: WriteTagsInput = {
        title: 'Complete Song',
        artist: 'Complete Artist',
        album: 'Complete Album',
        year: 2024,
        genre: ['Jazz'],
        trackNumber: 1,
        albumArtist: 'Complete Album Artist',
        lyrics: 'Complete lyrics here',
      };

      const result = writeMp3Tags(tempFile, input);

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.title).toBe('Complete Song');
      expect(readTags.artist).toBe('Complete Artist');
      expect(readTags.album).toBe('Complete Album');
      expect(readTags.year).toBe('2024');
      expect(readTags.genre).toBe('Jazz');
      expect(readTags.trackNumber).toBe('1');
      expect(readTags.performerInfo).toBe('Complete Album Artist');
    });

    it('should preserve existing tags in update mode (default)', () => {
      // First, write some initial tags
      writeMp3Tags(tempFile, { title: 'Original Title', artist: 'Original Artist' });

      // Then update only the title
      const result = writeMp3Tags(tempFile, { title: 'Updated Title' });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.title).toBe('Updated Title');
      expect(readTags.artist).toBe('Original Artist');
    });

    it('should overwrite all tags when overwriteAll is true', () => {
      // First, write initial tags
      writeMp3Tags(tempFile, { title: 'Original Title', artist: 'Original Artist' });

      // Then write only title with overwriteAll
      const result = writeMp3Tags(tempFile, { title: 'New Title' }, { overwriteAll: true });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.title).toBe('New Title');
      // Artist should be gone since we overwrote all
      expect(readTags.artist).toBeUndefined();
    });

    it('should return error for non-existent file', () => {
      const result = writeMp3Tags('/nonexistent/file.mp3', { title: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });

    it('should return error for non-MP3 file', () => {
      const wavFile = path.join(tempDir, 'test.wav');
      fs.writeFileSync(wavFile, 'dummy');

      const result = writeMp3Tags(wavFile, { title: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('only supports MP3');
    });

    it('should return filePath in result', () => {
      const result = writeMp3Tags(tempFile, { title: 'Test' });

      expect(result.filePath).toBe(tempFile);
    });

    it('should not re-encode audio (file size stays similar)', () => {
      const originalSize = fs.statSync(tempFile).size;

      writeMp3Tags(tempFile, {
        title: 'Test Song',
        artist: 'Test Artist',
        album: 'Test Album',
      });

      const newSize = fs.statSync(tempFile).size;

      // Size should only change by the size of the tags added (~few hundred bytes)
      // NOT double or significantly change (which would indicate re-encoding)
      const sizeDiff = Math.abs(newSize - originalSize);
      expect(sizeDiff).toBeLessThan(1000);
    });

    it('should handle unicode metadata', () => {
      const result = writeMp3Tags(tempFile, {
        title: 'Über Straße',
        artist: 'Ménage à Trois',
        album: '日本語テスト',
      });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.title).toBe('Über Straße');
      expect(readTags.artist).toBe('Ménage à Trois');
      expect(readTags.album).toBe('日本語テスト');
    });

    describe('performance', () => {
      it('should write tags in under 200ms', () => {
        const start = performance.now();
        writeMp3Tags(tempFile, {
          title: 'Perf Test',
          artist: 'Perf Artist',
          album: 'Perf Album',
          year: 2024,
          genre: ['Rock'],
          trackNumber: 1,
          lyrics: 'Some lyrics',
        });
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(200);
      });
    });
  });

  // ─── writeTags (format dispatcher) ────────────────────────────────────

  describe('writeTags', () => {
    let tempDir: string;
    let tempFile: string;

    beforeEach(() => {
      const temp = createTempCopy('silence.mp3');
      tempDir = temp.tempDir;
      tempFile = temp.tempFile;
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should dispatch MP3 to writeMp3Tags', () => {
      const result = writeTags(tempFile, { title: 'Dispatch Test' });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.title).toBe('Dispatch Test');
    });

    it('should write tags for FLAC files', () => {
      const flacFile = path.join(tempDir, 'test.flac');
      fs.copyFileSync(fixture('silence.flac'), flacFile);

      const result = writeTags(flacFile, { title: 'FLAC Title', artist: 'FLAC Artist' });

      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
    });

    it('should return not-implemented error for M4A', () => {
      const m4aFile = path.join(tempDir, 'test.m4a');
      fs.writeFileSync(m4aFile, 'dummy');

      const result = writeTags(m4aFile, { title: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not yet implemented');
      expect(result.error).toContain('M4A');
    });

    it('should return not-implemented error for WAV', () => {
      const wavFile = path.join(tempDir, 'test.wav');
      fs.writeFileSync(wavFile, 'dummy');

      const result = writeTags(wavFile, { title: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not yet implemented');
      expect(result.error).toContain('WAV');
    });

    it('should return error for unsupported format', () => {
      const txtFile = path.join(tempDir, 'test.txt');
      fs.writeFileSync(txtFile, 'dummy');

      const result = writeTags(txtFile, { title: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported audio format');
    });

    it('should pass writeOptions through to the MP3 writer', () => {
      // Write initial tags
      writeTags(tempFile, { title: 'Original', artist: 'Original Artist' });

      // Overwrite all
      const result = writeTags(tempFile, { title: 'New Only' }, { overwriteAll: true });

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(tempFile);
      expect(readTags.title).toBe('New Only');
      expect(readTags.artist).toBeUndefined();
    });
  });

  // ─── generateFilename ─────────────────────────────────────────────────

  describe('generateFilename', () => {
    it('should generate "Artist - Title.ext" format', () => {
      expect(generateFilename('Artist', 'Title', '.mp3')).toBe('Artist - Title.mp3');
    });

    it('should sanitize invalid characters', () => {
      expect(generateFilename('AC/DC', 'Back:In*Black', '.mp3')).toBe('ACDC - BackInBlack.mp3');
    });

    it('should remove question marks', () => {
      expect(generateFilename('Artist', 'Why?', '.mp3')).toBe('Artist - Why.mp3');
    });

    it('should remove quotes', () => {
      expect(generateFilename('Artist', '"Song"', '.mp3')).toBe('Artist - Song.mp3');
    });

    it('should remove angle brackets', () => {
      expect(generateFilename('Artist', '<Song>', '.mp3')).toBe('Artist - Song.mp3');
    });

    it('should remove pipe characters', () => {
      expect(generateFilename('Artist', 'Song | Mix', '.mp3')).toBe('Artist - Song Mix.mp3');
    });

    it('should handle different extensions', () => {
      expect(generateFilename('Artist', 'Title', '.flac')).toBe('Artist - Title.flac');
      expect(generateFilename('Artist', 'Title', '.m4a')).toBe('Artist - Title.m4a');
      expect(generateFilename('Artist', 'Title', '.wav')).toBe('Artist - Title.wav');
    });

    it('should collapse multiple spaces', () => {
      expect(generateFilename('The   Artist', 'The   Song', '.mp3')).toBe(
        'The Artist - The Song.mp3',
      );
    });

    it('should handle unicode characters (preserved)', () => {
      expect(generateFilename('Ménage à Trois', 'Über Straße', '.mp3')).toBe(
        'Ménage à Trois - Über Straße.mp3',
      );
    });

    it('should title-case lowercase input', () => {
      expect(generateFilename('the weeknd', 'blinding lights', '.mp3')).toBe(
        'The Weeknd - Blinding Lights.mp3',
      );
    });

    it('should title-case feat. and ft. in song titles', () => {
      expect(generateFilename('eminem', 'houdini (feat. dr. dre)', '.mp3')).toBe(
        'Eminem - Houdini (Feat. Dr. Dre).mp3',
      );
      expect(generateFilename('katy perry', 'dark horse (ft. juicy j)', '.mp3')).toBe(
        'Katy Perry - Dark Horse (ft. Juicy J).mp3',
      );
    });

    it('should title-case extended/remix labels', () => {
      expect(generateFilename('artist', 'song name - extended edit', '.mp3')).toBe(
        'Artist - Song Name - Extended Edit.mp3',
      );
    });

    it('should fallback for empty sanitized result', () => {
      // All characters are invalid
      expect(generateFilename('*?*', ':<>:', '.mp3')).toBe('Unknown - Unknown.mp3');
    });
  });

  // ─── renameAudioFile ──────────────────────────────────────────────────

  describe('renameAudioFile', () => {
    let tempDir: string;
    let tempFile: string;

    beforeEach(() => {
      const temp = createTempCopy('silence.mp3');
      tempDir = temp.tempDir;
      tempFile = temp.tempFile;
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should rename file to "Artist - Title.ext" format', () => {
      const result = renameAudioFile(tempFile, 'Test Artist', 'Test Song');

      expect(result.success).toBe(true);
      expect(result.newPath).toBe(path.join(tempDir, 'Test Artist - Test Song.mp3'));
      expect(fs.existsSync(result.newPath!)).toBe(true);
      expect(fs.existsSync(tempFile)).toBe(false);
    });

    it('should return originalPath in result', () => {
      const result = renameAudioFile(tempFile, 'Artist', 'Song');

      expect(result.originalPath).toBe(tempFile);
    });

    it('should sanitize invalid characters in new filename', () => {
      const result = renameAudioFile(tempFile, 'AC/DC', 'Back:In*Black');

      expect(result.success).toBe(true);
      expect(result.newPath).toBe(path.join(tempDir, 'ACDC - BackInBlack.mp3'));
    });

    it('should handle filename collisions with (1) suffix', () => {
      // Create a conflicting file
      const conflictPath = path.join(tempDir, 'Artist - Song.mp3');
      fs.writeFileSync(conflictPath, 'existing file');

      const result = renameAudioFile(tempFile, 'Artist', 'Song');

      expect(result.success).toBe(true);
      expect(result.newPath).toBe(path.join(tempDir, 'Artist - Song (1).mp3'));
      expect(fs.existsSync(result.newPath!)).toBe(true);
    });

    it('should handle multiple filename collisions with (2) suffix', () => {
      // Create two conflicting files
      fs.writeFileSync(path.join(tempDir, 'Artist - Song.mp3'), 'existing1');
      fs.writeFileSync(path.join(tempDir, 'Artist - Song (1).mp3'), 'existing2');

      const result = renameAudioFile(tempFile, 'Artist', 'Song');

      expect(result.success).toBe(true);
      expect(result.newPath).toBe(path.join(tempDir, 'Artist - Song (2).mp3'));
    });

    it('should rename to a different output directory', () => {
      const outputDir = path.join(tempDir, 'output');
      fs.mkdirSync(outputDir);

      const result = renameAudioFile(tempFile, 'Artist', 'Song', { outputDir });

      expect(result.success).toBe(true);
      expect(result.newPath).toBe(path.join(outputDir, 'Artist - Song.mp3'));
      expect(fs.existsSync(result.newPath!)).toBe(true);
    });

    it('should create output directory if it does not exist', () => {
      const outputDir = path.join(tempDir, 'new', 'nested', 'dir');

      const result = renameAudioFile(tempFile, 'Artist', 'Song', { outputDir });

      expect(result.success).toBe(true);
      expect(fs.existsSync(outputDir)).toBe(true);
      expect(result.newPath).toBe(path.join(outputDir, 'Artist - Song.mp3'));
    });

    it('should return error for non-existent file', () => {
      const result = renameAudioFile('/nonexistent/file.mp3', 'Artist', 'Song');

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
      expect(result.newPath).toBeNull();
    });

    it('should return error for empty artist', () => {
      const result = renameAudioFile(tempFile, '', 'Song');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Artist name is required');
    });

    it('should return error for whitespace-only artist', () => {
      const result = renameAudioFile(tempFile, '   ', 'Song');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Artist name is required');
    });

    it('should return error for empty title', () => {
      const result = renameAudioFile(tempFile, 'Artist', '');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Title is required');
    });

    it('should return error for whitespace-only title', () => {
      const result = renameAudioFile(tempFile, 'Artist', '   ');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Title is required');
    });

    it('should trim artist and title', () => {
      const result = renameAudioFile(tempFile, '  Artist  ', '  Song  ');

      expect(result.success).toBe(true);
      expect(result.newPath).toBe(path.join(tempDir, 'Artist - Song.mp3'));
    });

    it('should handle same-name rename (no-op)', () => {
      // First rename to set up a known filename
      const setupResult = renameAudioFile(tempFile, 'Artist', 'Song');
      expect(setupResult.success).toBe(true);

      // Now try to rename to the same name
      const result = renameAudioFile(setupResult.newPath!, 'Artist', 'Song');

      expect(result.success).toBe(true);
      expect(result.newPath).toBe(setupResult.newPath);
    });

    it('should preserve file content after rename', () => {
      const originalContent = fs.readFileSync(tempFile);

      const result = renameAudioFile(tempFile, 'Artist', 'Song');

      expect(result.success).toBe(true);
      const newContent = fs.readFileSync(result.newPath!);
      expect(Buffer.compare(originalContent, newContent)).toBe(0);
    });
  });

  // ─── writeTagsAndRename ───────────────────────────────────────────────

  describe('writeTagsAndRename', () => {
    let tempDir: string;
    let tempFile: string;

    beforeEach(() => {
      const temp = createTempCopy('silence.mp3');
      tempDir = temp.tempDir;
      tempFile = temp.tempFile;
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should write tags and rename file', () => {
      const input: WriteTagsInput = {
        title: 'New Song',
        artist: 'New Artist',
        album: 'New Album',
        year: 2024,
      };

      const result = writeTagsAndRename(tempFile, input);

      expect(result.success).toBe(true);
      expect(result.originalPath).toBe(tempFile);
      expect(result.newPath).toBe(path.join(tempDir, 'New Artist - New Song.mp3'));
      expect(result.error).toBeNull();

      // Verify tags were written
      expect(result.tagWriteResult.success).toBe(true);

      // Verify rename happened
      expect(result.renameResult).not.toBeNull();
      expect(result.renameResult!.success).toBe(true);

      // Verify file exists at new location with correct tags
      expect(fs.existsSync(result.newPath!)).toBe(true);
      const readTags = NodeID3.read(result.newPath!);
      expect(readTags.title).toBe('New Song');
      expect(readTags.artist).toBe('New Artist');
      expect(readTags.album).toBe('New Album');
    });

    it('should write tags without renaming if artist is missing', () => {
      const input: WriteTagsInput = {
        title: 'Song Only',
        album: 'Some Album',
      };

      const result = writeTagsAndRename(tempFile, input);

      expect(result.success).toBe(true);
      expect(result.newPath).toBeNull();
      expect(result.renameResult).toBeNull();
      expect(result.tagWriteResult.success).toBe(true);
      expect(result.error).toBeNull();

      // File should still be at original location with tags
      expect(fs.existsSync(tempFile)).toBe(true);
      const readTags = NodeID3.read(tempFile);
      expect(readTags.title).toBe('Song Only');
    });

    it('should write tags without renaming if title is missing', () => {
      const input: WriteTagsInput = {
        artist: 'Artist Only',
        album: 'Some Album',
      };

      const result = writeTagsAndRename(tempFile, input);

      expect(result.success).toBe(true);
      expect(result.newPath).toBeNull();
      expect(result.renameResult).toBeNull();
    });

    it('should not attempt rename if tag writing fails', () => {
      // Use an unsupported format (M4A) to trigger tag write failure
      const m4aFile = path.join(tempDir, 'test.m4a');
      fs.writeFileSync(m4aFile, 'dummy m4a content');

      const result = writeTagsAndRename(m4aFile, {
        title: 'Test',
        artist: 'Test Artist',
      });

      expect(result.success).toBe(false);
      expect(result.renameResult).toBeNull();
      expect(result.error).toContain('Tag writing failed');
    });

    it('should pass writeOptions through', () => {
      // Write initial tags
      writeTags(tempFile, { title: 'Original', artist: 'Original Artist' });

      // Use overwriteAll
      const result = writeTagsAndRename(
        tempFile,
        { title: 'New', artist: 'New Artist' },
        { overwriteAll: true },
      );

      expect(result.success).toBe(true);

      const readTags = NodeID3.read(result.newPath!);
      expect(readTags.title).toBe('New');
      expect(readTags.artist).toBe('New Artist');
    });

    it('should pass renameOptions through', () => {
      const outputDir = path.join(tempDir, 'output');

      const result = writeTagsAndRename(
        tempFile,
        { title: 'Song', artist: 'Artist' },
        {},
        { outputDir },
      );

      expect(result.success).toBe(true);
      expect(result.newPath).toBe(path.join(outputDir, 'Artist - Song.mp3'));
    });

    it('should include both sub-results on success', () => {
      const result = writeTagsAndRename(tempFile, { title: 'Song', artist: 'Artist' });

      expect(result.tagWriteResult).toBeDefined();
      expect(result.tagWriteResult.success).toBe(true);
      expect(result.renameResult).toBeDefined();
      expect(result.renameResult!.success).toBe(true);
    });
  });

  // ─── writeTagsAndRenameMultiple ───────────────────────────────────────

  describe('writeTagsAndRenameMultiple', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagwriter-multi-test-'));
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should process multiple files successfully', () => {
      // Create two temp copies
      const file1 = path.join(tempDir, 'file1.mp3');
      const file2 = path.join(tempDir, 'file2.mp3');
      fs.copyFileSync(fixture('silence.mp3'), file1);
      fs.copyFileSync(fixture('silence.mp3'), file2);

      const results = writeTagsAndRenameMultiple([
        { filePath: file1, input: { title: 'Song 1', artist: 'Artist 1' } },
        { filePath: file2, input: { title: 'Song 2', artist: 'Artist 2' } },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[0].newPath).toBe(path.join(tempDir, 'Artist 1 - Song 1.mp3'));
      expect(results[1].success).toBe(true);
      expect(results[1].newPath).toBe(path.join(tempDir, 'Artist 2 - Song 2.mp3'));
    });

    it('should handle per-file failures without stopping', () => {
      const file1 = path.join(tempDir, 'file1.mp3');
      fs.copyFileSync(fixture('silence.mp3'), file1);
      const nonExistent = '/nonexistent/file.mp3';

      const results = writeTagsAndRenameMultiple([
        { filePath: file1, input: { title: 'Song 1', artist: 'Artist 1' } },
        { filePath: nonExistent, input: { title: 'Song 2', artist: 'Artist 2' } },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBeTruthy();
    });

    it('should handle empty input array', () => {
      const results = writeTagsAndRenameMultiple([]);

      expect(results).toHaveLength(0);
    });

    it('should pass writeOptions to all files', () => {
      const file1 = path.join(tempDir, 'file1.mp3');
      fs.copyFileSync(fixture('silence.mp3'), file1);

      // Write initial tags
      writeTags(file1, { title: 'Original', artist: 'Original Artist' });

      const results = writeTagsAndRenameMultiple(
        [{ filePath: file1, input: { title: 'New', artist: 'New Artist' } }],
        { overwriteAll: true },
      );

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);

      const readTags = NodeID3.read(results[0].newPath!);
      expect(readTags.title).toBe('New');
    });

    it('should pass renameOptions to all files', () => {
      const outputDir = path.join(tempDir, 'output');
      const file1 = path.join(tempDir, 'file1.mp3');
      fs.copyFileSync(fixture('silence.mp3'), file1);

      const results = writeTagsAndRenameMultiple(
        [{ filePath: file1, input: { title: 'Song', artist: 'Artist' } }],
        {},
        { outputDir },
      );

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].newPath).toBe(path.join(outputDir, 'Artist - Song.mp3'));
    });

    it('should handle all files failing', () => {
      const results = writeTagsAndRenameMultiple([
        { filePath: '/nonexistent/a.mp3', input: { title: 'A', artist: 'A' } },
        { filePath: '/nonexistent/b.mp3', input: { title: 'B', artist: 'B' } },
      ]);

      expect(results).toHaveLength(2);
      results.forEach((result) => {
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
      });
    });
  });

  // ─── Integration tests ────────────────────────────────────────────────

  describe('integration', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagwriter-integ-test-'));
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should write full metadata and rename: end-to-end MP3 flow', () => {
      const tempFile = path.join(tempDir, 'unknown-track.mp3');
      fs.copyFileSync(fixture('silence.mp3'), tempFile);

      const input: WriteTagsInput = {
        title: 'Bohemian Rhapsody',
        artist: 'Queen',
        album: 'A Night at the Opera',
        year: 1975,
        genre: ['Rock', 'Progressive Rock'],
        trackNumber: 11,
        albumArtist: 'Queen',
        lyrics: 'Is this the real life?\nIs this just fantasy?',
      };

      const result = writeTagsAndRename(tempFile, input);

      expect(result.success).toBe(true);
      expect(result.newPath).toBe(path.join(tempDir, 'Queen - Bohemian Rhapsody.mp3'));

      // Read back and verify all tags
      const readTags = NodeID3.read(result.newPath!);
      expect(readTags.title).toBe('Bohemian Rhapsody');
      expect(readTags.artist).toBe('Queen');
      expect(readTags.album).toBe('A Night at the Opera');
      expect(readTags.year).toBe('1975');
      expect(readTags.genre).toBe('Rock/Progressive Rock');
      expect(readTags.trackNumber).toBe('11');
      expect(readTags.performerInfo).toBe('Queen');

      // Verify lyrics
      if (readTags.unsynchronisedLyrics && typeof readTags.unsynchronisedLyrics === 'object') {
        expect(readTags.unsynchronisedLyrics.text).toBe(
          'Is this the real life?\nIs this just fantasy?',
        );
      }

      // Verify original file is gone
      expect(fs.existsSync(tempFile)).toBe(false);

      // Verify no re-encoding (file size hasn't changed dramatically)
      const originalSize = fs.statSync(fixture('silence.mp3')).size;
      const newSize = fs.statSync(result.newPath!).size;
      const sizeDiff = Math.abs(newSize - originalSize);
      expect(sizeDiff).toBeLessThan(2000);
    });

    it('should update existing tagged MP3 and rename', () => {
      const tempFile = path.join(tempDir, 'old-name.mp3');
      fs.copyFileSync(fixture('tagged.mp3'), tempFile);

      const input: WriteTagsInput = {
        title: 'Corrected Title',
        artist: 'Corrected Artist',
      };

      const result = writeTagsAndRename(tempFile, input);

      expect(result.success).toBe(true);

      // Original tags should still be preserved (update mode)
      const readTags = NodeID3.read(result.newPath!);
      expect(readTags.title).toBe('Corrected Title');
      expect(readTags.artist).toBe('Corrected Artist');
      // Album from original tagged.mp3 should still be there
      expect(readTags.album).toBe('Test Album');
    });

    it('should handle batch processing with output directory', () => {
      const outputDir = path.join(tempDir, 'organized');
      const file1 = path.join(tempDir, 'track01.mp3');
      const file2 = path.join(tempDir, 'track02.mp3');
      fs.copyFileSync(fixture('silence.mp3'), file1);
      fs.copyFileSync(fixture('silence.mp3'), file2);

      const results = writeTagsAndRenameMultiple(
        [
          {
            filePath: file1,
            input: {
              title: 'Stairway to Heaven',
              artist: 'Led Zeppelin',
              album: 'Led Zeppelin IV',
              year: 1971,
            },
          },
          {
            filePath: file2,
            input: {
              title: 'Comfortably Numb',
              artist: 'Pink Floyd',
              album: 'The Wall',
              year: 1979,
            },
          },
        ],
        {},
        { outputDir },
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[0].newPath).toBe(
        path.join(outputDir, 'Led Zeppelin - Stairway To Heaven.mp3'),
      );
      expect(results[1].success).toBe(true);
      expect(results[1].newPath).toBe(path.join(outputDir, 'Pink Floyd - Comfortably Numb.mp3'));

      // Verify files exist
      expect(fs.existsSync(results[0].newPath!)).toBe(true);
      expect(fs.existsSync(results[1].newPath!)).toBe(true);
    });
  });
});
