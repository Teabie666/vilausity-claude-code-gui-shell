/**
 * The app icon in other colors: the window icon (taskbar, Alt+Tab) of a window whose logo is
 * not the app's orange, and the desktop shortcut made for an API provider. The icon's
 * polygons (platform/logoMark.ts, generated with resources/icon) are drawn at each size
 * icon.ico holds and written as an .ico under the data folder, one file per color. Files
 * rather than images: Electron gives Windows the size it asks for only from an .ico file
 * (from a NativeImage it hands over one bitmap for Windows to scale), and a shortcut can only
 * point at a file.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { ensureContrast, formatColor, parseColor, type Rgba } from '../../platform/accent';
import type { ILogger } from '../../platform/log';
import { ICON_CANVAS, ICON_POLYGONS, ICON_SIZES, LOGO_COLOR } from '../../platform/logoMark';

/** Rows sampled per pixel; across a row the coverage is exact. */
const SUBSAMPLES = 16;

/** Windows 11's taskbar, dark and light: what the taskbar and Alt+Tab show icons on. */
const SYSTEM_DARK: Rgba = { r: 32, g: 32, b: 32, a: 1 };
const SYSTEM_LIGHT: Rgba = { r: 243, g: 243, b: 243, a: 1 };

/**
 * The color to draw a logo in on the taskbar and the desktop: as visible there as the
 * title bar's (3:1). The app's own orange stays as it is, the app icon itself.
 */
export function systemIconColor(logo: string, darkSystem: boolean): string {
  const color = parseColor(logo);
  if (!color || logo.toLowerCase() === LOGO_COLOR) {
    return LOGO_COLOR;
  }
  return formatColor(ensureContrast(color, darkSystem ? SYSTEM_DARK : SYSTEM_LIGHT, 3));
}

/**
 * How much of each pixel the polygons cover, 0 to 1 (polygons that overlap add up), on a
 * `size` × `size` grid. Polygons are x1, y1, x2, y2, ... in units of `canvas` per side.
 */
export function rasterize(polygons: readonly (readonly number[])[], canvas: number, size: number): Float32Array {
  const coverage = new Float32Array(size * size);
  const scale = size / canvas;
  const crossings: number[] = [];
  for (const polygon of polygons) {
    const points = polygon.map((value) => value * scale);
    const count = points.length / 2;
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = 1; i < points.length; i += 2) {
      top = Math.min(top, points[i]!);
      bottom = Math.max(bottom, points[i]!);
    }
    const lastRow = Math.min(size, Math.ceil(bottom)) - 1;
    for (let row = Math.max(0, Math.floor(top)); row <= lastRow; row++) {
      for (let sample = 0; sample < SUBSAMPLES; sample++) {
        const y = row + (sample + 0.5) / SUBSAMPLES;
        crossings.length = 0;
        for (let i = 0; i < count; i++) {
          const j = (i + 1) % count;
          const x0 = points[2 * i]!;
          const y0 = points[2 * i + 1]!;
          const x1 = points[2 * j]!;
          const y1 = points[2 * j + 1]!;
          // Half-open, so that a vertex on the line counts once and flat edges not at all.
          if (y0 <= y !== y1 <= y) {
            crossings.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
          }
        }
        crossings.sort((a, b) => a - b);
        for (let k = 0; k + 1 < crossings.length; k += 2) {
          addSpan(coverage, row * size, size, crossings[k]!, crossings[k + 1]!, 1 / SUBSAMPLES);
        }
      }
    }
  }
  return coverage;
}

/** Adds `weight` times the part of each pixel of a row that [left, right) covers. */
function addSpan(coverage: Float32Array, offset: number, size: number, from: number, to: number, weight: number): void {
  const left = Math.max(0, from);
  const right = Math.min(size, to);
  if (right <= left) {
    return;
  }
  const first = Math.floor(left);
  const last = Math.floor(right);
  if (first === last) {
    coverage[offset + first]! += (right - left) * weight;
    return;
  }
  coverage[offset + first]! += (first + 1 - left) * weight;
  for (let x = first + 1; x < last; x++) {
    coverage[offset + x]! += weight;
  }
  if (last < size) {
    coverage[offset + last]! += (right - last) * weight;
  }
}

/** The icon at one size: RGBA, not premultiplied; every pixel has the color, the coverage is its alpha. */
export function drawIcon(color: Rgba, size: number): Uint8Array {
  const coverage = rasterize(ICON_POLYGONS, ICON_CANVAS, size);
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < coverage.length; i++) {
    pixels[4 * i] = Math.round(color.r);
    pixels[4 * i + 1] = Math.round(color.g);
    pixels[4 * i + 2] = Math.round(color.b);
    pixels[4 * i + 3] = Math.round(Math.min(1, coverage[i]!) * 255);
  }
  return pixels;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG of 8-bit RGBA pixels (`drawIcon`'s). */
export function encodePng(pixels: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // Each row starts with its filter type: 0, none.
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An .ico with one PNG image per size (Windows Vista and later read PNG entries), as scripts/icons.mjs writes. */
export function encodeIco(images: readonly { readonly size: number; readonly png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i;
    // 0 stands for 256.
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

/** The icon in `color` (`#rrggbb`) at every size icon.ico has. */
export function logoIco(color: string): Buffer {
  const rgba = parseColor(color);
  if (!rgba) {
    throw new Error(`not a color: ${color}`);
  }
  return encodeIco(ICON_SIZES.map((size) => ({ size, png: encodePng(drawIcon(rgba, size), size, size) })));
}

/** Changes with the icon's geometry: a file drawn before it changed is not reused. */
const GEOMETRY = crypto.createHash('sha256').update(JSON.stringify(ICON_POLYGONS)).digest('hex').slice(0, 8);

/** The .ico files of the logo in other colors, in one folder shared by every window and instance. */
export class LogoIcons {
  private readonly files = new Map<string, string>();

  constructor(
    private readonly dir: string,
    private readonly logger: ILogger,
  ) {}

  /** The .ico of the logo in `color` (`#rrggbb`), drawn the first time; undefined if it cannot be written. */
  file(color: string): string | undefined {
    const rgba = parseColor(color);
    if (!rgba) {
      return undefined;
    }
    const hex = formatColor({ ...rgba, a: 1 }).slice(1);
    const known = this.files.get(hex);
    if (known) {
      return known;
    }
    const file = path.join(this.dir, `logo-${hex}-${GEOMETRY}.ico`);
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(this.dir, { recursive: true });
        // Renamed into place: the other instance may be reading it.
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, logoIco(`#${hex}`));
        fs.renameSync(temp, file);
      }
    } catch (error) {
      this.logger.warn(`cannot write the icon ${file}`, error);
      return undefined;
    }
    this.files.set(hex, file);
    return file;
  }
}
