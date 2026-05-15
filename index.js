const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const QRCode = require('qrcode');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
const sharp = require('sharp');
const { Worker } = require('worker_threads');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// ─── CPU Core Count ─────────────────────────────────────────────────────
// Use all available cores minus 1 (reserve one for main thread I/O)
const NUM_CPUS = Math.max(1, os.cpus().length - 1);
console.log(`Server configured to use ${NUM_CPUS} worker thread(s) out of ${os.cpus().length} CPUs.`);

// Optimization: Set sharp concurrency low since workers handle parallelism
sharp.concurrency(1);
sharp.simd(true);

// Health check
app.get('/', (req, res) => {
    res.send('QR Code Generator API is running (Worker Pool Mode)...');
});

// Middleware
app.use(cors());
app.use(express.json());

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// MongoDB Connection (Optional)
if (process.env.MONGODB_URI && process.env.MONGODB_URI.startsWith('mongodb')) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('MongoDB Connected'))
        .catch(err => console.log('MongoDB Connection Error:', err));
}

const UploadLogSchema = new mongoose.Schema({
    filename: String,
    recordCount: Number,
    timestamp: { type: Date, default: Date.now },
    status: String
});
const UploadLog = mongoose.model('UploadLog', UploadLogSchema);

// Multer Setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'file') {
            if (file.mimetype.includes('excel') || file.mimetype.includes('spreadsheetml')) {
                cb(null, true);
            } else {
                cb(new Error('Only Excel files are allowed for the data sheet!'), false);
            }
        } else if (file.fieldname === 'logo') {
            if (file.mimetype.startsWith('image/')) {
                cb(null, true);
            } else {
                cb(new Error('Only image files are allowed for the logo!'), false);
            }
        } else {
            cb(null, true);
        }
    }
});

const uploadFields = upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'logo', maxCount: 1 }
]);

