var braidify = require('../braid-http-server.js')
var sendfile = (f, req, res) => res.end(require('fs').readFileSync(require('path').join(__dirname, f)))
var http = require('../braid-http-client.js').http(require('http'))
var https = require('../braid-http-client.js').http(require('https'))
var braid_fetch = require('../braid-http-client.js').fetch

allow_self_signed_certs()

let port = 9000
let test_update = {
    version: ['test'],
    parents: ['oldie'],
    body: JSON.stringify({this: 'stuff'})
}
let retries_left = 4
let giveup_completely_set = {}
let faulty_mux_i = 0

process.on("unhandledRejection", (x) =>
    console.log(`unhandledRejection: ${x.stack}`)
)
process.on("uncaughtException", (x) =>
    console.log(`uncaughtException: ${x.stack}`)
)

require('http2').createSecureServer({
     key: require('fs').readFileSync('./test/localhost-privkey.pem'),
     cert: require('fs').readFileSync('./test/localhost-cert.pem'),
     allowHTTP1: true
   },
    async (req, res) => {
        console.log('Request:', req.url, req.method)

        // Only allow connections from localhost
        if (req.socket.remoteAddress !== '127.0.0.1'
            && req.socket.remoteAddress !== '::1'
            && req.socket.remoteAddress !== '::ffff:127.0.0.1'
        ) {
            console.log(`connection attempt from: ${req.socket.remoteAddress}`)
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden: Only localhost connections are allowed');
            return;
        }

        // MULTIPLEX
        var is_mux = req.method === 'MULTIPLEX' || req.url.startsWith('/.well-known/multiplex/')
        if (is_mux) {
            var [multiplexer, stream] = req.url.split('/').slice(req.method === 'MULTIPLEX' ? 1 : 3)
        }

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
        } else if (is_mux && multiplexer === 'bad_mux_well_known_url' && req.url.startsWith('/.well-known/multiplex/')) {
            res.writeHead(500)
            return res.end('')
        } else if (is_mux && stream === 'bad_stream') {
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
            });
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
            if ((await eval_func()) !== 'keep going') return

        // Braidifies our server
        braidify(req, res)

        if (req.url.startsWith('/eval') && req.method === 'POST')
            if ((await eval_func()) !== 'keep going') return

        // MULTIPLEX
        if (req.is_multiplexer) return
        if (req.url === '/kill_mux') {
            braidify.multiplexers?.get(req.headers.mux)?.res.end('AAAAA')
            return res.end(`ok`)
        }

        // We'll serve Braid at the /json route!
        if (req.url === '/json' && req.method === 'GET') {
            res.setHeader('content-type', req.headers.charset ? 'application/json; charset=utf-8' : 'application/json')
            // res.setHeader('accept-subscribe', 'true')

            if (giveup_completely_set[req.headers.giveup_completely]) {
                res.statusCode = 500
                return res.end()
            }

            // If the client requested a subscription, let's honor it!
            if (req.subscribe)
                res.startSubscription()

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
            if (req.headers.send_binary_body_blob) await res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: new Blob([new Uint8Array([0, 1, 2, 3])])
            })
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
            if (req.headers.send_binary_patch_blob) await res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patch: {unit: 'text', range: '[0:0]', content: new Blob([new Uint8Array([0, 1, 2, 3])])}
            })
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
                    {unit: 'text', range: '[0:0]', content: new Blob([new Uint8Array([0, 1, 2, 3])])},
                    {unit: 'text', range: '[0:0]', content: new Blob([new Uint8Array([10, 11, 12, 13])])}
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

            if (req.headers.giveup) return res.end()
            if (req.headers.giveup_completely) {
                giveup_completely_set[req.headers.giveup_completely] = true
                return res.end()
            }

            if (req.subscribe) {
                // Send a patch
                res.sendUpdate({
                    VersiOn: ['test1'],             // Upper/lowercase is ignored
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
        else if (req.url === '/')
            sendfile('client.html', req, res)
        else if (req.url === '/braid-http-client.js')
            sendfile('../braid-http-client.js', req, res)
        else if (req.url === '/test-responses.txt')
            sendfile('test-responses.txt', req, res)

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
            const buffer = Buffer.alloc(256);
            for (let i = 0; i < 256; i++) buffer[i] = i;

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
                });
                res.end(buffer);
            }
        } else if (req.url === '/noheartbeat') {
            res.writeHead(209, {
                'Content-Type': 'text/plain',
                Connection: 'keep-alive',
                Heartbeats: req.headers['heartbeats']
            })
            res.write('hi')
            return
        } else if (req.url === '/parse_error') {
            res.startSubscription()

            res.write(`hello: true\r\n`)
            res.write(`hello\r\n`)
            res.write('Content-Length: 2\r\n')
            res.write('\r\n')
            res.write('hi')
        }
    }

).listen(port, (...args) => {
    console.log(args)
    console.log(`Listening on https://localhost:${port}...`)
})

function allow_self_signed_certs() {
    // see https://github.com/nodejs/node/issues/43187
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
