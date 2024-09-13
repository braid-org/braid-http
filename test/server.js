var braidify = require('../braid-http-server.js')
var sendfile = (f, req, res) => res.end(require('fs').readFileSync(require('path').join(__dirname, f)))
var http = require('../braid-http-client.js').http(require('http'))

let port = 9000
let test_update = {
    version: ['test'],
    parents: ['oldie'],
    body: JSON.stringify({this: 'stuff'})
}
let retries_left = 4

require('http').createServer(
    (req, res) => {
        // Only allow connections from localhost
        if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1') {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden: Only localhost connections are allowed');
            return;
        }

        // Braidifies our server
        braidify(req, res)

        console.log('Request:', req.url, req.method,
                    req.subscribe ? ('Subscribe: ' + req.subscribe)
                    : 'no subscription')

        // New eval endpoint
        if (req.url.startsWith('/eval') && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    eval(body);
                } catch (error) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end(`Error: ${error.message}`);
                }
            });
            return;
        }

        // We'll serve Braid at the /json route!
        if (req.url === '/json' && req.method === 'GET') {
            res.setHeader('content-type', 'application/json')
            // res.setHeader('accept-subscribe', 'true')

            // If the client requested a subscription, let's honor it!
            if (req.subscribe)
                res.startSubscription()

            // Send the current version
            res.sendUpdate(test_update)

            if (req.headers.giveup) return res.end()

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
            req.parseUpdate().then(update => {
                console.log('We got PUT', req.version, 'update', update)
                res.statusCode = 200
                res.end()
            })
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
        }
    }

).listen(port, () => console.log(`Listening on http://localhost:${port}...`))
