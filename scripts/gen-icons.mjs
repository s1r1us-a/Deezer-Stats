// Generiert Branding-PNGs (Icons + OG-Cover) ohne externe Abhängigkeiten.
// Reiner Node + zlib PNG-Encoder. Aufruf: node scripts/gen-icons.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });

// ── PNG-Encoder ────────────────────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // Filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── Zeichnen ───────────────────────────────────────────────
const lerp = (a, b, t) => a + (b - a) * t;
const PINK = [236, 72, 153], PURPLE = [139, 92, 246], DEEP = [11, 8, 32];

function render(w, h, { glyphScale = 0.5 } = {}) {
  const px = Buffer.alloc(w * h * 4);
  const cx = w / 2, cy = h / 2;
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    const ia = a / 255, na = 1 - ia;
    px[i] = px[i] * na + r * ia; px[i + 1] = px[i + 1] * na + g * ia;
    px[i + 2] = px[i + 2] * na + b * ia; px[i + 3] = Math.max(px[i + 3], a);
  };
  // Diagonaler Verlauf Pink → Purple, mit dunklen Ecken für Tiefe
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = (x / w + y / h) / 2;
    let r = lerp(PINK[0], PURPLE[0], t), g = lerp(PINK[1], PURPLE[1], t), b = lerp(PINK[2], PURPLE[2], t);
    const d = Math.hypot((x - cx) / w, (y - cy) / h) * 1.6; // Vignette
    const vg = Math.min(d, 1);
    r = lerp(r, DEEP[0], vg * 0.55); g = lerp(g, DEEP[1], vg * 0.55); b = lerp(b, DEEP[2], vg * 0.55);
    const i = (y * w + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
  // Weiße Viertelnote (Kopf + Hals + Fähnchen), mittig
  const S = Math.min(w, h) * glyphScale;
  const ox = cx - S * 0.12, oy = cy + S * 0.32;
  const headR = S * 0.22, headRx = headR * 1.25;
  const stemX = ox + headRx * 0.78, stemTop = oy - S * 0.95, stemW = S * 0.075;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // Notenkopf (leicht geneigte Ellipse)
    const dx = x - ox, dy = y - oy, ang = -0.35;
    const rx = dx * Math.cos(ang) - dy * Math.sin(ang);
    const ry = dx * Math.sin(ang) + dy * Math.cos(ang);
    if ((rx * rx) / (headRx * headRx) + (ry * ry) / (headR * headR) <= 1) set(x, y, 255, 255, 255, 255);
    // Hals
    if (x >= stemX && x <= stemX + stemW && y <= oy - headR * 0.2 && y >= stemTop) set(x, y, 255, 255, 255, 255);
    // Fähnchen
    const fx = x - (stemX + stemW), fy = y - stemTop;
    if (fx >= 0 && fy >= 0 && fy < S * 0.42 && fx < S * 0.34 - fy * 0.45 && fx > (S * 0.05)) set(x, y, 255, 255, 255, 255);
  }
  return px;
}

function write(name, w, h, opts) {
  const png = encodePNG(w, h, render(w, h, opts));
  fs.writeFileSync(path.join(OUT, name), png);
  console.log('✓', name, `${w}×${h}`, `${(png.length / 1024).toFixed(1)} KB`);
}

write('icon-192.png', 192, 192, { glyphScale: 0.55 });
write('icon-512.png', 512, 512, { glyphScale: 0.55 });
write('apple-touch-icon.png', 180, 180, { glyphScale: 0.55 });
write('og-cover.png', 1200, 630, { glyphScale: 0.42 });
