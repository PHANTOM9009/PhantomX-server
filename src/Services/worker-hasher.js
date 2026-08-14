// worker-hasher.js
// This worker script receives a message with { filePath, text } and returns { filePath, hash }
const { parentPort } = require('worker_threads');
const crypto = require('crypto');

parentPort.on('message', ({ filePath, text }) => {
    const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    parentPort.postMessage({ filePath, hash });
});
