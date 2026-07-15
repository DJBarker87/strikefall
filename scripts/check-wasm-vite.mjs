import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { build } from 'vite'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const smokeRoot = join(root, 'scripts/wasm-smoke')
const output = join(root, 'target/wasm-vite-smoke')

await build({
  configFile: false,
  root: smokeRoot,
  build: {
    emptyOutDir: true,
    outDir: output,
  },
})

let servedWasm = false
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
])

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    const relative = requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname.slice(1)
    const candidate = normalize(join(output, relative))
    if (!candidate.startsWith(`${output}/`) && candidate !== join(output, 'index.html')) {
      response.writeHead(403).end()
      return
    }
    const metadata = await stat(candidate)
    if (!metadata.isFile()) throw new Error('not a file')
    const extension = extname(candidate)
    if (extension === '.wasm') servedWasm = true
    response.writeHead(200, { 'Content-Type': contentTypes.get(extension) ?? 'application/octet-stream' })
    response.end(await readFile(candidate))
  } catch {
    response.writeHead(404).end()
  }
})

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
assert(address && typeof address === 'object')

let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${address.port}/`)
  await page.waitForFunction(() => ['ready', 'error', 'unsupported'].includes(document.documentElement.dataset.wasmStatus ?? ''))
  const status = await page.locator('html').getAttribute('data-wasm-status')
  const outputText = await page.locator('#output').textContent()
  assert.equal(status, 'ready', outputText ?? 'WASM smoke entry did not become ready')
  assert.match(outputText ?? '', /^4 decks · quote [0-9]+ · barrier [0-9]+$/)
  assert.equal(servedWasm, true, 'production page did not request Vite’s emitted WASM asset')

  const errorPage = await browser.newPage()
  await errorPage.goto(`http://127.0.0.1:${address.port}/?invalid`)
  await errorPage.waitForFunction(() => document.documentElement.dataset.wasmStatus === 'error')
  assert.match((await errorPage.locator('#output').textContent()) ?? '', /initialization failed/i)

  const unsupportedPage = await browser.newPage()
  await unsupportedPage.addInitScript(() => {
    Object.defineProperty(globalThis, 'WebAssembly', { configurable: true, value: undefined })
  })
  await unsupportedPage.goto(`http://127.0.0.1:${address.port}/`)
  await unsupportedPage.waitForFunction(() => document.documentElement.dataset.wasmStatus === 'unsupported')
  assert.match((await unsupportedPage.locator('#output').textContent()) ?? '', /does not provide the WebAssembly APIs/i)
} finally {
  try {
    if (browser) await browser.close()
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    )
  }
}

console.log('Production Vite bundle verified ready, error, and unsupported WASM states in Chromium.')
