'use strict';

// Must be set BEFORE any require() — controls libuv's async thread pool size
// This is what sharp and other native addons use for parallel I/O
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const xlsx       = require('xlsx');
const archiver   = require('archiver');
const fs         = require('fs');
const path       = require('path');
const mongoose   = require('mongoose');
const QRCode     = require('qrcode');
const sharp      = require('sharp');
require('dotenv').config();

// ─── Sharp global settings ────────────────────────────────────────────────────
// concurrency(4): let sharp use 4 libuv threads concurrently per operation
// cache(false):   never cache pixel data — saves significant RAM on Render
sharp.concurrency(4);
sharp.cache(false);

// ─── Async concurrency pool ───────────────────────────────────────────────────
// Runs up to `concurrency` async tasks at once from `items`.
// Each task result is handled by `fn` immediately and GC'd — no accumulation.
async function withConcurrency(items, concurrency, fn) {
    const queue = items.slice(); // shallow copy so we can shift safely
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (item !== undefined) await fn(item);
        }
    });
    await Promise.all(workers);
}

// ─── Memory usage logger ─────────────────────────────────────────────────────
function logMemory(label) {
    const m = process.memoryUsage();
    console.log(
        `[MEM] ${label} | RSS: ${(m.rss / 1024 / 1024).toFixed(1)} MB` +
        ` | Heap: ${(m.heapUsed / 1024 / 1024).toFixed(1)}/${(m.heapTotal / 1024 / 1024).toFixed(1)} MB`
    );
}

// ─── Config helpers ───────────────────────────────────────────────────────────
function hexToRgba(hex) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    if (c.length === 6) c += 'ff';
    return {
        r: parseInt(c.slice(0, 2), 16),
        g: parseInt(c.slice(2, 4), 16),
        b: parseInt(c.slice(4, 6), 16),
        a: parseInt(c.slice(6, 8), 16),
    };
}

/**
 * Generate a single QR code image buffer.
 * All logic runs in-process — no worker threads — keeping memory predictable.
 * Each buffer is generated, appended to the ZIP, then GC'd immediately.
 */
