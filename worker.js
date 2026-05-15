/**
 * worker.js — High-Performance QR Worker Thread
 *
 * Optimisation strategy:
 *  1. FAST PATH  (square, no logo, no text) → raw PNG via custom bitmap encoder.
 *     Uses QRCode.create() (fast matrix) then builds PNG bytes manually
 *     with Node's built-in zlib — zero Sharp overhead.
 *  2. CUSTOM PATH (rounded/dots/logo/text) → SVG string → Sharp.
 */

'use strict';

const { workerData, parentPort } = require('worker_threads');
const QRCode = require('qrcode');
const sharp = require('sharp');
const zlib = require('zlib');

sharp.concurrency(1);

const {
    records,
    width,
    marginXInt,
    marginYInt,
    errorCorrectionLevel,
    format,
    colorDark,
    actualColorLight,
    moduleStyle,
    eyeStyle,
    logoDataUri,
    logoSize,
    shouldShowText,
    fontSize,
    textHeight,
    textX,
    textSpace,
} = workerData;

const qrWidth = parseInt(width);

// ─── Colour helpers ───────────────────────────────────────────────────────
function hexToRgba(hex) {
    hex = String(hex).replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length === 8) {
        const v = parseInt(hex, 16);
        return { r: (v >>> 24) & 0xff, g: (v >>> 16) & 0xff, b: (v >>> 8) & 0xff, a: v & 0xff };
    }
    const v = parseInt(hex, 16);
    return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff, a: 255 };
}

// ─── CRC32 for PNG chunks ─────────────────────────────────────────────────
const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function uint32be(v) {
    return Buffer.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function pngChunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const combined = Buffer.concat([typeBytes, data]);
    return Buffer.concat([uint32be(data.length), typeBytes, data, uint32be(crc32(combined))]);
}

/**
 * Builds a minimal PNG directly from a QR modules object.
 * qrModules = qrData.modules  (has .size, .data, .get(r,c))
 */
function buildRawPng(qrModules, darkRgba, lightRgba) {
    const size = qrModules.size;
    const totalCols = size + 2 * marginXInt;
    const totalRows = size + 2 * marginYInt;
    const scale = Math.max(1, Math.floor(qrWidth / totalCols));
    const imgW = totalCols * scale;
    const imgH = totalRows * scale;

    const hasAlpha = darkRgba.a < 255 || lightRgba.a < 255;
    const channels = hasAlpha ? 4 : 3;
    const colorType = hasAlpha ? 6 : 2; // 6=RGBA, 2=RGB

    // Raw scanlines: 1 filter byte + row data
    const raw = Buffer.allocUnsafe(imgH * (1 + imgW * channels));
    let pos = 0;

    for (let py = 0; py < imgH; py++) {
        raw[pos++] = 0; // filter: None
        const qrRow = Math.floor(py / scale) - marginYInt;

        for (let px = 0; px < imgW; px++) {
            const qrCol = Math.floor(px / scale) - marginXInt;
            const dark = (qrRow >= 0 && qrRow < size && qrCol >= 0 && qrCol < size)
                ? qrModules.get(qrRow, qrCol)
                : false;

            if (dark) {
                raw[pos++] = darkRgba.r; raw[pos++] = darkRgba.g; raw[pos++] = darkRgba.b;
                if (hasAlpha) raw[pos++] = darkRgba.a;
            } else {
                raw[pos++] = lightRgba.r; raw[pos++] = lightRgba.g; raw[pos++] = lightRgba.b;
                if (hasAlpha) raw[pos++] = lightRgba.a;
            }
        }
    }

    const compressed = zlib.deflateSync(raw, { level: 1 }); // level 1 = fastest

    const ihdr = Buffer.allocUnsafe(13);
    ihdr.writeUInt32BE(imgW, 0);
    ihdr.writeUInt32BE(imgH, 4);
    ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', compressed),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ─── Custom SVG path (rounded / dots / logo / text) ──────────────────────
function isFinderZone(r, c, size) {
    return (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);
}

async function processCustom(serial, qrModules) {
    const size = qrModules.size;
    const totalQRSizeX = size + 2 * marginXInt;
    const totalQRSizeY = size + 2 * marginYInt;
    const shapes = [];

    // Finder pattern eyes
    const eyes = [{ r: 0, c: 0 }, { r: 0, c: size - 7 }, { r: size - 7, c: 0 }];
    for (const eye of eyes) {
        if (eyeStyle === 'rounded') {
            shapes.push(`<rect x="${eye.c + marginXInt + 0.5}" y="${eye.r + marginYInt + 0.5}" width="6" height="6" rx="1.5" fill="none" stroke="${colorDark}" stroke-width="1"/>`);
            shapes.push(`<rect x="${eye.c + marginXInt + 2}" y="${eye.r + marginYInt + 2}" width="3" height="3" rx="0.5" fill="${colorDark}"/>`);
        } else {
            shapes.push(`<rect x="${eye.c + marginXInt + 0.5}" y="${eye.r + marginYInt + 0.5}" width="6" height="6" fill="none" stroke="${colorDark}" stroke-width="1"/>`);
            shapes.push(`<rect x="${eye.c + marginXInt + 2}" y="${eye.r + marginYInt + 2}" width="3" height="3" fill="${colorDark}"/>`);
        }
    }

    // Data modules
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (isFinderZone(r, c, size)) continue;
            if (qrModules.get(r, c)) {
                if (moduleStyle === 'dots') {
                    shapes.push(`<circle cx="${c + marginXInt + 0.5}" cy="${r + marginYInt + 0.5}" r="0.4" fill="${colorDark}"/>`);
                } else if (moduleStyle === 'rounded') {
                    shapes.push(`<rect x="${c + marginXInt + 0.1}" y="${r + marginYInt + 0.1}" width="0.8" height="0.8" rx="0.2" fill="${colorDark}"/>`);
                } else {
                    shapes.push(`<rect x="${c + marginXInt}" y="${r + marginYInt}" width="1" height="1" fill="${colorDark}"/>`);
                }
            }
        }
    }

    const unitRatio = totalQRSizeX / qrWidth;
    const textSpaceInt = parseInt(textSpace) || 0;
    const textSpaceUnits = textSpaceInt * unitRatio;
    const textHeightUnits = (textHeight * unitRatio) + textSpaceUnits;
    const totalHeightUnits = shouldShowText ? totalQRSizeY + textHeightUnits : totalQRSizeY;

    let extras = [];
    if (logoDataUri) {
        const lSizeUnits = (parseInt(logoSize) / 100) * size;
        const lPosX = marginXInt + (size - lSizeUnits) / 2;
        const lPosY = marginYInt + (size - lSizeUnits) / 2;
        const safeLogoBg = actualColorLight === 'transparent' ? '#ffffff' : actualColorLight;
        extras.push(`<rect x="${lPosX - 0.2}" y="${lPosY - 0.2}" width="${lSizeUnits + 0.4}" height="${lSizeUnits + 0.4}" fill="${safeLogoBg}"/>`);
        extras.push(`<image x="${lPosX}" y="${lPosY}" width="${lSizeUnits}" height="${lSizeUnits}" href="${logoDataUri}"/>`);
    }

    if (shouldShowText) {
        const escaped = String(serial).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const textYUnits = totalQRSizeY + textSpaceUnits + ((textHeightUnits - Math.max(0, textSpaceUnits)) / 2);
        const fontSizeUnits = fontSize * unitRatio;
        const textXPos = (totalQRSizeX / 2) + ((parseFloat(textX) || 0) * unitRatio);
        extras.push(`<text x="${textXPos}" y="${textYUnits}" font-family="Arial,Helvetica,sans-serif" font-size="${fontSizeUnits}" fill="${colorDark}" text-anchor="middle" dominant-baseline="middle" font-weight="bold">${escaped}</text>`);
    }

    const qrBaseHeight = Math.round(totalQRSizeY / unitRatio);
    const qrOutputHeight = shouldShowText ? qrBaseHeight + textHeight + textSpaceInt : qrBaseHeight;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalQRSizeX} ${totalHeightUnits}" width="${qrWidth}" height="${qrOutputHeight}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${actualColorLight}"/>${shapes.join('')}${extras.join('')}</svg>`;

    return await sharp(Buffer.from(svg))
        .toFormat(format === 'png' ? 'png' : 'jpeg', format === 'png' ? {} : { quality: 90 })
        .toBuffer();
}

