/* Собирает один самодостаточный index.html из src/ и vendor/.
   Запуск:  node build.js
   Ничего не скачивает — все библиотеки уже лежат в vendor/. */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const css = read('src/style.css');
const qr = read('vendor/qrcode.js');
const app = read('src/app.js');

for (const [name, src] of [['qrcode.js', qr], ['app.js', app]]) {
  if (/<\/script/i.test(src)) {
    console.error('ОШИБКА: в ' + name + ' встречается "</script" — нельзя вставлять инлайном.');
    process.exit(1);
  }
}

let html = read('src/index.html');
html = html.replace('/*__STYLE__*/', () => css);
html = html.replace('/*__VENDOR_QR__*/', () => qr);
html = html.replace('/*__APP__*/', () => app);

const out = path.join(root, 'index.html');
fs.writeFileSync(out, html, 'utf8');
console.log('Готово: ' + out + ' (' + (Buffer.byteLength(html) / 1024).toFixed(0) + ' КБ)');
