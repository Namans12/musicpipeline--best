/**
 * Tag Writer Service
 *
 * Writes corrected metadata to audio file ID3 tags (MP3) or equivalent
 * tag formats (FLAC Vorbis comments, M4A MP4 tags) and renames files
 * to "Artist - Song Name.ext" format.
 *
 * Key design decisions:
 * - Uses `node-id3` for MP3 ID3v2.4 tag writing (update mode preserves existing tags)
 * - Uses `music-metadata` for reading back written tags (verification)
 * - Sanitizes filenames using fileScanner utility
 * - Handles filename collisions with (1), (2), etc. suffixes
 * - Does NOT re-encode audio (metadata-only modification)
 * - Atomic-style operations: writes tags first, then renames
 */

import * as fs from 'fs';
import * as path from 'path';
import NodeID3 from 'node-id3';
import type { AudioFormat } from '../../shared/types';
import { sanitizeFilename, getUniqueFilePath } from '../utils/fileScanner';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Metadata fields that can be written to an audio file */
export interface WriteTagsInput {
  /** Song title */
  title?: string;
  /** Primary artist name */
  artist?: string;
  /** Album name */
  album?: string;
  /** Release year */
  year?: number;
  /** Genre(s) */
  genre?: string[];
  /** Track number */
  trackNumber?: number;
  /** Disc number */
  discNumber?: number;
  /** Album artist */
  albumArtist?: string;
  /** Unsynchronized lyrics (plain text) */
  lyrics?: string;
  /** Album art image (JPEG or PNG bytes + MIME type) */
  albumArt?: { data: Buffer; mimeType: string };
}

/** Options for writing tags */
export interface WriteTagsOptions {
  /** If true, replaces all existing tags. If false (default), merges with existing. */
  overwriteAll?: boolean;
}

/** Result of a tag write operation */
export interface WriteTagsResult {
  /** Whether the write was successful */
  success: boolean;
  /** The file path (unchanged) */
  filePath: string;
  /** Error message if write failed */
  error: string | null;
}

/** Options for renaming a file */
export interface RenameOptions {
  /** Output directory. If null, same directory as original file. */
  outputDir?: string | null;
}

/** Result of a rename operation */
export interface RenameResult {
  /** Whether the rename was successful */
  success: boolean;
  /** Original file path */
  originalPath: string;
  /** New file path (null if rename failed) */
  newPath: string | null;
  /** Error message if rename failed */
  error: string | null;
}

/** Combined result of write + rename */
export interface WriteAndRenameResult {
  /** Whether the overall operation was successful */
  success: boolean;
  /** Original file path */
  originalPath: string;
  /** New file path after rename (null if not renamed) */
  newPath: string | null;
  /** Tag write result */
  tagWriteResult: WriteTagsResult;
  /** Rename result (null if rename was not attempted) */
  renameResult: RenameResult | null;
  /** Summary error message */
  error: string | null;
}

// ─── Format Detection ─────────────────────────────────────────────────────────

/**
 * Gets the audio format from a file extension.
 * @param filePath - Path to the audio file
 * @returns The audio format or null if unsupported
 */
export function getFormatFromPath(filePath: string): AudioFormat | null {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const supported: AudioFormat[] = ['mp3', 'flac', 'm4a', 'wav', 'ogg', 'wma'];
  return supported.includes(ext as AudioFormat) ? (ext as AudioFormat) : null;
}

// ─── ID3 Tag Building ─────────────────────────────────────────────────────────

/**
 * Builds a node-id3 compatible tag object from our WriteTagsInput.
 * @param input - The metadata fields to write
 * @returns A node-id3 Tags object ready for writing
 */