// ─── Helper: split array into N roughly equal chunks ─────────────────────
function splitIntoChunks(arr, n) {
    const chunks = [];
    const size = Math.ceil(arr.length / n);
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

// ─── Worker Pool Runner ───────────────────────────────────────────────────
/**
 * Distributes `records` across NUM_CPUS workers.
 * Each result (Buffer) is passed to `onResult(serial, buf)` as it arrives.
 * Returns a promise that resolves when all workers are done.
 */
function runWorkerPool(records, workerData, onResult) {
    return new Promise((resolve, reject) => {
        const chunks = splitIntoChunks(records, NUM_CPUS);
        let doneCount = 0;
        let hasError = false;

        for (const chunk of chunks) {
            if (chunk.length === 0) {
                doneCount++;
                if (doneCount === chunks.length) resolve();
                continue;
            }

            const worker = new Worker(path.join(__dirname, 'worker.js'), {
                workerData: { ...workerData, records: chunk }
            });

            worker.on('message', (msg) => {
                if (msg.type === 'result') {
                    // Reconstruct Buffer from transferred ArrayBuffer
                    onResult(msg.serial, Buffer.from(msg.buf));
                } else if (msg.type === 'done') {
                    doneCount++;
                    if (doneCount === chunks.length && !hasError) resolve();
                } else if (msg.type === 'error') {
                    console.error(`Worker error on serial ${msg.serial}:`, msg.error);
                    // Non-fatal: just skip this record
                }
            });

            worker.on('error', (err) => {
                hasError = true;
                reject(err);
            });

            worker.on('exit', (code) => {
                if (code !== 0 && !hasError) {
                    // Worker crashed – count as done so we don't hang
                    doneCount++;
                    if (doneCount === chunks.length) resolve();
                }
            });
        }
    });
}

// ─── Main Generation Route ────────────────────────────────────────────────
app.post('/api/generate', uploadFields, async (req, res) => {
    let filePath = null;
    let logoPath = null;
    const startOverall = Date.now();

    try {
        if (!req.files || !req.files['file']) {
            return res.status(400).json({ error: 'No data file uploaded' });
        }

        filePath = req.files['file'][0].path;
        logoPath = req.files['logo'] ? req.files['logo'][0].path : null;

        console.log(`[${new Date().toISOString()}] Starting generation: ${req.files['file'][0].originalname}`);

        // ─── Parse Excel ─────────────────────────────────────────────────
        const workbook = xlsx.readFile(filePath, { cellFormula: false, cellHTML: false, cellText: false });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        const {
            width = 300,
            margin = 2,
            marginX,
            marginY,
            errorCorrectionLevel = 'M',
            colIndex = 0,
            format = 'jpeg',
            colorDark = '#000000',
            colorLight = '#ffffff',
            moduleStyle = 'square',
            eyeStyle = 'square',
            logoSize = 20,
            showText = 'false',
            textFontSize = null,
            textX = 0,
            textSpace = 0
        } = req.body;

        const targetCol = parseInt(colIndex);
        const shouldShowText = showText === 'true' || showText === true;
        const qrWidth = parseInt(width);
        const marginInt = parseInt(margin);
        const marginXInt = marginX !== undefined ? parseInt(marginX) : marginInt;
        const marginYInt = marginY !== undefined ? parseInt(marginY) : marginInt;
        const fontSize = textFontSize ? parseInt(textFontSize) : Math.floor(Math.max(40, Math.floor(qrWidth * 0.15)) * 0.4);
        const textHeight = Math.max(Math.floor(qrWidth * 0.15), Math.floor(fontSize * 2.5));

        let actualColorLight = colorLight;
        if (colorLight === 'transparent') {
            actualColorLight = format === 'png' ? 'transparent' : '#ffffff';
        }

        // ─── Extract Records ──────────────────────────────────────────────
        const range = xlsx.utils.decode_range(sheet['!ref'] || 'A1');
        const validRecords = [];
        const errors = [];
        const seen = new Set();

        for (let r = range.s.r; r <= range.e.r; r++) {
            const cellAddr = xlsx.utils.encode_cell({ r, c: targetCol });
            const cell = sheet[cellAddr];
            const serial = cell ? cell.v : null;

            if (serial === undefined || serial === null || String(serial).trim() === '') {
                if (cell === undefined) continue;
                errors.push({ row: r + 1, error: 'Empty value' });
                continue;
            }

            const serialStr = String(serial).trim();
            if (seen.has(serialStr)) {
                errors.push({ row: r + 1, error: 'Duplicate serial', value: serialStr });
                continue;
            }
            seen.add(serialStr);
            validRecords.push(serialStr);
        }

        console.log(`[${new Date().toISOString()}] Extracted ${validRecords.length} records in ${Date.now() - startOverall}ms`);

        if (validRecords.length === 0) {
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return res.status(400).json({ error: 'No valid records found in the selected column.' });
        }

        // Log to DB if available
        if (process.env.MONGODB_URI) {
            new UploadLog({
                filename: req.files['file'][0].originalname,
                recordCount: validRecords.length,
                status: 'Success'
            }).save().catch(err => console.error(err));
        }

        // ─── Set Response Headers ─────────────────────────────────────────
        res.set('Access-Control-Expose-Headers', 'X-Total-Count, X-Success-Count, X-Skipped-Count, Content-Disposition');
        res.set('X-Total-Count', String(range.e.r - range.s.r + 1));
        res.set('X-Success-Count', String(validRecords.length));
        res.set('X-Skipped-Count', String(errors.length));
        res.attachment(`qrcodes_${Date.now()}.zip`);

        // ─── Setup ZIP Stream ─────────────────────────────────────────────
        // zlib level 0 = STORE (no compression). QR PNGs/JPEGs are already compressed.
        const archive = archiver('zip', { zlib: { level: 0 } });
        archive.on('error', (err) => { if (!res.headersSent) res.status(500).send({ error: err.message }); });
        archive.on('end', () => {
            console.log(`[${new Date().toISOString()}] ZIP complete. Total time: ${Date.now() - startOverall}ms`);
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (logoPath && fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
        });
        res.on('close', () => {
            if (filePath && fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch {}
            if (logoPath && fs.existsSync(logoPath)) try { fs.unlinkSync(logoPath); } catch {}
        });

        archive.pipe(res);

        // ─── Report File ──────────────────────────────────────────────────
        let reportContent = `Generation Report\n=================\nTotal Records: ${validRecords.length}\nSkipped/Errors: ${errors.length}\nWorkers Used: ${NUM_CPUS}\n\n`;
        if (errors.length > 0) {
            reportContent += `Error Details:\n`;
            errors.slice(0, 100).forEach(err => reportContent += `Row ${err.row}: ${err.error} (Value: "${err.value || ''}")\n`);
            if (errors.length > 100) reportContent += `...and ${errors.length - 100} more errors.\n`;
        }
        archive.append(reportContent, { name: 'report.txt' });

        // ─── Pre-process Logo ─────────────────────────────────────────────
        let logoDataUri = null;
        if (logoPath) {
            const lSize = Math.floor(qrWidth * (parseInt(logoSize) / 100));
            const logoResizedBuf = await sharp(logoPath)
                .resize(lSize, lSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toBuffer();
            logoDataUri = `data:image/png;base64,${logoResizedBuf.toString('base64')}`;
        }

        // ─── Shared worker config (serializable) ──────────────────────────
        const sharedWorkerData = {
            width: qrWidth,
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
        };

        const ext = format === 'png' ? 'png' : 'jpg';

        // ─── Run Worker Pool ──────────────────────────────────────────────
        const genStart = Date.now();
        let completed = 0;

        await runWorkerPool(validRecords, sharedWorkerData, (serial, buf) => {
            const safeName = String(serial).replace(/[\/\\?%*:|"<>]/g, '-').trim();
            archive.append(buf, { name: `${safeName || 'qrcode'}.${ext}` });
            completed++;
            if (completed % 5000 === 0) {
                console.log(`[${new Date().toISOString()}] Progress: ${completed}/${validRecords.length} (${Math.round(completed / validRecords.length * 100)}%) — ${Math.round(completed / ((Date.now() - genStart) / 1000))}/s`);
            }
        });

        const genTime = Date.now() - genStart;
        const rate = Math.round(validRecords.length / (genTime / 1000));
        console.log(`[${new Date().toISOString()}] Generation done: ${validRecords.length} QRs in ${genTime}ms (${rate} QR/s)`);

        archive.finalize();

    } catch (error) {
        console.error('Generation Error:', error);
        if (filePath && fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch {}
        if (!res.headersSent) res.status(500).json({ error: 'Server error processing file.' });
    }
});

// ─── Analysis Route ───────────────────────────────────────────────────────
app.post('/api/analyze', uploadFields, (req, res) => {
    let filePath = null;
    const startTime = Date.now();
    try {
        if (!req.files || !req.files['file']) return res.status(400).json({ error: 'No data file uploaded' });
        filePath = req.files['file'][0].path;

        const workbook = xlsx.readFile(filePath, { cellFormula: false, cellHTML: false, cellText: false });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const range = xlsx.utils.decode_range(sheet['!ref'] || 'A1');

        const totalRows = range.e.r - range.s.r + 1;
        const preview = [];
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
        fs.unlinkSync(filePath);

        console.log(`Analysis complete for ${totalRows} rows in ${Date.now() - startTime}ms`);
        res.json({ totalRows, preview, headers, analysisTime: Date.now() - startTime });

    } catch (err) {
        console.error('Analysis error:', err);
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.status(500).json({ error: 'Failed to parse Excel file' });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT} with ${NUM_CPUS} worker threads`));