async function generateQRBuffer(serial, cfg, logoDataUri) {
    const {
        width = 300, margin = 2, marginX, marginY,
        errorCorrectionLevel = 'M', format = 'jpeg',
        colorDark = '#000000', colorLight = '#ffffff',
        moduleStyle = 'square', eyeStyle = 'square',
        logoSize = 20, showText = 'false', textFontSize = null,
        textX = 0, textSpace = 0,
    } = cfg;

    const qrWidth       = parseInt(width);
    const marginInt     = parseInt(margin);
    const marginXInt    = marginX !== undefined ? parseInt(marginX) : marginInt;
    const marginYInt    = marginY !== undefined ? parseInt(marginY) : marginInt;
    const shouldShowText = showText === 'true' || showText === true;
    const fontSize      = textFontSize
        ? parseInt(textFontSize)
        : Math.floor(Math.max(40, Math.floor(qrWidth * 0.15)) * 0.4);
    const textHeight    = Math.max(Math.floor(qrWidth * 0.15), Math.floor(fontSize * 2.5));

    let actualColorLight = colorLight;
    if (colorLight === 'transparent') {
        actualColorLight = format === 'png' ? 'transparent' : '#ffffff';
    }

    const qrData  = QRCode.create(String(serial), { errorCorrectionLevel });
    const modules = qrData.modules;        // BitMatrix — has .get(r,c) and .size
    const size    = modules.size;
    const totalQRSizeX = size + 2 * marginXInt;
    const totalQRSizeY = size + 2 * marginYInt;

    // ── Fast pixel path: square modules, no logo, no text ────────────────────
    if (
        moduleStyle === 'square' && eyeStyle === 'square' &&
        !logoDataUri && !shouldShowText && marginXInt === marginYInt
    ) {
        const buf   = Buffer.alloc(totalQRSizeX * totalQRSizeY * 4, 0);
        const cDark = hexToRgba(colorDark);
        const cLight = actualColorLight === 'transparent'
            ? { r: 0, g: 0, b: 0, a: 0 }
            : hexToRgba(actualColorLight);

        for (let r = 0; r < totalQRSizeY; r++) {
            for (let c = 0; c < totalQRSizeX; c++) {
                const offset  = (r * totalQRSizeX + c) * 4;
                let isDark    = false;
                if (r >= marginYInt && r < size + marginYInt && c >= marginXInt && c < size + marginXInt) {
                    isDark = modules.get(r - marginYInt, c - marginXInt);
                }
                const color = isDark ? cDark : cLight;
                buf[offset]     = color.r;
                buf[offset + 1] = color.g;
                buf[offset + 2] = color.b;
                buf[offset + 3] = color.a;
            }
        }
        return sharp(buf, { raw: { width: totalQRSizeX, height: totalQRSizeY, channels: 4 } })
            .resize(qrWidth, qrWidth, { kernel: sharp.kernel.nearest })
            .toFormat(format === 'png' ? 'png' : 'jpeg', format === 'png' ? {} : { quality: 90 })
            .toBuffer();
    }

    // ── SVG path: rounded/dots/logo/text ─────────────────────────────────────
    const shapes   = [];
    const isFinder = (r, c) =>
        (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);

    const eyes = [{ r: 0, c: 0 }, { r: 0, c: size - 7 }, { r: size - 7, c: 0 }];
    for (const eye of eyes) {
        if (eyeStyle === 'rounded') {
            shapes.push(`<rect x="${eye.c + marginXInt + 0.5}" y="${eye.r + marginYInt + 0.5}" width="6" height="6" rx="1.5" fill="none" stroke="${colorDark}" stroke-width="1" />`);
            shapes.push(`<rect x="${eye.c + marginXInt + 2}" y="${eye.r + marginYInt + 2}" width="3" height="3" rx="0.5" fill="${colorDark}" />`);
        } else {
            shapes.push(`<rect x="${eye.c + marginXInt + 0.5}" y="${eye.r + marginYInt + 0.5}" width="6" height="6" fill="none" stroke="${colorDark}" stroke-width="1" />`);
            shapes.push(`<rect x="${eye.c + marginXInt + 2}" y="${eye.r + marginYInt + 2}" width="3" height="3" fill="${colorDark}" />`);
        }
    }

    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (isFinder(r, c)) continue;
            if (modules.get(r, c)) {
                if (moduleStyle === 'dots')
                    shapes.push(`<circle cx="${c + marginXInt + 0.5}" cy="${r + marginYInt + 0.5}" r="0.4" fill="${colorDark}" />`);
                else if (moduleStyle === 'rounded')
                    shapes.push(`<rect x="${c + marginXInt + 0.1}" y="${r + marginYInt + 0.1}" width="0.8" height="0.8" rx="0.2" fill="${colorDark}" />`);
                else
                    shapes.push(`<rect x="${c + marginXInt}" y="${r + marginYInt}" width="1" height="1" fill="${colorDark}" />`);
            }
        }
    }

    const unitRatio        = totalQRSizeX / qrWidth;
    const textSpaceInt     = parseInt(textSpace) || 0;
    const textSpaceUnits   = textSpaceInt * unitRatio;
    const textHeightUnits  = (textHeight * unitRatio) + textSpaceUnits;
    const totalHeightUnits = shouldShowText ? totalQRSizeY + textHeightUnits : totalQRSizeY;

    const extraElements = [];
    if (logoDataUri) {
        const lSizeUnits = (parseInt(logoSize) / 100) * size;
        const lPosX      = marginXInt + (size - lSizeUnits) / 2;
        const lPosY      = marginYInt + (size - lSizeUnits) / 2;
        const safeLogoBg = actualColorLight === 'transparent' ? '#ffffff' : actualColorLight;
        extraElements.push(`<rect x="${lPosX - 0.2}" y="${lPosY - 0.2}" width="${lSizeUnits + 0.4}" height="${lSizeUnits + 0.4}" fill="${safeLogoBg}" />`);
        extraElements.push(`<image x="${lPosX}" y="${lPosY}" width="${lSizeUnits}" height="${lSizeUnits}" href="${logoDataUri}" />`);
    }

    if (shouldShowText) {
        const escaped    = String(serial).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const textYUnits = totalQRSizeY + textSpaceUnits + ((textHeightUnits - Math.max(0, textSpaceUnits)) / 2);
        const fontSzUnits = fontSize * unitRatio;
        const textXPos   = (totalQRSizeX / 2) + ((parseFloat(textX) || 0) * unitRatio);
        extraElements.push(`<text x="${textXPos}" y="${textYUnits}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSzUnits}" fill="${colorDark}" text-anchor="middle" dominant-baseline="middle" font-weight="bold">${escaped}</text>`);
    }

    const qrBaseHeight   = Math.round(totalQRSizeY / unitRatio);
    const qrOutputHeight = shouldShowText ? qrBaseHeight + textHeight + textSpaceInt : qrBaseHeight;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalQRSizeX} ${totalHeightUnits}" width="${qrWidth}" height="${qrOutputHeight}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${actualColorLight}"/>${shapes.join('')}${extraElements.join('')}</svg>`;

    return sharp(Buffer.from(svg))
        .toFormat(format === 'png' ? 'png' : 'jpeg', format === 'png' ? {} : { quality: 90 })
        .toBuffer();
}