export function buildId3Tags(input: WriteTagsInput): NodeID3.Tags {
  const tags: NodeID3.Tags = {};

  if (input.title !== undefined) {
    tags.title = input.title;
  }

  if (input.artist !== undefined) {
    tags.artist = input.artist;
  }

  if (input.album !== undefined) {
    tags.album = input.album;
  }

  if (input.year !== undefined) {
    tags.year = String(input.year);
  }

  if (input.genre !== undefined) {
    tags.genre = input.genre.join('/');
  }

  if (input.trackNumber !== undefined) {
    tags.trackNumber = String(input.trackNumber);
  }

  if (input.albumArtist !== undefined) {
    tags.performerInfo = input.albumArtist;
  }

  if (input.lyrics !== undefined) {
    tags.unsynchronisedLyrics = {
      language: 'eng',
      text: input.lyrics,
    };
  }

  if (input.albumArt !== undefined) {
    tags.image = {
      mime: input.albumArt.mimeType,
      type: { id: 3, name: 'front cover' },
      description: 'Front Cover',
      imageBuffer: input.albumArt.data,
    };
  }

  return tags;
}

// ─── Read-only Helper ─────────────────────────────────────────────────────────

/**
 * If `filePath` is read-only, temporarily makes it writable and returns a
 * restore function.  If it is already writable, the restore function is a no-op.
 *
 * On Windows the read-only flag lives in the file's Win32 attribute bits, not
 * in POSIX permission mode bits.  `fs.chmodSync(path, 0o666)` clears it
 * because Node's Windows implementation maps the owner-write bit (0o200)
 * directly to the FILE_ATTRIBUTE_READONLY flag via SetFileAttributesW.
 *
 * @param filePath - Absolute path to the file
 * @returns A function that restores the original permissions
 */
function makeWritableTemporarily(filePath: string): () => void {
  // Read the current stat so we can restore the exact mode afterwards.
  let originalMode: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    // On Windows the write bits are what matter; on Linux/macOS preserve all.
    if (!(stat.mode & 0o200)) {
      // Owner-write bit is unset → file is read-only
      originalMode = stat.mode & 0o777;
      fs.chmodSync(filePath, originalMode | 0o200);
    }
  } catch {
    // If stat/chmod fails we still attempt the write; the real error
    // will surface from node-id3 with a clearer message.
  }

  return (): void => {
    if (originalMode !== null) {
      try {
        fs.chmodSync(filePath, originalMode);
      } catch {
        // Best-effort restore; ignore if it fails.
      }
    }
  };
}

// ─── Tag Writing ──────────────────────────────────────────────────────────────

/**
 * Writes ID3 tags to an MP3 file.
 *
 * By default uses update mode (preserves existing tags not being overwritten).
 * Set options.overwriteAll = true to replace all tags.
 *
 * If the file is marked read-only the function will temporarily clear that
 * attribute, write the tags, and then restore read-only status.
 *
 * @param filePath - Absolute path to the MP3 file
 * @param input - Metadata fields to write
 * @param options - Write options
 * @returns WriteTagsResult indicating success or failure
 */
export function writeMp3Tags(
  filePath: string,
  input: WriteTagsInput,
  options: WriteTagsOptions = {},
): WriteTagsResult {
  let restorePermissions: (() => void) | null = null;
  try {
    // Validate file exists
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        filePath,
        error: `File not found: ${filePath}`,
      };
    }

    // Validate format
    const format = getFormatFromPath(filePath);
    if (format !== 'mp3') {
      return {
        success: false,
        filePath,
        error: `writeMp3Tags only supports MP3 files, got: ${format ?? 'unknown'}`,
      };
    }

    // Temporarily clear read-only flag so node-id3 can open the file for writing
    restorePermissions = makeWritableTemporarily(filePath);

    const tags = buildId3Tags(input);

    let result: true | Error;
    if (options.overwriteAll) {
      result = NodeID3.write(tags, filePath);
    } else {
      result = NodeID3.update(tags, filePath);
    }

    restorePermissions();
    restorePermissions = null;

    if (result instanceof Error) {
      return {
        success: false,
        filePath,
        error: `Failed to write ID3 tags: ${result.message}`,
      };
    }

    return {
      success: true,
      filePath,
      error: null,
    };
  } catch (error: unknown) {
    restorePermissions?.();
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      filePath,
      error: `Unexpected error writing tags: ${message}`,
    };
  }
}

