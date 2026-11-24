// Messages between the extension host and the webviews. Plain data only (structured clone).
import type { Region } from '../engine/structure.ts';

export type { Region };

/** Extension host -> hex editor webview. */
export type ToHex =
  | {
      type: 'init';
      fileName: string;
      /** Whole file. Transferred, not copied. */
      data: Uint8Array;
      bytesPerRow: number;
    }
  /** The file content changed on disk; replaces the data. */
  | { type: 'data'; data: Uint8Array }
  /**
   * A new parse finished (or the spec was cleared). Drop cached regions and request them again.
   * `version` increases with each parse; replies to older `requestRegions` must be ignored.
   */
  | { type: 'parsed'; version: number; hasSpec: boolean; error?: string }
  | { type: 'regions'; requestId: number; version: number; start: number; end: number; regions: Region[] }
  /** Select (and optionally scroll to) a byte range. `end` is exclusive. */
  | { type: 'select'; start: number; end: number; reveal: boolean }
  /** Outline a range without changing the selection, e.g. while hovering in the tree. */
  | { type: 'highlight'; start?: number; end?: number }
  | { type: 'config'; bytesPerRow: number };

/** Hex editor webview -> extension host. */
export type FromHex =
  | { type: 'ready' }
  /** User changed the selection. `end` is exclusive; start === end is a caret. */
  | { type: 'select'; start: number; end: number }
  /** Regions overlapping [start, end) are needed, usually the visible rows plus some margin. */
  | { type: 'requestRegions'; requestId: number; start: number; end: number }
  /** User asked for the field at the offset to be revealed in the tree (e.g. double-click). */
  | { type: 'revealInTree'; offset: number }
  /** Context-menu style actions from the webview. */
  | { type: 'command'; command: 'goToOffset' | 'loadSpec' | 'exportJson' };

/** Extension host -> value inspector webview. */
export type ToInspector =
  | {
      type: 'bytes';
      /** Offset of bytes[0] in the document. */
      offset: number;
      /** Up to 16 bytes starting at the caret. */
      bytes: Uint8Array;
      /** Selection length, for a "N bytes selected" line. */
      selectionLength: number;
      /** Endianness from the active spec's meta/endian, if any. */
      endian?: 'le' | 'be';
    }
  | { type: 'empty' };

/** Value inspector webview -> extension host. */
export type FromInspector = { type: 'ready' } | { type: 'setEndian'; endian: 'le' | 'be' };
