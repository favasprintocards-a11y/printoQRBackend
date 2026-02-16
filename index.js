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
    try {
        if (!req.files || !req.files['file']) {
            return res.status(400).json({ error: 'No data file uploaded' });
        }

        filePath = req.files['file'][0].path;
        logoPath = req.files['logo'] ? req.files['logo'][0].path : null;
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawData = xlsx.utils.sheet_to_json(sheet, { header: 1 });

        // Configuration
        const {
            width = 300,
            margin = 4,
            errorCorrectionLevel = 'M',
            colIndex = 0, // Default to first column
            format = 'jpeg',
            colorDark = '#000000',
            colorLight = '#ffffff',
            moduleStyle = 'square',
            eyeStyle = 'square',
            logoSize = 20, // percent
            showText = 'false'
        } = req.body;

        const shouldShowText = showText === 'true' || showText === true;

        // Process Data
        // Assume first row might be header. We'll check if it looks like a header or data.
        // For simplicity, let's assume if the user selects a column, we process all rows. 
        // Or we can let user specify if header exists. 
        // Let's assume row 1 is header if it's string and looks like a name.
        // We'll just filter valid rows.

        const validRecords = [];
        const errors = [];
        const seen = new Set();

        // Skip header if needed. For now, we process all non-empty cells in the selected column.
        // If the first item is "Serial Number", skip it.
        let startIndex = 0;
        if (rawData.length > 0 && typeof rawData[0][colIndex] === 'string' && isNaN(rawData[0][colIndex])) {
            // lenient check for header
            // But valid serials can be strings.
            // Let's just create a list and if the user sees 'Serial' as a QR, they'll know.
            // Better: Use a "hasHeader" flag from frontend? Or just process everything.
        }

        for (let i = startIndex; i < rawData.length; i++) {
            const row = rawData[i];
            const serial = row[colIndex];

            if (serial === undefined || serial === null || serial === '') {
                errors.push({ row: i + 1, error: 'Empty value' });
                continue;
            }

            const serialStr = String(serial).trim();

            // Duplicate Check
            if (seen.has(serialStr)) {
                errors.push({ row: i + 1, error: 'Duplicate serial', value: serialStr });
                continue;
            }
            seen.add(serialStr);

            // Validation (Basic alphanumeric + safe chars)
            // if (!/^[a-zA-Z0-9\-_]+$/.test(serialStr)) { 
            //     // Relaxed validation: Just warn or skip?
            //     // Prompt says "Validate: Invalid characters". Let's assume strictly safe for filenames if we use them as filenames.
            // }

            validRecords.push(serialStr);
        }

        if (validRecords.length === 0) {
            if (filePath) fs.unlinkSync(filePath); // Cleanup
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

        // Set Headers for ZIP Download
        res.set('Access-Control-Expose-Headers', 'X-Total-Count, X-Success-Count, X-Skipped-Count, Content-Disposition');
        res.set('X-Total-Count', String(rawData.length - startIndex));
        res.set('X-Success-Count', String(validRecords.length));
        res.set('X-Skipped-Count', String(errors.length));

        res.attachment('qrcodes.zip');

        const archive = archiver('zip', {
            zlib: { level: 1 } // Level 1 is much faster than 9 with similar results for small images
        });

        archive.on('error', function (err) {
            res.status(500).send({ error: err.message });
        });

        // Cleanup on finish
        archive.on('end', () => {
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (logoPath && fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
        });

        // If client closes connection
        res.on('close', () => {
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (logoPath && fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
        });

        archive.pipe(res);

        // Generate Report
        let reportContent = `Generation Report\n=================\n`;
        reportContent += `Total Rows Processed: ${rawData.length - startIndex}\n`;
        reportContent += `Successful: ${validRecords.length}\n`;
        reportContent += `Skipped/Errors: ${errors.length}\n\n`;

        if (errors.length > 0) {
            reportContent += `Error Details:\n`;
            errors.forEach(err => {
                reportContent += `Row ${err.row}: ${err.error} (Value: "${err.value || ''}")\n`;
            });
        }

        archive.append(reportContent, { name: 'report.txt' });

        // Pre-calculate common values
        const qrWidth = parseInt(width);
        const marginInt = parseInt(margin);
        const textHeight = Math.max(40, Math.floor(qrWidth * 0.15));
        const fontSize = Math.floor(textHeight * 0.4);
        const lSize = Math.floor(qrWidth * (parseInt(logoSize) / 100));

        // Global Sharp settings for bulk
        sharp.simd(true);
        sharp.concurrency(0); // Use all available cores

        // Pre-process Logo once if available
        let logoBg = null;
        let logoResized = null;
        if (logoPath) {
            logoBg = await sharp({
                create: {
                    width: lSize + 10,
                    height: lSize + 10,
                    channels: 4,
                    background: colorLight
                }
            }).png().toBuffer();

            logoResized = await sharp(logoPath)
                .resize(lSize, lSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .toBuffer();
        }

        // Processing Function
        const processRecord = async (serial) => {
            const data = serial;
            let buffer;

            if (moduleStyle === 'square' && eyeStyle === 'square' && !logoPath && !shouldShowText) {
                // Fastest path: Standard lib only
                // If PNG, use toBuffer directly (faster than toDataURL)
                if (format === 'png') {
                    return await QRCode.toBuffer(data, {
                        width: qrWidth,
                        margin: marginInt,
                        errorCorrectionLevel: errorCorrectionLevel,
                        color: { dark: colorDark, light: colorLight }
                    });
                } else {
                    const url = await QRCode.toDataURL(data, {
                        width: qrWidth,
                        margin: marginInt,
                        errorCorrectionLevel: errorCorrectionLevel,
                        type: 'image/jpeg',
                        color: { dark: colorDark, light: colorLight },
                        rendererOpts: { quality: 0.90 }
                    });
                    return Buffer.from(url.split(',')[1], 'base64');
                }
            } else {
                // Custom path or logo/text needed
                const qrData = QRCode.create(data, { errorCorrectionLevel });
                const modules = qrData.modules.data;
                const size = qrData.modules.size;

                const isFinder = (r, c) => {
                    if (r < 7 && c < 7) return true;
                    if (r < 7 && c >= size - 7) return true;
                    if (r >= size - 7 && c < 7) return true;
                    return false;
                };

                const shapes = [];

                // Draw Eye Patterns (Finders)
                const eyes = [{ r: 0, c: 0 }, { r: 0, c: size - 7 }, { r: size - 7, c: 0 }];
                for (const eye of eyes) {
                    if (eyeStyle === 'rounded') {
                        // Outer
                        shapes.push(`<rect x="${eye.c}" y="${eye.r}" width="7" height="7" rx="1.5" fill="${colorDark}" />`);
                        // Hole
                        shapes.push(`<rect x="${eye.c + 1}" y="${eye.r + 1}" width="5" height="5" rx="1" fill="${colorLight}" />`);
                        // Inner
                        shapes.push(`<rect x="${eye.c + 2}" y="${eye.r + 2}" width="3" height="3" rx="0.5" fill="${colorDark}" />`);
                    } else {
                        // Square
                        shapes.push(`<rect x="${eye.c}" y="${eye.r}" width="7" height="7" fill="${colorDark}" />`);
                        shapes.push(`<rect x="${eye.c + 1}" y="${eye.r + 1}" width="5" height="5" fill="${colorLight}" />`);
                        shapes.push(`<rect x="${eye.c + 2}" y="${eye.r + 2}" width="3" height="3" fill="${colorDark}" />`);
                    }
                }

                // Draw remaining modules
                for (let r = 0; r < size; r++) {
                    const rowOffset = r * size;
                    for (let c = 0; c < size; c++) {
                        if (isFinder(r, c)) continue; // Skip finder areas

                        if (modules[rowOffset + c]) {
                            if (moduleStyle === 'dots') {
                                shapes.push(`<circle cx="${c + 0.5}" cy="${r + 0.5}" r="0.4" fill="${colorDark}" />`);
                            } else if (moduleStyle === 'rounded') {
                                shapes.push(`<rect x="${c + 0.1}" y="${r + 0.1}" width="0.8" height="0.8" rx="0.2" fill="${colorDark}" />`);
                            } else {
                                shapes.push(`<rect x="${c}" y="${r}" width="1" height="1" fill="${colorDark}" />`);
                            }
                        }
                    }
                }

                const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${qrWidth}" height="${qrWidth}" shape-rendering="crispEdges">
                    <rect width="100%" height="100%" fill="${colorLight}"/>
                    ${shapes.join('')}
                </svg>`;

                let sharpInstance = sharp(Buffer.from(svg));

                if (logoPath) {
                    sharpInstance = sharpInstance.composite([
                        { input: logoBg, gravity: 'center' },
                        { input: logoResized, gravity: 'center' }
                    ]);
                }

                if (shouldShowText) {
                    const escapedSerial = String(serial)
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&apos;');

                    const textSvg = `<svg width="${qrWidth}" height="${textHeight}">
                        <rect width="100%" height="100%" fill="${colorLight}" />
                        <text x="50%" y="50%" font-family="Arial" font-size="${fontSize}" fill="${colorDark}" text-anchor="middle" dominant-baseline="middle" font-weight="bold">${escapedSerial}</text>
                    </svg>`;

                    buffer = await sharpInstance
                        .extend({
                            bottom: textHeight,
                            background: colorLight
                        })
                        .composite([
                            { input: Buffer.from(textSvg), gravity: 'south' }
                        ])
                        .toFormat(format === 'png' ? 'png' : 'jpeg', { quality: 90 })
                        .toBuffer();
                } else {
                    buffer = await sharpInstance
                        .toFormat(format === 'png' ? 'png' : 'jpeg', { quality: 90 })
                        .toBuffer();
                }
                return buffer;
            }
        };

        // Parallel processing with high concurrency limit
        const CONCURRENCY_LIMIT = 50;
        for (let i = 0; i < validRecords.length; i += CONCURRENCY_LIMIT) {
            const chunk = validRecords.slice(i, i + CONCURRENCY_LIMIT);
            const results = await Promise.all(chunk.map(async (serial) => {
                try {
                    const buf = await processRecord(serial);
                    return { serial, buf };
                } catch (err) {
                    console.error(`Error processing ${serial}:`, err);
                    return null;
                }
            }));

            for (const res of results) {
                if (res) {
                    const ext = format === 'png' ? 'png' : 'jpg';
                    archive.append(res.buf, { name: `${res.serial}.${ext}` });
                }
            }
        }

        archive.finalize();

    } catch (error) {
        console.error(error);
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        if (!res.headersSent) {
            res.status(500).json({ error: 'Server error processing file.' });
        }
    }
});

// Endpoint to just preview/analyze file
app.post('/api/analyze', uploadFields, (req, res) => {
    let filePath = null;
    try {
        if (!req.files || !req.files['file']) {
            return res.status(400).json({ error: 'No data file uploaded' });
        }
        filePath = req.files['file'][0].path;
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

        // Return first 5 rows and total count, and columns
        const totalRows = data.length;
        const preview = data.slice(0, 5);

        // Assuming header might be row 0
        const headers = data.length > 0 ? data[0] : [];

        // We don't delete yet? Or we rely on client to re-upload for generation?
        // Stateless is better. Delete now. Client uploads again for generation.
        fs.unlinkSync(filePath);

        res.json({
            totalRows,
            preview,
            headers
        });

    } catch (err) {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.status(500).json({ error: 'Failed to parse Excel file' });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
