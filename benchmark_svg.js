process.env.UV_THREADPOOL_SIZE = '16';
const QRCode = require('qrcode');
const sharp = require('sharp');
sharp.concurrency(4);
sharp.cache(false);

async function makeQR_SVG(serial) {
    const qrData = QRCode.create(String(serial), { errorCorrectionLevel: 'M' });
    const modules = qrData.modules;
    const size = modules.size;
    const marginXInt = 2;
    const marginYInt = 2;
    const colorDark = '#000000';
    const qrWidth = 300;

    const totalQRSizeX = size + 2 * marginXInt;
    const totalQRSizeY = size + 2 * marginYInt;

    const shapes = [];
    const isFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);
    
    const eyes = [{ r: 0, c: 0 }, { r: 0, c: size - 7 }, { r: size - 7, c: 0 }];
    for (const eye of eyes) {
        shapes.push(`<rect x="${eye.c + marginXInt + 0.5}" y="${eye.r + marginYInt + 0.5}" width="6" height="6" fill="none" stroke="${colorDark}" stroke-width="1" />`);
        shapes.push(`<rect x="${eye.c + marginXInt + 2}" y="${eye.r + marginYInt + 2}" width="3" height="3" fill="${colorDark}" />`);
    }

    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (isFinder(r, c)) continue;
            if (modules.get(r, c)) {
                shapes.push(`<rect x="${c + marginXInt}" y="${r + marginYInt}" width="1" height="1" fill="${colorDark}" />`);
            }
        }
    }

    const unitRatio = totalQRSizeX / qrWidth;
    const textHeight = 40;
    const textSpaceInt = 0;
    const textSpaceUnits = textSpaceInt * unitRatio;
    const textHeightUnits = (textHeight * unitRatio) + textSpaceUnits;
    const totalHeightUnits = totalQRSizeY + textHeightUnits;
    
    let extraElements = [];
    const textYUnits = totalQRSizeY + textSpaceUnits + ((textHeightUnits - Math.max(0, textSpaceUnits)) / 2);
    const fontSizeUnits = 16 * unitRatio;
    const textXPos = (totalQRSizeX / 2);
    extraElements.push(`<text x="${textXPos}" y="${textYUnits}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSizeUnits}" fill="${colorDark}" text-anchor="middle" dominant-baseline="middle" font-weight="bold">${serial}</text>`);

    const qrBaseHeight = Math.round(totalQRSizeY / unitRatio);
    const qrOutputHeight = qrBaseHeight + textHeight + textSpaceInt;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalQRSizeX} ${totalHeightUnits}" width="${qrWidth}" height="${qrOutputHeight}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/>${shapes.join('')}${extraElements.join('')}</svg>`;
    
    return sharp(Buffer.from(svg))
        .toFormat('jpeg', { quality: 90 })
        .toBuffer();
}

async function withConcurrency(items, n, fn) {
    const q = items.slice();
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (q.length > 0) { const item = q.shift(); if (item !== undefined) await fn(item); }
    }));
}

async function run() {
    const N = 500;
    const records = Array.from({ length: N }, (_, i) => 'SN' + String(i).padStart(6, '0'));
    const t = Date.now();
    await withConcurrency(records, 8, makeQR_SVG);
    const ms = Date.now() - t;
    console.log(`SVG x8  ${N} QRs: ${ms}ms  (${Math.round(N * 1000 / ms)}/sec)`);
}

run().catch(console.error);
