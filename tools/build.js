// node tools/build.js
// Produces two single-file builds in dist/:
//   dist/nonoslam.html  — complete standalone page (double-click to play, email it, host it anywhere)
//   dist/artifact.html  — body-only variant for hosts that wrap the page themselves (no doctype/head/body)
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const dataUri = f => 'data:image/png;base64,' + fs.readFileSync(path.join(root, f)).toString('base64');

const html = read('index.html');
const css = read('src/style.css').replace(/url\(\.\.\/fonts\/([^)]+)\)/g, (m, f) => 'url(data:font/woff2;base64,' + fs.readFileSync(path.join(root, 'fonts', f)).toString('base64') + ')');
const js = ['src/nonogram.js', 'src/audio.js', 'src/board.js', 'src/app.js'].map(read).join('\n\n');

const bodyStart = html.indexOf('<!-- BEGIN APP -->') + '<!-- BEGIN APP -->'.length;
const bodyEnd = html.indexOf('<!-- END APP -->');
const app = html.slice(bodyStart, bodyEnd).trim();

const icon = dataUri('icons/icon-192.png');
const apple = dataUri('icons/apple-touch-icon.png');

const standalone = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>NONOSLAM</title>
<meta name="theme-color" content="#0b0e17">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="NONOSLAM">
<link rel="icon" type="image/png" href="${icon}">
<link rel="apple-touch-icon" href="${apple}">
<style>
${css}
</style>
</head>
<body>
${app}
<script>window.NONOSLAM_SINGLE_FILE = true;</script>
<script>
${js}
</script>
</body>
</html>
`;

const artifact = `<title>NONOSLAM</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<link rel="icon" type="image/png" href="${icon}">
<link rel="apple-touch-icon" href="${apple}">
<style>
${css}
</style>
${app}
<script>window.NONOSLAM_SINGLE_FILE = true;</script>
<script>
${js}
</script>
`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/nonoslam.html'), standalone);
fs.writeFileSync(path.join(root, 'dist/artifact.html'), artifact);
console.log('dist/nonoslam.html', (standalone.length / 1024).toFixed(0) + ' KB');
console.log('dist/artifact.html', (artifact.length / 1024).toFixed(0) + ' KB');