// ─── FLAC Tag Writing ─────────────────────────────────────────────────────────

// FLAC block type constants
const FLAC_MAGIC = 'fLaC';
const FLAC_BLOCK_TYPE_VORBIS_COMMENT = 4;
const FLAC_BLOCK_TYPE_PICTURE = 6;
const FLAC_BLOCK_TYPE_PADDING = 1;

interface FlacBlock {
  type: number;
  data: Buffer;
}

/** Parses FLAC metadata blocks; returns blocks and the byte offset where audio frames begin. */
function parseFlacBlocks(fileData: Buffer): { blocks: FlacBlock[]; audioOffset: number } {
  if (fileData.length < 4 || fileData.toString('ascii', 0, 4) !== FLAC_MAGIC) {
    throw new Error('Not a valid FLAC file (missing fLaC magic)');
  }
  const blocks: FlacBlock[] = [];
  let offset = 4;
  while (offset + 4 <= fileData.length) {
    const headerByte = fileData[offset];
    const isLast = (headerByte & 0x80) !== 0;
    const type = headerByte & 0x7f;
    const length =
      (fileData[offset + 1] << 16) | (fileData[offset + 2] << 8) | fileData[offset + 3];
    offset += 4;
    if (offset + length > fileData.length) throw new Error('Truncated FLAC metadata block');
    blocks.push({ type, data: Buffer.from(fileData.subarray(offset, offset + length)) });
    offset += length;
    if (isLast) break;
  }
  return { blocks, audioOffset: offset };
}

/** Parses a Vorbis Comment block into a key→values map (keys uppercased). */
function parseVorbisCommentBlock(data: Buffer): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let offset = 0;
  if (offset + 4 > data.length) return result;
  const vendorLen = data.readUInt32LE(offset);
  offset += 4 + vendorLen;
  if (offset + 4 > data.length) return result;
  const count = data.readUInt32LE(offset);
  offset += 4;
  for (let i = 0; i < count; i++) {
    if (offset + 4 > data.length) break;
    const len = data.readUInt32LE(offset);
    offset += 4;
    if (offset + len > data.length) break;
    const comment = data.subarray(offset, offset + len).toString('utf8');
    offset += len;
    const eqIdx = comment.indexOf('=');
    if (eqIdx < 0) continue;
    const key = comment.slice(0, eqIdx).toUpperCase();
    const value = comment.slice(eqIdx + 1);
    const existing = result.get(key) ?? [];
    existing.push(value);
    result.set(key, existing);
  }
  return result;
}

/** Serialises a key→values map into a Vorbis Comment block buffer. */
function buildVorbisCommentBlock(comments: Map<string, string[]>): Buffer {
  const VENDOR = Buffer.from('audio-pipeline', 'utf8');
  const vendorLen = Buffer.allocUnsafe(4);
  vendorLen.writeUInt32LE(VENDOR.length, 0);
  const entries: Buffer[] = [];
  let totalCount = 0;
  for (const [key, values] of comments) {
    for (const val of values) {
      const entry = Buffer.from(`${key}=${val}`, 'utf8');
      const lenBuf = Buffer.allocUnsafe(4);
      lenBuf.writeUInt32LE(entry.length, 0);
      entries.push(lenBuf, entry);
      totalCount++;
    }
  }
  const countBuf = Buffer.allocUnsafe(4);
  countBuf.writeUInt32LE(totalCount, 0);
  return Buffer.concat([vendorLen, VENDOR, countBuf, ...entries]);
}

