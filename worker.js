/**
 * worker.js — High-Performance QR Worker Thread
 *
 * Optimisation strategy:
 *  1. FAST PATH  (square, no logo, no text) → raw PNG via `qrcode` SVG→manual bitmap.
 *     We use QRCode.create() (fast matrix generation) then build PNG bytes manually
 *     using pako deflate — avoids ALL Sharp overhead.
 *  2. CUSTOM PATH (rounded/dots/logo/text) → SVG string → Sharp (one Sharp call per QR).
 *
 * Workers run entirely off the main thread, true multi-core parallelism.
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

// ─── Colour parsing helpers ───────────────────────────────────────────────
function hexToRgba(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const v = parseInt(hex, 16);
    if (hex.length === 8) {
        return { r: (v >> 24) & 0xff, g: (v >> 16) & 0xff, b: (v >> 8) & 0xff, a: v & 0xff };
    }
    return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff, a: 255 };
}

// ─── CRC32 table for PNG ──────────────────────────────────────────────────
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
    const len = uint32be(data.length);
    const combined = Buffer.concat([typeBytes, data]);
    const crc = uint32be(crc32(combined));
    return Buffer.concat([len, typeBytes, data, crc]);
}

/**
 * Builds a minimal RGBA PNG directly from a QR matrix.
 * No Sharp, no Canvas, no dependencies beyond zlib (built-in Node).
 * Extremely fast for square QR codes.
 */
function buildRawPng(qrData, qrWidth, marginX, marginY, darkRgba, lightRgba) {
    const { modules, size } = qrData.modules;
    const totalCols = size + 2 * marginX;
    const totalRows = size + 2 * marginY;
    const scale = Math.floor(qrWidth / totalCols);
    const imgW = totalCols * scale;
    const imgH = totalRows * scale;

    const darkR = darkRgba.r, darkG = darkRgba.g, darkB = darkRgba.b, darkA = darkRgba.a;
    const lightR = lightRgba.r, lightG = lightRgba.g, lightB = lightRgba.b, lightA = lightRgba.a;
    const hasAlpha = darkA < 255 || lightA < 255;
    const channels = hasAlpha ? 4 : 3;
    const colorType = hasAlpha ? 6 : 2; // 6 = RGBA, 2 = RGB

    // Build raw image scanlines (filter byte 0 = None per row)
    const rawSize = imgH * (1 + imgW * channels);
    const raw = Buffer.allocUnsafe(rawSize);
    let pos = 0;

    for (let py = 0; py < imgH; py++) {
        raw[pos++] = 0; // PNG filter type: None
        const qrRow = Math.floor(py / scale) - marginY;

        for (let px = 0; px < imgW; px++) {
            const qrCol = Math.floor(px / scale) - marginX;

            let dark = false;
            if (qrRow >= 0 && qrRow < size && qrCol >= 0 && qrCol < size) {
                dark = modules.get(qrRow, qrCol);
            }

            if (dark) {
                raw[pos++] = darkR; raw[pos++] = darkG; raw[pos++] = darkB;
                if (hasAlpha) raw[pos++] = darkA;
            } else {
                raw[pos++] = lightR; raw[pos++] = lightG; raw[pos++] = lightB;
                if (hasAlpha) raw[pos++] = lightA;
            }
        }
    }

    // Deflate the raw scanlines (zlib sync – fast with small input)
    const compressed = zlib.deflateSync(raw, { level: 1 }); // level 1 = fastest

    // Assemble PNG
    const ihdr = Buffer.allocUnsafe(13);
    ihdr.writeUInt32BE(imgW, 0);
    ihdr.writeUInt32BE(imgH, 4);
    ihdr[8] = 8;        // bit depth
    ihdr[9] = colorType;
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', compressed),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ─── SVG-based path (custom styles / logo / text) ────────────────────────
function isFinder(r, c, size) {
    return (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);
}

async function processCustom(serial, qrData) {
    const { modules, size } = qrData.modules;
    const qrWidth = parseInt(width);
    const totalQRSizeX = size + 2 * marginXInt;
    const totalQRSizeY = size + 2 * marginYInt;
    const shapes = [];

    // Eyes
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

    // Modules
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (isFinder(r, c, size)) continue;
            if (modules.get(r, c)) {
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

// ─── Main record processor ────────────────────────────────────────────────
const isSimplePath = (moduleStyle === 'square' && eyeStyle === 'square' && !logoDataUri && !shouldShowText);
const qrWidth = parseInt(width);

// Pre-parse colours once
const darkRgba  = hexToRgba(colorDark);
const lightHex  = (actualColorLight === 'transparent') ? '#ffffff00' : actualColorLight;
const lightRgba = hexToRgba(lightHex);

async function processRecord(serial) {
    const qrData = QRCode.create(serial, { errorCorrectionLevel });

    if (isSimplePath) {
        if (format === 'png') {
            // ⚡ ULTRA FAST: custom raw PNG, no Sharp at all
            return buildRawPng(qrData, qrWidth, marginXInt, marginYInt, darkRgba, lightRgba);
        } else {
            // JPEG still needs Sharp (PNG→JPEG conversion)
            const pngBuf = buildRawPng(qrData, qrWidth, marginXInt, marginYInt, darkRgba, { ...lightRgba, a: 255 });
            return await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
        }
    }

    // Custom: rounded/dots/logo/text
    return await processCustom(serial, qrData);
}

// ─── Batch runner ─────────────────────────────────────────────────────────
const INTERNAL_CONCURRENCY = isSimplePath ? 64 : 12; // Higher concurrency for fast path

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
                const ab = r.buf.buffer.slice(r.buf.byteOffset, r.buf.byteOffset + r.buf.byteLength);
                parentPort.postMessage({ type: 'result', serial: r.serial, buf: ab }, [ab]);
            } else {
                parentPort.postMessage({ type: 'error', serial: r.serial, error: r.error });
            }
        }
    }
    parentPort.postMessage({ type: 'done' });
})();
