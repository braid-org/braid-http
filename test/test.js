#!/usr/bin/env node

// Unified test runner - can run in console mode (Node.js) or browser mode (server)
const fs = require('fs')
const path = require('path')
const defineTests = require('./tests.js')
const {braidify, free_cors} = require('../braid-http-server.js')
const https = require('../braid-http-client.js').http(require('https'))
const braid_fetch = require('../braid-http-client.js').fetch
const multiplex_fetch = require('../braid-http-client.js').multiplex_fetch

// Parse command line arguments
const args = process.argv.slice(2)
const mode = args.includes('--browser') || args.includes('-b') ? 'browser' : 'console'
const filterArg = args.find(arg => arg.startsWith('--filter='))?.split('=')[1]
    || args.find(arg => arg.startsWith('--grep='))?.split('=')[1]

// Show help if requested
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node test/test.js [options]

Options:
  --browser, -b          Start server for browser testing (default: console mode)
  --filter=PATTERN       Only run tests matching pattern (case-insensitive)
  --grep=PATTERN         Alias for --filter
  --help, -h             Show this help message

Examples:
  node test/test.js                      # Run all tests in console
  node test/test.js --filter="version"   # Run only tests with "version" in name
  node test/test.js --browser            # Start browser test server
  node test/test.js -b                   # Short form for browser mode
