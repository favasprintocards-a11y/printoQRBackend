const fs = require('fs');

const svg1 = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 10 10">
    <rect x="0.5" y="0.5" width="6" height="6" fill="none" stroke="black" stroke-width="1" rx="1.5" />
    <rect x="2" y="2" width="3" height="3" fill="red" rx="0.5" />
</svg>`;

const svg2 = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 10 10">
    <rect x="0.5" y="0.5" width="6" height="6" fill="none" stroke="black" stroke-width="1" />
    <rect x="2" y="2" width="3" height="3" fill="blue" />
</svg>`;

fs.writeFileSync('test-eye-rounded.svg', svg1);
fs.writeFileSync('test-eye-square.svg', svg2);
