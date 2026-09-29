const fs = require('fs');
const path = require('path');

const sandbox = path.join(__dirname, '..', '.sandbox');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox);