`)
    process.exit(0)
}

// Allow self-signed certs for localhost testing
if (typeof fetch !== 'undefined') allow_self_signed_certs()

// Server configuration
const port = 9000
const test_update = {
    version: ['test'],
    parents: ['oldie'],
    body: JSON.stringify({this: 'stuff'})
}
let retries_left = 4
let giveup_completely_set = {}
let faulty_mux_i = 0
let deleted_request_count = {}

process.on("unhandledRejection", (x) => {
    if (mode === 'browser') console.log(`unhandledRejection: ${x.stack}`)
})
process.on("uncaughtException", (x) =>
    console.log(`uncaughtException: ${x.stack}`)
)

// ============================================================================
// Test Server
// ============================================================================

function createTestServer() {
    const server = require('http2').createSecureServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem')),
        allowHTTP1: true
    }, async (req, res) => {
        console.log('Request:', req.url, req.method)

        // Only allow connections from localhost
        if (req.socket.remoteAddress !== '127.0.0.1'
            && req.socket.remoteAddress !== '::1'
            && req.socket.remoteAddress !== '::ffff:127.0.0.1'
        ) {
            console.log(`connection attempt from: ${req.socket.remoteAddress}`)
            res.writeHead(403, { 'Content-Type': 'text/plain' })
            res.end('Forbidden: Only localhost connections are allowed')
            return
        }

        // MULTIPLEX
        var is_mux = req.method === 'MULTIPLEX' || req.url.startsWith('/.well-known/multiplexer/')
        if (is_mux) {
            var [multiplexer, request] = req.url.split('/').slice(req.method === 'MULTIPLEX' ? 1 : 3)
        }

        if (is_mux && request) deleted_request_count[request] = (deleted_request_count[request] ?? 0) + 1

        if (is_mux && multiplexer === 'faulty_mux') {
            faulty_mux_i++
            if (faulty_mux_i === 1) {
                res.writeHead(425)
                return res.end('')
            }
        } else if (is_mux && multiplexer === 'bad_mux') {
            res.writeHead(500)
            return res.end('')
        } else if (is_mux && multiplexer === 'bad_mux_method' && req.method === 'MULTIPLEX') {
            res.writeHead(500)
            return res.end('')
        } else if (is_mux && multiplexer === 'bad_mux_well_known_url' && req.url.startsWith('/.well-known/multiplexer/')) {
            res.writeHead(500)
            return res.end('')
        } else if (is_mux && request === 'bad_request') {
            res.writeHead(500)
            return res.end('')
        } else if (req.url === '/500') {
            res.writeHead(500)
            return res.end('')
        }

        if (req.headers.pre_delay_ms) await new Promise(done => setTimeout(done, parseFloat(req.headers.pre_delay_ms)))

        var eval_func = () => new Promise((done, fail) => {
            let body = ''
            req.on('data', chunk => {
                body += chunk.toString()
            })
            req.on('end', () => {
                try {
                    done(eval(body))
                } catch (error) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' })
                    res.end(`Error: ${error.message}`)
                    fail(error)
                }
            })
        })

        if (req.url.startsWith('/eval_pre_braidify') && req.method === 'POST')
            if ((await eval_func()) !== 'keep going') return res.end('ok')

        // Braidifies our server
        braidify(req, res)
        if (req.is_multiplexer) return

        if (req.url.startsWith('/eval') && req.method === 'POST')
            if ((await eval_func()) !== 'keep going') return

        // MULTIPLEX
        if (req.url === '/kill_mux') {
            braidify.multiplexers?.get(req.headers.mux)?.res.end('AAAAA')
            return res.end(`ok`)
        }
        if (is_mux) res.end('hm..')

        // We'll serve Braid at the /json route!
        if (req.url.startsWith('/json') && req.method === 'GET') {
            res.setHeader('content-type', req.headers.charset ? 'application/json; charset=utf-8' : 'application/json')

            if (giveup_completely_set[req.headers.giveup_completely]) {
                res.statusCode = 500
                return res.end()
            }

            // If the client requested a subscription, let's honor it!
            if (req.subscribe)
                res.startSubscription()

            // test writing header after startSubscription
            res.setHeader('post-sub-header', 'yup')

            // Send the current version
            if (!req.headers.skip_first) res.sendUpdate(test_update)

            res.multiplexer?.write('\r\r\n\r\r')

            if (req.headers.send_unicode_version) res.sendUpdate({
                version: ['hello🌍-0'],
                body: 'hi'
            })
            if (req.headers.send_unicode_parents) res.sendUpdate({
                parents: ['hello🌍-0', '🌈-5'],
                body: 'hi'
            })

            // Send a binary body update
            if (req.headers.send_binary_body_arraybuffer) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: new Uint8Array([0, 1, 2, 3]).buffer
            })
            if (req.headers.send_binary_body) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: new Uint8Array([0, 1, 2, 3])
            })
            if (req.headers.send_binary_body_blob) {
                await res.sendUpdate({
                    version: ['test'],
                    parents: ['oldie'],
                    body: typeof Blob !== 'undefined' ?
                        new Blob([new Uint8Array([0, 1, 2, 3])]) :
                        'old node version'
                })
            }
            if (req.headers.send_binary_body_buffer) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: Buffer.from(new Uint8Array([0, 1, 2, 3]))
            })

            // Send a binary patch update
            if (req.headers.send_binary_patch_arraybuffer) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patch: {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3]).buffer}
            })
            if (req.headers.send_binary_patch) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patch: {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3])}
            })
            if (req.headers.send_binary_patch_blob) {
                await res.sendUpdate({
                    version: ['test'],
                    parents: ['oldie'],
                    patch: {unit: 'text', range: '[0:0]', content: typeof Blob !== 'undefined' ? new Blob([new Uint8Array([0, 1, 2, 3])]) : 'old node version'}
                })
            }
            if (req.headers.send_binary_patch_buffer) await res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patch: {unit: 'text', range: '[0:0]', content: Buffer.from(new Uint8Array([0, 1, 2, 3]))}
            })

            // binary patches
            if (req.headers.send_binary_patches_arraybuffer) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3]).buffer},
                    {unit: 'text', range: '[0:0]', content: new Uint8Array([10, 11, 12, 13]).buffer}
                ]
            })
            if (req.headers.send_binary_patches) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3])},
                    {unit: 'text', range: '[0:0]', content: new Uint8Array([10, 11, 12, 13])}
                ]
            })
            if (req.headers.send_binary_patches_blob) await res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: typeof Blob !== 'undefined' ? new Blob([new Uint8Array([0, 1, 2, 3])]) : 'old node version'},
                    {unit: 'text', range: '[0:0]', content: typeof Blob !== 'undefined' ? new Blob([new Uint8Array([10, 11, 12, 13])]) : 'old node version'}
                ]
            })
            if (req.headers.send_binary_patches_buffer) await res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: Buffer.from(new Uint8Array([0, 1, 2, 3]))},
                    {unit: 'text', range: '[0:0]', content: Buffer.from(new Uint8Array([10, 11, 12, 13]))}
                ]
            })

            if (req.headers.giveup) return setTimeout(() => res.end(), 300)
            if (req.headers.giveup_completely) {
                giveup_completely_set[req.headers.giveup_completely] = true
                return setTimeout(() => res.end(), 300)
            }

            if (req.subscribe) {
                // Send a patch
                res.sendUpdate({
                    VersiOn: ['test1'],
                    ParEnts: ['oldie', 'goodie'],
                    patch: {unit: 'json', range: '[1]', content: '1'},
                    hash: '42',
                    ':status': '115'
                })

                // Send a patch as array
                res.sendUpdate({
                    Version: ['test2'],
                    patch: {unit: 'json', range: '[2]', content: '2'}
                })

                // Send two patches as array
                res.sendUpdate({
                    version: ['test3'],
                    patches: [{unit: 'json', range: '[3]', content: '3', hash: '43'},
                              {unit: 'json', range: '[4]', content: '4'}]
                })

                // Simulate an update after the fact
                setTimeout(() => res.sendUpdate({version: ['another!'], body: '"!"'}), 200)
            }

            // End the response, if this isn't a subscription
            if (!req.subscribe) {
                res.statusCode = 200
                res.end()
            }
        }

        // We'll accept Braid at the /json PUTs!
        if (req.url === '/json' && req.method === 'PUT') {
            if (req.headers.check_patch_content_text) {
                let update = await req.parseUpdate()
                for (let p of update.patches)
                    res.write('' + p.content_text + '\n')
            } else if (req.headers.check_patch_binary) {
                let update = await req.parseUpdate()
                for (let p of update.patches)
                    res.write('' + p.content + '\n')
            } else if (req.headers.check_everything_patch_content_text) {
                let patches = await req.patches()
                res.write(patches[0].content_text)
            } else if (req.headers.check_everything_patch_binary) {
                let patches = await req.patches()
                res.write('' + patches[0].content)
            } else if (req.headers.check_body_binary) {
                let update = await req.parseUpdate()
                res.write('' + update.body)
            } else if (req.headers.check_body_text) {
                let update = await req.parseUpdate()
                res.write(update.body_text)
            }
            res.statusCode = 200
            res.end()
        }

        // Static HTML routes here:
        var pathname = req.url.split('?')[0]
        if (pathname === '/' || pathname === '/client.html')
            res.end(fs.readFileSync(path.join(__dirname, 'client.html')))
        else if (req.url === '/braid-http-client.js')
            res.end(fs.readFileSync(path.join(__dirname, '..', 'braid-http-client.js')))
        else if (req.url === '/tests.js')
            res.end(fs.readFileSync(path.join(__dirname, 'tests.js')))
        else if (req.url === '/test-responses.txt')
            res.end(fs.readFileSync(path.join(__dirname, 'test-responses.txt')))

        // New routes for tests
        if (req.url === "/400") {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: 400 }))
        } else if (req.url === "/401") {
            res.writeHead(401, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: 401 }))
        } else if (req.url === "/keep_open") {
        } else if (req.url === "/check_parents") {
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ parents: req.headers.parents }))
        } else if (req.url === "/retry") {
            if (retries_left > 0) {
                retries_left--
                res.writeHead(408, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ error: 408 }))
            } else {
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify(test_update))
            }
        } else if (req.url === '/binary') {
            const buffer = Buffer.alloc(256)
            for (let i = 0; i < 256; i++) buffer[i] = i

            if (req.subscribe) {
                res.startSubscription()
                res.sendUpdate({
                    version: ['test'],
                    parents: ['oldie'],
                    body: buffer
                })
            } else {
                res.writeHead(200, {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": buffer.length
                })
                res.end(buffer)
            }
        } else if (req.url === '/noheartbeat') {
            res.setHeader('Heartbeats', req.headers['heartbeats'])
            delete req.headers['heartbeats']
            res.startSubscription()
            res.sendUpdate(test_update)
            return
        } else if (req.url === '/parse_error') {
            res.startSubscription()
            res.write(`hello: true\r\n`)
            res.write(`hello\r\n`)
            res.write('Content-Length: 2\r\n')
            res.write('\r\n')
            res.write('hi')
        }
    })

    return server
}

function createExpressMiddlewareServer() {
    const express_app = require("express")()

    express_app.use((req, res, next) => {
        if (req.socket.remoteAddress !== '127.0.0.1'
            && req.socket.remoteAddress !== '::1'
            && req.socket.remoteAddress !== '::ffff:127.0.0.1'
        ) {
            res.writeHead(403, { 'Content-Type': 'text/plain' })
            res.end('Forbidden: Only localhost connections are allowed')
            return
        }
        next()
    })

    express_app.use(braidify)

    express_app.use((req, res, next) => {
        free_cors(res)
        if (req.method === 'OPTIONS') return res.end('')
        next()
    })

    express_app.get("/middleware-test", (req, res) => {
        if (mode === 'browser') console.log('Express-Request:', req.url, req.method)

        if (typeof res.startSubscription === "function" && typeof res.sendUpdate === "function") {
            if (req.subscribe) {
                res.startSubscription()
                res.sendUpdate({
                    version: ["middleware-works"],
                    body: "Braidify works as Express middleware!",
                })
            } else {
                res.json({ success: true, message: "Braidify works as Express middleware!" })
            }
        } else {
            res.status(500).end('not ok')
        }
    })

    return https.createServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem'))
    }, express_app)
}

function createWrapperServer() {
    return https.createServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem'))
    }, braidify(async (req, res) => {
        if (mode === 'browser') console.log('Wrapped-Handler-Request:', req.url, req.method)

        if (req.socket.remoteAddress !== '127.0.0.1'
            && req.socket.remoteAddress !== '::1'
            && req.socket.remoteAddress !== '::ffff:127.0.0.1'
        ) {
            res.writeHead(403, { 'Content-Type': 'text/plain' })
            res.end('Forbidden: Only localhost connections are allowed')
            return
        }

        free_cors(res)
        if (req.method === 'OPTIONS') return res.end()

        if (req.url === '/wrapper-test' && req.method === 'GET') {
            res.setHeader('content-type', 'application/json')

            if (req.subscribe)
                res.startSubscription()

            res.sendUpdate({
                version: ['wrapper-test-version'],
                body: JSON.stringify({ message: "Braidify works as a wrapper function!" })
            })

            if (!req.subscribe) {
                res.end()
            } else {
                setTimeout(() => {
                    res.sendUpdate({
                        version: ['wrapper-test-update'],
                        body: JSON.stringify({ message: "This is an update!" })
                    })
                }, 200)
            }
        } else if (req.url === '/eval') {
            var body = ''
            req.on('data', chunk => body += chunk.toString())
            req.on('end', () => {
                try {
                    eval(body)
                } catch (error) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' })
                    res.end(`Error: ${error.message}`)
                }
            })
        } else {
            res.writeHead(404)
            res.end('Not found')
        }
    }))
}

function allow_self_signed_certs() {
    fetch().catch(() => { })
    var globalDispatcherSymbol = Symbol.for('undici.globalDispatcher.1')
    var Agent = globalThis[globalDispatcherSymbol].constructor

    Object.defineProperty(globalThis, globalDispatcherSymbol, {
        value: new Agent({ connect: { rejectUnauthorized: false } }),
        writable: true,
        enumerable: false,
        configurable: false
    })
}

// HTTP/2 fetch wrapper - needed because Node's native fetch uses HTTP/1.1
// which doesn't support custom methods like MULTIPLEX
function createHttp2Fetch(baseUrl) {
    const http2 = require('http2')
    const { URL } = require('url')

    // Keep a session pool for reuse
    const sessions = new Map()

    function getSession(origin) {
        if (!sessions.has(origin)) {
            const session = http2.connect(origin, { rejectUnauthorized: false })
            session.on('error', () => sessions.delete(origin))
            session.on('close', () => sessions.delete(origin))
            sessions.set(origin, session)
        }
        return sessions.get(origin)
    }

    return async function http2Fetch(url, options = {}) {
        const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`

        // use regular fetch when we can..
        if (options.method !== 'MULTIPLEX')
            return fetch(fullUrl, options)

        const parsedUrl = new URL(fullUrl)
        const origin = parsedUrl.origin

        const client = getSession(origin)

        const headers = {
            ':method': options.method || 'GET',
            ':path': parsedUrl.pathname + parsedUrl.search,
        }

        // Add custom headers
        if (options.headers) {
            const h = options.headers instanceof Headers ? Object.fromEntries(options.headers) : options.headers
            for (const [key, value] of Object.entries(h)) {
                headers[key.toLowerCase()] = value
            }
        }

        const req = client.request(headers)

        // Send body if present
        if (options.body) {
            req.write(options.body)
        }
        req.end()

        return new Promise((resolve, reject) => {
            req.on('error', reject)
            req.on('response', (responseHeaders) => {
                const status = responseHeaders[':status']

                // For streaming responses, we need to provide a reader that
                // returns data as it arrives, not wait for 'end'
                let dataQueue = []
                let dataResolve = null
                let ended = false

                req.on('data', chunk => {
                    if (dataResolve) {
                        dataResolve({ done: false, value: new Uint8Array(chunk) })
                        dataResolve = null
                    } else {
                        dataQueue.push(chunk)
                    }
                })

                req.on('end', () => {
                    ended = true
                    if (dataResolve) {
                        dataResolve({ done: true, value: undefined })
                        dataResolve = null
                    }
                })

                // Create a fetch-like Response object
                const body = {
                    getReader: () => ({
                        read: async () => {
                            if (dataQueue.length > 0) {
                                return { done: false, value: new Uint8Array(dataQueue.shift()) }
                            }
                            if (ended) {
                                return { done: true, value: undefined }
                            }
                            return new Promise(resolve => {
                                dataResolve = resolve
                            })
                        }
                    })
                }
                const response = {
                    ok: status >= 200 && status < 300,
                    status,
                    headers: {
                        get: (name) => responseHeaders[name.toLowerCase()]
                    },
                    body,
                    text: async () => {
                        const chunks = []
                        const reader = body.getReader()
                        while (true) {
                            const { done, value } = await reader.read()
                            if (done) break
                            chunks.push(Buffer.from(value))
                        }
                        return Buffer.concat(chunks).toString()
                    },
                    json: async function() { return JSON.parse(await response.text()) }
                }
                resolve(response)
            })
        })
    }
}

