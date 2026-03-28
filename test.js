const sharp = require('sharp');
const fs = require('fs');
async function test() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="transparent"/><circle cx="50" cy="50" r="40" fill="red"/></svg>';
    const buf = await sharp(Buffer.from(svg)).toFormat('png').toBuffer();
    fs.writeFileSync('test-transparent.png', buf);
}
test().catch(console.error);