/** Extracts pixel dimensions from a JPEG or PNG buffer (needed for FLAC PICTURE block). */
function getFlacImageDimensions(
  data: Buffer,
  mimeType: string,
): { width: number; height: number; depth: number } {
  try {
    if (mimeType === 'image/png' && data.length >= 26) {
      const channels = ([1, 0, 3, 1, 2, 0, 4] as const)[data[25]] ?? 3;
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), depth: data[24] * channels };
    } else {
      let i = 2;
      while (i < data.length - 11) {
        if (data[i] !== 0xff) { i++; continue; }
        const marker = data[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return {
            width: data.readUInt16BE(i + 7),
            height: data.readUInt16BE(i + 5),
            depth: 8 * data[i + 9],
          };
        }
        if (marker === 0xda) break;
        i += 2 + data.readUInt16BE(i + 2);
      }
    }
  } catch { /* fall through */ }
  return { width: 0, height: 0, depth: 0 };
}

/** Builds a FLAC METADATA_BLOCK_PICTURE buffer (type 6, front cover = type 3). */
function buildFlacPictureBlock(imageData: Buffer, mimeType: string): Buffer {
  const { width, height, depth } = getFlacImageDimensions(imageData, mimeType);
  const mimeBytes = Buffer.from(mimeType, 'ascii');
  // 4 (pic type) + 4 (mime len) + mimeBytes + 4 (desc len) + 0 (desc) + 4*4 (dims) + 4 (data len)
  const headerSize = 4 + 4 + mimeBytes.length + 4 + 4 + 4 + 4 + 4 + 4;
  const header = Buffer.allocUnsafe(headerSize);
  let pos = 0;
  header.writeUInt32BE(3, pos); pos += 4;                       // picture type: front cover
  header.writeUInt32BE(mimeBytes.length, pos); pos += 4;
  mimeBytes.copy(header, pos); pos += mimeBytes.length;
  header.writeUInt32BE(0, pos); pos += 4;                       // description length (empty)
  header.writeUInt32BE(width, pos); pos += 4;
  header.writeUInt32BE(height, pos); pos += 4;
  header.writeUInt32BE(depth, pos); pos += 4;
  header.writeUInt32BE(0, pos); pos += 4;                       // indexed colour count
  header.writeUInt32BE(imageData.length, pos);
  return Buffer.concat([header, imageData]);
}

/** Serialises a list of FLAC metadata blocks + audio data back into a complete file buffer. */
function serializeFlacBlocks(blocks: FlacBlock[], audioData: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from(FLAC_MAGIC, 'ascii')];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const isLast = i === blocks.length - 1;
    const header = Buffer.allocUnsafe(4);
    header[0] = (isLast ? 0x80 : 0x00) | (block.type & 0x7f);
    header[1] = (block.data.length >> 16) & 0xff;
    header[2] = (block.data.length >> 8) & 0xff;
    header[3] = block.data.length & 0xff;
    parts.push(header, block.data);
  }
  parts.push(audioData);
  return Buffer.concat(parts);
}

/**
 * Writes Vorbis Comment tags (and optionally front cover art) to a FLAC file.
 *
 * In update mode (default): existing Vorbis Comment keys not present in `input`
 * are preserved; keys in `input` replace all existing values for that key.
 * In overwrite mode: the Vorbis Comment block is rebuilt from scratch.
 *
 * Any existing PICTURE block (type 3, front cover) is replaced when
 * `input.albumArt` is provided. Handles read-only files the same way as MP3.
 */