// ============================================================================
// Console Test Mode (Node.js)
// ============================================================================

async function runConsoleTests() {
    // Test tracking
    let totalTests = 0
    let passedTests = 0
    let failedTests = 0
    let skippedTests = 0

    // Store tests to run sequentially
    const testsToRun = []

    // Create wrapped fetch that points to localhost
    // Use HTTP/2 fetch for og_fetch since Node's native fetch uses HTTP/1.1
    // which doesn't support custom methods like MULTIPLEX
    const og_fetch = createHttp2Fetch(`https://localhost:${port}`)
    const wrappedFetch = async (url, options = {}) => {
        const fullUrl = url.startsWith('http') ? url : `https://localhost:${port}${url}`
        return braid_fetch(fullUrl, options)
    }
    // Expose set_fetch on wrappedFetch so tests can call it
    wrappedFetch.set_fetch = braid_fetch.set_fetch

    // Create a wrapped braid_fetch that handles relative URLs for Node.js
    const wrappedBraidFetch = (url, options = {}) => {
        const fullUrl = url.startsWith('http') ? url : `https://localhost:${port}${url}`
        return braid_fetch(fullUrl, options)
    }
    // Copy properties from braid_fetch
    wrappedBraidFetch.set_fetch = braid_fetch.set_fetch
    Object.defineProperty(wrappedBraidFetch, 'enable_multiplex', {
        get: () => braid_fetch.enable_multiplex,
        set: (v) => { braid_fetch.enable_multiplex = v }
    })
    Object.defineProperty(wrappedBraidFetch, 'reconnect_delay_ms', {
        get: () => braid_fetch.reconnect_delay_ms,
        set: (v) => { braid_fetch.reconnect_delay_ms = v }
    })

    // multiplex_fetch is imported from braid-http-client.js

    function addSectionHeader(headerText) {
        addSectionHeader.currentSection = headerText
    }

    // In console mode, waitForTests queues a callback to run after all previous tests
    // We store it as a special entry in testsToRun
    function waitForTests(cb) {
        testsToRun.push({ isWaitCallback: true, callback: cb })
    }

    function runTest(testName, testFunction, expectedResult) {
        // Apply filter if specified
        if (filterArg && !testName.toLowerCase().includes(filterArg.toLowerCase())) {
            skippedTests++
            return
        }

        totalTests++
        const section = addSectionHeader.currentSection
        testsToRun.push({ testName, testFunction, expectedResult, section })
    }

    console.log('Starting braid-http tests...\n')

    // Start the servers
    const mainServer = createTestServer()
    const expressServer = createExpressMiddlewareServer()
    const wrapperServer = createWrapperServer()

    await new Promise(resolve => mainServer.listen(port, resolve))
    await new Promise(resolve => expressServer.listen(port + 1, resolve))
    await new Promise(resolve => wrapperServer.listen(port + 2, resolve))

    console.log(`Test server running on https://localhost:${port}`)

    // Define all tests
    // Note: tests.js manages braid_fetch.enable_multiplex itself
    defineTests(runTest, {
        fetch: wrappedFetch,
        og_fetch,  // Already configured with baseUrl
        port,
        addSectionHeader,
        waitForTests,
        test_update: { ...test_update, status: "200" },
        multiplex_fetch,
        braid_fetch: wrappedBraidFetch,
        baseUrl: `https://localhost:${port}`  // For building expected values in tests
    })

    // Run tests sequentially
    let currentSection = null
    for (const item of testsToRun) {
        // Handle waitForTests callbacks
        if (item.isWaitCallback) {
            item.callback()
            continue
        }

        const { testName, testFunction, expectedResult, section } = item
        if (section && section !== currentSection) {
            currentSection = section
            console.log(`\n--- ${section} ---`)
        }

        try {
            const timeout_ms = 30000
            const result = await Promise.race([
                testFunction(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Test timed out after ${timeout_ms/1000}s`)), timeout_ms))
            ])
            if (result == expectedResult) {
                passedTests++
                console.log(`✓ ${testName}`)
            } else if (result === 'old node version') {
                skippedTests++
                console.log(`○ ${testName} (skipped: old node version)`)
            } else {
                failedTests++
                console.log(`✗ ${testName}`)
                console.log(`  Expected: ${expectedResult}`)
                console.log(`  Got: ${result}`)
            }
        } catch (error) {
            failedTests++
            console.log(`✗ ${testName}`)
            console.log(`  Error: ${error.message || error}`)
        }
    }

    // Print summary
    console.log('\n' + '='.repeat(50))
    console.log(`Total: ${totalTests} | ✓ : ${passedTests} | ✗ : ${failedTests} | Skipped: ${skippedTests}`)
    console.log('='.repeat(50))

    // Close servers
    mainServer.close()
    expressServer.close()
    wrapperServer.close()

    // Close all connections if available (Node 18.2+)
    if (typeof mainServer.closeAllConnections === 'function') {
        mainServer.closeAllConnections()
        expressServer.closeAllConnections()
        wrapperServer.closeAllConnections()
    }

    setTimeout(() => process.exit(failedTests > 0 ? 1 : 0), 100)
}

// ============================================================================
// Browser Test Mode (Server)
// ============================================================================

async function runBrowserMode() {
    const mainServer = createTestServer()
    const expressServer = createExpressMiddlewareServer()
    const wrapperServer = createWrapperServer()

    await new Promise(resolve => mainServer.listen(port, resolve))
    await new Promise(resolve => expressServer.listen(port + 1, resolve))
    await new Promise(resolve => wrapperServer.listen(port + 2, resolve))

    console.log(`Test server running on https://localhost:${port}`)
    console.log(`Express middleware test server running on port ${port + 1}`)
    console.log(`Wrapper function test server running on port ${port + 2}`)
    var url = filterArg
        ? `https://localhost:${port}/?filter=${encodeURIComponent(filterArg)}`
        : `https://localhost:${port}/`
    console.log(`\nOpening ${url} in your browser...`)
    if (filterArg) console.log(`Filter: ${filterArg}`)

    // Auto-open browser
    var {exec} = require('child_process')
    var cmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start' : 'xdg-open'
    exec(`${cmd} "${url}"`)
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    if (mode === 'browser') {
        await runBrowserMode()
    } else {
        await runConsoleTests()
    }
}

main().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
