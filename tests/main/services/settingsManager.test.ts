/**
 * Tests for Settings Manager Service
 *
 * Covers all exported functions, the SettingsManager class lifecycle,
 * file persistence, validation, change notifications, and edge cases.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SettingsManager,
  getDefaultSettingsDir,
  validateConcurrency,
  validateNamingTemplate,
  validateSettings,
  serializeSettings,
  deserializeSettings,
} from '../../../src/main/services/settingsManager';
import { DEFAULT_SETTINGS, AppSettings } from '../../../src/shared/types';

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Creates a unique temporary directory for test isolation */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
}

/** Recursively removes a directory */
function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Cleanup failure is non-fatal in tests
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SettingsManager', () => {
  // ─── getDefaultSettingsDir ─────────────────────────────────────────────

  describe('getDefaultSettingsDir', () => {
    it('returns a string', () => {
      expect(typeof getDefaultSettingsDir()).toBe('string');
    });

    it('contains "audio-pipeline"', () => {
      expect(getDefaultSettingsDir()).toContain('audio-pipeline');
    });

    it('does not contain "logs"', () => {
      // Settings dir should NOT be the log dir
      const dir = getDefaultSettingsDir();
      expect(dir.endsWith('logs')).toBe(false);
    });

    it('uses APPDATA if set', () => {
      const original = process.env.APPDATA;
      const fakeAppData = path.join('fake', 'appdata');
      process.env.APPDATA = fakeAppData;
      try {
        const dir = getDefaultSettingsDir();
        expect(dir).toContain(fakeAppData);
        expect(dir).toContain('audio-pipeline');
      } finally {
        if (original !== undefined) {
          process.env.APPDATA = original;
        } else {
          delete process.env.APPDATA;
        }
      }
    });

    it('falls back to homedir/.config if APPDATA is not set', () => {
      const original = process.env.APPDATA;
      delete process.env.APPDATA;
      try {
        const dir = getDefaultSettingsDir();
        expect(dir).toContain(os.homedir());
        expect(dir).toContain('audio-pipeline');
      } finally {
        if (original !== undefined) {
          process.env.APPDATA = original;
        }
      }
    });
  });

  // ─── validateConcurrency ───────────────────────────────────────────────

  describe('validateConcurrency', () => {
    it('returns value for valid number in range', () => {
      expect(validateConcurrency(5)).toBe(5);
    });

    it('clamps to minimum of 1', () => {
      expect(validateConcurrency(0)).toBe(1);
      expect(validateConcurrency(-5)).toBe(1);
    });

    it('clamps to maximum of 10', () => {
      expect(validateConcurrency(15)).toBe(10);
      expect(validateConcurrency(100)).toBe(10);
    });

    it('rounds fractional values', () => {
      expect(validateConcurrency(3.7)).toBe(4);
      expect(validateConcurrency(3.2)).toBe(3);
    });

    it('returns default for NaN', () => {
      expect(validateConcurrency(NaN)).toBe(DEFAULT_SETTINGS.concurrency);
    });

    it('returns default for non-number types', () => {
      expect(validateConcurrency('abc')).toBe(DEFAULT_SETTINGS.concurrency);
      expect(validateConcurrency(null)).toBe(DEFAULT_SETTINGS.concurrency);
      expect(validateConcurrency(undefined)).toBe(DEFAULT_SETTINGS.concurrency);
      expect(validateConcurrency(true)).toBe(DEFAULT_SETTINGS.concurrency);
    });

    it('handles boundary values', () => {
      expect(validateConcurrency(1)).toBe(1);
      expect(validateConcurrency(10)).toBe(10);
    });
  });

  // ─── validateNamingTemplate ────────────────────────────────────────────

  describe('validateNamingTemplate', () => {
    it('returns true for template with {artist}', () => {
      expect(validateNamingTemplate('{artist} - {title}')).toBe(true);
    });

    it('returns true for template with only {title}', () => {
      expect(validateNamingTemplate('{title}')).toBe(true);
    });

    it('returns true for template with only {artist}', () => {
      expect(validateNamingTemplate('{artist}')).toBe(true);
    });

    it('returns false for template without placeholders', () => {
      expect(validateNamingTemplate('no placeholders here')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(validateNamingTemplate('')).toBe(false);
    });

    it('returns false for whitespace-only string', () => {
      expect(validateNamingTemplate('   ')).toBe(false);
    });

    it('returns false for non-string types', () => {
      expect(validateNamingTemplate(null)).toBe(false);
      expect(validateNamingTemplate(undefined)).toBe(false);
      expect(validateNamingTemplate(42)).toBe(false);
      expect(validateNamingTemplate(true)).toBe(false);
    });

    it('accepts templates with additional placeholders', () => {
      expect(validateNamingTemplate('{artist} - {title} ({album})')).toBe(true);
      expect(validateNamingTemplate('{year} - {artist} - {title}')).toBe(true);
    });
  });

  // ─── validateSettings ─────────────────────────────────────────────────

  describe('validateSettings', () => {
    it('returns defaults for null input', () => {
      expect(validateSettings(null)).toEqual(DEFAULT_SETTINGS);
    });

    it('returns defaults for undefined input', () => {
      expect(validateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    });

    it('returns defaults for non-object input', () => {
      expect(validateSettings('string')).toEqual(DEFAULT_SETTINGS);
      expect(validateSettings(42)).toEqual(DEFAULT_SETTINGS);
      expect(validateSettings(true)).toEqual(DEFAULT_SETTINGS);
    });

    it('preserves valid outputFolder string', () => {
      const result = validateSettings({ outputFolder: '/some/path' });
      expect(result.outputFolder).toBe('/some/path');
    });

    it('trims outputFolder whitespace', () => {
      const result = validateSettings({ outputFolder: '  /some/path  ' });
      expect(result.outputFolder).toBe('/some/path');
    });

    it('converts empty outputFolder to null', () => {
      const result = validateSettings({ outputFolder: '' });
      expect(result.outputFolder).toBeNull();
    });

    it('converts whitespace-only outputFolder to null', () => {
      const result = validateSettings({ outputFolder: '   ' });
      expect(result.outputFolder).toBeNull();
    });

    it('preserves null outputFolder', () => {
      const result = validateSettings({ outputFolder: null });
      expect(result.outputFolder).toBeNull();
    });

    it('preserves valid namingTemplate', () => {
      const result = validateSettings({ namingTemplate: '{title} by {artist}' });
      expect(result.namingTemplate).toBe('{title} by {artist}');
    });

    it('trims namingTemplate whitespace', () => {
      const result = validateSettings({ namingTemplate: '  {artist} - {title}  ' });
      expect(result.namingTemplate).toBe('{artist} - {title}');
    });

    it('uses default for invalid namingTemplate', () => {
      const result = validateSettings({ namingTemplate: 'no placeholders' });
      expect(result.namingTemplate).toBe(DEFAULT_SETTINGS.namingTemplate);
    });

    it('validates and clamps concurrency', () => {
      expect(validateSettings({ concurrency: 3 }).concurrency).toBe(3);
      expect(validateSettings({ concurrency: 0 }).concurrency).toBe(1);
      expect(validateSettings({ concurrency: 20 }).concurrency).toBe(10);
    });

    it('preserves valid fetchLyrics boolean', () => {
      expect(validateSettings({ fetchLyrics: false }).fetchLyrics).toBe(false);
      expect(validateSettings({ fetchLyrics: true }).fetchLyrics).toBe(true);
    });

    it('uses default for non-boolean fetchLyrics', () => {
      const result = validateSettings({ fetchLyrics: 'yes' as unknown as boolean });
      expect(result.fetchLyrics).toBe(DEFAULT_SETTINGS.fetchLyrics);
    });

    it('preserves valid overwriteExistingTags boolean', () => {
      expect(validateSettings({ overwriteExistingTags: true }).overwriteExistingTags).toBe(true);
      expect(validateSettings({ overwriteExistingTags: false }).overwriteExistingTags).toBe(false);
    });

    it('uses default for non-boolean overwriteExistingTags', () => {
      const result = validateSettings({ overwriteExistingTags: 1 as unknown as boolean });
      expect(result.overwriteExistingTags).toBe(DEFAULT_SETTINGS.overwriteExistingTags);
    });

    it('preserves valid usePersistentCache boolean', () => {
      expect(validateSettings({ usePersistentCache: true }).usePersistentCache).toBe(true);
      expect(validateSettings({ usePersistentCache: false }).usePersistentCache).toBe(false);
    });

    it('uses default for non-boolean usePersistentCache', () => {
      const result = validateSettings({ usePersistentCache: 'yes' as unknown as boolean });
      expect(result.usePersistentCache).toBe(DEFAULT_SETTINGS.usePersistentCache);
    });

    it('preserves valid acoustIdApiKey string', () => {
      expect(validateSettings({ acoustIdApiKey: 'my-api-key' }).acoustIdApiKey).toBe('my-api-key');
      expect(validateSettings({ acoustIdApiKey: '' }).acoustIdApiKey).toBe('');
    });

    it('trims whitespace from acoustIdApiKey', () => {
      const result = validateSettings({ acoustIdApiKey: '  abc123  ' });
      expect(result.acoustIdApiKey).toBe('abc123');
    });

    it('uses default empty string for non-string acoustIdApiKey', () => {
      const result = validateSettings({ acoustIdApiKey: 42 as unknown as string });
      expect(result.acoustIdApiKey).toBe(DEFAULT_SETTINGS.acoustIdApiKey);
    });

    it('handles complete valid settings', () => {
      const input: AppSettings = {
        outputFolder: '/output',
        namingTemplate: '{artist} - {title}',
        concurrency: 3,
        fetchLyrics: false,
        overwriteExistingTags: true,
        usePersistentCache: true,
        acoustIdApiKey: '',
        useSpotify: false,
        spotifyClientId: '',
        spotifyClientSecret: '',
        useGenius: false,
        geniusAccessToken: '',
      };
      expect(validateSettings(input)).toEqual(input);
    });

    it('handles mixed valid and invalid fields', () => {
      const result = validateSettings({
        outputFolder: '/valid/path',
        namingTemplate: 'invalid template',
        concurrency: 15,
        fetchLyrics: 'not a boolean',
        overwriteExistingTags: true,
      });
      expect(result.outputFolder).toBe('/valid/path');
      expect(result.namingTemplate).toBe(DEFAULT_SETTINGS.namingTemplate);
      expect(result.concurrency).toBe(10);
      expect(result.fetchLyrics).toBe(DEFAULT_SETTINGS.fetchLyrics);
      expect(result.overwriteExistingTags).toBe(true);
    });

    it('ignores extra unknown fields', () => {
      const result = validateSettings({
        outputFolder: null,
        unknownField: 'should be ignored',
        anotherUnknown: 42,
      });
      expect(result.outputFolder).toBeNull();
      expect((result as Record<string, unknown>)['unknownField']).toBeUndefined();
    });
  });

  // ─── serializeSettings ─────────────────────────────────────────────────

  describe('serializeSettings', () => {
    it('serializes settings to formatted JSON', () => {
      const json = serializeSettings(DEFAULT_SETTINGS);
      expect(typeof json).toBe('string');
      expect(JSON.parse(json)).toEqual(DEFAULT_SETTINGS);
    });

    it('uses 2-space indentation', () => {
      const json = serializeSettings(DEFAULT_SETTINGS);
      expect(json).toContain('  ');
    });

    it('handles null outputFolder', () => {
      const json = serializeSettings({ ...DEFAULT_SETTINGS, outputFolder: null });
      expect(json).toContain('"outputFolder": null');
    });

    it('handles string outputFolder', () => {
      const json = serializeSettings({ ...DEFAULT_SETTINGS, outputFolder: '/path' });
      expect(json).toContain('"outputFolder": "/path"');
    });
  });

  // ─── deserializeSettings ───────────────────────────────────────────────

  describe('deserializeSettings', () => {
    it('parses valid JSON object', () => {
      const result = deserializeSettings('{"concurrency": 3}');
      expect(result).toEqual({ concurrency: 3 });
    });

    it('returns null for invalid JSON', () => {
      expect(deserializeSettings('not json')).toBeNull();
    });

    it('returns null for JSON array', () => {
      expect(deserializeSettings('[1, 2, 3]')).toBeNull();
    });

    it('returns null for JSON string', () => {
      expect(deserializeSettings('"just a string"')).toBeNull();
    });

    it('returns null for JSON number', () => {
      expect(deserializeSettings('42')).toBeNull();
    });

    it('returns null for JSON null', () => {
      expect(deserializeSettings('null')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(deserializeSettings('')).toBeNull();
    });

    it('roundtrips with serializeSettings', () => {
      const settings: AppSettings = {
        outputFolder: '/test/path',
        namingTemplate: '{artist} - {title}',
        concurrency: 7,
        fetchLyrics: false,
        overwriteExistingTags: true,
        usePersistentCache: false,
        acoustIdApiKey: 'test-key',
        useSpotify: true,
        spotifyClientId: 'my-client-id',
        spotifyClientSecret: 'my-client-secret',
        useGenius: true,
        geniusAccessToken: 'my-genius-token',
      };
      const json = serializeSettings(settings);
      const parsed = deserializeSettings(json);
      expect(parsed).toEqual(settings);
    });
  });

  // ─── SettingsManager constructor ───────────────────────────────────────

  describe('SettingsManager constructor', () => {
    it('uses default settings initially', () => {
      const manager = new SettingsManager({ settingsDir: '/nonexistent' });
      expect(manager.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('uses custom settingsDir', () => {
      const manager = new SettingsManager({ settingsDir: '/custom/dir' });
      expect(manager.getSettingsDir()).toBe('/custom/dir');
    });

    it('uses default settingsDir when not specified', () => {
      const manager = new SettingsManager();
      expect(manager.getSettingsDir()).toBe(getDefaultSettingsDir());
    });

    it('uses custom fileName', () => {
      const manager = new SettingsManager({ settingsDir: '/dir', fileName: 'custom.json' });
      expect(manager.getFilePath()).toBe(path.join('/dir', 'custom.json'));
    });

    it('uses default fileName when not specified', () => {
      const manager = new SettingsManager({ settingsDir: '/dir' });
      expect(manager.getFilePath()).toBe(path.join('/dir', 'settings.json'));
    });

    it('is not initialized before calling initialize()', () => {
      const manager = new SettingsManager({ settingsDir: '/nonexistent' });
      expect(manager.isInitialized()).toBe(false);
    });

    it('has no listeners initially', () => {
      const manager = new SettingsManager({ settingsDir: '/nonexistent' });
      expect(manager.getListenerCount()).toBe(0);
    });
  });

  // ─── SettingsManager initialize ────────────────────────────────────────

  describe('SettingsManager initialize', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    it('sets initialized to true', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();
      expect(manager.isInitialized()).toBe(true);
    });

    it('creates settings directory if it does not exist', async () => {
      const subDir = path.join(tempDir, 'nested', 'settings');
      const manager = new SettingsManager({ settingsDir: subDir });
      await manager.initialize();
      expect(fs.existsSync(subDir)).toBe(true);
    });

    it('uses defaults when settings file does not exist', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();
      expect(manager.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('loads settings from existing file', async () => {
      const settings: AppSettings = {
        outputFolder: '/custom/output',
        namingTemplate: '{title} - {artist}',
        concurrency: 3,
        fetchLyrics: false,
        overwriteExistingTags: true,
        usePersistentCache: true,
        acoustIdApiKey: '',
        useSpotify: false,
        spotifyClientId: '',
        spotifyClientSecret: '',
        useGenius: false,
        geniusAccessToken: '',
      };
      fs.writeFileSync(path.join(tempDir, 'settings.json'), JSON.stringify(settings), 'utf-8');

      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();
      expect(manager.get()).toEqual(settings);
    });

    it('falls back to defaults on corrupt settings file', async () => {
      fs.writeFileSync(path.join(tempDir, 'settings.json'), 'NOT VALID JSON!!!', 'utf-8');

      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();
      expect(manager.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('validates loaded settings and fills missing fields with defaults', async () => {
      // File has only concurrency set
      fs.writeFileSync(
        path.join(tempDir, 'settings.json'),
        JSON.stringify({ concurrency: 8 }),
        'utf-8',
      );

      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();
      const settings = manager.get();
      expect(settings.concurrency).toBe(8);
      expect(settings.outputFolder).toBeNull(); // default
      expect(settings.fetchLyrics).toBe(true); // default
    });

    it('clamps out-of-range values from file', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'settings.json'),
        JSON.stringify({ concurrency: 999 }),
        'utf-8',
      );

      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();
      expect(manager.get().concurrency).toBe(10);
    });

    it('handles gracefully when directory creation fails', async () => {
      // Use a path that would fail on most systems (e.g., inside a file)
      const settingsFilePath = path.join(tempDir, 'settings.json');
      fs.writeFileSync(settingsFilePath, '{}', 'utf-8');

      // Try to create a directory inside a file (should fail)
      const badDir = path.join(settingsFilePath, 'subdir');
      const manager = new SettingsManager({ settingsDir: badDir });
      await manager.initialize(); // Should not throw
      expect(manager.isInitialized()).toBe(true);
      expect(manager.get()).toEqual(DEFAULT_SETTINGS);
    });
  });

  // ─── SettingsManager get ───────────────────────────────────────────────

  describe('SettingsManager get', () => {
    it('returns a copy of settings (not a reference)', () => {
      const manager = new SettingsManager({ settingsDir: '/nonexistent' });
      const settings1 = manager.get();
      const settings2 = manager.get();
      expect(settings1).toEqual(settings2);
      expect(settings1).not.toBe(settings2);
    });

    it('mutations to returned object do not affect internal state', () => {
      const manager = new SettingsManager({ settingsDir: '/nonexistent' });
      const settings = manager.get();
      settings.concurrency = 999;
      expect(manager.get().concurrency).toBe(DEFAULT_SETTINGS.concurrency);
    });
  });

  // ─── SettingsManager save ──────────────────────────────────────────────

  describe('SettingsManager save', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    it('updates settings with partial update', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const result = await manager.save({ concurrency: 3 });
      expect(result.concurrency).toBe(3);
      // Other settings remain default
      expect(result.fetchLyrics).toBe(DEFAULT_SETTINGS.fetchLyrics);
    });

    it('persists settings to file', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      await manager.save({ concurrency: 7, fetchLyrics: false });

      // Read the file directly
      const content = fs.readFileSync(path.join(tempDir, 'settings.json'), 'utf-8');
      const saved = JSON.parse(content) as AppSettings;
      expect(saved.concurrency).toBe(7);
      expect(saved.fetchLyrics).toBe(false);
    });

    it('validates updates before saving', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const result = await manager.save({ concurrency: 99 });
      expect(result.concurrency).toBe(10); // Clamped
    });

    it('returns a copy of the updated settings', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const result = await manager.save({ concurrency: 5 });
      result.concurrency = 999;
      expect(manager.get().concurrency).toBe(5);
    });

    it('merges multiple partial saves', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      await manager.save({ concurrency: 3 });
      await manager.save({ fetchLyrics: false });
      await manager.save({ overwriteExistingTags: true });

      const settings = manager.get();
      expect(settings.concurrency).toBe(3);
      expect(settings.fetchLyrics).toBe(false);
      expect(settings.overwriteExistingTags).toBe(true);
    });

    it('handles outputFolder update', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      await manager.save({ outputFolder: '/new/output' });
      expect(manager.get().outputFolder).toBe('/new/output');

      await manager.save({ outputFolder: null });
      expect(manager.get().outputFolder).toBeNull();
    });

    it('handles namingTemplate update', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      await manager.save({ namingTemplate: '{title} by {artist}' });
      expect(manager.get().namingTemplate).toBe('{title} by {artist}');
    });

    it('rejects invalid namingTemplate and keeps current', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const original = manager.get().namingTemplate;
      await manager.save({ namingTemplate: 'no placeholders' });
      expect(manager.get().namingTemplate).toBe(original);
    });

    it('creates settings directory if deleted between saves', async () => {
      const subDir = path.join(tempDir, 'sub');
      const manager = new SettingsManager({ settingsDir: subDir });
      await manager.initialize();

      // Delete the directory
      removeTempDir(subDir);
      expect(fs.existsSync(subDir)).toBe(false);

      // Save should recreate it
      await manager.save({ concurrency: 2 });
      expect(fs.existsSync(subDir)).toBe(true);
    });

    it('notifies listeners on save', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const listener = vi.fn();
      manager.onChange(listener);

      await manager.save({ concurrency: 8 });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ concurrency: 8 }));
    });

    it('handles save with all fields at once', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const newSettings: AppSettings = {
        outputFolder: '/full/path',
        namingTemplate: '{artist} ({year}) - {title}',
        concurrency: 2,
        fetchLyrics: false,
        overwriteExistingTags: true,
        usePersistentCache: true,
        acoustIdApiKey: 'my-key',
        useSpotify: true,
        spotifyClientId: 'client-id',
        spotifyClientSecret: 'client-secret',
        useGenius: true,
        geniusAccessToken: 'genius-token',
      };

      const result = await manager.save(newSettings);
      expect(result).toEqual(newSettings);
    });
  });

  // ─── SettingsManager reset ─────────────────────────────────────────────

  describe('SettingsManager reset', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    it('resets all settings to defaults', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      await manager.save({
        concurrency: 2,
        fetchLyrics: false,
        overwriteExistingTags: true,
        outputFolder: '/somewhere',
      });

      const result = await manager.reset();
      expect(result).toEqual(DEFAULT_SETTINGS);
      expect(manager.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('persists reset to file', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();
      await manager.save({ concurrency: 2 });
      await manager.reset();

      const content = fs.readFileSync(path.join(tempDir, 'settings.json'), 'utf-8');
      const saved = JSON.parse(content) as AppSettings;
      expect(saved).toEqual(DEFAULT_SETTINGS);
    });

    it('notifies listeners on reset', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();
      await manager.save({ concurrency: 2 });

      const listener = vi.fn();
      manager.onChange(listener);

      await manager.reset();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(DEFAULT_SETTINGS);
    });

    it('returns a copy of defaults', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const result = await manager.reset();
      result.concurrency = 999;
      expect(manager.get().concurrency).toBe(DEFAULT_SETTINGS.concurrency);
    });
  });

  // ─── SettingsManager onChange ───────────────────────────────────────────

  describe('SettingsManager onChange', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    it('registers a listener', () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      const listener = vi.fn();
      manager.onChange(listener);
      expect(manager.getListenerCount()).toBe(1);
    });

    it('returns an unsubscribe function', () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      const listener = vi.fn();
      const unsub = manager.onChange(listener);
      expect(typeof unsub).toBe('function');
    });

    it('unsubscribe removes the listener', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const listener = vi.fn();
      const unsub = manager.onChange(listener);
      expect(manager.getListenerCount()).toBe(1);

      unsub();
      expect(manager.getListenerCount()).toBe(0);

      await manager.save({ concurrency: 3 });
      expect(listener).not.toHaveBeenCalled();
    });

    it('supports multiple listeners', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      manager.onChange(listener1);
      manager.onChange(listener2);

      await manager.save({ concurrency: 4 });

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('selective unsubscribe only removes targeted listener', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = manager.onChange(listener1);
      manager.onChange(listener2);

      unsub1();

      await manager.save({ concurrency: 6 });
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('listener receives a copy of settings', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      let received: AppSettings | null = null;
      manager.onChange((settings) => {
        received = settings;
      });

      await manager.save({ concurrency: 9 });
      expect(received).not.toBeNull();
      expect(received!.concurrency).toBe(9);

      // Mutating received should not affect internal state
      received!.concurrency = 999;
      expect(manager.get().concurrency).toBe(9);
    });

    it('handles listener errors gracefully', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const badListener = vi.fn(() => {
        throw new Error('Listener error');
      });
      const goodListener = vi.fn();

      manager.onChange(badListener);
      manager.onChange(goodListener);

      // Should not throw even though first listener throws
      await manager.save({ concurrency: 4 });
      expect(badListener).toHaveBeenCalledTimes(1);
      expect(goodListener).toHaveBeenCalledTimes(1);
    });

    it('double unsubscribe is safe', () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      const listener = vi.fn();
      const unsub = manager.onChange(listener);
      unsub();
      unsub(); // Should not throw
      expect(manager.getListenerCount()).toBe(0);
    });
  });

  // ─── SettingsManager getFilePath / getSettingsDir ──────────────────────

  describe('SettingsManager getFilePath / getSettingsDir', () => {
    it('getFilePath combines settingsDir and fileName', () => {
      const manager = new SettingsManager({
        settingsDir: '/custom/dir',
        fileName: 'my-settings.json',
      });
      expect(manager.getFilePath()).toBe(path.join('/custom/dir', 'my-settings.json'));
    });

    it('getSettingsDir returns the configured directory', () => {
      const manager = new SettingsManager({ settingsDir: '/custom/dir' });
      expect(manager.getSettingsDir()).toBe('/custom/dir');
    });
  });

  // ─── SettingsManager persistence roundtrip ─────────────────────────────

  describe('SettingsManager persistence roundtrip', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    it('settings persist between manager instances', async () => {
      // Save with first instance
      const manager1 = new SettingsManager({ settingsDir: tempDir });
      await manager1.initialize();
      await manager1.save({
        concurrency: 3,
        fetchLyrics: false,
        outputFolder: '/persistent/path',
        namingTemplate: '{title} - {artist}',
        overwriteExistingTags: true,
      });

      // Load with second instance
      const manager2 = new SettingsManager({ settingsDir: tempDir });
      await manager2.initialize();
      const loaded = manager2.get();

      expect(loaded.concurrency).toBe(3);
      expect(loaded.fetchLyrics).toBe(false);
      expect(loaded.outputFolder).toBe('/persistent/path');
      expect(loaded.namingTemplate).toBe('{title} - {artist}');
      expect(loaded.overwriteExistingTags).toBe(true);
    });

    it('reset persists between instances', async () => {
      const manager1 = new SettingsManager({ settingsDir: tempDir });
      await manager1.initialize();
      await manager1.save({ concurrency: 2 });
      await manager1.reset();

      const manager2 = new SettingsManager({ settingsDir: tempDir });
      await manager2.initialize();
      expect(manager2.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('corrupted file is handled on next load', async () => {
      // Write valid settings first
      const manager1 = new SettingsManager({ settingsDir: tempDir });
      await manager1.initialize();
      await manager1.save({ concurrency: 7 });

      // Corrupt the file
      fs.writeFileSync(path.join(tempDir, 'settings.json'), '{{CORRUPT}}', 'utf-8');

      // Load with new instance - should fall back to defaults
      const manager2 = new SettingsManager({ settingsDir: tempDir });
      await manager2.initialize();
      expect(manager2.get()).toEqual(DEFAULT_SETTINGS);
    });
  });

  // ─── Integration tests ─────────────────────────────────────────────────

  describe('Integration', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    it('full lifecycle: init -> modify -> persist -> reload', async () => {
      // Create and initialize
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();
      expect(manager.get()).toEqual(DEFAULT_SETTINGS);

      // Modify settings progressively
      await manager.save({ concurrency: 2 });
      await manager.save({ fetchLyrics: false });
      await manager.save({ outputFolder: '/my/output' });

      const final = manager.get();
      expect(final.concurrency).toBe(2);
      expect(final.fetchLyrics).toBe(false);
      expect(final.outputFolder).toBe('/my/output');
      expect(final.namingTemplate).toBe(DEFAULT_SETTINGS.namingTemplate);
      expect(final.overwriteExistingTags).toBe(DEFAULT_SETTINGS.overwriteExistingTags);

      // Reload in new instance
      const manager2 = new SettingsManager({ settingsDir: tempDir });
      await manager2.initialize();
      expect(manager2.get()).toEqual(final);
    });

    it('listener tracks all changes through lifecycle', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const changes: AppSettings[] = [];
      manager.onChange((settings) => changes.push(settings));

      await manager.save({ concurrency: 3 });
      await manager.save({ fetchLyrics: false });
      await manager.reset();

      expect(changes).toHaveLength(3);
      expect(changes[0].concurrency).toBe(3);
      expect(changes[1].fetchLyrics).toBe(false);
      expect(changes[2]).toEqual(DEFAULT_SETTINGS);
    });

    it('validates all fields in a single save call', async () => {
      const manager = new SettingsManager({ settingsDir: tempDir });
      await manager.initialize();

      const result = await manager.save({
        outputFolder: '  /trimmed  ',
        namingTemplate: 'bad template',
        concurrency: -5,
        fetchLyrics: false,
        overwriteExistingTags: true,
      });

      expect(result.outputFolder).toBe('/trimmed');
      expect(result.namingTemplate).toBe(DEFAULT_SETTINGS.namingTemplate); // Invalid, kept default
      expect(result.concurrency).toBe(1); // Clamped
      expect(result.fetchLyrics).toBe(false);
      expect(result.overwriteExistingTags).toBe(true);
    });

    it('custom fileName works end-to-end', async () => {
      const manager = new SettingsManager({
        settingsDir: tempDir,
        fileName: 'my-config.json',
      });
      await manager.initialize();
      await manager.save({ concurrency: 4 });

      // Verify file was created with custom name
      expect(fs.existsSync(path.join(tempDir, 'my-config.json'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'settings.json'))).toBe(false);

      // Reload with same filename
      const manager2 = new SettingsManager({
        settingsDir: tempDir,
        fileName: 'my-config.json',
      });
      await manager2.initialize();
      expect(manager2.get().concurrency).toBe(4);
    });
  });
});