export function writeFlacTags(
  filePath: string,
  input: WriteTagsInput,
  options: WriteTagsOptions = {},
): WriteTagsResult {
  let restorePermissions: (() => void) | null = null;
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, filePath, error: `File not found: ${filePath}` };
    }
    const format = getFormatFromPath(filePath);
    if (format !== 'flac') {
      return {
        success: false,
        filePath,
        error: `writeFlacTags only supports FLAC files, got: ${format ?? 'unknown'}`,
      };
    }

    restorePermissions = makeWritableTemporarily(filePath);

    const fileData = fs.readFileSync(filePath);
    const { blocks, audioOffset } = parseFlacBlocks(fileData);
    const audioData = fileData.subarray(audioOffset);

    // ── Vorbis Comment ────────────────────────────────────────────────────
    let existingComments = new Map<string, string[]>();
    const vcIndex = blocks.findIndex((b) => b.type === FLAC_BLOCK_TYPE_VORBIS_COMMENT);
    if (!options.overwriteAll && vcIndex >= 0) {
      existingComments = parseVorbisCommentBlock(blocks[vcIndex].data);
    }

    const newComments = new Map<string, string[]>(existingComments);
    const setTag = (key: string, value: string | undefined): void => {
      if (value !== undefined) newComments.set(key, [value]);
    };
    setTag('TITLE', input.title);
    setTag('ARTIST', input.artist);
    setTag('ALBUM', input.album);
    setTag('DATE', input.year !== undefined ? String(input.year) : undefined);
    setTag('ALBUMARTIST', input.albumArtist);
    setTag('TRACKNUMBER', input.trackNumber !== undefined ? String(input.trackNumber) : undefined);
    setTag('DISCNUMBER', input.discNumber !== undefined ? String(input.discNumber) : undefined);
    setTag('LYRICS', input.lyrics);
    if (input.genre !== undefined) newComments.set('GENRE', input.genre);

    const vcBlock: FlacBlock = {
      type: FLAC_BLOCK_TYPE_VORBIS_COMMENT,
      data: buildVorbisCommentBlock(newComments),
    };

    // ── Picture block ─────────────────────────────────────────────────────
    let pictureBlock: FlacBlock | null = null;
    if (input.albumArt) {
      pictureBlock = {
        type: FLAC_BLOCK_TYPE_PICTURE,
        data: buildFlacPictureBlock(input.albumArt.data, input.albumArt.mimeType),
      };
    }

    // ── Rebuild block list ────────────────────────────────────────────────
    // Keep all blocks except VC, PICTURE (front cover), and old PADDING
    const newBlocks: FlacBlock[] = [];
    for (const block of blocks) {
      if (block.type === FLAC_BLOCK_TYPE_VORBIS_COMMENT) continue;
      if (block.type === FLAC_BLOCK_TYPE_PICTURE) continue;
      if (block.type === FLAC_BLOCK_TYPE_PADDING) continue;
      newBlocks.push(block);
    }
    newBlocks.push(vcBlock);
    if (pictureBlock) newBlocks.push(pictureBlock);

    fs.writeFileSync(filePath, serializeFlacBlocks(newBlocks, audioData));

    restorePermissions();
    restorePermissions = null;
    return { success: true, filePath, error: null };
  } catch (error: unknown) {
    restorePermissions?.();
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, filePath, error: `Failed to write FLAC tags: ${message}` };
  }
}

/**
 * Writes tags to an audio file, dispatching to the appropriate writer based on format.
 *
 * Currently supports:
 * - MP3: Full ID3v2.4 tag writing via node-id3
 * - FLAC: Vorbis Comment + PICTURE block via native Buffer manipulation
 *
 * @param filePath - Absolute path to the audio file
 * @param input - Metadata fields to write
 * @param options - Write options
 * @returns WriteTagsResult indicating success or failure
 */
export function writeTags(
  filePath: string,
  input: WriteTagsInput,
  options: WriteTagsOptions = {},
): WriteTagsResult {
  const format = getFormatFromPath(filePath);

  if (format === null) {
    return {
      success: false,
      filePath,
      error: `Unsupported audio format: ${path.extname(filePath)}`,
    };
  }

  switch (format) {
    case 'mp3':
      return writeMp3Tags(filePath, input, options);
    case 'flac':
      return writeFlacTags(filePath, input, options);
    case 'm4a':
    case 'wav':
    case 'ogg':
    case 'wma':
      return {
        success: false,
        filePath,
        error: `Tag writing for ${format.toUpperCase()} is not yet implemented. Only MP3 and FLAC are currently supported.`,
      };
    default: {
      const _exhaustive: never = format;
      return {
        success: false,
        filePath,
        error: `Unknown format: ${String(_exhaustive)}`,
      };
    }
  }
}

