process.env.UV_THREADPOOL_SIZE = '16';
const QRCode = require('qrcode');
const sharp = require('sharp');
sharp.concurrency(4);
sharp.cache(false);

// Current approach: manual JS pixel loop
async function makeQR_pixelLoop(serial) {
    const qrData = QRCode.create(String(serial), { errorCorrectionLevel: 'M' });
    const modules = qrData.modules;
    const size = modules.size;
    const margin = 2;
    const totalX = size + margin * 2;
    const totalY = totalX;
    const buf = Buffer.alloc(totalX * totalY * 4, 0);
    for (let r = 0; r < totalY; r++) {
        for (let c = 0; c < totalX; c++) {
            const off = (r * totalX + c) * 4;
            let isDark = false;
            if (r >= margin && r < size + margin && c >= margin && c < size + margin)
                isDark = modules.get(r - margin, c - margin);
            const v = isDark ? 0 : 255;
            buf[off] = v; buf[off+1] = v; buf[off+2] = v; buf[off+3] = 255;
        }
    }
    return sharp(buf, { raw: { width: totalX, height: totalY, channels: 4 } })
        .resize(300, 300, { kernel: sharp.kernel.nearest })
        .jpeg({ quality: 90 }).toBuffer();
}

// Optimized: use qrcode's built-in PNG output directly (avoids manual pixel loop)
async function makeQR_builtin(serial) {
    return QRCode.toBuffer(String(serial), {
        type: 'png',
        width: 300,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000ff', light: '#ffffffff' }
    });
}

// Hybrid: use qrcode PNG → sharp JPEG conversion (skips pixel loop entirely)
async function makeQR_hybrid(serial) {
    const pngBuf = await QRCode.toBuffer(String(serial), {
        type: 'png', width: 300, margin: 2,
        errorCorrectionLevel: 'M'
    });
    return sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
}

async function withConcurrency(items, n, fn) {
    const q = items.slice();
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (q.length > 0) { const item = q.shift(); if (item !== undefined) await fn(item); }
    }));
}

async function bench(label, N, fn, concurrency) {
    const records = Array.from({ length: N }, (_, i) => 'SN' + String(i).padStart(6, '0'));
    const t = Date.now();
    if (concurrency > 1) await withConcurrency(records, concurrency, fn);
    else for (const s of records) await fn(s);
    const ms = Date.now() - t;
    console.log(`${label.padEnd(40)} ${N} QRs: ${String(ms).padStart(5)}ms  (${String(Math.round(N * 1000 / ms)).padStart(5)}/sec)`);
    return ms;
}

async function run() {
    const N = 500;
    const C = 8;
    console.log(`\nBenchmarking ${N} QRs @ concurrency=${C} (300px JPEG output)\n`);

    await bench('Pixel loop  seq',           N, makeQR_pixelLoop, 1);
    await bench(`Pixel loop  x${C}`,         N, makeQR_pixelLoop, C);
    await bench('QRCode builtin PNG  seq',   N, makeQR_builtin,   1);
    await bench(`QRCode builtin PNG  x${C}`, N, makeQR_builtin,   C);
    await bench('QRCode PNG → JPEG  seq',    N, makeQR_hybrid,    1);
    await bench(`QRCode PNG → JPEG  x${C}`,  N, makeQR_hybrid,    C);

    const mem = process.memoryUsage();
    console.log(`\nPeak RAM — RSS: ${(mem.rss/1024/1024).toFixed(1)} MB, Heap: ${(mem.heapUsed/1024/1024).toFixed(1)} MB\n`);
}

run().catch(console.error);
