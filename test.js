const sharp = require('sharp');
const fs = require('fs');

async function test() {
    const totalQRSize = 33;
    const totalHeightUnits = 33;
    const qrWidth = 300;
    const qrOutputHeight = 300;
    const colorLight = '#ffffff';
    const shapes = ['<rect width="1" height="1" fill="#000000"/>'];
    const extraElements = [];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalQRSize} ${totalHeightUnits}" width="${qrWidth}" height="${qrOutputHeight}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${colorLight}"/>${shapes.join('')}${extraElements.join('')}</svg>`;
    const buf = await sharp(Buffer.from(svg))
        .toFormat('png', { quality: 90 })
        .toBuffer();
    fs.writeFileSync('test-full-svg.png', buf);
}
test().catch(console.error);