// ─── File Renaming ────────────────────────────────────────────────────────────

/**
 * Converts a string to title case by capitalising the first ASCII letter of
 * every word.  A "word start" is defined as the beginning of the string or a
 * position immediately after whitespace or an opening bracket/parenthesis.
 *
 * Design decisions:
 * - Only the matched boundary letter is uppercased; the rest of the word is
 *   left untouched.  This preserves intentional all-caps like "ACDC" or camel-
 *   case like "BackInBlack" while still lifting lowercase starts.
 * - Accented/non-ASCII characters ("Ü", "é", etc.) are not matched by
 *   [a-zA-Z] and are left unchanged, so "Über" stays "Über" rather than
 *   becoming "ÜBer" (which a naïve \b approach would produce).
 *
 * Examples:
 *   "houdini (feat. eminem)"  → "Houdini (Feat. Eminem)"
 *   "extended edit"           → "Extended Edit"
 *   "ACDC"                    → "ACDC"  (already uppercase)
 *   "Ménage à Trois"          → "Ménage à Trois"  (unchanged)
 */
export function toTitleCase(str: string): string {
  // (start-of-string | whitespace | opening bracket) followed by an ASCII letter
  const titled = str.replace(/(^|[\s([])([a-zA-Z])/g, (_: string, sep: string, letter: string) => sep + letter.toUpperCase());
  // Keep "ft." lowercase (namespacing convention) — but leave "feat." capitalised
  return titled.replace(/\bFt\./g, 'ft.');
}

/**
 * Generates the new filename based on artist and title.
 * Format: "Artist - Title.ext"
 * Sanitizes artist and title to remove invalid characters, then applies title
 * case so every word starts with a capital letter (e.g. "feat." → "Feat.",
 * "extended edit" → "Extended Edit").
 * Falls back to "Unknown" if either part is empty after sanitization.
 *
 * @param artist - Artist name
 * @param title - Song title
 * @param extension - File extension (with dot, e.g. ".mp3")
 * @returns Sanitized, title-cased filename string
 */
export function generateFilename(artist: string, title: string, extension: string): string {
  const sanitizedArtist = sanitizeFilename(artist);
  const sanitizedTitle = sanitizeFilename(title);

  // Fall back to "Unknown" if sanitization results in empty string
  const finalArtist = sanitizedArtist.length === 0 ? 'Unknown' : toTitleCase(sanitizedArtist);
  const finalTitle = sanitizedTitle.length === 0 ? 'Unknown' : toTitleCase(sanitizedTitle);

  return `${finalArtist} - ${finalTitle}${extension}`;
}

/**
 * Renames an audio file to "Artist - Title.ext" format.
 *
 * Uses sanitizeFilename to remove invalid characters and getUniqueFilePath
 * to handle filename collisions.
 *
 * @param filePath - Absolute path to the current audio file
 * @param artist - Artist name for the new filename
 * @param title - Song title for the new filename
 * @param options - Rename options (output directory, etc.)
 * @returns RenameResult indicating success or failure
 */
export function renameAudioFile(
  filePath: string,
  artist: string,
  title: string,
  options: RenameOptions = {},
): RenameResult {
  try {
    // Validate file exists
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        originalPath: filePath,
        newPath: null,
        error: `File not found: ${filePath}`,
      };
    }

    // Validate inputs
    if (!artist || artist.trim().length === 0) {
      return {
        success: false,
        originalPath: filePath,
        newPath: null,
        error: 'Artist name is required for renaming',
      };
    }

    if (!title || title.trim().length === 0) {
      return {
        success: false,
        originalPath: filePath,
        newPath: null,
        error: 'Title is required for renaming',
      };
    }

    const extension = path.extname(filePath);
    const outputDir = options.outputDir ?? path.dirname(filePath);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const newFilename = generateFilename(artist.trim(), title.trim(), extension);
    const desiredPath = path.join(outputDir, newFilename);

    // If the desired path is the same as current path, no rename needed
    const resolvedCurrent = path.resolve(filePath);
    const resolvedDesired = path.resolve(desiredPath);
    if (resolvedCurrent === resolvedDesired) {
      return {
        success: true,
        originalPath: filePath,
        newPath: filePath,
        error: null,
      };
    }

    // Get a unique path (handles collisions)
    const uniquePath = getUniqueFilePath(desiredPath);

    // Perform the rename
    fs.renameSync(filePath, uniquePath);

    return {
      success: true,
      originalPath: filePath,
      newPath: uniquePath,
      error: null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      originalPath: filePath,
      newPath: null,
      error: `Failed to rename file: ${message}`,
    };
  }
}