// ─── Cleanup helper ───────────────────────────────────────────────────────────
function safeDelete(...paths) {
    for (const p of paths) {
        try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 5000;

app.get('/', (req, res) => res.send('QR Code Generator API is running...'));
app.use(cors());
app.use(express.json());

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ─── MongoDB ──────────────────────────────────────────────────────────────────
if (process.env.MONGODB_URI && process.env.MONGODB_URI.startsWith('mongodb')) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('MongoDB Connected'))
        .catch(err => console.log('MongoDB Connection Error:', err));
}

const UploadLog = mongoose.model('UploadLog', new mongoose.Schema({
    filename:    String,
    recordCount: Number,
    timestamp:   { type: Date, default: Date.now },
    status:      String,
}));

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB upload cap
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'file') {
            if (file.mimetype.includes('excel') || file.mimetype.includes('spreadsheetml'))
                return cb(null, true);
            return cb(new Error('Only Excel files are allowed for the data sheet!'), false);
        }
        if (file.fieldname === 'logo') {
            if (file.mimetype.startsWith('image/')) return cb(null, true);
            return cb(new Error('Only image files are allowed for the logo!'), false);
        }
        cb(null, true);
    },
});
const uploadFields = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'logo', maxCount: 1 }]);

// ─── /api/generate ────────────────────────────────────────────────────────────
app.post('/api/generate', uploadFields, async (req, res) => {
    let filePath    = null;
    let logoPath    = null;
    let tempZipPath = null;
    const startOverall = Date.now();

    try {
        if (!req.files || !req.files['file'])
            return res.status(400).json({ error: 'No data file uploaded' });

        filePath = req.files['file'][0].path;
        logoPath = req.files['logo'] ? req.files['logo'][0].path : null;

        logMemory('START');
        console.log(`[GEN] File: ${req.files['file'][0].originalname}`);

        // ── Parse Excel ───────────────────────────────────────────────────────
        const workbook  = xlsx.readFile(filePath, { cellFormula: false, cellHTML: false, cellText: false });
        const sheet     = workbook.Sheets[workbook.SheetNames[0]];
        const targetCol = parseInt(req.body.colIndex || 0);
        const range     = xlsx.utils.decode_range(sheet['!ref'] || 'A1');

        const validRecords = [];
        const errors       = [];
        const seen         = new Set();

        for (let r = range.s.r; r <= range.e.r; r++) {
            const cell   = sheet[xlsx.utils.encode_cell({ r, c: targetCol })];
            const serial = cell ? cell.v : null;
            if (serial === undefined || serial === null || String(serial).trim() === '') {
                if (cell !== undefined) errors.push({ row: r + 1, error: 'Empty value' });
                continue;
            }
            const s = String(serial).trim();
            if (seen.has(s)) { errors.push({ row: r + 1, error: 'Duplicate serial', value: s }); continue; }
            seen.add(s);
            validRecords.push(s);
        }

        // Free the seen set immediately — can be large
        seen.clear();

        console.log(`[GEN] ${validRecords.length} valid / ${errors.length} skipped (parse: ${Date.now() - startOverall}ms)`);
        logMemory('AFTER_PARSE');

        // ── MongoDB log ───────────────────────────────────────────────────────
        if (process.env.MONGODB_URI) {
            new UploadLog({
                filename:    req.files['file'][0].originalname,
                recordCount: validRecords.length,
                status:      'Processing',
            }).save().catch(err => console.error('[DB]', err));
        }

        // ── Prepare logo once ─────────────────────────────────────────────────
        let logoDataUri = null;
        if (logoPath && validRecords.length > 0) {
            const qrWidth = parseInt(req.body.width || 300);
            const lSize   = Math.floor(qrWidth * (parseInt(req.body.logoSize || 20) / 100));
            const logoBuf = await sharp(logoPath)
                .resize(lSize, lSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toBuffer();
            logoDataUri = `data:image/png;base64,${logoBuf.toString('base64')}`;
            // logoBuf goes out of scope here → GC'd
        }

        // ── Create temp ZIP on disk ───────────────────────────────────────────
        tempZipPath    = path.join(uploadDir, `zip_${Date.now()}_${Math.random().toString(36).slice(2)}.zip`);
        const output   = fs.createWriteStream(tempZipPath);
        const archive  = archiver('zip', { zlib: { level: 1 } }); // level 1 = fast, low CPU

        const zipDone = new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
            archive.on('error', reject);
        });

        archive.pipe(output);

        // ── Append report.txt ─────────────────────────────────────────────────
        let report = `Generation Report\n=================\n` +
            `Total Records: ${validRecords.length}\n` +
            `Skipped/Errors: ${errors.length}\n` +
            `Date: ${new Date().toISOString()}\n\n`;
        if (validRecords.length === 0)
            report += 'NOTICE: No valid QR records found in the selected column.\n\n';
        if (errors.length > 0) {
            report += 'Error Details:\n';
            errors.slice(0, 100).forEach(e =>
                report += `Row ${e.row}: ${e.error}${e.value ? ` (Value: "${e.value}")` : ''}\n`);
            if (errors.length > 100) report += `...and ${errors.length - 100} more errors.\n`;
        }
        archive.append(report, { name: 'report.txt' });

        // ── Generate QRs concurrently and stream each directly into ZIP ──────
        // withConcurrency runs 8 async pipelines simultaneously via libuv threads.
        // Each buffer is appended to archiver and freed immediately — no RAM pile-up.
        // On Render free tier this gives ~6-8x speedup vs sequential with flat memory.
        const CONCURRENCY = parseInt(process.env.QR_CONCURRENCY || '8');
        const format       = req.body.format || 'jpeg';
        const ext          = format === 'png' ? 'png' : 'jpg';
        const cfg          = req.body;
        const nameCount    = new Map();
        let successCount   = 0;
        let errorCount     = 0;
        const LOG_INTERVAL = 500;
        let processed      = 0;

        await withConcurrency(validRecords, CONCURRENCY, async (serial) => {
            try {
                const imgBuf = await generateQRBuffer(serial, cfg, logoDataUri);

                // Deduplicate filenames (Map access is sync, safe across coroutines)
                let safeName = String(serial).replace(/[<>:"/\\|?*\x00-\x1F\r\n\t]/g, '-').trim();
                safeName     = safeName.replace(/\.+$/, '') || 'qrcode';
                let finalName = safeName;
                if (nameCount.has(safeName)) {
                    const cnt = nameCount.get(safeName) + 1;
                    nameCount.set(safeName, cnt);
                    finalName = `${safeName}_${cnt}`;
                } else {
                    nameCount.set(safeName, 1);
                }

                archive.append(imgBuf, { name: `${finalName}.${ext}` });
                // imgBuf drops out of scope → GC-eligible immediately
                successCount++;
            } catch (err) {
                console.error(`[GEN] Error on "${serial}": ${err.message}`);
                errorCount++;
            }

            processed++;
            if (processed % LOG_INTERVAL === 0) {
                logMemory(`${processed}/${validRecords.length}`);
            }
        });

        console.log(`[GEN] Done — OK: ${successCount}, Errors: ${errorCount} (${Date.now() - startOverall}ms)`);
        logMemory('AFTER_GENERATION');

        // ── Finalize ZIP and wait for disk write ──────────────────────────────
        archive.finalize();
        await zipDone;

        const zipSize = fs.statSync(tempZipPath).size;
        console.log(`[GEN] ZIP ready — ${(zipSize / 1024 / 1024).toFixed(2)} MB (${Date.now() - startOverall}ms total)`);
        logMemory('ZIP_DONE');

        // ── Stream completed ZIP to client ────────────────────────────────────
        res.set('Access-Control-Expose-Headers', 'X-Total-Count, X-Success-Count, X-Skipped-Count, Content-Disposition');
        res.set('X-Total-Count',   String(range.e.r - range.s.r + 1));
        res.set('X-Success-Count', String(successCount));
        res.set('X-Skipped-Count', String(errors.length + errorCount));
        res.set('Content-Type',        'application/zip');
        res.set('Content-Disposition', `attachment; filename="qrcodes_${Date.now()}.zip"`);
        res.set('Content-Length',      String(zipSize));

        const readStream = fs.createReadStream(tempZipPath);
        readStream.pipe(res);

        readStream.on('close', () => {
            safeDelete(tempZipPath, filePath, logoPath);
            console.log('[GEN] Cleanup done.');
            logMemory('CLEANUP');
        });
        readStream.on('error', (err) => {
            console.error('[GEN] Read stream error:', err.message);
            safeDelete(tempZipPath, filePath, logoPath);
            if (!res.headersSent) res.status(500).json({ error: 'Failed to stream ZIP.' });
        });

    } catch (error) {
        console.error('[GEN] Fatal error:', error.message, error.stack);
        safeDelete(tempZipPath, filePath, logoPath);
        if (!res.headersSent) res.status(500).json({ error: 'Server error processing file.' });
    }
});

// ─── /api/analyze ─────────────────────────────────────────────────────────────
app.post('/api/analyze', uploadFields, (req, res) => {
    let filePath = null;
    const t0     = Date.now();
    try {
        if (!req.files || !req.files['file'])
            return res.status(400).json({ error: 'No data file uploaded' });

        filePath = req.files['file'][0].path;
        const workbook  = xlsx.readFile(filePath, { cellFormula: false, cellHTML: false, cellText: false });
        const sheet     = workbook.Sheets[workbook.SheetNames[0]];
        const range     = xlsx.utils.decode_range(sheet['!ref'] || 'A1');
        const totalRows = range.e.r - range.s.r + 1;

        const preview    = [];
        const maxPreview = Math.min(range.s.r + 5, range.e.r + 1);
        for (let r = range.s.r; r < maxPreview; r++) {
            const row = [];
            for (let c = range.s.c; c <= range.e.c; c++) {
                const cell = sheet[xlsx.utils.encode_cell({ r, c })];
                row.push(cell ? cell.v : '');
            }
            preview.push(row);
        }

        const headers = preview.length > 0 ? preview[0] : [];
        safeDelete(filePath);

        console.log(`[ANALYZE] ${totalRows} rows in ${Date.now() - t0}ms`);
        res.json({ totalRows, preview, headers, analysisTime: Date.now() - t0 });

    } catch (err) {
        console.error('[ANALYZE] Error:', err.message);
        safeDelete(filePath);
        res.status(500).json({ error: 'Failed to parse Excel file' });
    }
});

// ─── Periodic stale file cleanup (safety net for crashed requests) ─────────────
setInterval(() => {
    try {
        const files = fs.readdirSync(uploadDir);
        const now   = Date.now();
        for (const f of files) {
            const fp   = path.join(uploadDir, f);
            const stat = fs.statSync(fp);
            // Delete any file older than 30 minutes
            if (now - stat.mtimeMs > 30 * 60 * 1000) {
                fs.unlinkSync(fp);
                console.log(`[CLEANUP] Removed stale file: ${f}`);
            }
        }
    } catch (_) {}
}, 10 * 60 * 1000); // Run every 10 minutes

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[SERVER] Running on port ${PORT}`);
    logMemory('STARTUP');
});
