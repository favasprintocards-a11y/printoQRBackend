const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
require('dotenv').config();

if (!isMainThread) {
    // --- WORKER THREAD CODE ---
    const QRCode = require('qrcode');
    const sharp = require('sharp');
    sharp.concurrency(1); // Crucial for worker threads to prevent thread pool exhaustion
    sharp.simd(true);

    const { chunk, config, logoDataUri } = workerData;
    const {
        width = 300, margin = 2, marginX, marginY, errorCorrectionLevel = 'M', format = 'jpeg',
        colorDark = '#000000', colorLight = '#ffffff', moduleStyle = 'square', eyeStyle = 'square',
        logoSize = 20, showText = 'false', textFontSize = null, textX = 0, textSpace = 0
    } = config;

    const qrWidth = parseInt(width);
    const marginInt = parseInt(margin);
    const marginXInt = marginX !== undefined ? parseInt(marginX) : marginInt;
    const marginYInt = marginY !== undefined ? parseInt(marginY) : marginInt;
    const shouldShowText = showText === 'true' || showText === true;
    const fontSize = textFontSize ? parseInt(textFontSize) : Math.floor(Math.max(40, Math.floor(qrWidth * 0.15)) * 0.4);
    const textHeight = Math.max(Math.floor(qrWidth * 0.15), Math.floor(fontSize * 2.5));

    let actualColorLight = colorLight;
    if (colorLight === 'transparent') {
        actualColorLight = format === 'png' ? 'transparent' : '#ffffff';
    }

    function hexToRgba(hex) {
        let c = hex.replace('#', '');
        if (c.length === 3) c = c.split('').map(x => x + x).join('');
        if (c.length === 6) c += 'ff'; // default alpha
        return {
            r: parseInt(c.slice(0, 2), 16),
            g: parseInt(c.slice(2, 4), 16),
            b: parseInt(c.slice(4, 6), 16),
            a: parseInt(c.slice(6, 8), 16)
        };
    }

    const processRecord = async (serial) => {
        const qrData = QRCode.create(serial, { errorCorrectionLevel });
        const modules = qrData.modules;   // BitMatrix object with .get(r,c) and .size
        const size = modules.size;
        const totalQRSizeX = size + 2 * marginXInt;
        const totalQRSizeY = size + 2 * marginYInt;

        // Optimized ultra-fast path for simple square QRs without logo/text
        if (moduleStyle === 'square' && eyeStyle === 'square' && !logoDataUri && !shouldShowText && marginXInt === marginYInt) {
            const buf = Buffer.alloc(totalQRSizeX * totalQRSizeY * 4, 0);
            const cDark = hexToRgba(colorDark);
            const cLight = actualColorLight === 'transparent' ? { r: 0, g: 0, b: 0, a: 0 } : hexToRgba(actualColorLight);
            
            for (let r = 0; r < totalQRSizeY; r++) {
                for (let c = 0; c < totalQRSizeX; c++) {
                    const offset = (r * totalQRSizeX + c) * 4;
                    let isDark = false;
                    if (r >= marginYInt && r < size + marginYInt && c >= marginXInt && c < size + marginXInt) {
                        isDark = modules.get(r - marginYInt, c - marginXInt);
                    }
                    const color = isDark ? cDark : cLight;
                    buf[offset] = color.r;
                    buf[offset + 1] = color.g;
                    buf[offset + 2] = color.b;
                    buf[offset + 3] = color.a;
                }
            }
            return await sharp(buf, { raw: { width: totalQRSizeX, height: totalQRSizeY, channels: 4 } })
                .resize(qrWidth, qrWidth, { kernel: sharp.kernel.nearest })
                .toFormat(format === 'png' ? 'png' : 'jpeg', format === 'png' ? {} : { quality: 90 })
                .toBuffer();
        }

        // Fast SVG rendering path for customized styles, texts, logos
        const shapes = [];
        const isFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);
        
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
                    if (moduleStyle === 'dots') shapes.push(`<circle cx="${c + marginXInt + 0.5}" cy="${r + marginYInt + 0.5}" r="0.4" fill="${colorDark}" />`);
                    else if (moduleStyle === 'rounded') shapes.push(`<rect x="${c + marginXInt + 0.1}" y="${r + marginYInt + 0.1}" width="0.8" height="0.8" rx="0.2" fill="${colorDark}" />`);
                    else shapes.push(`<rect x="${c + marginXInt}" y="${r + marginYInt}" width="1" height="1" fill="${colorDark}" />`);
                }
            }
        }

        const unitRatio = totalQRSizeX / qrWidth;
        const textSpaceInt = parseInt(textSpace) || 0;
        const textSpaceUnits = textSpaceInt * unitRatio;
        const textHeightUnits = (textHeight * unitRatio) + textSpaceUnits;
        const totalHeightUnits = shouldShowText ? totalQRSizeY + textHeightUnits : totalQRSizeY;
        
        let extraElements = [];
        if (logoDataUri) {
            const lSizeUnits = (parseInt(logoSize) / 100) * size;
            const lPosX = marginXInt + (size - lSizeUnits) / 2;
            const lPosY = marginYInt + (size - lSizeUnits) / 2;
            const safeLogoBg = actualColorLight === 'transparent' ? '#ffffff' : actualColorLight;
            extraElements.push(`<rect x="${lPosX - 0.2}" y="${lPosY - 0.2}" width="${lSizeUnits + 0.4}" height="${lSizeUnits + 0.4}" fill="${safeLogoBg}" />`);
            extraElements.push(`<image x="${lPosX}" y="${lPosY}" width="${lSizeUnits}" height="${lSizeUnits}" href="${logoDataUri}" />`);
        }

        if (shouldShowText) {
            const escaped = String(serial).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const textYUnits = totalQRSizeY + textSpaceUnits + ((textHeightUnits - Math.max(0, textSpaceUnits)) / 2);
            const fontSizeUnits = fontSize * unitRatio;
            const textXPos = (totalQRSizeX / 2) + ((parseFloat(textX) || 0) * unitRatio);
            extraElements.push(`<text x="${textXPos}" y="${textYUnits}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSizeUnits}" fill="${colorDark}" text-anchor="middle" dominant-baseline="middle" font-weight="bold">${escaped}</text>`);
        }

        const qrBaseHeight = Math.round(totalQRSizeY / unitRatio);
        const qrOutputHeight = shouldShowText ? qrBaseHeight + textHeight + textSpaceInt : qrBaseHeight;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalQRSizeX} ${totalHeightUnits}" width="${qrWidth}" height="${qrOutputHeight}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${actualColorLight}"/>${shapes.join('')}${extraElements.join('')}</svg>`;
        
        return await sharp(Buffer.from(svg))
            .toFormat(format === 'png' ? 'png' : 'jpeg', format === 'png' ? {} : { quality: 90 })
            .toBuffer();
    };

    async function run() {
        for (const serial of chunk) {
            try {
                const buf = await processRecord(serial);
                // Transfer the underlying ArrayBuffer to avoid serialization issues
                const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                parentPort.postMessage({ type: 'result', serial, buf: arrayBuf }, [arrayBuf]);
            } catch (err) {
                parentPort.postMessage({ type: 'error', serial, error: err.message });
            }
        }
        parentPort.postMessage({ type: 'done' });
    }
    
    run();
} else {
    // --- MAIN THREAD CODE ---
    const sharp = require('sharp'); // Load sharp in main thread for logo processing
    const os = require('os');
    
    const app = express();
    const PORT = process.env.PORT || 5000;

    app.get('/', (req, res) => res.send('QR Code Generator API is running...'));

    app.use(cors());
    app.use(express.json());

    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

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

    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
    });

    const upload = multer({
        storage: storage,
        fileFilter: (req, file, cb) => {
            if (file.fieldname === 'file') {
                if (file.mimetype.includes('excel') || file.mimetype.includes('spreadsheetml')) cb(null, true);
                else cb(new Error('Only Excel files are allowed for the data sheet!'), false);
            } else if (file.fieldname === 'logo') {
                if (file.mimetype.startsWith('image/')) cb(null, true);
                else cb(new Error('Only image files are allowed for the logo!'), false);
            } else {
                cb(null, true);
            }
        }
    });

    const uploadFields = upload.fields([
        { name: 'file', maxCount: 1 },
        { name: 'logo', maxCount: 1 }
    ]);

    app.post('/api/generate', uploadFields, async (req, res) => {
        let filePath = null;
        let logoPath = null;
        let tempZipPath = null;
        const startOverall = Date.now();
        
        try {
            if (!req.files || !req.files['file']) return res.status(400).json({ error: 'No data file uploaded' });

            filePath = req.files['file'][0].path;
            logoPath = req.files['logo'] ? req.files['logo'][0].path : null;
            
            console.log(`Starting generation from file: ${req.files['file'][0].originalname}`);
            
            const workbook = xlsx.readFile(filePath, { cellFormula: false, cellHTML: false, cellText: false });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            
            const colIndex = req.body.colIndex || 0;
            const targetCol = parseInt(colIndex);
            
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

            console.log(`Extracted ${validRecords.length} records in ${Date.now() - startOverall}ms`);

            if (process.env.MONGODB_URI) {
                new UploadLog({
                    filename: req.files['file'][0].originalname,
                    recordCount: validRecords.length,
                    status: 'Success'
                }).save().catch(err => console.error(err));
            }

            // --- Build ZIP to a temp file first, then send when complete ---
            tempZipPath = path.join(uploadDir, `zip_${Date.now()}_${Math.random().toString(36).slice(2)}.zip`);
            const output = fs.createWriteStream(tempZipPath);
            const archive = archiver('zip', { zlib: { level: 1 } });

            // Wait for the ZIP file to be fully written before sending
            const zipDone = new Promise((resolve, reject) => {
                output.on('close', resolve);
                output.on('error', reject);
                archive.on('error', reject);
            });

            archive.pipe(output);

            // Build report
            let reportContent = `Generation Report\n=================\nTotal Records Found: ${validRecords.length}\nSkipped/Errors: ${errors.length}\nGeneration Time: ${Date.now() - startOverall}ms\n\n`;
            if (validRecords.length === 0) {
                reportContent += 'NOTICE: No valid QR records found. No QR codes were generated.\n\n';
            }
            if (errors.length > 0) {
                reportContent += 'Error Details:\n';
                errors.slice(0, 100).forEach(err => reportContent += `Row ${err.row}: ${err.error} (Value: "${err.value || ''}")\n`);
                if (errors.length > 100) reportContent += `...and ${errors.length - 100} more errors.\n`;
            }
            archive.append(reportContent, { name: 'report.txt' });

            if (validRecords.length > 0) {
                // Prepare Logo Data URI in main thread
                let logoDataUri = null;
                if (logoPath) {
                    const qrWidth = parseInt(req.body.width || 300);
                    const lSize = Math.floor(qrWidth * (parseInt(req.body.logoSize || 20) / 100));
                    const logoResizedBuf = await sharp(logoPath)
                        .resize(lSize, lSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                        .png()
                        .toBuffer();
                    logoDataUri = `data:image/png;base64,${logoResizedBuf.toString('base64')}`;
                }

                // Distribute to workers and collect all results before finalizing
                const numWorkers = Math.max(1, os.cpus().length);
                const chunkSize = Math.ceil(validRecords.length / numWorkers);
                const chunks = [];
                for (let i = 0; i < validRecords.length; i += chunkSize) {
                    chunks.push(validRecords.slice(i, i + chunkSize));
                }

                const format = req.body.format || 'jpeg';
                const nameCount = new Map();

                // Process all workers and await completion
                await Promise.all(chunks.map((chunk) => {
                    return new Promise((resolve, reject) => {
                        const worker = new Worker(__filename, {
                            workerData: { chunk, config: req.body, logoDataUri }
                        });

                        worker.on('message', (msg) => {
                            if (msg.type === 'result') {
                                let safeName = String(msg.serial).replace(/[<>:"/\\|?*\x00-\x1F\r\n\t]/g, '-').trim();
                                safeName = safeName.replace(/\.+$/, '') || 'qrcode';

                                let finalName = safeName;
                                if (nameCount.has(safeName)) {
                                    const count = nameCount.get(safeName) + 1;
                                    nameCount.set(safeName, count);
                                    finalName = `${safeName}_${count}`;
                                } else {
                                    nameCount.set(safeName, 1);
                                }

                                // msg.buf is a transferred ArrayBuffer
                                archive.append(Buffer.from(msg.buf), { name: `${finalName}.${format === 'png' ? 'png' : 'jpg'}` });
                            } else if (msg.type === 'error') {
                                console.error(`Worker error on ${msg.serial}:`, msg.error);
                            } else if (msg.type === 'done') {
                                resolve();
                            }
                        });

                        worker.on('error', reject);
                    });
                }));
            }

            // Finalize archive — this flushes all data to the temp file
            archive.finalize();

            // Wait until the file write stream is fully closed
            await zipDone;

            const zipSize = fs.statSync(tempZipPath).size;
            console.log(`ZIP finalized: ${zipSize} bytes, total time: ${Date.now() - startOverall}ms`);

            // Now send the complete, valid ZIP file
            res.set('Access-Control-Expose-Headers', 'X-Total-Count, X-Success-Count, X-Skipped-Count, Content-Disposition');
            res.set('X-Total-Count', String(range.e.r - range.s.r + 1));
            res.set('X-Success-Count', String(validRecords.length));
            res.set('X-Skipped-Count', String(errors.length));
            res.set('Content-Type', 'application/zip');
            res.set('Content-Disposition', `attachment; filename="qrcodes_${Date.now()}.zip"`);
            res.set('Content-Length', String(zipSize));

            const readStream = fs.createReadStream(tempZipPath);
            readStream.pipe(res);
            readStream.on('end', () => {
                // Cleanup temp zip after sending
                if (tempZipPath && fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
                if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
                if (logoPath && fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
            });
            readStream.on('error', (err) => {
                console.error('Read stream error:', err);
                if (!res.headersSent) res.status(500).json({ error: 'Failed to send ZIP file.' });
            });

        } catch (error) {
            console.error('Generation Error:', error);
            if (tempZipPath && fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (logoPath && fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
            if (!res.headersSent) res.status(500).json({ error: 'Server error processing file.' });
        }
    });

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

    app.listen(PORT, () => console.log(`Server running on port ${PORT} with ${os.cpus().length} cores available for workers`));
}
