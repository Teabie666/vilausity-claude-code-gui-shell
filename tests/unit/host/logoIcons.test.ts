import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { contrast, parseColor, type Rgba } from '../../../src/platform/accent';
import { NullLogger } from '../../../src/platform/log';
import { ICON_CANVAS, ICON_POLYGONS, ICON_SIZES, LOGO_COLOR } from '../../../src/platform/logoMark';
import {
  drawIcon,
  encodeIco,
  encodePng,
  logoIco,
  LogoIcons,
  rasterize,
  systemIconColor,
} from '../../../src/host/main/logoIcons';

const ORANGE: Rgba = parseColor(LOGO_COLOR)!;

/** Shoelace area of polygons given as x1, y1, x2, y2, ... */
function area(polygons: readonly (readonly number[])[]): number {
  let total = 0;
  for (const points of polygons) {
    let sum = 0;
    const count = points.length / 2;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      sum += points[2 * i]! * points[2 * j + 1]! - points[2 * j]! * points[2 * i + 1]!;
    }
    total += Math.abs(sum) / 2;
  }
  return total;
}

describe('drawing the logo', () => {
  test('a pixel-aligned square covers its pixels exactly, a half-pixel edge half', () => {
    const square = rasterize([[1, 1, 2, 1, 2, 2, 1, 2]], 4, 4);
    assert.deepEqual([...square], [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const shifted = rasterize([[0.5, 0, 1.5, 0, 1.5, 1, 0.5, 1]], 4, 4);
    assert.deepEqual([...shifted.slice(0, 4)], [0.5, 0.5, 0, 0]);
    // Drawn at twice the size, the same square covers four pixels.
    assert.equal(rasterize([[1, 1, 2, 1, 2, 2, 1, 2]], 4, 8).reduce((sum, value) => sum + value, 0), 4);
  });

  test('the icon covers as much as its polygons, at every size', () => {
    for (const size of [16, 32, 256]) {
      const pixels = drawIcon(ORANGE, size);
      let alpha = 0;
      for (let i = 3; i < pixels.length; i += 4) {
        alpha += pixels[i]! / 255;
      }
      const expected = area(ICON_POLYGONS) * (size / ICON_CANVAS) ** 2;
      assert.ok(Math.abs(alpha - expected) / expected < 0.01, `${size}: ${alpha} vs ${expected}`);
    }
  });

  test('inside the "v" is the color, opaque; the corners are clear', () => {
    const pixels = drawIcon(ORANGE, 256);
    const at = (x: number, y: number): number[] => [...pixels.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
    assert.deepEqual(at(85, 100), [ORANGE.r, ORANGE.g, ORANGE.b, 255]);
    assert.equal(at(0, 0)[3], 0);
    assert.equal(at(255, 255)[3], 0);
  });
});

describe('icon files', () => {
  test('a PNG: signature, header, chunks with their CRCs, the pixels after the filter bytes', () => {
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const png = encodePng(pixels, 2, 2);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks: { type: string; data: Buffer }[] = [];
    for (let offset = 8; offset < png.length; ) {
      const length = png.readUInt32BE(offset);
      const type = png.toString('latin1', offset + 4, offset + 8);
      const data = png.subarray(offset + 8, offset + 8 + length);
      assert.equal(png.readUInt32BE(offset + 8 + length), zlib.crc32(png.subarray(offset + 4, offset + 8 + length)), type);
      chunks.push({ type, data });
      offset += 12 + length;
    }
    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      ['IHDR', 'IDAT', 'IEND'],
    );
    const header = chunks[0]!.data;
    assert.equal(header.readUInt32BE(0), 2);
    assert.equal(header.readUInt32BE(4), 2);
    assert.deepEqual([...header.subarray(8)], [8, 6, 0, 0, 0]);
    assert.deepEqual([...zlib.inflateSync(chunks[1]!.data)], [0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  test('an .ico: one PNG entry per size, 256 written as 0, offsets to each image', () => {
    const images = [
      { size: 16, png: Buffer.from('first') },
      { size: 256, png: Buffer.from('second!') },
    ];
    const ico = encodeIco(images);
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    const entry = (i: number) => ({
      width: ico.readUInt8(6 + 16 * i),
      bits: ico.readUInt16LE(6 + 16 * i + 6),
      length: ico.readUInt32LE(6 + 16 * i + 8),
      offset: ico.readUInt32LE(6 + 16 * i + 12),
    });
    assert.deepEqual(entry(0), { width: 16, bits: 32, length: 5, offset: 38 });
    assert.deepEqual(entry(1), { width: 0, bits: 32, length: 7, offset: 43 });
    assert.equal(ico.toString('latin1', 43), 'second!');
  });

  test("the logo's .ico holds every size icon.ico has", () => {
    const ico = logoIco('#4d6bfe');
    assert.equal(ico.readUInt16LE(4), ICON_SIZES.length);
    ICON_SIZES.forEach((size, i) => assert.equal(ico.readUInt8(6 + 16 * i), size >= 256 ? 0 : size));
    assert.throws(() => logoIco('blue'));
  });

  test('on the taskbar a color is as visible as on the title bar; the app orange stays', () => {
    const darkTaskbar = parseColor('#202020')!;
    assert.equal(systemIconColor(LOGO_COLOR, true), LOGO_COLOR);
    assert.equal(systemIconColor(LOGO_COLOR, false), LOGO_COLOR);
    assert.equal(systemIconColor('#4d6bfe', true), '#4d6bfe');
    const glm = parseColor(systemIconColor('#2b2b2b', true))!;
    assert.ok(contrast(glm, darkTaskbar) >= 3);
    // Near-black on a light taskbar is fine as it is.
    assert.equal(systemIconColor('#2b2b2b', false), '#2b2b2b');
  });

  test('each color is drawn into its own file once, and kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vilaus-icons-'));
    try {
      const icons = new LogoIcons(path.join(dir, 'icons'), NullLogger);
      const blue = icons.file('#4D6BFE');
      assert.ok(blue && path.basename(blue).startsWith('logo-4d6bfe-') && blue.endsWith('.ico'), blue);
      assert.deepEqual(fs.readFileSync(blue), logoIco('#4d6bfe'));
      assert.equal(icons.file('#4d6bfe'), blue);
      // Another instance finds the file there and uses it as it is.
      fs.writeFileSync(blue, 'drawn before');
      assert.equal(new LogoIcons(path.join(dir, 'icons'), NullLogger).file('#4d6bfe'), blue);
      assert.equal(fs.readFileSync(blue, 'utf8'), 'drawn before');
      assert.notEqual(icons.file('#8ab4f8'), blue);
      assert.equal(icons.file('nonsense'), undefined);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'icons')).filter((name) => name.endsWith('.tmp')), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
