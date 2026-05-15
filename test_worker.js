const { Worker } = require('worker_threads');
const path = require('path');

const worker = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: {
        records: ['TEST001', 'TEST002', 'TEST003'],
        width: 300, marginXInt: 2, marginYInt: 2,
        errorCorrectionLevel: 'M', format: 'png',
        colorDark: '#000000', actualColorLight: '#ffffff00',
        moduleStyle: 'square', eyeStyle: 'square',
        logoDataUri: null, logoSize: 20,
        shouldShowText: false, fontSize: 16,
        textHeight: 45, textX: 0, textSpace: 0,
    }
});

let count = 0;
worker.on('message', (msg) => {
    if (msg.type === 'result') {
        const buf = Buffer.from(msg.buf);
        const isPng = buf[0] === 137 && buf[1] === 80 && buf[2] === 78;
        count++;
        console.log(`QR ${msg.serial} → ${buf.byteLength} bytes, valid PNG: ${isPng}`);
    } else if (msg.type === 'error') {
        console.error('ERROR for', msg.serial, ':', msg.error);
    } else if (msg.type === 'done') {
        console.log(`\nDone! Generated: ${count}/3`);
        process.exit(count === 3 ? 0 : 1);
    }
});
worker.on('error', e => { console.error('Worker crash:', e); process.exit(1); });