// ─── Detect fast vs custom path ───────────────────────────────────────────
const isSimplePath = (moduleStyle === 'square' && eyeStyle === 'square' && !logoDataUri && !shouldShowText);

// Pre-parse colours once per worker
const darkRgba = hexToRgba(colorDark);
const lightHex = (actualColorLight === 'transparent') ? '#ffffff00' : actualColorLight;
const lightRgba = hexToRgba(lightHex);

// ─── Per-record processor ─────────────────────────────────────────────────
async function processRecord(serial) {
    const qrData = QRCode.create(serial, { errorCorrectionLevel });
    const qrModules = qrData.modules; // { size, data, reservedBit, get(r,c) }

    if (isSimplePath) {
        if (format === 'png') {
            // ⚡ Ultra-fast: custom raw PNG encoder, no Sharp at all
            return buildRawPng(qrModules, darkRgba, lightRgba);
        } else {
            // JPEG: build PNG first, then Sharp converts to JPEG
            const pngBuf = buildRawPng(qrModules, darkRgba, { ...lightRgba, a: 255 });
            return await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
        }
    }

    // Custom styles / logo / text
    return await processCustom(serial, qrModules);
}

// ─── Batch runner ─────────────────────────────────────────────────────────
const INTERNAL_CONCURRENCY = isSimplePath ? 64 : 12;

(async () => {
    for (let i = 0; i < records.length; i += INTERNAL_CONCURRENCY) {
        const batch = records.slice(i, i + INTERNAL_CONCURRENCY);
        const results = await Promise.all(
            batch.map(async (serial) => {
                try {
                    const buf = await processRecord(serial);
                    return { serial, buf, ok: true };
                } catch (err) {
                    return { serial, ok: false, error: err.message };
                }
            })
        );

        for (const r of results) {
            if (r.ok) {
                // Zero-copy transfer of buffer back to main thread
                const ab = r.buf.buffer.slice(r.buf.byteOffset, r.buf.byteOffset + r.buf.byteLength);
                parentPort.postMessage({ type: 'result', serial: r.serial, buf: ab }, [ab]);
            } else {
                parentPort.postMessage({ type: 'error', serial: r.serial, error: r.error });
            }
        }
    }
    parentPort.postMessage({ type: 'done' });
})();