// ─── Combined Write + Rename ──────────────────────────────────────────────────

/**
 * Writes tags to an audio file and then renames it to "Artist - Title.ext".
 *
 * Operations are performed in order:
 * 1. Write tags to the file at its current path
 * 2. If tags write succeeds, rename the file
 *
 * If tag writing fails, rename is NOT attempted.
 * If renaming fails, tags are still written (partial success).
 *
 * @param filePath - Absolute path to the audio file
 * @param input - Metadata to write
 * @param writeOptions - Tag writing options
 * @param renameOptions - File renaming options
 * @returns WriteAndRenameResult with details of both operations
 */
export function writeTagsAndRename(
  filePath: string,
  input: WriteTagsInput,
  writeOptions: WriteTagsOptions = {},
  renameOptions: RenameOptions = {},
): WriteAndRenameResult {
  // Step 1: Write tags
  const tagWriteResult = writeTags(filePath, input, writeOptions);

  if (!tagWriteResult.success) {
    return {
      success: false,
      originalPath: filePath,
      newPath: null,
      tagWriteResult,
      renameResult: null,
      error: `Tag writing failed: ${tagWriteResult.error}`,
    };
  }

  // Step 2: Rename file (use written metadata for filename)
  const artist = input.artist;
  const title = input.title;

  if (!artist || !title) {
    // Tags written successfully, but can't rename without artist/title
    return {
      success: true,
      originalPath: filePath,
      newPath: null,
      tagWriteResult,
      renameResult: null,
      error: null,
    };
  }

  const renameResult = renameAudioFile(filePath, artist, title, renameOptions);

  return {
    success: renameResult.success,
    originalPath: filePath,
    newPath: renameResult.newPath,
    tagWriteResult,
    renameResult,
    error: renameResult.success ? null : `Rename failed: ${renameResult.error}`,
  };
}

/**
 * Processes multiple files: writes tags and renames each one.
 *
 * Each file is processed independently - failures in one file don't
 * affect processing of other files.
 *
 * @param files - Array of objects with filePath and metadata to write
 * @param writeOptions - Tag writing options (applied to all files)
 * @param renameOptions - Rename options (applied to all files)
 * @returns Array of WriteAndRenameResult, one per file
 */
export function writeTagsAndRenameMultiple(
  files: Array<{ filePath: string; input: WriteTagsInput }>,
  writeOptions: WriteTagsOptions = {},
  renameOptions: RenameOptions = {},
): WriteAndRenameResult[] {
  const results: WriteAndRenameResult[] = [];

  for (const file of files) {
    const result = writeTagsAndRename(file.filePath, file.input, writeOptions, renameOptions);
    results.push(result);
  }

  return results;
}
