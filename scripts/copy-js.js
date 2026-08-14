/**
 * copy-js.js
 * Cross-platform script to copy all .js files from src/ to dist/
 * preserving the folder structure.
 * Used as part of the build step since tsc only emits compiled .ts files
 * and does not copy raw .js files (e.g. ssh-client.js, prompt_library.js).
 */

const fs   = require('fs');
const path = require('path');

const SRC  = path.resolve(__dirname, '../src');
const DEST = path.resolve(__dirname, '../dist');

function copyJsFiles(srcDir, destDir) {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath  = path.join(srcDir,  entry.name);
        const destPath = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            copyJsFiles(srcPath, destPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(srcPath, destPath);
            console.log(`  copied: ${path.relative(SRC, srcPath)}`);
        }
    }
}

console.log('Copying .js files from src/ to dist/ ...');
copyJsFiles(SRC, DEST);
console.log('Done.');
