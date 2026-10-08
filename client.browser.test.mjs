import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const coreRoot = process.env.DSH_TEST_CORE_ROOT;
if (!coreRoot || !process.env.DSH_TEST_PLAYWRIGHT_MODULE) throw new Error('Set DSH_TEST_CORE_ROOT and DSH_TEST_PLAYWRIGHT_MODULE; see README.');
const frontend = resolve(coreRoot, 'dsh-web-frontend/dist');
const html = await readFile(join(frontend, 'index.html'), 'utf8');
const mainPath = /src="\.\/(assets\/index-[^"]+\.js)"/u.exec(html)?.[1];
if (!mainPath) throw new Error('Unsupported DSH frontend bundle: entry script missing.');
const main = await readFile(join(frontend, mainPath), 'utf8');
const react = /return\{react:(\w+),"react\/jsx-runtime":\w+,"react-dom":\w+,"react-dom\/client":(\w+)/u.exec(main);
const boot = main.lastIndexOf('const fo=globalThis.dshDesktopBoot');
if (!react || boot < 0) throw new Error('Unsupported DSH frontend bundle: React seam changed.');
// Expose the installed renderer in an isolated test page, without booting DSH
// or accessing its real profile. Installed application files are read only.
const renderer = main.slice(0, boot) + `\nexport { ${react[1]} as React, ${react[2]} as ReactDOM };`;
const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
const fixture = await readFile(new URL('./client.browser.fixture.mjs', import.meta.url), 'utf8');
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta charset="utf-8"><title>DSH handoff isolated UI regression</title>'); return; }
    response.setHeader('Content-Type', 'text/javascript');
    if (pathname === '/fixture.mjs') { response.end(fixture); return; }
    if (pathname === '/assets/test-renderer.js') { response.end(renderer); return; }
    const file = resolve(frontend, '.' + pathname);
    if (!file.startsWith(frontend + sep) || !file.endsWith('.js')) { response.statusCode = 404; response.end(); return; }
    response.end(await readFile(file));
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const playwright = await import(pathToFileURL(resolve(process.env.DSH_TEST_PLAYWRIGHT_MODULE)).href);
  const { chromium } = playwright.default ?? playwright;
  browser = await chromium.launch({ headless: true,
    ...(process.env.DSH_TEST_BROWSER_EXE ? { executablePath: process.env.DSH_TEST_BROWSER_EXE } : { channel: 'msedge' }) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const results = await page.evaluate(async source => {
    const { runClientTests } = await import('/fixture.mjs');
    const { React, ReactDOM } = await import('/assets/test-renderer.js');
    return runClientTests(source, React, ReactDOM);
  }, source);
  assert.equal(results.length, 10);
  assert.ok(results.every(result => result.pass));
  if (process.env.DSH_TEST_BROWSER_RESULTS) await writeFile(process.env.DSH_TEST_BROWSER_RESULTS, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
