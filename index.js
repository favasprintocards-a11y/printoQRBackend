const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const QRCode = require('qrcode');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const sharp = require('sharp');
require('dotenv').config();

// Optimization: Global Sharp settings
sharp.concurrency(1);
sharp.simd(true);

const app = express();
const PORT = process.env.PORT || 5000;

// Health check
app.get('/', (req, res) => {
    res.send('QR Code Generator API is running...');
});

// Middleware
app.use(cors());
app.use(express.json());

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// MongoDB Connection (Optional: Only if real URI provided)
if (process.env.MONGODB_URI && process.env.MONGODB_URI.startsWith('mongodb')) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('MongoDB Connected'))
        .catch(err => console.log('MongoDB Connection Error:', err));
}

// Schema for optional logging
const UploadLogSchema = new mongoose.Schema({
    filename: String,
    recordCount: Number,
    timestamp: { type: Date, default: Date.now },
    status: String
});
const UploadLog = mongoose.model('UploadLog', UploadLogSchema);

// Multer Setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
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
        
        console.log(`Starting generation from file: ${req.files['file'][0].originalname}`);
        
        const workbook = xlsx.readFile(filePath, { cellFormula: false, cellHTML: false, cellText: false });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        // Configuration
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
        
        // Efficient record extraction instead of full sheet_to_json
        const range = xlsx.utils.decode_range(sheet['!ref'] || 'A1');
        const validRecords = [];
        const errors = [];
        const seen = new Set();
        
        for (let r = range.s.r; r <= range.e.r; r++) {
            const cellAddr = xlsx.utils.encode_cell({ r, c: targetCol });
            const cell = sheet[cellAddr];
            const serial = cell ? cell.v : null;

            if (serial === undefined || serial === null || String(serial).trim() === '') {
                // If it's a completely empty row, just skip silently
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

        console.log(`Extracted ${validRecords.length} records. Analysis took ${Date.now() - startOverall}ms`);

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

        // Set Headers
        res.set('Access-Control-Expose-Headers', 'X-Total-Count, X-Success-Count, X-Skipped-Count, Content-Disposition');
        res.set('X-Total-Count', String(range.e.r - range.s.r + 1));
        res.set('X-Success-Count', String(validRecords.length));
        res.set('X-Skipped-Count', String(errors.length));
        res.attachment(`qrcodes_${Date.now()}.zip`);

        // Optimization: Use level 0 (STORE) to save CPU as images are already compressed
        const archive = archiver('zip', { zlib: { level: 0 } });
        archive.on('error', (err) => res.status(500).send({ error: err.message }));
        archive.on('end', () => {
             console.log(`ZIP complete. Total time: ${Date.now() - startOverall}ms`);
             if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
             if (logoPath && fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
        });
        res.on('close', () => {
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (logoPath && fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
        });

        archive.pipe(res);

        // Report
        let reportContent = `Generation Report\n=================\nTotal Records Found: ${validRecords.length}\nSkipped/Errors: ${errors.length}\nAnalysis Time: ${Date.now() - startOverall}ms\n\n`;
        if (errors.length > 0) {
            reportContent += `Error Details:\n`;
            errors.slice(0, 100).forEach(err => reportContent += `Row ${err.row}: ${err.error} (Value: "${err.value || ''}")\n`);
            if (errors.length > 100) reportContent += `...and ${errors.length - 100} more errors.\n`;
        }
        archive.append(reportContent, { name: 'report.txt' });

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

        // Pre-process logo as base64 for embedding in SVG
        let logoDataUri = null;
        if (logoPath) {
            const lSize = Math.floor(qrWidth * (parseInt(logoSize) / 100));
            const logoResizedBuf = await sharp(logoPath)
                .resize(lSize, lSize, { fit: 'contain', background: { r:0, g:0, b:0, alpha:0 } })
                .png() // Ensure it's PNG for the data URI
                .toBuffer();
            logoDataUri = `data:image/png;base64,${logoResizedBuf.toString('base64')}`;
        }

        const processRecord = async (serial) => {
            // Fast path for simple square QR
            if (moduleStyle === 'square' && eyeStyle === 'square' && !logoPath && !shouldShowText && marginXInt === marginYInt) {
                if (format === 'png') {
                    return await QRCode.toBuffer(serial, { width: qrWidth, margin: marginXInt, errorCorrectionLevel, color: { dark: colorDark, light: actualColorLight === 'transparent' ? '#ffffff00' : actualColorLight } });
                } else {
                    const url = await QRCode.toDataURL(serial, { width: qrWidth, margin: marginXInt, errorCorrectionLevel, type: 'image/jpeg', color: { dark: colorDark, light: actualColorLight }, rendererOpts: { quality: 0.9 } });
                    return Buffer.from(url.split(',')[1], 'base64');
                }
            } else {
                // Optimized path: Single SVG render for customized styles/logos/text
                const qrData = QRCode.create(serial, { errorCorrectionLevel });
                const { modules, size } = qrData.modules;
                const totalQRSizeX = size + 2 * marginXInt;
                const totalQRSizeY = size + 2 * marginYInt;
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
                        if (qrData.modules.get(r, c)) {
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
                    // Background for logo to ensure it's readable
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
            }
        };

        const CONCURRENCY_LIMIT = 20; // Optimized for stability on typical multi-core CPUs
        for (let i = 0; i < validRecords.length; i += CONCURRENCY_LIMIT) {
            const chunk = validRecords.slice(i, i + CONCURRENCY_LIMIT);
            const results = await Promise.all(chunk.map(async (serial) => {
                try { return { serial, buf: await processRecord(serial) }; }
                catch (err) { console.error(`Error ${serial}:`, err); return null; }
            }));
            for (const res of results) {
                if (res) {
                    const safeName = String(res.serial).replace(/[\/\\?%*:|"<>]/g, '-').trim();
                    archive.append(res.buf, { name: `${safeName || 'qrcode'}.${format === 'png' ? 'png' : 'jpg'}` });
                }
            }
        }
        archive.finalize();

    } catch (error) {
        console.error('Generation Error:', error);
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
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
        
        // Extract only needed rows for preview
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
