/**
 * benchmark.js — Quick performance test for Worker Pool QR generation
 * Run: node benchmark.js
 */

const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');

const NUM_CPUS = Math.max(1, os.cpus().length - 1);
const TEST_SIZES = [1000, 5000, 10000, 50000];

function splitIntoChunks(arr, n) {
    const chunks = [];
    const size = Math.ceil(arr.length / n);
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

function runWorkerPool(records, workerData) {
    return new Promise((resolve) => {
        const chunks = splitIntoChunks(records, NUM_CPUS);
        let doneCount = 0;
        let completed = 0;

        for (const chunk of chunks) {
            if (chunk.length === 0) { doneCount++; if (doneCount === chunks.length) resolve(completed); continue; }
            const worker = new Worker(path.join(__dirname, 'worker.js'), {
                workerData: { ...workerData, records: chunk }
            });
            worker.on('message', (msg) => {
                if (msg.type === 'result') completed++;
                else if (msg.type === 'done') {
                    doneCount++;
                    if (doneCount === chunks.length) resolve(completed);
                }
            });
            worker.on('error', (e) => { console.error(e); doneCount++; if (doneCount === chunks.length) resolve(completed); });
        }
    });
}

const workerData = {
    width: 300, marginXInt: 2, marginYInt: 2,
    errorCorrectionLevel: 'M', format: 'png',
    colorDark: '#000000', actualColorLight: '#ffffff00',
    moduleStyle: 'square', eyeStyle: 'square',
    logoDataUri: null, logoSize: 20,
    shouldShowText: false, fontSize: 16,
    textHeight: 45, textX: 0, textSpace: 0,
};

(async () => {
    console.log(`\n🔧 System: ${os.cpus().length} CPUs, using ${NUM_CPUS} worker threads`);
    console.log(`📦 Mode: Fast-path PNG (square, no logo, no text)\n`);
    console.log('─'.repeat(55));

    for (const count of TEST_SIZES) {
        // Generate fake serial numbers
        const records = Array.from({ length: count }, (_, i) => `SN${String(i + 1).padStart(8, '0')}`);

        const start = Date.now();
        await runWorkerPool(records, workerData);
        const elapsed = Date.now() - start;
        const elapsedSec = Math.max(0.001, elapsed / 1000);
        const rate = Math.round(count / elapsedSec);

        console.log(`✅ ${String(count).padStart(6)} QRs │ ${elapsed}ms │ ${rate.toLocaleString()} QR/sec`);

        if (count === 50000) {
            console.log(`\n🎯 50,000 QRs completed in ${elapsed}ms (${(elapsed/1000).toFixed(1)}s)`);
            console.log(`   That is ${rate.toLocaleString()} QR codes per second!`);
        }
    }

    console.log('─'.repeat(55));
    console.log('\nDone. Press Ctrl+C to exit.\n');
    process.exit(0);
})();
