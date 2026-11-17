'use strict';

// Regenerates PNG app icons from public/icons/icon.svg.
// Requires Playwright (not a project dependency): npx -y playwright ... or a
// globally available `playwright` module.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const dir = path.join(__dirname, '..', 'public', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const render = async (size, file, maskable = false) => {
    await page.setViewportSize({ width: size, height: size });
    const inner = maskable
      // Maskable icons need a full-bleed background with the art in the safe zone.
      ? `<div style="width:${size}px;height:${size}px;background:#2b1a12;display:grid;place-items:center">
           <div style="width:${size * 0.8}px;height:${size * 0.8}px">${svg}</div></div>`
      : `<div style="width:${size}px;height:${size}px">${svg}</div>`;
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:100%;height:100%;display:block}</style>${inner}`);
    await page.screenshot({ path: path.join(dir, file), omitBackground: !maskable });
  };
  await render(192, 'icon-192.png');
  await render(512, 'icon-512.png');
  await render(512, 'icon-maskable-512.png', true);
  await render(180, 'icon-180.png', true); // iOS applies its own rounding
  await browser.close();
  console.log('Icons written to', dir);
})();
