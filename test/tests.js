// Shared test definitions that work in both Node.js and browser environments
// This file exports a function that takes a test runner and context

function define_tests(run_test, context) {
    var { fetch, og_fetch, port, add_section_header, test_update, multiplex_fetch, braid_fetch, reliable_update_channel, update_pipe, base_url, assert } = context
    // base_url is empty in browser, 'https://localhost:${port}' in console tests
    base_url = base_url || ''

    // Registers a new handler on a test server and returns the full URL to hit
    // it. The handler runs server-side, so we send its source over the wire.
    async function add_handler(server_url, handler) {
        var r = await og_fetch(`${server_url}/add-handler`, {
            method: 'POST',
            body: handler.toString()
        })
        return `${server_url}${await r.text()}`
    }

    // Adds a handler to the main test server (port).
    function add_main_handler(handler) {
        return add_handler(base_url, handler)
    }

    // Adds a pre-braidify handler to the main test server -- it runs before
    // braidify on every request, gets (req, res), and should return
    // true if it handled the response. Unlike add_main_handler, this can
    // intercept MULTIPLEX / .well-known/multiplexer requests, which braidify
    // would otherwise consume. See /add-pre-braidify-handler in test.js.
    function add_pre_braidify_handler(handler) {
        return og_fetch(`${base_url}/add-pre-braidify-handler`, {
            method: 'POST',
            body: handler.toString()
        })
    }

    // Adds a handler to the Express middleware server (port + 1).
    function add_express_handler(handler) {
        return add_handler(`https://localhost:${port + 1}`, handler)
    }

    // Adds a handler to the braidify-wrapper server (port + 2).
    function add_wrapper_handler(handler) {
        return add_handler(`https://localhost:${port + 2}`, handler)
    }

add_section_header("Multiplexing Tests")

var multiplex_version = '1.0'
braid_fetch.enable_multiplex = {after: Infinity}

run_test(
    "Basic MULTIPLEX method test.",
    async () => {
        // do a MULTIPLEX request
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var r = await og_fetch(`/${m}`, {
            signal: a.signal,
            method: 'MULTIPLEX',
            headers: {'Multiplex-Version': multiplex_version}
        })

        // make sure the request succeeded
        assert(r.ok, 'expected ok response')

        // we check for some content with getReader,
        // because the stream will remain open
        assert((await r.body.getReader().read()).value, 'expected body')
        
        a.abort()
    }
)

run_test(
    "Test multiplexing with Express middleware endpoint",
    async () => {
        // add handler to express server that
        // sends a subscription update
        var endpoint = await add_express_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hello' })
        })

        // subscribe to the endpoint we added,
        // forcing the request to be multiplexed
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: true,
        })

        // make sure the request was actually multiplexed
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // grab the first update off the subscription
        var update = await new Promise(done => r.subscribe(done))

        // make sure we got the body we expected
        assert(update.body_text === 'hello', 'got unexpected body')

        a.abort()
    }
)

run_test(
    "Test multiplexing with wrapper function endpoint",
    async () => {
        // add handler to the wrapper server that sends a subscription update
        var endpoint = await add_wrapper_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['v123'],
                body: 'hello'
            })
        })

        // subscribe to the endpoint we added,
        // forcing the request to be multiplexed
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: true,
        })

        // make sure the request was actually multiplexed
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // grab the first update off the subscription
        var update = await new Promise(done => r.subscribe(done))

        // make sure we got the body and version we expected
        assert(update.version[0] === 'v123', 'got unexpected version')
        assert(update.body_text === 'hello', 'got unexpected body')

        a.abort()
    }
)

run_test(
    "Test that when DELETE gets 404 for multiplexer, it kills the multiplexer",
    async () => {
        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        // add a handler that makes the server forget a multiplexer (named in a
        // header), so it will 404 the next time the client talks to it about it
        var forget_endpoint = await add_main_handler((req, res) => {
            braidify.multiplexers.delete(req.headers.forget_mux)
            res.end('ok')
        })

        // open a subscription multiplexed through a multiplexer of our choosing
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })

        // tell the server to forget the multiplexer
        await fetch(forget_endpoint, { headers: { forget_mux: m } })

        // abort the subscription -- this makes the client send a DELETE to
        // cancel its request on the multiplexer, which the server 404s,
        // tipping the client off that the whole multiplexer is dead
        a.abort()

        // wait for the client to clean up the now-dead multiplexer -- if it
        // never does, this loop spins until the test runner's timeout fails the
        // test; getting past it means the client really did drop the multiplexer
        while (multiplex_fetch.multiplexers[m])
            await new Promise(done => setTimeout(done, 10))
    }
)

run_test(
    "Test that multiplex request sets cache-control: no-store.",
    async () => {
        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        // open a subscription, creating a multiplexer of our choosing
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })

        // make a second multiplexed request through that same multiplexer,
        // and make sure its response is marked cache-control: no-store
        var s2 = Math.random().toString(36).slice(2)
        var r = await og_fetch(endpoint, {
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s2}`,
                'Multiplex-Version': multiplex_version
            }
        })
        assert(r.headers.get('cache-control') === 'no-store', 'expected no-store')

        a.abort()
    }
)

run_test(
    "Test multiplexer timing out because of no requests.",
    async () => {
        // a multiplexer with no active requests should die after an idle
        // period (not_used_timeout), and each new request should reset that
        // idle timer -- so the multiplexer only dies once it has been idle
        // for the full timeout

        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        var m = Math.random().toString(36).slice(2)
        var sleep = ms => new Promise(done => setTimeout(done, ms))

        // open a subscription through a multiplexer of our choosing, with a
        // 1000ms idle timeout, then abort it (leaving the multiplexer idle)
        var subscribe_then_abort = async () => {
            var a = new AbortController()
            var s = Math.random().toString(36).slice(2)
            await fetch(endpoint, {
                signal: a.signal,
                subscribe: true,
                multiplex: {not_used_timeout: 1000},
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
            })
            a.abort()
        }

        // first request: the multiplexer now exists
        await subscribe_then_abort()
        assert(multiplex_fetch.multiplexers[m], 'expected multiplexer after first request')

        // 800ms < 1000ms idle timeout, so it is still alive
        await sleep(800)
        assert(multiplex_fetch.multiplexers[m], 'expected multiplexer to survive 800ms idle')

        // second request resets the idle timer; 800ms later it is still alive
        await subscribe_then_abort()
        await sleep(800)
        assert(multiplex_fetch.multiplexers[m], 'expected idle timer to reset on second request')

        // another 400ms (1200ms total idle since the second request) exceeds
        // the timeout, so the multiplexer finally dies
        await sleep(400)
        assert(!multiplex_fetch.multiplexers[m], 'expected multiplexer to time out')
    }
)

run_test(
    "Test MULTIPLEX retrying when receiving 409 Conflict: Duplicate Multiplexer",
    async () => {
        // add a handler that just answers with a known body
        var endpoint = await add_main_handler((req, res) => res.end('woopee'))

        // pick our own multiplexer id, so the duplicate below is scoped to
        // *our* multiplexer (and not race with other tests' multiplexers)
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // pre-register a multiplexer with our chosen id directly in the
        // server's multiplexers Map. Now when the client tries to create a
        // multiplexer with this id, the real server code sees it already
        // exists and answers with a genuine 409 Conflict. The client should
        // retry with a fresh random id (which won't collide) and ultimately
        // get our handler's body.
        await og_fetch('/eval', {
            method: 'POST',
            body: `
                if (!braidify.multiplexers) braidify.multiplexers = new Map()
                braidify.multiplexers.set(${JSON.stringify(m)}, {requests: new Map(), res})
                res.end('ok')
            `
        })

        // make a multiplexed request through our chosen multiplexer: the client
        // should hit the 409, retry with a fresh multiplexer id, and ultimately
        // get our handler's body
        var res = await fetch(endpoint, {
            multiplex: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        assert(await res.text() === 'woopee', 'expected request to succeed after 409 retry')

        // make sure the request was actually multiplexed, and that the retry
        // moved it onto a *different* multiplexer than the colliding id we asked
        // for (the client should have picked a fresh one after the 409)
        assert(res.multiplexed_through, 'expected request to be multiplexed')
        assert(res.multiplexed_through.split('/')[3] !== m, 'expected a different multiplexer id after retry')

        // clean up the multiplexer we pre-registered
        await og_fetch('/kill_mux', {headers: {mux: m}})
    }
)

run_test(
    `Test for "Incremental: ?1" header in multiplexer response.`,
    async () => {
        // create a multiplexer with a MULTIPLEX request
        var m = Math.random().toString(36).slice(2)
        var r = await og_fetch(`/${m}`, {
            method: 'MULTIPLEX',
            headers: {'Multiplex-Version': multiplex_version}
        })

        // the response should announce that it's an incremental stream
        assert(r.headers.get('Incremental') === '?1', 'expected Incremental: ?1')
    }
)

run_test(
    "Test handling duplicate request id locally",
    async () => {
        // add a handler that holds a subscription open, sending an update now
        // and another, delayed, update 200ms later
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ version: ['now!'], body: 'hi' })
            setTimeout(() => res.sendUpdate({ version: ['another!'], body: '"!"' }), 200)
        })

        // open a multiplexed subscription through a multiplexer of our choosing
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
        })

        // watch for that delayed update
        var saw_delayed_update
        r.subscribe(update => {
            if (update.version[0] === 'another!')
                saw_delayed_update = true
        })

        // the client honors the request id we submitted on a fresh request, so
        // the first request really is occupying our id s
        assert(r.multiplexed_through.split('/')[4] === s, 'expected the first request to use our submitted id')

        // make a second request deliberately reusing that now-taken request id,
        // to force the client's local duplicate-request-id handling
        var st = Date.now()
        var r2 = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
        })
        var et = Date.now()

        // both requests go through the same multiplexer...
        assert(r.multiplexed_through.split('/')[3] === r2.multiplexed_through.split('/')[3],
               'expected both requests on the same multiplexer')

        // ...but the client should have noticed the duplicate request id and
        // assigned the second one a fresh id, so they aren't the same request...
        assert(r.multiplexed_through !== r2.multiplexed_through,
               'expected the second request to get a fresh request id')

        // ...and it should have done so locally, without a slow round-trip
        assert(et < st + 300, 'expected duplicate request id to be handled quickly (locally)')

        // give the delayed 'another!' update time to arrive, then make sure it did
        await new Promise(done => setTimeout(done, 300))
        assert(saw_delayed_update, 'expected to get the delayed update')

        a.abort()
        await og_fetch('/kill_mux', {headers: {mux: m}})
    }
)

run_test(
    "Test falling back to MULTIPLEX well-known url, if method doesn't work.",
    async () => {
        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // make the server 500 attempts to create our multiplexer via the
        // MULTIPLEX *method*, but let the well-known *url* path through (by not
        // handling it -- it falls through to braidify). So the client should
        // try the method, see it fail, and fall back to the well-known url --
        // ending up multiplexed either way.
        //
        // NOTE: the client currently has the MULTIPLEX method hard-disabled
        // (see `if (true || ...) throw 'skip multiplex method'` in
        // braid-http-client.js), so it goes straight to the well-known url and
        // this fault is never actually hit. The test still passes (the request
        // gets multiplexed via the url), but it won't truly exercise the
        // method->url fallback until the MULTIPLEX method is re-enabled.
        //
        // And even if it were re-enabled, it still wouldn't work here: braid_fetch
        // uses node's native fetch (undici), which rejects the non-standard
        // MULTIPLEX method outright (400, before the request is even sent) --
        // regardless of HTTP/1.1 vs HTTP/2. The MULTIPLEX-method tests that do
        // pass use og_fetch, a custom HTTP/2 client that can send arbitrary
        // methods via the :method pseudo-header.
        await add_pre_braidify_handler(`(req, res) => {
            if (req.method === 'MULTIPLEX' && req.url.startsWith('/${m}')) {
                res.writeHead(500)
                res.end('')
                return true
            }
        }`)

        var st = Date.now()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: true
        })

        // the request ended up multiplexed (via the well-known url fallback)...
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // ...and the fallback was quick -- no slow retry/timeout
        assert(Date.now() < st + 300, 'expected fallback to be fast')

        a.abort()
        await og_fetch('/kill_mux', {headers: {mux: m}})
    }
)

run_test(
    "Test option to use MULTIPLEX well-known url regardless.",
    async () => {
        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // make the server 500 attempts to create *this* multiplexer via the
        // well-known url, so the first attempt fails and the client retries
        await add_pre_braidify_handler(`(req, res) => {
            if (req.url.startsWith('/.well-known/multiplexer/${m}')) {
                res.writeHead(500)
                res.end('')
                return true
            }
        }`)

        // count how many times the client tries to fetch through a multiplexer.
        // multiplex: {via: 'POST'} forces the well-known-url path (not the
        // MULTIPLEX method). The first attempt uses our bad m and gets a 500;
        // onFetch then swaps m to a fresh (good) id, so the retry succeeds.
        var count = 0
        await new Promise(async done => {
            await fetch(endpoint, {
                signal: a.signal,
                subscribe: true,
                multiplex: {via: 'POST'},
                retry: true,
                onFetch: (url, params) => {
                    count++
                    if (count === 2) done()
                    params.headers.set('Multiplex-Through', `/.well-known/multiplexer/${m}/${s}`)
                    m = Math.random().toString(36).slice(2)
                }
            })
        })

        // exactly two attempts: the failed one, plus the successful retry
        assert(count === 2, 'expected one failed attempt followed by one retry')

        a.abort()
    }
)

run_test(
    "Test that when multiplexer doesn't exist, it returns the proper header.",
    async () => {
        // add a handler (which won't actually be reached: a Multiplex-Through
        // request for a non-existent multiplexer is rejected by braidify with
        // a 424 before it ever gets routed to a handler)
        var endpoint = await add_main_handler((req, res) => res.end('hi'))

        // send a Multiplex-Through request naming a multiplexer that doesn't
        // exist -- the server should 424 with a Bad-Multiplexer header naming it
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await og_fetch(endpoint, {
            headers: {
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            }
        })
        assert(r.headers.get('bad-multiplexer') === m, 'expected Bad-Multiplexer header naming the missing multiplexer')
    }
)

run_test(
    "Test that multiplexer code handles a relative url (rather than an absolute url).",
    async () => {
        var a1 = new AbortController()
        var r1 = await fetch(`/json`, {
            signal: a1.signal,
            subscribe: true,
            multiplex: {}
        })

        var a2 = new AbortController()
        var r2 = await fetch(`/json`, {
            signal: a2.signal,
            subscribe: true,
            multiplex: {}
        })

        if (!r2.multiplexed_through) throw new Error('not multiplexed')

        return await new Promise(async (outter_done, outter_fail) => {
            var ret = await new Promise(done => r2.subscribe(u => {
                u.body = u.body_text
                done(JSON.stringify(u))
            }, e => {
                if (e.name === 'AbortError') outter_done(ret)
                else outter_fail(e)
            }))

            a1.abort()
            a2.abort()
        })
    },
    JSON.stringify(test_update)
)

run_test(
    "Test that multiplexer code handles a full url (rather than relative one).",
    async () => {
        var a1 = new AbortController()
        var r1 = await fetch(`https://localhost:${port}/json`, {
            signal: a1.signal,
            subscribe: true,
            multiplex: {}
        })

        var a2 = new AbortController()
        var r2 = await fetch(`https://localhost:${port}/json`, {
            signal: a2.signal,
            subscribe: true,
            multiplex: {}
        })

        if (!r2.multiplexed_through) throw new Error('not multiplexed')

        return await new Promise(async (outter_done, outter_fail) => {
            var ret = await new Promise(done => r2.subscribe(u => {
                u.body = u.body_text
                done(JSON.stringify(u))
            }, e => {
                if (e.name === 'AbortError') outter_done(ret)
                else outter_fail(e)
            }))

            a1.abort()
            a2.abort()
        })
    },
    JSON.stringify(test_update)
)

run_test(
    "Test that multiplexer code handles a full url (rather than relative one) on server.",
    async () => {
        var r = await fetch('/eval', {
            method: 'POST',
            body: `
            void (async () => {
                if (typeof fetch === 'undefined') return res.end('old node version')

                var a = new AbortController()
                var r = await braid_fetch('https://localhost:' + port + '/json', {
                    multiplex: true,
                    signal: a.signal,
                    subscribe: true,
                    retry: true
                })

                if (!r.multiplexed_through) return res.end('not multiplexer!?')

                r.subscribe(u => {
                    u.body = u.body_text
                    if (!res.writableEnded) {
                        res.end(JSON.stringify(u))
                        a.abort()
                    }
                })
            })()
            `
        })
        return await r.text()
    },
    JSON.stringify(test_update)
)

run_test(
    "Test closing unrecognized requests in the multiplexer.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {signal: a.signal, headers: {'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`, 'Multiplex-Version': multiplex_version}})

        var s2 = Math.random().toString(36).slice(2)
        var r2 = await fetch('/eval', {
            method: 'POST',
            body: `
            void (async () => {
                braidify.multiplexers.get(${JSON.stringify(m)}).res.write('start response ${s2}\\r\\n'.repeat(3))

                setTimeout(() => {
                    braidify.multiplexers.get(${JSON.stringify(m)}).res.write('start response ${s2}\\r\\n'.repeat(3))
                }, 300)

                setTimeout(() => {
                    res.end(JSON.stringify(deleted_request_count[${JSON.stringify(s2)}]))
                }, 600)
            })()
            `
        })
        return await r2.text()
    },
    '2'
)

run_test(
    "Test receiving multiplexed message.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: {
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`
            }
        })
        if (!r.multiplexed_through) throw new Error('not multiplexed')
        var x = await new Promise(async done => {
            r.subscribe(u => {
                u.body = u.body_text
                done(JSON.stringify(u))
            })
        })
        a.abort()
        return x
    },
    JSON.stringify(test_update)
)

run_test(
    "Test receiving multiplexed message's version.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {signal: a.signal, headers: {'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`, 'Multiplex-Version': multiplex_version}})

        return r.headers.get('version')
    },
    '"test"'
)

run_test(
    "Test receiving multiplexed messages with whitespace between them.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        if (!r.multiplexed_through) throw new Error('not multiplexed')
        var x = await new Promise(async done => {
            r.subscribe(u => {

                console.log('u = ', u)

                u.body = u.body_text
                if (u.version[0] === 'test1') done(u.version[0])
            })
        })
        await og_fetch('/kill_mux', {headers: {mux: m}})
        a.abort()
        return x
    },
    'test1'
)

run_test(
    "Test receiving multiplexed message using subscription",
    async () => {
        var a1 = new AbortController()
        var r1 = await fetch('/json', {
            signal: a1.signal,
            subscribe: true,
        })

        var a2 = new AbortController()
        var r2 = await fetch('/json', {
            signal: a2.signal,
            subscribe: true,
            multiplex: true,
        })

        if (!r2.multiplexed_through) throw new Error('not multiplexed')

        var x = await new Promise(done => {
            r2.subscribe(u => {
                u.body = u.body_text
                done(JSON.stringify(u))
            })
        })

        a1.abort()
        a2.abort()

        return x
    },
    JSON.stringify(test_update)
)

run_test(
    "Test closing multiplexer",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: {
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`
            }
        })
        if (!r.multiplexed_through) throw new Error('not multiplexed')
        var x = await new Promise(async done => {
            r.subscribe(u => {
            }, e => done('multiplexer ended'))
            await og_fetch('/kill_mux', {headers: {mux: m}})
        })
        a.abort()
        return x
    },
    'multiplexer ended'
)

run_test(
    "Test closing multiplexer before headers received",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        setTimeout(() => {
            og_fetch('/kill_mux', {headers: {mux: m}})
        }, 500)
        try {
            var r = await fetch('/eval', {
                method: 'POST',
                signal: a.signal,
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
                body: `
                    setTimeout(() => {
                        res.setHeader('test', '42')
                        res.end('hi')
                    }, 1000)
                `});
        } catch (e) { return '' + e }
        return 'hm..'
    },
    'Error: multiplex stream ended unexpectedly'
)

run_test(
    "Test closing multiplexer with retry",
    async () => {
        var ret = ''
        await new Promise(async done => {
            var count = 0
            var a = new AbortController()
            var m = Math.random().toString(36).slice(2)
            var s = Math.random().toString(36).slice(2)
            var aborter = null
            var r = await fetch('/json', {
                signal: a.signal,
                subscribe: true,
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
                retry: { onRes: () => count++ },
                onFetch: (url, params, _aborter) => {
                    aborter = _aborter
                }
            })
            if (!r.multiplexed_through) throw new Error('not multiplexed')
            r.subscribe(u => {
                if (count === 2 && !ret) {
                    u.body = u.body_text
                    ret = JSON.stringify(u)
                    aborter.abort()
                }
            }, e => {
                ret += ', ' + e.message
                done()
            })
            await og_fetch('/kill_mux', {headers: {mux: m}})
        })
        return ret
    },
    JSON.stringify(test_update) + ', request aborted'
)

run_test(
    "Test aborting multiplexed subscription.",
    async () => {
        var good = false
        var a = new AbortController()
        try {
            var res = await fetch("/json", {
                signal: a.signal,
                retry: true,
                subscribe: true,
                multiplex: true
            })
            await new Promise((done, fail) => {
                setTimeout(() => a.abort(), 30)
                setTimeout(() => fail(new Error("abort failed 1")), 60)
                res.subscribe((update) => {
                    if (update.body != null) update.body = update.body_text
                    if (JSON.stringify(update) === JSON.stringify(test_update)) good = true
                }, fail)
            })
        } catch (e) {
            return e.name === "AbortError" && good ? "passed" : "failed"
        }
    },
    "passed"
)

run_test(
    "Test ending multiplexed subscription on the server side.",
    async () => {
        var onRes_count = 0
        var update_count = 0
        try {
            await new Promise(async (done, fail) => {
                var a = new AbortController()
                var res = await fetch("/json", {
                    retry: { onRes: () => onRes_count++ },
                    subscribe: true,
                    multiplex: true,
                    signal: a.signal,
                    headers: {
                        giveup: true,
                    }
                })
                res.subscribe(
                    (update) => {
                        if (update.body != null) update.body = update.body_text
                        if (JSON.stringify(update) === JSON.stringify(test_update)) update_count++
                        if (update_count > 1) done()
                    },
                    (e) => fail(new Error("fetch error: " + e))
                )
                setTimeout(() => {
                    a.abort()
                    fail(new Error("timed out: " + JSON.stringify({ onRes_count, update_count })))
                }, 3000)
            })
            return `onRes_count=${onRes_count}, update_count=${update_count}`
        } catch (e) {
            return e.message
        }
    },
    "onRes_count=2, update_count=2"
)

run_test(
    "Test retry when first establishinig multiplexer",
    async () => {
        if ((await (await og_fetch('/eval', {
            method: 'POST',
            body: `
                faulty_mux_i = 0
                res.end('ok!')
            `})).text()) !== 'ok!') throw new Error('fail to reset_faulty_mux')

        var a = new AbortController()
        var m = 'faulty_mux'
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: true
        })
        if (!r.multiplexed_through) throw new Error('not multiplexed')
        a.abort()
        return 'multiplexed!'
    },
    'multiplexed!'
)

run_test(
    "Test that server multiplexer can detect closure.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/eval', {
            method: 'POST',
            signal: a.signal,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            body: `
                res.setHeader('test', '42')
                res.startSubscription({
                    onClose: () => {
                        _${m} = 42
                    }
                })
                res.write('\\r\\n')
            `});
        if (r.headers.get('test') !== '42') throw new Error('sad')
        await og_fetch('/kill_mux', {headers: {mux: m}})
        var r2 = await fetch('/eval', {
            method: 'POST',
            signal: a.signal,
            body: `
                res.end('' + _${m})
            `});
        var x = await r2.text()
        a.abort()
        return x
    },
    '42'
);

run_test(
    "Test failing to establish multiplexed connection.",
    async () => {
        var a = new AbortController()
        var m = 'bad_mux'
        var s = Math.random().toString(36).slice(2)
        try {
            var r = await fetch('/json', {
                signal: a.signal,
                subscribe: true,
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
            })
        } catch (e) { return e.message }
        return 'hm..'
    },
    'multiplexer failed'
);

run_test(
    "Test that creating duplicate multiplexed connections fails correctly.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })

        var r2 = await og_fetch(`/${m}`, {method: 'MULTIPLEX', headers: {'Multiplex-Version': multiplex_version}})
        var o = await r2.json()
        return `status: ${r2.status}, json.error: ` + o.error + `, error as expected: ${JSON.stringify(o) === JSON.stringify({
            "error": "Multiplexer already exists",
            "details": `Cannot create duplicate multiplexer with ID '${m}'`
        })}`
    },
    'status: 409, json.error: Multiplexer already exists, error as expected: true'
);

run_test(
    "Test that creating duplicate multiplexed requests fails correctly.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        var mux_r = await og_fetch(`/.well-known/multiplexer/${m}`, {
            method: 'POST',
            signal: a.signal,
            headers: { 'Multiplex-Version': multiplex_version }
        })
        if (!mux_r.ok) throw 'failed to set up mux'

        var r1 = await og_fetch(`/json`, {
            signal: a.signal,
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            },
        })
        if (!r1.ok) throw 'failed to set up mux request 1'

        var r2 = await og_fetch(`/json`, {signal: a.signal, headers: {'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`, 'Multiplex-Version': multiplex_version}})
        var o = await r2.json()
        return `status: ${r2.status}, json.error: ` + o.error + `, error as expected: ${JSON.stringify(o) === JSON.stringify({
            "error": "Request already multiplexed",
            "details": `Cannot multiplex request with duplicate ID '${s}' for multiplexer '${m}'`,
        })}`
    },
    'status: 409, json.error: Request already multiplexed, error as expected: true'
);

run_test(
    "Test random 500 error while multiplexing a request.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        try {
            var res = await fetch('/500', {
                signal: a.signal,
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
                retry: true
            })
            console.log('We got a response of ', res.status, await res.text())
        } catch (e) {
            return '' + e
        }
        return 'hm..'
    },
    'hm..'
)

run_test(
    "Test failing to establish multiplexed request because of version.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        try {
            var r = await fetch('/eval_pre_braidify', {
                method: 'POST',
                signal: a.signal,
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
                retry: true,
                body: `
                    res.writeHead(293, {'Multiplex-Version': 'wrong'})
                    res.end('ok')
                `
            })
        } catch (e) {
            console.log('We have an error of', e)
            return ('' + e).slice(0, 'ProtocolError: Server created multiplexer, and then set a '.length)
        }
        return 'hm..'
    },
    'ProtocolError: Server created multiplexer, and then set a '
);

run_test(
    "Test that failed DELETE on multiplexed request is caught (no uncaught rejection).",
    async () => {
        var saw_rejection = false
        var handler = (event) => {
            var message = event.reason?.message || event.message || ''
            if (message.includes('Could not cancel multiplexed request'))
                saw_rejection = true
        }
        if (typeof window !== 'undefined') window.addEventListener('unhandledrejection', handler)
        else process.on('unhandledRejection', handler)

        var m = Math.random().toString(36).slice(2)
        var s = 'bad_request'
        try {
            await fetch('/500', { headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` } })
        } catch (e) {}

        // Give time for any uncaught rejections to surface
        await new Promise(r => setTimeout(r, 500))

        if (typeof window !== 'undefined') window.removeEventListener('unhandledrejection', handler)
        else process.off('unhandledRejection', handler)

        return saw_rejection ? 'uncaught rejection leaked' : 'error was caught'
    },
    'error was caught'
);

run_test(
    "Test header syntax error in multiplexed stream.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: {
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`
            }
        })
        if (!r.multiplexed_through) throw new Error('not multiplexed')

        var s = Math.random().toString(36).slice(2)

        try {
            var r = await fetch('/eval', {
                method: 'POST',
                signal: a.signal,
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
                body: `
                    var m = braidify.multiplexers?.get(${JSON.stringify(m)})
                    m.res.write('10 bytes for response ${s}\\r\\na b\\r\\na b\\r\\n')
                    setTimeout(() => {
                        m.res.write('2 bytes for response ${s}\\r\\n\\r\\n')
                        res.write('aaaaabbbb')
                    }, 1000)
                `
            })
        } catch (e) { return '' + e }
        return 'hm..: ' + r.status + (await r.body.getReader().read()).value
    },
    'Error: error parsing headers'
);

run_test(
    "Test 2nd GET causing multiplexed connection.",
    async () => {
        var a = new AbortController()
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            multiplex: {}
        })
        var r2 = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            multiplex: {}
        })
        setTimeout(() => a.abort(), 0)
        return '' + !!r2.multiplexed_through
    },
    'true'
);

run_test(
    "Test stream parsing error.",
    async () => {
        var a = new AbortController()
        var r = await fetch('/eval', {
            signal: a.signal,
            method: 'POST',
            subscribe: true,
            body: `
                res.statusCode = 209
                res.write('\\r\\n\\r\\n\\r\\nHTP 555\\r\\n\\r\\n\\r\\n')
            `
        })
        setTimeout(() => a.abort(), 2000)
        return await new Promise((done, fail) => {
            r.subscribe(u => {
                done(JSON.stringify(u))

            }, e => {
                done('' + e.message)

            })

        })
    },
    'Parse error in headers: "HTP 555\\r\\n\\r\\n"'
);

run_test(
    "Test server getting GET for multiplexer that doesn't exist.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        var s2 = Math.random().toString(36).slice(2)
        var r2 = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s2}` },
        })

        return await new Promise((done, fail) => {
            var count = 0
            fetch('/eval_pre_braidify', {
                method: 'POST',
                signal: a.signal,
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
                multiplex: {
                    onFetch: () => {
                        count++
                        if (count == 2) {
                            done('we got the error we expected')
                            a.abort()
                        }
                    }
                },
                body: `
                    braidify.multiplexers.delete(${JSON.stringify(m)})
                    'keep going'
                `});
        })
    },
    'we got the error we expected'
);

run_test(
    "Test multiplexed request aborted before GET, on server",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var s2 = Math.random().toString(36).slice(2)
        await fetch('/json', {
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s2}` }
        })
        var r = await og_fetch(`/${m}/${s}`, {method: 'MULTIPLEX', headers: {'Multiplex-Version': multiplex_version}})
        return '' + r.status
    },
    '404'
)

// Note: The following multiplex_wait tests rely on tight timing (e.g. 5ms
// delays, 50ms windows) and may fail intermittently in the browser due to
// CORS preflight overhead changing who wins the race. If you see spurious
// 293-vs-424 failures, re-run to confirm. We should investigate whether
// these are real bugs or just flaky timing, and fix either way.

run_test(
    "Test multiplex_wait suppresses 424 when POST arrives within window.",
    async () => {
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // Send Multiplex-Through GET before multiplexer exists.
        // Express server has next(), so multiplex_wait kicks in.
        var get_promise = og_fetch(`https://localhost:${port+1}/middleware-test`, {
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            }
        })

        // Short delay, then create the multiplexer
        await new Promise(done => setTimeout(done, 5))
        var post_r = await og_fetch(`https://localhost:${port+1}/.well-known/multiplexer/${m}`, {
            method: 'POST',
            headers: { 'Multiplex-Version': multiplex_version }
        })

        // GET should resolve with 293 (multiplexed), not 424
        var r = await get_promise
        return `get_status=${r.status}, post_ok=${post_r.ok}`
    },
    'get_status=293, post_ok=true'
)

run_test(
    "Test multiplex_wait times out to 424 when POST never arrives.",
    async () => {
        // Set a short wait so the test doesn't take long
        await fetch('/eval', {
            method: 'POST',
            body: `braidify.multiplex_wait = 30; res.end('ok')`
        })

        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // Send Multiplex-Through GET for a multiplexer that never gets created
        var r = await og_fetch(`https://localhost:${port+1}/middleware-test`, {
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            }
        })

        // Restore default
        await fetch('/eval', {
            method: 'POST',
            body: `braidify.multiplex_wait = 10; res.end('ok')`
        })

        return `status=${r.status}, header=${r.headers.get('bad-multiplexer') === m}`
    },
    'status=424, header=true'
)

run_test(
    "Test multiplex_wait=0 disables waiting (immediate 424).",
    async () => {
        await fetch('/eval', {
            method: 'POST',
            body: `braidify.multiplex_wait = 0; res.end('ok')`
        })

        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var st = Date.now()

        var r = await og_fetch(`https://localhost:${port+1}/middleware-test`, {
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            }
        })

        var elapsed = Date.now() - st

        // Restore default
        await fetch('/eval', {
            method: 'POST',
            body: `braidify.multiplex_wait = 10; res.end('ok')`
        })

        return `status=${r.status}, fast=${elapsed < 50}`
    },
    'status=424, fast=true'
)

run_test(
    "Test multiple requests waiting for same multiplexer via multiplex_wait.",
    async () => {
        // Use a generous wait so the POST's CORS preflight (browser-only)
        // doesn't eat into the timer window
        await fetch('/eval', {
            method: 'POST',
            body: `braidify.multiplex_wait = 50; res.end('ok')`
        })

        var m = Math.random().toString(36).slice(2)
        var s1 = Math.random().toString(36).slice(2)
        var s2 = Math.random().toString(36).slice(2)

        // Send two Multiplex-Through GETs before multiplexer exists
        var get1 = og_fetch(`https://localhost:${port+1}/middleware-test`, {
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s1}`,
                'Multiplex-Version': multiplex_version
            }
        })
        var get2 = og_fetch(`https://localhost:${port+1}/middleware-test`, {
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s2}`,
                'Multiplex-Version': multiplex_version
            }
        })

        // Short delay, then create the multiplexer
        await new Promise(done => setTimeout(done, 5))
        await og_fetch(`https://localhost:${port+1}/.well-known/multiplexer/${m}`, {
            method: 'POST',
            headers: { 'Multiplex-Version': multiplex_version }
        })

        var [r1, r2] = await Promise.all([get1, get2])

        // Restore default
        await fetch('/eval', {
            method: 'POST',
            body: `braidify.multiplex_wait = 10; res.end('ok')`
        })

        return `r1=${r1.status}, r2=${r2.status}`
    },
    'r1=293, r2=293'
)

run_test(
    "Test multiplex_wait has no effect without next (main server).",
    async () => {
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var st = Date.now()

        // Main server calls braidify(req, res) without next,
        // so multiplex_wait should not apply — immediate 424
        var r = await og_fetch('/json', {
            headers: {
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            }
        })

        var elapsed = Date.now() - st
        return `status=${r.status}, fast=${elapsed < 50}`
    },
    'status=424, fast=true'
)

run_test(
    "Test client asking for multiplexing, but server doesn't realize it.",
    async () => {
        // This hits a dedicated server (port+4) whose braidify has
        // multiplexing permanently disabled
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch(`https://localhost:${port + 4}/json`, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        return await new Promise(done => {
            r.subscribe(u => {
                if (u.version[0] === 'another!') {
                    done('another!')
                    a.abort()
                }
            })
        })
    },
    'another!'
)

add_section_header("Express Middleware Tests")

run_test(
    "Test braidify as Express middleware with subscription",
    async () => {
        var a = new AbortController()
        var updates = []
        
        // Note: Using port+1 for the Express server
        var res = await fetch(`https://localhost:${port + 1}/middleware-test`, {
            subscribe: true,
            signal: a.signal,
            multiplex: {via: 'POST'}
        })
        
        await new Promise(resolve => {
            res.subscribe(
                update => {
                    if (update.body != null) update.body = update.body_text
                    updates.push(update.body)
                    resolve()
                }
            )
        })
        
        a.abort()
        return updates[0]
    },
    'Braidify works as Express middleware!'
)

run_test(
    "Test braidify as Express middleware without subscription",
    async () => {
        var res = await fetch(`https://localhost:${port + 1}/middleware-test`)
        var data = await res.json()
        return data.message
    },
    "Braidify works as Express middleware!"
)

add_section_header("Wrapper Function Tests")

run_test(
    "Test braidify as wrapper function with subscription",
    async () => {
        var a = new AbortController()
        var updates = []
        
        // Using port+2 for the wrapper function server
        var res = await fetch(`https://localhost:${port + 2}/wrapper-test`, {
            subscribe: true,
            signal: a.signal
        })
        
        await new Promise(resolve => {
            res.subscribe(
                update => {
                    if (update.body != null) update.body = update.body_text
                    var parsed = JSON.parse(update.body)
                    updates.push(parsed.message)
                    if (updates.length >= 2) resolve()
                }
            )
        })
        
        a.abort()
        return updates.join(" → ")
    },
    'Braidify works as a wrapper function! → This is an update!'
)

run_test(
    "Test braidify as wrapper function without subscription",
    async () => {
        var res = await fetch(`https://localhost:${port + 2}/wrapper-test`)
        var data = await res.json()
        return data.message
    },
    "Braidify works as a wrapper function!"
)

add_section_header("braidify.server() Tests")

// braidify.server() attaches to an existing http.Server.  Listens on port+3.

run_test(
    "Test braidify.server with subscription",
    async () => {
        var a = new AbortController()
        var updates = []

        var res = await fetch(`https://localhost:${port + 3}/server-test`, {
            subscribe: true,
            signal: a.signal
        })

        await new Promise(resolve => {
            res.subscribe(update => {
                if (update.body != null) update.body = update.body_text
                var parsed = JSON.parse(update.body)
                updates.push(parsed.message)
                if (updates.length >= 2) resolve()
            })
        })

        a.abort()
        return updates.join(" → ")
    },
    'Braidify works as server! → This is a server update!'
)

run_test(
    "Test braidify.server without subscription",
    async () => {
        var res = await fetch(`https://localhost:${port + 3}/server-test`)
        var data = await res.json()
        return data.message
    },
    "Braidify works as server!"
)

run_test(
    "Test multiplexing through braidify.server endpoint",
    async () => {
        var a = new AbortController()
        var r = await fetch(`https://localhost:${port + 3}/server-test`, {
            signal: a.signal,
            subscribe: true,
            multiplex: {after: 0},
            retry: true
        })

        if (!r.multiplexed_through) throw new Error('not multiplexed')
        var result = await new Promise(async done => {
            r.subscribe(u => {
                u.body = u.body_text
                var parsed = JSON.parse(u.body)
                done(JSON.stringify({
                    multiplexed: !!r.multiplexed_through,
                    message: parsed.message
                }))
            })
        })
        a.abort()
        return result
    },
    '{"multiplexed":true,"message":"Braidify works as server!"}'
)

run_test(
    // The http2-proxy bug pattern: setting a property on `res` and reading
    // it from inside an event listener on `res`.  Under the old
    // property-forwarding hack this could fail in the multiplex-through
    // case (state stuck on the original res, listener fired on res2).
    "Test that properties on res are accessible to res event listeners (via multiplex)",
    async () => {
        var test_id = Math.random().toString(36).slice(2)

        // Open a multiplexed subscription to /listener-test/<id>.  The
        // server sets res.my_marker, attaches a 'finish' listener, sends one
        // update, and stays open.
        var a = new AbortController()
        var r = await fetch(`https://localhost:${port + 3}/listener-test/${test_id}`, {
            signal: a.signal,
            subscribe: true,
            multiplex: {after: 0}
        })
        if (!r.multiplexed_through) throw new Error('not multiplexed')

        await new Promise(resolve => r.subscribe(resolve))

        // Abort the subscription — this triggers the 'finish' listener on
        // the server, which checks whether `this.my_marker` is reachable
        // and stashes the result.
        a.abort()

        // Give the server a moment to fire the listener.
        await new Promise(r => setTimeout(r, 100))

        // Read the stashed result.
        var result = await fetch(`https://localhost:${port + 3}/listener-result/${test_id}`)
        return await result.text()
    },
    'ok'
)

add_section_header("Server sending binary data with sendUpdate")

run_test(
    "Server can send binary body when not subscribing",
    async () => {
        var a = new AbortController()
        var x = await new Promise((resolve, reject) => {
            fetch('/json', {headers: {skip_first: true, send_binary_body: true, giveup: true}}).then(x => x.arrayBuffer()).then(resolve)
        })
        return '' + new Uint8Array(x)
    },
    '0,1,2,3'
)

run_test(
    "Server can send binary body as ArrayBuffer",
    async () => {
        var a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_body_arraybuffer: true, giveup: true}}).then(
                res => res.subscribe(
                    (update) => {
                        resolve(update.body)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
    },
    '0,1,2,3'
)

run_test(
    "Server can send binary body as Uint8Array",
    async () => {
        var a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_body: true, giveup: true}}).then(
                res => res.subscribe(
                    (update) => {
                        resolve(update.body)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
    },
    '0,1,2,3'
)

run_test(
    "Server can send binary body as Blob",
    async () => {
        var a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_body_blob: true, giveup: true}}).then(
                res => res.subscribe(
                    (update) => {
                        resolve(update.body.length <= 4 ? update.body : update.body_text)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
    },
    '0,1,2,3'
)

run_test(
    "Server can send binary body as Buffer",
    async () => {
        var a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_body_buffer: true, giveup: true}}).then(
                res => res.subscribe(
                    (update) => {
                        resolve(update.body)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
    },
    '0,1,2,3'
)

run_test(
    "Server can send binary patch as ArrayBuffer",
    async () => {
        var a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_patch_arraybuffer: true, giveup: true}}).then(
                res => res.subscribe(
                    (update) => {
                        resolve(update.patches[0].content)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
    },
    '0,1,2,3'
)

run_test(
    "Server can send binary patch as Uint8Array",
    async () => {
        var a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_patch: true, giveup: true}}).then(
                res => res.subscribe(
                    (update) => {
                        resolve(update.patches[0].content)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
    },
    '0,1,2,3'
)

run_test(
    "Server can send binary patch as Blob",
    async () => {
        var a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_patch_blob: true, giveup: true}}).then(
                res => res.subscribe(
                    (update) => {
                        var c = update.patches[0].content
                        resolve(c.length <= 4 ? c : update.patches[0].content_text)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
    },
    '0,1,2,3'
)

run_test(
    "Server can send binary patch as Buffer",
    async () => {
        var a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {
                subscribe: true, multiplex: false, signal: a.signal,
                headers: {skip_first: true, send_binary_patch_buffer: true, giveup: true}
            }).then(
                res => res.subscribe(
                    (update) => {
                        resolve(update.patches[0].content)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
    },
    '0,1,2,3'
)

run_test(
    "Server can send multiple binary patches as ArrayBuffers",
    async () => {
        var a = new AbortController()
        var x = await new Promise((resolve, reject) => {
            fetch('/json', {
                subscribe: true, multiplex: false, signal: a.signal,
                headers: {skip_first: true, send_binary_patches_arraybuffer: true, giveup: true}
            }).then(
                async res => {
                    console.log('the res is', res, 'with',
                                await (res.clone()).text())
                    res.subscribe(
                        (update) => {
                            console.log('Got update', update)
                            resolve(new Blob([update.patches[0].content, update.patches[1].content]))
                            console.log('that was ok')
                            a.abort()
                        },
                        reject
                    )
                }).catch(reject)
        })
        x = await x.arrayBuffer()
        return '' + new Uint8Array(x)
    },
    '0,1,2,3,10,11,12,13'
)

run_test(
    "Server can send multiple binary patches as Uint8Arrays",
    async () => {
        var a = new AbortController()
        var x = await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_patches: true, giveup: true}}).then(
                res => res.subscribe(
                    (update) => {
                        resolve(new Blob([update.patches[0].content, update.patches[1].content]))
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
        x = await x.arrayBuffer()
        return '' + new Uint8Array(x)
    },
    '0,1,2,3,10,11,12,13'
)

run_test(
    "Server can send multiple binary patches as Blobs",
    async () => {
        var a = new AbortController()
        var x = await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_patches_blob: true, giveup: true}}).then(
                res => res.subscribe(
                    (update) => {
                        var c1 = update.patches[0].content
                        var c2 = update.patches[1].content
                        if (c1.length <= 4) resolve(new Blob([c1, c2]))
                        else resolve(update.patches[0].content_text)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
        if (typeof x === 'string') return x
        x = await x.arrayBuffer()
        return '' + new Uint8Array(x)
    },
    '0,1,2,3,10,11,12,13'
)

run_test(
    "Server can send multiple binary patches as Buffers",
    async () => {
        var a = new AbortController()
        var x = await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_patches_buffer: true, giveup: true}}).then(
                res => res.subscribe(
                    (update) => {
                        resolve(new Blob([update.patches[0].content, update.patches[1].content]))
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
        x = await x.arrayBuffer()
        return '' + new Uint8Array(x)
    },
    '0,1,2,3,10,11,12,13'
)

add_section_header("Client sending binary data")

run_test(
    "Client can PUT single binary patch as ArrayBuffer",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true}, patches: {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3]).buffer}}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '0,1,2,3\n'
)

run_test(
    "Client can PUT single binary patch as Uint8Array",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true}, patches: {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3])}}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '0,1,2,3\n'
)

run_test(
    "Client can PUT multiple binary patches as ArrayBuffers",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true}, patches: [{unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3]).buffer}, {unit: 'text', range: '[0:0]', content: new Uint8Array([10, 11, 12, 13]).buffer}]}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '0,1,2,3\n10,11,12,13\n'
)

run_test(
    "Client can PUT multiple binary patches as Uint8Arrays",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true}, patches: [{unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3])}, {unit: 'text', range: '[0:0]', content: new Uint8Array([10, 11, 12, 13])}]}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '0,1,2,3\n10,11,12,13\n'
)

run_test(
    "Client can PUT multiple binary patches as Blobs",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true}, patches: [{unit: 'text', range: '[0:0]', content: new Blob([new Uint8Array([0, 1, 2, 3])])}, {unit: 'text', range: '[0:0]', content: new Blob([new Uint8Array([10, 11, 12, 13])])}]}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '0,1,2,3\n10,11,12,13\n'
)

run_test(
    "Client can PUT single patch with unicode text",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_content_text: true}, patches: [{unit: 'text', range: '[0:0]', content: '🌈👽🎵'}]}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '🌈👽🎵\n'
)

run_test(
    "Client can PUT multiple patches with unicode texts",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_content_text: true}, patches: [{unit: 'text', range: '[0:0]', content: '🌈👽🎵'}, {unit: 'text', range: '[0:0]', content: 'Hello 🌍!'}]}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '🌈👽🎵\nHello 🌍!\n'
)

add_section_header("Make sure contents are binary, with property to access as text")

run_test(
    "Verify client-side patches are binary",
    async () => {
        var a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true}}).then(
                res => res.subscribe(
                    (update) => {
                        resolve(update.patches[0].content instanceof Uint8Array)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
    },
    'true'
)

run_test(
    "Verify client-side patches have content_text",
    async () => {
        var a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true}}).then(
                res => res.subscribe(
                    (update) => {
                        resolve(update.patches[0].content_text)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
    },
    '1'
)

run_test(
    "Verify that content_text can be accessed after overriding content",
    async () => {
        var a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true}}).then(
                res => res.subscribe(
                    (update) => {
                        update.patches[0].content = update.patches[0].content_text
                        resolve(update.patches[0].content_text)
                        a.abort()
                    },
                    reject
                )).catch(reject)
        })
    },
    '1'
)

run_test(
    "Verify server-side bodies are binary",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_body_binary: true}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '123,34,97,34,58,53,125'
)

run_test(
    "Verify server-side bodies have body_text",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_body_text: true}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '{"a":5}'
)

run_test(
    "Verify server-side patches are binary",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true, 'content-range': 'text [0:0]'}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '123,34,97,34,58,53,125\n'
)

run_test(
    "Verify server-side patches have content_text",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_content_text: true, 'content-range': 'text [0:0]'}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '{"a":5}\n'
)

run_test(
    "Verify server-side 'everything' patches are binary",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_everything_patch_binary: true}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '123,34,97,34,58,53,125'
)

run_test(
    "Verify server-side 'everything' patches have content_text",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_everything_patch_content_text: true}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '{"a":5}'
)

run_test(
    "Verify that body_text can be accessed after overriding body",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, headers: {skip_first: true}}).then(
                res => res.subscribe(
                    (update) => {
                        try {
                            update.body_text
                            resolve(update.body_text)
                        } catch (e) {
                            reject(e)
                        }
                    },
                    reject
                )).catch(reject)
        })
    },
    'undefined'
)

run_test(
    "Handle client-side undefined body_text without exceptions",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, headers: {skip_first: true}}).then(
                res => res.subscribe(
                    (update) => {
                        try {
                            resolve(update.body_text)
                        } catch (e) {
                            reject(e)
                        }
                    },
                    reject
                )).catch(reject)
        })
    },
    'undefined'
)

add_section_header("Misc")

run_test(
    "Test that startSubscription can detect closure.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/eval', {
            method: 'POST',
            signal: a.signal,
            body: `
                res.setHeader('test', '42')
                res.startSubscription({
                    onClose: () => {
                        _${m} = 42
                    }
                })
                res.write('\\r\\n')
            `});
        if (r.headers.get('test') !== '42') throw new Error('sad')
        a.abort()
        await new Promise(done => setTimeout(done, 100))
        var r2 = await fetch('/eval', {
            method: 'POST',
            body: `
                res.end('' + _${m})
            `});
        var x = await r2.text()
        return x
    },
    '42'
);

run_test(
    "Test set_fetch",
    async () => {
        var flag_A = false
        fetch.set_fetch((...args) => {
            flag_A = true
            return og_fetch(...args)
        })

        var r = await fetch('/eval', {
            method: 'POST',
            body: `
            void (async () => {
                if (typeof fetch === 'undefined') return res.end('old node version')

                var flag_B = false
                braid_fetch.set_fetch((...args) => {
                    flag_B = true
                    return fetch(...args)
                })
                await braid_fetch('https://localhost:' + port + '/json')
                res.end('flag_B = ' + flag_B)
            })()
            `
        })
        return `flag_A = ${flag_A}, ` + await r.text()
    },
    'flag_A = true, flag_B = true'
)

run_test(
    "Test version header is parsing prints error on corrupt version",
    async () => {
        var r = await fetch('/eval', {
            method: 'POST',
            body: `
                res.setHeader('version', 'v1')
                res.end('ok')
            `
        })
        return '' + JSON.stringify(r.version)
    },
    'undefined'
)

run_test(
    "Test version header is parsed into res.version",
    async () => {
        var r = await fetch('/eval', {
            method: 'POST',
            body: `
                res.setHeader('version', '"v1"')
                res.end('ok')
            `
        })
        return JSON.stringify(r.version)
    },
    '["v1"]'
)

run_test(
    "Test current-version header is parsed into res.version",
    async () => {
        var r = await fetch('/eval', {
            method: 'POST',
            body: `
                res.setHeader('current-version', '"cv1"')
                res.end('ok')
            `
        })
        return JSON.stringify(r.version)
    },
    '["cv1"]'
)

run_test(
    "Test version header with multiple versions",
    async () => {
        var r = await fetch('/eval', {
            method: 'POST',
            body: `
                res.setHeader('version', '"v1", "v2"')
                res.end('ok')
            `
        })
        return JSON.stringify(r.version)
    },
    '["v1","v2"]'
)

run_test(
    "Test res.version is undefined when no version header",
    async () => {
        var r = await fetch('/eval', {
            method: 'POST',
            body: `
                res.end('ok')
            `
        })
        return String(r.version)
    },
    'undefined'
)

run_test(
    "Test calling subscribe on a non-subscription.",
    async () => {
        return await new Promise(async (resolve, reject) => {
            var res = await fetch('/eval', {
                method: 'POST',
                body: `res.end('ok')`
            })
            try {
                res.subscribe(() => {})
            } catch (e) {
                resolve('' + e)
            }
        })
    },
    'ProtocolError: Got unexpected subscription status code: 200. Expected 209.'
)

run_test(
    "Verify error in cb stops retry",
    async () => {
        return await new Promise((resolve, reject) => {
            var a = new AbortController()
            fetch('/json', {subscribe: true, multiplex: false, retry: true, signal: a.signal}).then(
                res => res.subscribe(
                    update => { throw Error('My Error') },
                    e => resolve(e.message)
                )).catch(reject)
            setTimeout(() => {
                reject('timed out')
                a.abort()
            }, 1000)
        })
    },
    'My Error'
)

run_test(
    "Verify heartbeat error in cb doesn't stop retry",
    async () => {
        return await new Promise((resolve, reject) => {
            var a = new AbortController()
            var count = 0
            fetch('/noheartbeat', {subscribe: true, multiplex: false, signal: a.signal, heartbeats: 0.5, retry: {
                onRes: () => {
                    count++
                    if (count == 2) {
                        resolve('did retry!')
                        a.abort()
                    }
                }
            }}).then(
                res => res.subscribe(
                    async update => {
                        await new Promise(done => setTimeout(done, 5000))
                    },
                    e => resolve(e.message)
                )).catch(reject)
        })
    },
    'did retry!'
)

run_test(
    "Verify error in async cb stops retry",
    async () => {
        return await new Promise((resolve, reject) => {
            var a = new AbortController()
            fetch('/json', {subscribe: true, multiplex: false, retry: true, signal: a.signal}).then(
                res => res.subscribe(
                    async update => { throw Error('My Error') },
                    e => resolve(e.message)
                )).catch(reject)
            setTimeout(() => {
                reject('timed out')
                a.abort()
            }, 1000)
        })
    },
    'My Error'
)

run_test(
    "Verify that server sets peer on response object",
    async () => {
        return await (await fetch("/eval", {
            method: 'POST',
            peer: 'test-peer-123',
            body: `res.end(req.peer)`
        })).text()
    },
    'test-peer-123'
)

run_test(
    "Verify that client writes ASCII versions",
    async () => {
        return await (await fetch("/eval", {
            method: 'POST',
            version: ['hello🌍-0'],
            body: `res.end(req.headers['version'])`
        })).text()
    },
    '"hello\\ud83c\\udf0d-0"'
)

run_test(
    "Verify that server writes ASCII versions",
    async () => {
        var x = await fetch('/json', {headers: {skip_first: true, send_unicode_version: true, giveup: true}})
        return x.headers.get('version')
    },
    '"hello\\ud83c\\udf0d-0"'
)

run_test(
    "Verify that client writes ASCII parents",
    async () => {
        return await (await fetch("/eval", {
            method: 'POST',
            parents: ['hello🌍-0', '🌈-5'],
            body: `res.end(req.headers['parents'])`
        })).text()
    },
    '"hello\\ud83c\\udf0d-0", "\\ud83c\\udf08-5"'
)

run_test(
    "Verify that server writes ASCII parents",
    async () => {
        var x = await fetch('/json', {headers: {skip_first: true, send_unicode_parents: true, giveup: true}})
        return x.headers.get('parents')
    },
    '"hello\\ud83c\\udf0d-0", "\\ud83c\\udf08-5"'
)

run_test(
    "Verify that fetch params are not mutated",
    async () => {
        var x = {
            method: 'PUT',
            patches: [{
                unit: 'text', range: '[0:0]', content: 'hello'
            }]
        }
        var y = await (await fetch("/check_parents", x)).json()
        return x.patches[0].content
    },
    'hello'
)

run_test(
    "Verify content-type with charset=utf-8 is handled correctly",
    async () => {
        var updates = []
        await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, headers: {charset: true}}).then(
                res => res.subscribe(
                    (update) => {
                        if (update.body != null) update.body = update.body_text
                        if (update.patches) for (var p of update.patches) p.content = p.content_text
                        updates.push(JSON.stringify(update))
                        if (updates.length === 5) resolve()
                    },
                    reject
                )).catch(reject)
        })
        return updates.join('\n')
    },
    '{"version":["test"],"parents":["oldie"],"body":"{\\\"this\\\":\\\"stuff\\\"}","status":"200"}\n' +
    '{"version":["test1"],"parents":["oldie","goodie"],"patches":[{"unit":"json","range":"[1]","content":"1"}],"status":"115","extra_headers":{"hash":"42"}}\n' +
    '{"version":["test2"],"patches":[{"unit":"json","range":"[2]","content":"2"}],"status":"200"}\n' +
    '{"version":["test3"],"patches":[{"unit":"json","range":"[3]","content":"3","extra_headers":{"hash":"43"}},{"unit":"json","range":"[4]","content":"4"}],"status":"200"}\n' +
    '{"version":["another!"],"body":"\\\"!\\\"","status":"200"}'
)

run_test(
    "Verify that parents option results in parents header",
    async () => {
        var x = { parents: ["test-0", "test-1"] }
        var y = await (await fetch("/check_parents", x)).json()
        return y.parents
    },
    '"test-0", "test-1"'
)

run_test(
    "Verify that parents option can be a function",
    async () => {
        var x = { parents: ["test-0", "test-1"] }
        var y = await (await fetch("/check_parents", { parents: () => x.parents })).json()
        return y.parents
    },
    '"test-0", "test-1"'
)

run_test(
    "Verify that parents option can be an async function",
    async () => {
        var x = { parents: ["test-0", "test-1"] }
        var y = await (await fetch("/check_parents", { parents: async () => x.parents })).json()
        return y.parents
    },
    '"test-0", "test-1"'
)


run_test(
    "onFetch test 1",
    async () => {
        var x = await new Promise(async (done, fail) => {
            await fetch('/json', {
                parents: () => ['test'],
                onFetch: (...args) => done(args)
            })
        })
        x[1].headers = Object.fromEntries([...x[1].headers])
        return JSON.stringify(x)
    },
    `["${base_url}/json",{"url":"${base_url}/json","headers":{"parents":"\\"test\\""},"signal":{}},{}]`
)

run_test(
    "onBytes test 1",
    async () => {
        return await new Promise(async (done, fail) => {
            var s = ''
            var x = await fetch('/json', {
                subscribe: true,
                multiplex: false, 
                headers: {giveup: true},
                onBytes: (x) => {
                    s += new TextDecoder('utf-8').decode(x)
                }
            })
            x.subscribe(_ => done(s))
        })
    },
    "HTTP 200 OK\r\nVersion: \"test\"\r\nParents: \"oldie\"\r\nContent-Length: 16\r\n\r\n{\"this\":\"stuff\"}\r\n\r\n"
)

run_test(
    "parents-function test 1",
    async () => {
        var has_parents = null
        var x = { parents: null }
        var res = await (await fetch("/check_parents", { parents: () => x.parents, onFetch: (url, params) => {
            has_parents = JSON.stringify(params.headers.has('parents'))
        } })).json()
        return JSON.stringify({has_parents, res})
    },
    '{"has_parents":"false","res":{}}'
)

add_section_header("Heartbeat Tests")

run_test(
    "Verify heartbeats don't prevent user writing headers",
    async () => {
        var a = new AbortController()
        var res = await fetch('/json', {subscribe: true, multiplex: false, heartbeats: 0.5, signal: a.signal})
        a.abort()
        return 'post-sub-header: ' + res.headers.get('post-sub-header')
    },
    'post-sub-header: yup'
)

run_test(
    "Verify heartbeat reception",
    async () => {
        var a = new AbortController()
        var x = await new Promise((resolve, reject) => {
            var st = Date.now()
            fetch('/json', {subscribe: true, multiplex: false, heartbeats: 0.5, signal: a.signal, onBytes: () => {
                if (Date.now() - st > 500) resolve('got beat!')
            }}).then(res => res.subscribe(() => {}, reject)).catch(reject)
        })
        a.abort()
        return x
    },
    'got beat!'
)

run_test(
    "Verify absence of unwanted heartbeats",
    async () => {
        var a = new AbortController()
        var x = await new Promise((resolve, reject) => {
            var st = Date.now()
            setTimeout(() => resolve('did not get!'), 1000)
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, onBytes: () => {
                if (Date.now() - st > 500) resolve('got beat!')
            }}).then(res => res.subscribe(() => {}, reject)).catch(reject)
        })
        a.abort()
        return x
    },
    'did not get!'
)

run_test(
    "Test heartbeat error",
    async () => {
        var res_count = 0
        var a = new AbortController()
        var x = '' + await new Promise(resolve => {
            fetch('/noheartbeat', {heartbeats: 0.5, signal: a.signal}).then(res => res.subscribe(() => {}, resolve)).catch(resolve)
        })
        a.abort()
        return x
    },
    'PipeError: heartbeat not seen in 3.60s'
)

run_test(
    "Restart connection on missed heartbeats",
    async () => {
        var res_count = 0
        var a = new AbortController()
        var x = await new Promise((resolve, reject) => {
            fetch('/noheartbeat', {heartbeats: 0.5, signal: a.signal, retry: {
                onRes: () => {
                    res_count++
                    if (res_count > 1) {
                        resolve('detected no heartbeat')
                    }
                }
            }}).then(res => res.subscribe(() => {}, reject)).catch(reject)
        })
        a.abort()
        return x
    },
    'detected no heartbeat'
)

run_test(
    "Maintain connection with regular heartbeats",
    async () => {
        var res_count = 0
        var a = new AbortController()
        var x = await new Promise((resolve, reject) => {
            setTimeout(() => resolve("didn't restart"), 1000);
            fetch('/json', {heartbeats: 0.5, subscribe: true, multiplex: false, signal: a.signal, retry: {
                onRes: () => {
                    res_count++
                    if (res_count > 1) {
                        resolve('did restart')
                    }
                }
            }}).then(res => res.subscribe(() => {}, reject)).catch(reject)
        })
        a.abort()
        return x
    },
    "didn't restart"
)

run_test(
    "Verify on_heartbeat is called on heartbeats",
    async () => {
        var a = new AbortController()
        var heartbeat_count = 0
        var x = await new Promise((resolve, reject) => {
            fetch('/json', {
                subscribe: true,
                multiplex: false,
                heartbeats: 0.3,
                signal: a.signal,
                on_heartbeat: () => {
                    heartbeat_count++
                    if (heartbeat_count >= 3) resolve(`on_heartbeat called ${heartbeat_count} times`)
                }
            }).then(res => res.subscribe(() => {}, reject)).catch(reject)
        })
        a.abort()
        return x
    },
    'on_heartbeat called 3 times'
)

run_test(
    "Test reconnect_delay_ms default path",
    async () => {
        await braid_fetch.reconnect_delay_test_chain
        braid_fetch.reconnect_delay_test_chain = (async () => {
            // Ensure reconnect_delay_ms is not set
            delete braid_fetch.reconnect_delay_ms
            var a = new AbortController()
            var res_count = 0
            var start_time = null
            var x = await new Promise((resolve, reject) => {
                // Use retry function that returns true to force retry on 500
                fetch('/500', {signal: a.signal, retry: (res) => {
                    res_count++
                    if (res_count === 1) {
                        start_time = Date.now()
                    } else if (res_count > 1) {
                        var elapsed = Date.now() - start_time
                        // Default is Math.min(retry_count + 1, 3) * 1000 = 1000ms for retry_count=0
                        // Allow 800-1500ms range
                        if (elapsed >= 800 && elapsed <= 1500) {
                            resolve('default path ok')
                        } else {
                            resolve(`default path TIMING ERROR: elapsed=${elapsed}ms (expected ~1000ms)`)
                        }
                        a.abort()
                        return false
                    }
                    return true
                }}).catch(() => {})
            })
            return x
        })()
        return await braid_fetch.reconnect_delay_test_chain
    },
    'default path ok'
)

run_test(
    "Test reconnect_delay_ms as number",
    async () => {
        await braid_fetch.reconnect_delay_test_chain
        braid_fetch.reconnect_delay_test_chain = (async () => {
            braid_fetch.reconnect_delay_ms = 200
            var a = new AbortController()
            var res_count = 0
            var start_time = null
            var x = await new Promise((resolve, reject) => {
                fetch('/500', {signal: a.signal, retry: (res) => {
                    res_count++
                    if (res_count === 1) {
                        start_time = Date.now()
                    } else if (res_count > 1) {
                        var elapsed = Date.now() - start_time
                        // Should be ~200ms, allow 100-400ms range
                        if (elapsed >= 100 && elapsed <= 400) {
                            resolve('number path ok')
                        } else {
                            resolve(`number path TIMING ERROR: elapsed=${elapsed}ms (expected ~200ms)`)
                        }
                        a.abort()
                        return false
                    }
                    return true
                }}).catch(() => {})
            })
            delete braid_fetch.reconnect_delay_ms
            return x
        })()
        return await braid_fetch.reconnect_delay_test_chain
    },
    'number path ok'
)

run_test(
    "Test reconnect_delay_ms as function",
    async () => {
        await braid_fetch.reconnect_delay_test_chain
        braid_fetch.reconnect_delay_test_chain = (async () => {
            var received_retry_count = null
            braid_fetch.reconnect_delay_ms = (retry_count) => {
                received_retry_count = retry_count
                return 150
            }
            var a = new AbortController()
            var res_count = 0
            var start_time = null
            var x = await new Promise((resolve, reject) => {
                fetch('/500', {signal: a.signal, retry: (res) => {
                    res_count++
                    if (res_count === 1) {
                        start_time = Date.now()
                    } else if (res_count > 1) {
                        var elapsed = Date.now() - start_time
                        // Should be ~150ms, allow 50-350ms range
                        if (elapsed >= 50 && elapsed <= 350 && received_retry_count === 0) {
                            resolve('function path ok')
                        } else {
                            resolve(`function path ERROR: elapsed=${elapsed}ms, retry_count=${received_retry_count}`)
                        }
                        a.abort()
                        return false
                    }
                    return true
                }}).catch(() => {})
            })
            delete braid_fetch.reconnect_delay_ms
            return x
        })()
        return await braid_fetch.reconnect_delay_test_chain
    },
    'function path ok'
)

add_section_header("Read Tests")

run_test(
    "Subscribe with empty Subscribe header value",
    async () => {
        var a = new AbortController()
        // Use og_fetch with empty Subscribe header to test server accepts it
        var res = await og_fetch('/json', {
            signal: a.signal,
            headers: { 'Subscribe': '' }
        })
        // If server accepts empty subscribe header, we should get 209 status
        var status = res.status
        a.abort()
        return `status: ${status}`
    },
    'status: 209'
)

run_test(
    "Subscribe returns 209 with statusText 'Multiresponse' (HTTP/1.x only)",
    async () => {
        var a = new AbortController()
        var res = await og_fetch('/json', {
            signal: a.signal,
            headers: { 'Subscribe': 'true' }
        })
        var status = res.status
        var statusText = res.statusText
        a.abort()
        // HTTP/2 doesn't support status messages - statusText is always empty
        // HTTP/1.x without explicit statusMessage returns 'unknown' for 209
        // HTTP/1.x with our statusMessage returns 'Multiresponse'
        if (status !== 209)
            return `unexpected status: ${status}`
        if (statusText === '' || statusText === 'Multiresponse')
            return 'ok'
        return `unexpected statusText: ${statusText}`
    },
    'ok'
)

run_test(
    "Subscribe and receive multiple updates, using promise chaining",
    async () => {
        var updates = []
        await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false}).then(
                res => res.subscribe(
                    update => {
                        if (update.body != null) update.body = update.body_text
                        if (update.patches) for (var p of update.patches) p.content = p.content_text
                        updates.push(JSON.stringify(update))
                        if (updates.length === 5) resolve()
                    },
                    reject
                )).catch(reject)
        })
        return updates.join('\n')
    },
    '{"version":["test"],"parents":["oldie"],"body":"{\\\"this\\\":\\\"stuff\\\"}","status":"200"}\n' +
    '{"version":["test1"],"parents":["oldie","goodie"],"patches":[{"unit":"json","range":"[1]","content":"1"}],"status":"115","extra_headers":{"hash":"42"}}\n' +
    '{"version":["test2"],"patches":[{"unit":"json","range":"[2]","content":"2"}],"status":"200"}\n' +
    '{"version":["test3"],"patches":[{"unit":"json","range":"[3]","content":"3","extra_headers":{"hash":"43"}},{"unit":"json","range":"[4]","content":"4"}],"status":"200"}\n' +
    '{"version":["another!"],"body":"\\\"!\\\"","status":"200"}'
)

run_test(
    "Subscribe and receive multiple updates, using async/await",
    async () => {
        var updates = []
        await new Promise(async (resolve, reject) => {
            try {
                (await fetch('/json', {subscribe: true, multiplex: false})).subscribe(
                    update => {
                        if (update.body != null) update.body = update.body_text
                        if (update.patches) for (var p of update.patches) p.content = p.content_text
                        updates.push(JSON.stringify(update))
                        if (updates.length === 5) resolve()
                    },
                    reject
                )
            } catch (e) {
                reject(e)
            }
        })
        return updates.join('\n')
    },
    '{"version":["test"],"parents":["oldie"],"body":"{\\\"this\\\":\\\"stuff\\\"}","status":"200"}\n' +
    '{"version":["test1"],"parents":["oldie","goodie"],"patches":[{"unit":"json","range":"[1]","content":"1"}],"status":"115","extra_headers":{"hash":"42"}}\n' +
    '{"version":["test2"],"patches":[{"unit":"json","range":"[2]","content":"2"}],"status":"200"}\n' +
    '{"version":["test3"],"patches":[{"unit":"json","range":"[3]","content":"3","extra_headers":{"hash":"43"}},{"unit":"json","range":"[4]","content":"4"}],"status":"200"}\n' +
    '{"version":["another!"],"body":"\\\"!\\\"","status":"200"}'
)

run_test(
    "Subscribe and receive multiple updates, using 'for await'",
    async () => {
        var updates = []
        for await (var update of (await fetch('/json', {subscribe: true, multiplex: false})).subscription) {
            if (update.body != null) update.body = update.body_text
            if (update.patches) for (var p of update.patches) p.content = p.content_text
            updates.push(JSON.stringify(update))
            if (updates.length === 5) break
        }
        return updates.join('\n')
    },
    '{"version":["test"],"parents":["oldie"],"body":"{\\\"this\\\":\\\"stuff\\\"}","status":"200"}\n' +
    '{"version":["test1"],"parents":["oldie","goodie"],"patches":[{"unit":"json","range":"[1]","content":"1"}],"status":"115","extra_headers":{"hash":"42"}}\n' +
    '{"version":["test2"],"patches":[{"unit":"json","range":"[2]","content":"2"}],"status":"200"}\n' +
    '{"version":["test3"],"patches":[{"unit":"json","range":"[3]","content":"3","extra_headers":{"hash":"43"}},{"unit":"json","range":"[4]","content":"4"}],"status":"200"}\n' +
    '{"version":["another!"],"body":"\\\"!\\\"","status":"200"}'
)

add_section_header("Write Tests")

run_test(
    "PUT with single patch, not in array",
    async () => {
        var res = await fetch('/json', {
            version: ['test1'],
            patches: {unit: 'json', range: '[0]', content: '"test1"'},
            method: 'PUT'
        })
        return `returned ${res.status}`
    },
    "returned 200"
)

run_test(
    "PUT with single patch, in array",
    async () => {
        var res = await fetch('/json', {
            version: ['test2'],
            patches: [{unit: 'json', range: '[0]', content: '"test2"'}],
            method: 'PUT'
        })
        return `returned ${res.status}`
    },
    "returned 200"
)

run_test(
    "PUT with multiples patches",
    async () => {
        var res = await fetch('/json', {
            version: ['test3'],
            patches: [
                {unit: 'jsonpath', range: '[0]', content: '"test3"'},
                {unit: 'jsonpath', range: '[1]', content: '"test3"'},
                {unit: 'jsonpath', range: '[2]', content: '"test3"'}
            ],
            method: 'PUT'
        })
        return `returned ${res.status}`
    },
    "returned 200"
)

run_test(
    "PUT with empty patches array",
    async () => {
        var res = await fetch('/json', {
            version: ['test4'],
            patches: [],
            method: 'PUT'
        })
        return `returned ${res.status}`
    },
    "returned 200"
)

add_section_header('Testing braid wrapper for node http(s).get')

run_test(
    "Subscribe and receive multiple updates",
    async () => {
        var code_to_eval = `
            var updates = []
            ;(new Promise((resolve, reject) => {
                https.get(
                    'https://localhost:' + port + '/json',
                    {subscribe: true, multiplex: false, rejectUnauthorized: false},
                    (res) => {
                        res.on('update', (update) => {
                            if (update.body != null) update.body = update.body_text
                            if (update.patches) for (var p of update.patches) p.content = p.content_text
                            updates.push(update)
                            if (updates.length === 5) resolve()
                        })
                    }
                )
            })).then(() => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(updates));
            })
        `;

        var response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: code_to_eval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        var result = await response.json();
        
        return result.map(JSON.stringify).join('\n')
    },
    '{"version":["test"],"parents":["oldie"],"body":"{\\\"this\\\":\\\"stuff\\\"}","status":"200"}\n' +
    '{"version":["test1"],"parents":["oldie","goodie"],"patches":[{"unit":"json","range":"[1]","content":"1"}],"status":"115","extra_headers":{"hash":"42"}}\n' +
    '{"version":["test2"],"patches":[{"unit":"json","range":"[2]","content":"2"}],"status":"200"}\n' +
    '{"version":["test3"],"patches":[{"unit":"json","range":"[3]","content":"3","extra_headers":{"hash":"43"}},{"unit":"json","range":"[4]","content":"4"}],"status":"200"}\n' +
    '{"version":["another!"],"body":"\\\"!\\\"","status":"200"}'
);

run_test(
    "PUT with single patch, not in array",
    async () => {
        var code_to_eval = `
            var p = new Promise((resolve, reject) => {
                https.get(
                    'https://localhost:' + port + '/json',
                    {
                        version: ['test1'],
                        patches: {unit: 'json', range: '[0]', content: '"test1"'},
                        method: 'PUT',
                        rejectUnauthorized: false
                    },
                    (res) => {
                        resolve('returned ' + res.statusCode)
                    }
                )            
            })
            p.then(x => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(x));
            })
        `;

        var response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: code_to_eval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        var result = await response.json();
        return result
    },
    'returned 200'
);

run_test(
    "PUT with single patch, in array",
    async () => {
        var code_to_eval = `
            var p = new Promise((resolve, reject) => {
                https.get(
                    'https://localhost:' + port + '/json',
                    {
                        version: ['test2'],
                        patches: [{unit: 'json', range: '[0]', content: '"test2"'}],
                        method: 'PUT',
                        rejectUnauthorized: false
                    },
                    (res) => {
                        resolve('returned ' + res.statusCode)
                    }
                )            
            })
            p.then(x => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(x));
            })
        `;

        var response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: code_to_eval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        var result = await response.json();
        return result
    },
    'returned 200'
);

run_test(
    "PUT with multiples patches",
    async () => {
        var code_to_eval = `
            var p = new Promise((resolve, reject) => {
                https.get(
                    'https://localhost:' + port + '/json',
                    {
                        version: ['test3'],
                        patches: [
                            {unit: 'jsonpath', range: '[0]', content: '"test3"'},
                            {unit: 'jsonpath', range: '[1]', content: '"test3"'},
                            {unit: 'jsonpath', range: '[2]', content: '"test3"'}
                        ],
                        method: 'PUT',
                        rejectUnauthorized: false
                    },
                    (res) => {
                        resolve('returned ' + res.statusCode)
                    }
                )            
            })
            p.then(x => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(x));
            })
        `;

        var response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: code_to_eval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        var result = await response.json();
        return result
    },
    'returned 200'
);

run_test(
    "PUT with empty patches array",
    async () => {
        var code_to_eval = `
            var p = new Promise((resolve, reject) => {
                https.get(
                    'https://localhost:' + port + '/json',
                    {
                        version: ['test4'],
                        patches: [],
                        method: 'PUT',
                        rejectUnauthorized: false
                    },
                    (res) => {
                        resolve('returned ' + res.statusCode)
                    }
                )            
            })
            p.then(x => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(x));
            })
        `;

        var response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: code_to_eval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        var result = await response.json();
        return result
    },
    'returned 200'
);

add_section_header('Testing braid wrapper for node fetch')

run_test(
    "Subscribe and receive multiple updates",
    async () => {
        var code_to_eval = `
        void (() => {
            if (typeof fetch === 'undefined') return res.end('"old node version"')
            var updates = []
            ;(new Promise(async (resolve, reject) => {
                try {
                    (await braid_fetch('https://localhost:' + port + '/json',
                        {subscribe: true, multiplex: false})).subscribe(
                        update => {
                            if (update.body != null) update.body = update.body_text
                            if (update.patches) for (var p of update.patches) p.content = p.content_text
                            updates.push(update)
                            if (updates.length === 5) resolve()
                        },
                        reject
                    )
                } catch (e) {
                    reject(e)
                }            
            })).then(() => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(updates));
            })
        })()
        `;

        var response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: code_to_eval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        var result = await response.json();
        if (typeof result === 'string') return result
        
        return result.map(JSON.stringify).join('\n')
    },
    '{"version":["test"],"parents":["oldie"],"body":"{\\\"this\\\":\\\"stuff\\\"}","status":"200"}\n' +
    '{"version":["test1"],"parents":["oldie","goodie"],"patches":[{"unit":"json","range":"[1]","content":"1"}],"status":"115","extra_headers":{"hash":"42"}}\n' +
    '{"version":["test2"],"patches":[{"unit":"json","range":"[2]","content":"2"}],"status":"200"}\n' +
    '{"version":["test3"],"patches":[{"unit":"json","range":"[3]","content":"3","extra_headers":{"hash":"43"}},{"unit":"json","range":"[4]","content":"4"}],"status":"200"}\n' +
    '{"version":["another!"],"body":"\\\"!\\\"","status":"200"}'
);

run_test(
    "PUT with single patch, not in array",
    async () => {
        var code_to_eval = `
        void (() => {
            if (typeof fetch === 'undefined') return res.end('"old node version"')
            var p = new Promise(async (resolve, reject) => {
                var res = await braid_fetch(
                    'https://localhost:' + port + '/json',
                    {
                        version: ['test1'],
                        patches: {unit: 'json', range: '[0]', content: '"test1"'},
                        method: 'PUT'
                    }
                )

                resolve('returned ' + res.status)
            })
            p.then(x => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(x));
            })
        })()
        `;

        var response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: code_to_eval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        var result = await response.json();
        return result
    },
    'returned 200'
);

run_test(
    "PUT with single patch, in array",
    async () => {
        var code_to_eval = `
        void (() => {
            if (typeof fetch === 'undefined') return res.end('"old node version"')
            var p = new Promise(async (resolve, reject) => {
                var res = await braid_fetch(
                    'https://localhost:' + port + '/json',
                    {
                        version: ['test2'],
                        patches: [{unit: 'json', range: '[0]', content: '"test2"'}],
                        method: 'PUT'
                    }
                )
                resolve('returned ' + res.status)
            })
            p.then(x => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(x));
            })
        })()
        `;

        var response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: code_to_eval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        var result = await response.json();
        return result
    },
    'returned 200'
);

run_test(
    "PUT with multiples patches",
    async () => {
        var code_to_eval = `
        void (() => {
            if (typeof fetch === 'undefined') return res.end('"old node version"')
            var p = new Promise(async (resolve, reject) => {
                var res = await braid_fetch(
                    'https://localhost:' + port + '/json',
                    {
                        version: ['test3'],
                        patches: [
                            {unit: 'jsonpath', range: '[0]', content: '"test3"'},
                            {unit: 'jsonpath', range: '[1]', content: '"test3"'},
                            {unit: 'jsonpath', range: '[2]', content: '"test3"'}
                        ],
                        method: 'PUT'
                    }
                )
                resolve('returned ' + res.status)
            })
            p.then(x => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(x));
            })
        })()
        `;

        var response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: code_to_eval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        var result = await response.json();
        return result
    },
    'returned 200'
);

run_test(
    "PUT with empty patches array",
    async () => {
        var code_to_eval = `
        void (() => {
            if (typeof fetch === 'undefined') return res.end('"old node version"')
            var p = new Promise(async (resolve, reject) => {
                var res = await braid_fetch(
                    'https://localhost:' + port + '/json',
                    {
                        version: ['test4'],
                        patches: [],
                        method: 'PUT'
                    }
                )
                resolve('returned ' + res.status)
            })
            p.then(x => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(x));
            })
        })()
        `;

        var response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: code_to_eval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        var result = await response.json();
        return result
    },
    'returned 200'
);

add_section_header("Retry Tests")

run_test(
    "Verify that retry.retryRes gets heeded when true.",
    async () => {
        return await new Promise(done => {
            var count = 0
            var a = new AbortController()            
            setTimeout(() => {
                done('did not retry!')
                a.abort()
            }, 4000)
            fetch('/eval', {
                method: 'POST',
                signal: a.signal,
                multiplex: false,
                body: `
                    res.statusCode = 500
                    res.end('ok')
                `,
                onFetch: () => {
                    count++
                    if (count === 2) {
                        done('retried!')
                        a.abort()
                    }
                },
                retry: {
                    retryRes: (res) => true
                }
            })
        })
    },
    'retried!'
)

run_test(
    "Verify that retry.retryRes gets heeded when false.",
    async () => {
        return await new Promise(done => {
            var count = 0
            var a = new AbortController()
            setTimeout(() => {
                done('did not retry!')
                a.abort()
            }, 4000)
            fetch('/eval', {
                method: 'POST',
                signal: a.signal,
                multiplex: false,
                body: `
                    res.statusCode = 425
                    res.end('ok')
                `,
                onFetch: () => {
                    count++
                    if (count === 2) {
                        done('retried!')
                        a.abort()
                    }
                },
                retry: {
                    retryRes: (res) => false
                }
            })
        })
    },
    'did not retry!'
)

run_test(
    "Verify that setting retry as function gets heeded when true.",
    async () => {
        return await new Promise(done => {
            var count = 0
            var a = new AbortController()            
            setTimeout(() => {
                done('did not retry!')
                a.abort()
            }, 4000)
            fetch('/eval', {
                method: 'POST',
                signal: a.signal,
                multiplex: false,
                body: `
                    res.statusCode = 500
                    res.end('ok')
                `,
                onFetch: () => {
                    count++
                    if (count === 2) {
                        done('retried!')
                        a.abort()
                    }
                },
                retry: (res) => true
            })
        })
    },
    'retried!'
)

run_test(
    "Verify that setting retry as function gets heeded when false.",
    async () => {
        return await new Promise(done => {
            var count = 0
            var a = new AbortController()
            setTimeout(() => {
                done('did not retry!')
                a.abort()
            }, 4000)
            fetch('/eval', {
                method: 'POST',
                signal: a.signal,
                multiplex: false,
                body: `
                    res.statusCode = 425
                    res.end('ok')
                `,
                onFetch: () => {
                    count++
                    if (count === 2) {
                        done('retried!')
                        a.abort()
                    }
                },
                retry: (res) => false
            })
        })
    },
    'did not retry!'
)

run_test(
    "Verify that we retry on 503",
    async () => {
        return await new Promise(done => {
            var count = 0
            var a = new AbortController()            
            fetch('/eval', {
                method: 'POST',
                signal: a.signal,
                multiplex: false,
                body: `
                    res.statusCode = 503
                    res.end('ok')
                `,
                onFetch: () => {
                    count++
                    if (count === 2) {
                        done('retried!')
                        a.abort()
                    }
                },
                retry: true
            })
        })
    },
    'retried!'
)

run_test(
    "Verify that we retry on 400 Missing Parents",
    async () => {
        return await new Promise(done => {
            var count = 0
            var a = new AbortController()
            fetch(`https://localhost:${port + 2}/eval`, {
                method: 'POST',
                signal: a.signal,
                multiplex: false,
                body: `
                    res.writeHead(510, 'Missing Parents', { 'Content-Type': 'text/plain' })
                    res.end('ok!')
                `,
                onFetch: () => {
                    console.log('got here!!!!')
                    count++
                    if (count === 2) {
                        done('retried!')
                        a.abort()
                    }
                },
                retry: true
            })
        })
    },
    'retried!'
)

run_test(
    "Verify that we retry when Retry-After is set",
    async () => {
        return await new Promise(done => {
            var count = 0
            var a = new AbortController()            
            fetch('/eval', {
                method: 'POST',
                signal: a.signal,
                multiplex: false,
                body: `
                    res.statusCode = 500
                    res.setHeader('Retry-After', '')
                    res.end('ok')
                `,
                onFetch: () => {
                    console.log('got here!!!!')
                    count++
                    if (count === 2) {
                        done('retried!')
                        a.abort()
                    }
                },
                retry: true
            })
        })
    },
    'retried!'
)

run_test(
    "Verify that unparsable headers do not result in retrying connection.",
    async () => {
        var a = new AbortController()
        var count = 0
        return '' + await new Promise(async (done, fail) => {
            var res = await fetch("/parse_error", { retry: {
                onRes: () => {
                    count++
                    if (count === 2) fail('retried')
                }
            }, subscribe: true, multiplex: false, signal: a.signal })
            res.subscribe((u) => {}, done)
        })
    },
    'ParseError: Parse error in headers: "hello: true\\r\\nhello\\r\\nContent-Length: 2\\r\\n\\r\\n"'
)

run_test(
    "Should not retry on HTTP 400",
    async () => {
        var r = await fetch("/400", { retry: true })
        return '' + r.status
    },
    "400"
)

run_test(
    "Should not retry on HTTP 401 (access denied)",
    async () => {
        var r = await fetch("/401", { retry: true })
        return '' + r.status
    },
    "401"
)

run_test(
    "Should not try at all if abort controller already aborted",
    async () => {
        var a = new AbortController()
        a.abort()
        try {
            await fetch("/keep_open", { retry: true, signal: a.signal })
            throw new Error("Should have been aborted")
        } catch (e) {
            return e.message
        }
    },
    "already aborted"
)

run_test(
    "Should not retry if aborted",
    async () => {
        var a = new AbortController()
        setTimeout(() => a.abort(), 30)
        try {
            await fetch("/keep_open", { retry: true, signal: a.signal })
            throw new Error("Should have been aborted")
        } catch (e) {
            return e.name
        }
    },
    "AbortError"
)

run_test(
    "Should not retry if already aborted",
    async () => {
        var a = new AbortController()
        a.abort()
        try {
            await fetch("/keep_open", { signal: a.signal })
            throw new Error("Should have been aborted")
        } catch (e) {
            return e.name
        }
    },
    "AbortError"
)

run_test(
    "Should not retry if aborted, when subscribed",
    async () => {
        var good = false
        var a = new AbortController()
        try {
            var res = await fetch("/json", {
                signal: a.signal,
                retry: true,
                subscribe: true,
                multiplex: false,
            })
            await new Promise((done, fail) => {
                setTimeout(() => a.abort(), 30)
                setTimeout(() => fail(new Error("abort failed 1")), 60)
                res.subscribe((update) => {
                    if (update.body != null) update.body = update.body_text
                    if (JSON.stringify(update) === JSON.stringify(test_update)) good = true
                }, fail)
            })
        } catch (e) {
            return e.name === "AbortError" && good ? "passed" : "failed"
        }
    },
    "passed"
)

run_test(
    "Verify that retry option works with subscribe",
    async () => {
        var a = new AbortController()
        var x = await new Promise(async (done, fail) => {
            try {
                var res = await braid_fetch("/json", {
                    retry: true,
                    signal: a.signal,
                    subscribe: true,
                    multiplex: false,
                })
            } catch (e) {
                fail(e)
            }
            res.subscribe(done, fail)
        })
        a.abort()
        if (x.body != null) x.body = x.body_text
        return JSON.stringify(x)
    },
    JSON.stringify(test_update)
)

var {status, ...test_update_without_status} = test_update
run_test(
    "Should retry on HTTP 408",
    async () => {
        var x = await (await fetch("/retry", { retry: true })).json()
        return JSON.stringify(x)
    },
    JSON.stringify(test_update_without_status)
)

run_test(
    "Verify that onRes is called on first connection",
    async () => {
        try {
            await new Promise((done, fail) => {
                fetch("/", { retry: { onRes: done } })
                setTimeout(() => fail(new Error("onRes was NOT called")), 100)
            })
            return "onRes was called"
        } catch (e) {
            return e.message
        }
    },
    "onRes was called"
)

run_test(
    "Verify that onRes is called on reconnections",
    async () => {
        var onRes_count = 0
        var update_count = 0
        try {
            await new Promise(async (done, fail) => {
                var a = new AbortController()
                var res = await fetch("/json", {
                    retry: { onRes: () => onRes_count++ },
                    subscribe: true,
                    multiplex: false,
                    headers: { giveup: true },
                    signal: a.signal,
                })
                res.subscribe(
                    (update) => {
                        if (update.body != null) update.body = update.body_text
                        if (JSON.stringify(update) === JSON.stringify(test_update)) update_count++
                        if (update_count > 1) done()
                    },
                    (e) => fail(new Error("fetch error: " + e))
                )
                setTimeout(() => {
                    a.abort()
                    fail(new Error("timed out: " + JSON.stringify({ onRes_count, update_count })))
                }, 3000)
            })
            return `onRes_count=${onRes_count}, update_count=${update_count}`
        } catch (e) {
            return e.message
        }
    },
    "onRes_count=2, update_count=2"
)

run_test(
    "Verify that retry works with for-await style subscription",
    async () => {
        var updates = []
        var a = new AbortController()
        for await (var update of (await fetch('/json', {retry: true, signal: a.signal, subscribe: true, multiplex: false, headers: {giveup: true}})).subscription) {
            if (update.body != null) update.body = update.body_text
            updates.push(JSON.stringify(update))

            if (updates.length === 3) break
        }
        a.abort()
        return updates.join('\n')
    },
    '{"version":["test"],"parents":["oldie"],"body":"{\\\"this\\\":\\\"stuff\\\"}","status":"200"}\n' +
    '{"version":["test"],"parents":["oldie"],"body":"{\\\"this\\\":\\\"stuff\\\"}","status":"200"}\n' +
    '{"version":["test"],"parents":["oldie"],"body":"{\\\"this\\\":\\\"stuff\\\"}","status":"200"}'
)

run_test(
    "Should stop retrying in a subscription if reconnection attempt returns HTTP 500",
    async () => {
        var giveup_completely = Math.random().toString(36).slice(2)
        var updates = []
        return await new Promise(async (done, fail) => {
            var res = await fetch('/json', {retry: true, subscribe: true, multiplex: false, headers: {giveup_completely}, multiplex: false})
            res.subscribe((update) => {
                if (update.body != null) update.body = update.body_text
                updates.push(JSON.stringify(update))
            }, (e) => {
                done('' + updates + ' -- ' + e)
            })
        })
    },
    '{"version":["test"],"parents":["oldie"],"body":"{\\"this\\":\\"stuff\\"}","status":"200"} -- Error: giving up because of http status: 500'
)

run_test(
    "Should throw an exception in for-await style when subscription encounters HTTP 500",
    async () => {
        var giveup_completely = Math.random().toString(36).slice(2)
        var updates = []
        try {
            for await (var update of (await fetch('/json', {retry: true, subscribe: true, multiplex: false, headers: {giveup_completely}})).subscription) {
                if (update.body != null) update.body = update.body_text
                updates.push(JSON.stringify(update))
            }
        } catch (e) {
            return '' + updates + ' -- ' + e
        }
    },
    '{"version":["test"],"parents":["oldie"],"body":"{\\"this\\":\\"stuff\\"}","status":"200"} -- Error: giving up because of http status: 500'
)

add_section_header('Binary Tests')

run_test(
    "Verify basic binary GET",
    async () => {
        var x = await fetch('/binary')
        x = await x.arrayBuffer()
        x = new Uint8Array(x)
        x = [...x]
        return x.join(', ')
    },
    new Array(256).fill(0).map((x, i) => i).join(', ')
)

run_test(
    "Verify binary data in subscription update",
    async () => {
        var a = new AbortController()
        var x = await new Promise(async (done, fail) => {
            var x = await fetch('/binary', {subscribe: true, multiplex: false, signal: a.signal})
            x.subscribe(done, fail)
        })
        a.abort()
        return '' + x.body
    },
    '' + new Array(256).fill(0).map((x, i) => i)
)

add_section_header("onSubscriptionStatus Tests")

run_test(
    "onSubscriptionStatus fires online:true on initial connection",
    async () => {
        var a = new AbortController()
        var events = []
        var res = await fetch('/json', {
            subscribe: true,
            multiplex: false,
            signal: a.signal,
            onSubscriptionStatus: (s) => events.push(s)
        })
        await new Promise(done => {
            res.subscribe(() => setTimeout(done, 100))
        })
        a.abort()
        return `events=${events.length},online=${events[0]?.online}`
    },
    'events=1,online=true'
)

run_test(
    "onSubscriptionStatus fires online:true on reconnect",
    async () => {
        braid_fetch.reconnect_delay_ms = 150
        var a = new AbortController()
        var first_event = null
        var waiter = null
        var res = await fetch('/json', {
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            headers: { giveup: true },
            onSubscriptionStatus: (s) => {
                if (!first_event) {
                    first_event = s
                    waiter?.()
                }
            }
        })
        var result = await new Promise((done, fail) => {
            waiter = () => done(`online=${first_event.online}`)
            if (first_event) waiter()
            res.subscribe(() => {}, () => {})
            setTimeout(() => done('timed out'), 5000)
        })
        a.abort()
        delete braid_fetch.reconnect_delay_ms
        return result
    },
    'online=true'
)

run_test(
    "onSubscriptionStatus online:true has no extra fields",
    async () => {
        braid_fetch.reconnect_delay_ms = 150
        var a = new AbortController()
        var first_event = null
        var waiter = null
        var res = await fetch('/json', {
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            headers: { giveup: true },
            onSubscriptionStatus: (s) => {
                if (!first_event) {
                    first_event = s
                    waiter?.()
                }
            }
        })
        var result = await new Promise((done, fail) => {
            waiter = () => done(JSON.stringify(first_event))
            if (first_event) waiter()
            res.subscribe(() => {}, () => {})
            setTimeout(() => done('timed out'), 5000)
        })
        a.abort()
        delete braid_fetch.reconnect_delay_ms
        return result
    },
    '{"online":true}'
)

run_test(
    "onSubscriptionStatus lifecycle: true, false, true",
    async () => {
        braid_fetch.reconnect_delay_ms = 150
        var a = new AbortController()
        var events = []
        var waiter = null
        var res = await fetch('/json', {
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            headers: { giveup: true },
            onSubscriptionStatus: (s) => {
                events.push(s.online)
                if (events.length >= 3) waiter?.()
            }
        })
        var result = await new Promise((done, fail) => {
            waiter = () => done(events.slice(0, 3).join(', '))
            if (events.length >= 3) waiter()
            res.subscribe(() => {}, () => {})
            setTimeout(() => done('timed out: ' + events.join(', ')), 5000)
        })
        a.abort()
        delete braid_fetch.reconnect_delay_ms
        return result
    },
    'true, false, true'
)

run_test(
    "onSubscriptionStatus offline event has error, no status",
    async () => {
        braid_fetch.reconnect_delay_ms = 150
        var a = new AbortController()
        var offline_event = null
        var waiter = null
        var res = await fetch('/json', {
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            headers: { giveup: true },
            onSubscriptionStatus: (s) => {
                if (!s.online && !offline_event) {
                    offline_event = s
                    waiter?.()
                }
            }
        })
        var result = await new Promise((done, fail) => {
            waiter = () => {
                var has_error = offline_event.error !== undefined
                var no_status = offline_event.status === undefined
                done(`has_error=${has_error}, no_status=${no_status}`)
            }
            if (offline_event) waiter()
            res.subscribe(() => {}, () => {})
            setTimeout(() => done('timed out'), 5000)
        })
        a.abort()
        delete braid_fetch.reconnect_delay_ms
        return result
    },
    'has_error=true, no_status=true'
)

run_test(
    "onSubscriptionStatus offline error is descriptive",
    async () => {
        braid_fetch.reconnect_delay_ms = 150
        var a = new AbortController()
        var offline_event = null
        var waiter = null
        var res = await fetch('/json', {
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            headers: { giveup: true },
            onSubscriptionStatus: (s) => {
                if (!s.online && !offline_event) {
                    offline_event = s
                    waiter?.()
                }
            }
        })
        var result = await new Promise((done, fail) => {
            waiter = () => done('' + offline_event.error)
            if (offline_event) waiter()
            res.subscribe(() => {}, () => {})
            setTimeout(() => done('timed out'), 5000)
        })
        a.abort()
        delete braid_fetch.reconnect_delay_ms
        return result
    },
    'PipeError: Connection closed'
)

run_test(
    "onSubscriptionStatus cycles through 5 transitions",
    async () => {
        braid_fetch.reconnect_delay_ms = 150
        var a = new AbortController()
        var events = []
        var waiter = null
        var res = await fetch('/json', {
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            headers: { giveup: true },
            onSubscriptionStatus: (s) => {
                events.push(s.online)
                if (events.length >= 5) waiter?.()
            }
        })
        var result = await new Promise((done, fail) => {
            waiter = () => done(events.slice(0, 5).join(', '))
            if (events.length >= 5) waiter()
            res.subscribe(() => {}, () => {})
            setTimeout(() => done('timed out: ' + events.join(', ')), 10000)
        })
        a.abort()
        delete braid_fetch.reconnect_delay_ms
        return result
    },
    'true, false, true, false, true'
)

run_test(
    "onSubscriptionStatus offline from parse error has descriptive error",
    async () => {
        braid_fetch.reconnect_delay_ms = 150
        var a = new AbortController()
        var test_id = Math.random().toString(36).slice(2)
        var events = []
        var waiter = null
        var res = await fetch('/eval', {
            method: 'POST',
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            onSubscriptionStatus: (s) => {
                events.push(s)
                if (!s.online && events.filter(e => !e.online).length >= 2) waiter?.()
            },
            body: `
                global._oss_${test_id} = (global._oss_${test_id} || 0) + 1
                var n = global._oss_${test_id}
                res.startSubscription()
                res.sendUpdate({version: ['v' + n], body: 'hi'})
                if (n === 1) setTimeout(() => res.end(), 200)
                else if (n === 2) setTimeout(() => res.write('bad_header_no_colon\\r\\n\\r\\n'), 200)
            `
        })
        var result = await new Promise((done, fail) => {
            waiter = () => {
                var offline_events = events.filter(e => !e.online)
                var online_first = events[0].online
                var has_two_offline = offline_events.length >= 2
                var is_parse_error = ('' + offline_events[1].error).includes('Parse error')
                done(`${online_first}, ${has_two_offline}, ${is_parse_error}`)
            }
            if (events.filter(e => !e.online).length >= 2) waiter()
            res.subscribe(() => {}, () => {})
            setTimeout(() => done('timed out: ' + JSON.stringify(events.map(e => ({online: e.online, error: '' + e.error})))), 5000)
        })
        a.abort()
        delete braid_fetch.reconnect_delay_ms
        return result
    },
    'true, true, true'
)

run_test(
    "onSubscriptionStatus not called without subscribe",
    async () => {
        var events = []
        await fetch('/json', {
            onSubscriptionStatus: (s) => events.push(s)
        })
        return `events=${events.length}`
    },
    'events=0'
)

add_section_header("already_buffered_body Tests")

run_test(
    "already_buffered_body works for multiple patches",
    async () => {
        var r = await fetch('/json_prebuffered', {
            method: 'PUT',
            headers: {check_patch_content_text: true},
            patches: [
                {unit: 'text', range: '[0:0]', content: 'first'},
                {unit: 'text', range: '[5:5]', content: 'second'}
            ]
        })
        return await r.text()
    },
    'first\nsecond\n'
)

add_section_header("Content-Type: application/http-patches Tests")

run_test(
    "Multi-patch PUT sends Content-Type: application/http-patches",
    async () => {
        var r = await fetch('/json_echo_content_type', {
            method: 'PUT',
            patches: [
                {unit: 'text', range: '[0:0]', content: 'a'},
                {unit: 'text', range: '[1:1]', content: 'b'}
            ]
        })
        return await r.text()
    },
    'application/http-patches; count=2'
)

run_test(
    "Single-patch PUT does not send Content-Type: application/http-patches",
    async () => {
        var r = await fetch('/json_echo_content_type', {
            method: 'PUT',
            patches: {unit: 'text', range: '[0:0]', content: 'a'}
        })
        var type = await r.text()
        return '' + !type.startsWith('application/http-patches')
    },
    'true'
)

add_section_header("Parsing patches with new vs legacy patch-count headers")
//
// During the transition from `Patches: N` to `Content-Type:
// application/http-patches; count=N`, both forms must be parsed.
// We test:
//   - new form alone (Content-Type only)
//   - legacy form alone (Patches: N only)
// (Both together is exercised by every other test, since that's what
// the server currently emits.)

run_test(
    "Server parses multi-patch PUT with only Content-Type: application/http-patches; count=N (no Patches: header)",
    async () => {
        var body =
            'Content-Length: 1\r\n' +
            'Content-Range: text [0:0]\r\n' +
            '\r\n' +
            'a\r\n' +
            '\r\n' +
            'Content-Length: 1\r\n' +
            'Content-Range: text [1:1]\r\n' +
            '\r\n' +
            'b'
        var r = await og_fetch(base_url + '/json', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/http-patches; count=2',
                check_patch_content_text: 'true'
            },
            body
        })
        return await r.text()
    },
    'a\nb\n'
)

run_test(
    "Server parses multi-patch PUT with only Patches: N header (no Content-Type)",
    async () => {
        var body =
            'Content-Length: 1\r\n' +
            'Content-Range: text [0:0]\r\n' +
            '\r\n' +
            'a\r\n' +
            '\r\n' +
            'Content-Length: 1\r\n' +
            'Content-Range: text [1:1]\r\n' +
            '\r\n' +
            'b'
        var r = await og_fetch(base_url + '/json', {
            method: 'PUT',
            headers: {
                'Patches': '2',
                check_patch_content_text: 'true'
            },
            body
        })
        return await r.text()
    },
    'a\nb\n'
)

run_test(
    "Client parses subscription update with only Content-Type: application/http-patches; count=N (no Patches: header)",
    async () => {
        var got
        await new Promise((resolve, reject) => {
            fetch('/eval', {
                method: 'POST',
                multiplex: false,
                body: `
                    res.startSubscription()
                    // Manually emit a multi-patch update with ONLY
                    // Content-Type: application/http-patches; count=2
                    // (no Patches: 2 header).
                    res.write('HTTP 200 OK\\r\\n' +
                              'Version: "v1"\\r\\n' +
                              'Content-Type: application/http-patches; count=2\\r\\n' +
                              '\\r\\n' +
                              'Content-Length: 1\\r\\n' +
                              'Content-Range: text [0:0]\\r\\n' +
                              '\\r\\n' +
                              'a\\r\\n\\r\\n' +
                              'Content-Length: 1\\r\\n' +
                              'Content-Range: text [1:1]\\r\\n' +
                              '\\r\\n' +
                              'b\\r\\n\\r\\n')
                    setTimeout(() => res.end(), 50)
                `
            }).then(r => r.subscribe(u => {
                if (u.patches) for (var p of u.patches) p.content = p.content_text
                got = JSON.stringify(u)
                resolve()
            }, reject))
        })
        return got
    },
    '{"version":["v1"],"patches":[{"unit":"text","range":"[0:0]","content":"a"},{"unit":"text","range":"[1:1]","content":"b"}],"status":"200"}'
)

add_section_header("Parsing updates from a single 200 response body")
run_test(
    "Parse a single 200 response body snapshot",
    async () => {
        var res = await fetch(base_url + '/single-update-snapshot')
        var update = await res.update()
        return JSON.stringify({version: update.version,
                               parents: update.parents,
                               body: JSON.parse(update.body_text)})
    },
    '{"version":["3"],"parents":["1"],"body":{"hello":"world"}}'
)
run_test(
    "Parse a single 200 response body with patches",
    async () => {
        var res = await fetch(base_url + '/single-update-patches')
        var update = await res.update()
        update.patches.forEach(p =>
            p.content = p.content_text
        )
        return JSON.stringify({version: update.version,
                               parents: update.parents,
                               patches: update.patches})
    },
    '{"version":["4"],"parents":["3"],"patches":[{"unit":"json","range":".hello","content":"worlds"},{"unit":"json","range":".and","content":"wonderverses"}]}'
)

add_section_header("Server patch: vs patches: wire format")

run_test(
    "patch: (singular) inlines without Patches: N",
    async () => {
        var raw = ''
        var r = await og_fetch(base_url + '/test_patches_n_trigger', {headers: {subscribe: 'true'}})
        var reader = r.body.getReader()
        while (true) {
            var {done, value} = await reader.read()
            if (done) break
            raw += new TextDecoder().decode(value)
        }
        // v1 uses patch: (singular) — should NOT have "Patches:" in its section
        var v1_section = raw.split('HTTP 200 OK')[1]
        var has_patches_header = v1_section.split('HTTP 200 OK')[0].includes('Patches:')
        var has_content_range = v1_section.split('HTTP 200 OK')[0].includes('Content-Range:')
        return JSON.stringify({has_patches_header, has_content_range})
    },
    JSON.stringify({has_patches_header: false, has_content_range: true})
)

run_test(
    "patches: (array of 1) uses Patches: 1",
    async () => {
        var raw = ''
        var r = await og_fetch(base_url + '/test_patches_n_trigger', {headers: {subscribe: 'true'}})
        var reader = r.body.getReader()
        while (true) {
            var {done, value} = await reader.read()
            if (done) break
            raw += new TextDecoder().decode(value)
        }
        // v2 is the second update — uses patches: array of 1
        var sections = raw.split('HTTP 200 OK')
        var v2_section = sections[2].split('HTTP 200 OK')[0]
        var has_patches_1 = v2_section.includes('Patches: 1')
        var has_message_http_patches = v2_section.includes('Content-Type: application/http-patches')
        return JSON.stringify({has_patches_1, has_message_http_patches})
    },
    JSON.stringify({has_patches_1: true, has_message_http_patches: true})
)

run_test(
    "patches: (array of 2) uses Patches: 2",
    async () => {
        var raw = ''
        var r = await og_fetch(base_url + '/test_patches_n_trigger', {headers: {subscribe: 'true'}})
        var reader = r.body.getReader()
        while (true) {
            var {done, value} = await reader.read()
            if (done) break
            raw += new TextDecoder().decode(value)
        }
        // v3 is the third update — uses patches: array of 2
        var sections = raw.split('HTTP 200 OK')
        var v3_section = sections[3]
        var has_patches_2 = v3_section.includes('Patches: 2')
        var has_message_http_patches = v3_section.includes('Content-Type: application/http-patches')
        return JSON.stringify({has_patches_2, has_message_http_patches})
    },
    JSON.stringify({has_patches_2: true, has_message_http_patches: true})
)

run_test(
    "status: false suppresses the HTTP status line in a subscription update",
    async () => {
        var raw = ''
        var r = await og_fetch(base_url + '/status_false_test', {headers: {subscribe: 'true'}})
        var reader = r.body.getReader()
        while (true) {
            var {done, value} = await reader.read()
            if (done) break
            raw += new TextDecoder().decode(value)
        }
        // Two updates are sent: the first with status:false (no status line),
        // the second with the default 200 (prints `HTTP 200 OK`). So we should
        // see exactly one status line, and both bodies should arrive.
        var status_line_count = (raw.match(/HTTP \d+ /g) || []).length
        return JSON.stringify({
            status_line_count,
            got_hidden: raw.includes('"hidden"'),
            got_shown: raw.includes('"shown"')
        })
    },
    JSON.stringify({status_line_count: 1, got_hidden: true, got_shown: true})
)

add_section_header("reliable_update_channel Tests")

run_test(
    "reliable_update_channel receives updates via on_update and put sends a PUT",
    async () => {
        var url = base_url + '/braid-text-test/reliable_update_channel_' + Math.random().toString(36).slice(2)
        var update_count = 0
        var resolve_second

        var got_second = new Promise(r => { resolve_second = r })

        // Subscribe — braid-text sends an initial empty update, then
        // our PUT should trigger a second update with the patch
        var channel = reliable_update_channel(url, {
            on_update: update => {
                update_count++
                if (update_count === 2) resolve_second(update)
            }
        })

        // Wait a moment for the subscription to establish, then PUT
        await new Promise(r => setTimeout(r, 200))

        var r = await channel.put({
            patches: [{unit: 'text', range: '[0:0]', content: 'hello'}]
        })

        var second_update = await got_second
        channel.close()

        return JSON.stringify({
            put_ok: r.ok,
            received_put_update: second_update.patches?.[0]?.content_text ?? second_update.body_text
        })
    },
    JSON.stringify({put_ok: true, received_put_update: 'hello'})
)

run_test(
    "reliable_update_channel retries the fetch if it throws",
    async () => {
        var key_suffix = 'retry_' + Math.random().toString(36).slice(2)
        var url = base_url + '/braid-text-test/' + key_suffix

        // Tell the server to fail the first GET on this key
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_fail_first_get[${JSON.stringify('/braid-text-test/' + key_suffix)}] = true; res.end('ok')`
        })

        // Subscribe — first attempt should fail with 500, then retry ~1s later and succeed
        var channel
        var got_update = new Promise(resolve => {
            channel = reliable_update_channel(url, {
                on_update: update => resolve(update)
            })
        })

        var update = await got_update
        channel.close()

        // We successfully reconnected after a failure — the update we got is
        // the initial (empty) update from braid-text on the retried connection
        return '' + (update !== undefined)
    },
    'true'
)

run_test(
    "reliable_update_channel retries put if it throws, and fires parallel puts in order",
    async () => {
        var key_suffix = 'put_retry_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // Tell the server to fail the first PUT on this key
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_fail_first_put[${JSON.stringify(full_key)}] = true; res.end('ok')`
        })

        var updates_body = []

        // Subscribe so we can observe the eventual state
        var channel = reliable_update_channel(url, {
            on_update: update => {
                if (update.body_text !== undefined) updates_body.push(update.body_text)
                else if (update.patches) updates_body.push('patches')
            }
        })

        // Wait for the subscription to establish
        await new Promise(r => setTimeout(r, 200))

        // Fire 3 PUTs in parallel. The first will be failed by the server,
        // which should abort all in-flight PUTs, and then all 3 should be
        // re-fired in order after the 1s retry delay.
        var results = await Promise.all([
            channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'a'}]}),
            channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'b'}]}),
            channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'c'}]})
        ])

        // Give the subscription a moment to receive the final state
        await new Promise(r => setTimeout(r, 300))
        channel.close()

        return JSON.stringify({
            all_ok: results.every(r => r.ok),
            num_results: results.length
        })
    },
    JSON.stringify({all_ok: true, num_results: 3})
)

run_test(
    "reliable_update_channel reconnects when heartbeats stop",
    async () => {
        // /noheartbeat sends one update then goes silent (no heartbeats).
        // With timeout: 0.5, the heartbeat timeout is 1.2*0.5+3 = 3.6s, so after
        // ~3.6s of silence we should reconnect and receive the initial
        // update a second time.
        var update_count = 0
        var got_second

        var second_update_promise = new Promise(resolve => { got_second = resolve })

        var channel = reliable_update_channel(base_url + '/noheartbeat', {
            timeout: 0.5,
            on_update: update => {
                update_count++
                if (update_count === 2) got_second()
            }
        })

        // Wait for the reconnect + 2nd update (give it plenty of time:
        // 3.6s heartbeat timeout + 1s retry delay = ~4.6s, plus slack)
        await Promise.race([
            second_update_promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 10000))
        ])

        channel.close()
        return '' + (update_count >= 2)
    },
    'true'
)

run_test(
    "reliable_update_channel on_warning is called for non-silent status codes",
    async () => {
        var key_suffix = 'warn_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // First GET returns 500 (not in the silent-retry list)
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_first_get_status[${JSON.stringify(full_key)}] = {status: 500}; res.end('ok')`
        })

        var warnings = []
        var channel
        var got_update = new Promise(resolve => {
            channel = reliable_update_channel(url, {
                on_warning: msg => warnings.push(msg),
                on_update: () => resolve()
            })
        })

        await got_update
        channel.close()

        return '' + warnings.some(w => /500/.test(w))
    },
    'true'
)

run_test(
    "reliable_update_channel does not warn on silent-retry status codes",
    async () => {
        var key_suffix = 'silent_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // First GET returns 503 (in the silent-retry list)
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_first_get_status[${JSON.stringify(full_key)}] = {status: 503}; res.end('ok')`
        })

        var warnings = []
        var channel
        var got_update = new Promise(resolve => {
            channel = reliable_update_channel(url, {
                on_warning: msg => warnings.push(msg),
                on_update: () => resolve()
            })
        })

        await got_update
        channel.close()

        return '' + (warnings.length === 0)
    },
    'true'
)

run_test(
    "reliable_update_channel honors Retry-After header on subscription responses",
    async () => {
        var key_suffix = 'retry_after_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // First GET returns 200 with Retry-After: 2 (seconds)
        // 200 is not in the silent-retry list, but Retry-After makes it silent.
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_first_get_status[${JSON.stringify(full_key)}] = {status: 200, retry_after: 2}; res.end('ok')`
        })

        var warnings = []
        var channel
        var start = Date.now()
        var got_update = new Promise(resolve => {
            channel = reliable_update_channel(url, {
                on_warning: msg => warnings.push(msg),
                on_update: () => resolve()
            })
        })

        await got_update
        var elapsed = Date.now() - start
        channel.close()

        // Without Retry-After, we'd reconnect after 1s. With Retry-After: 2,
        // the reconnect should happen ~2s after the first failure, so
        // total elapsed should be at least 1800ms (allowing some slack).
        return JSON.stringify({
            fast_enough: elapsed >= 1800,
            no_warnings: warnings.length === 0
        })
    },
    JSON.stringify({fast_enough: true, no_warnings: true})
)

run_test(
    "reliable_update_channel calls parents() callback on each (re)connect",
    async () => {
        var key_suffix = 'parents_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // Arm the server: log the parents header on every GET to this
        // key, and make every GET return 500 so the client keeps retrying.
        // We don't care about ever succeeding — we just want to observe
        // that parents() gets called fresh on each reconnect attempt.
        await fetch('/eval', {
            method: 'POST',
            body: `
                global.braid_text_get_parents_log[${JSON.stringify(full_key)}] = []
                global.braid_text_first_get_status[${JSON.stringify(full_key)}] = {status: 500}
                res.end('ok')
            `
        })

        // Application-side "latest version I know about". Changes between
        // the first GET and the retry so we can verify the callback was
        // re-invoked (not just memoized).
        var latest_parents = []
        var parents_call_count = 0
        var parents_cb = () => {
            parents_call_count++
            return latest_parents
        }

        var channel = reliable_update_channel(url, {
            reconnect_from_parents: parents_cb,
            on_warning: () => {},   // silence the expected 500 warning
            on_update: () => {}
        })

        // Wait for the first GET to fail, then switch the parents value.
        await new Promise(r => setTimeout(r, 300))
        latest_parents = ['abc-1']

        // Wait long enough for the 1s retry to fire and hit the server.
        // Every GET returns 500 (via first_get_status, which only fires
        // once — but that's enough: first GET is rigged, second hits
        // braid-text on an empty key which ignores the parents header).
        await new Promise(r => setTimeout(r, 1500))
        channel.close()

        // Read back what the server saw
        var log_res = await fetch('/eval', {
            method: 'POST',
            body: `res.end(JSON.stringify(global.braid_text_get_parents_log[${JSON.stringify(full_key)}]))`
        })
        var log = JSON.parse(await log_res.text())

        return JSON.stringify({
            called_at_least_twice: parents_call_count >= 2,
            first_had_no_parents: !log[0],
            second_had_abc_1: !!log[1] && /abc-1/.test(log[1])
        })
    },
    JSON.stringify({called_at_least_twice: true, first_had_no_parents: true, second_had_abc_1: true})
)

run_test(
    "reliable_update_channel retries all queued PUTs in parallel after reconnect",
    async () => {
        var key_suffix = 'fanout_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // Arm the server: fail the first PUT, delay every PUT by 200ms,
        // track PUT concurrency.
        await fetch('/eval', {
            method: 'POST',
            body: `
                global.braid_text_fail_first_put[${JSON.stringify(full_key)}] = true
                global.braid_text_put_delay_ms[${JSON.stringify(full_key)}] = 200
                global.braid_text_put_concurrency[${JSON.stringify(full_key)}] = {current: 0, max: 0}
                res.end('ok')
            `
        })

        var channel = reliable_update_channel(url, { on_update: () => {} })
        await new Promise(r => setTimeout(r, 200))   // let subscription establish

        // Fire 3 parallel PUTs. First hits 500 (fails fast); other two
        // are either completed, in-flight, or aborted when the failure
        // triggers the reconnect.
        var puts = Promise.all([
            channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'a'}]}),
            channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'b'}]}),
            channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'c'}]})
        ])

        // Wait for the initial fan-out to finish (the 500 fires fast, the
        // other two hit the 200ms delay, ~300ms is plenty). Then reset the
        // concurrency tracker so we only measure the retry phase.
        await new Promise(r => setTimeout(r, 400))
        await fetch('/eval', {
            method: 'POST',
            body: `
                var c = global.braid_text_put_concurrency[${JSON.stringify(full_key)}]
                c.max = c.current
                res.end('ok')
            `
        })

        // Let the retry run to completion (1s delay + fan-out 200ms).
        await puts
        await new Promise(r => setTimeout(r, 100))
        channel.close()

        // Read the retry-phase max concurrency.
        var retry_res = await fetch('/eval', {
            method: 'POST',
            body: `res.end(String(global.braid_text_put_concurrency[${JSON.stringify(full_key)}].max))`
        })
        var retry_max = parseInt(await retry_res.text())

        // All 3 queued PUTs should fan out in parallel after the GET
        // comes back online — no probe step.
        return JSON.stringify({
            all_fired_in_parallel: retry_max === 3
        })
    },
    JSON.stringify({all_fired_in_parallel: true})
)

run_test(
    "reliable_update_channel put: on_warning is called for non-silent status codes",
    async () => {
        var key_suffix = 'put_warn_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // First PUT returns 500 (not in the silent-retry list)
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_first_put_status[${JSON.stringify(full_key)}] = {status: 500}; res.end('ok')`
        })

        var warnings = []
        var channel = reliable_update_channel(url, {
            on_warning: msg => warnings.push(msg),
            on_update: () => {}
        })
        await new Promise(r => setTimeout(r, 200))  // let subscription establish

        await channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'x'}]})
        channel.close()

        return '' + warnings.some(w => /500/.test(w))
    },
    'true'
)

run_test(
    "reliable_update_channel put: does not warn on silent-retry status codes",
    async () => {
        var key_suffix = 'put_silent_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // First PUT returns 503 (in the silent-retry list)
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_first_put_status[${JSON.stringify(full_key)}] = {status: 503}; res.end('ok')`
        })

        var warnings = []
        var channel = reliable_update_channel(url, {
            on_warning: msg => warnings.push(msg),
            on_update: () => {}
        })
        await new Promise(r => setTimeout(r, 200))

        await channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'x'}]})
        channel.close()

        return '' + (warnings.length === 0)
    },
    'true'
)

run_test(
    "reliable_update_channel put: honors Retry-After header",
    async () => {
        var key_suffix = 'put_retry_after_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // First PUT returns 500 (not in silent list) with Retry-After: 2
        // — Retry-After makes it silent and delays the retry by ~2s.
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_first_put_status[${JSON.stringify(full_key)}] = {status: 500, retry_after: 2}; res.end('ok')`
        })

        var warnings = []
        var channel = reliable_update_channel(url, {
            on_warning: msg => warnings.push(msg),
            on_update: () => {}
        })
        await new Promise(r => setTimeout(r, 200))

        var start = Date.now()
        await channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'x'}]})
        var elapsed = Date.now() - start
        channel.close()

        // Without Retry-After, retry would be ~1s. With Retry-After: 2,
        // elapsed should be at least ~1800ms (allowing slack).
        return JSON.stringify({
            slow_enough: elapsed >= 1800,
            no_warnings: warnings.length === 0
        })
    },
    JSON.stringify({slow_enough: true, no_warnings: true})
)

run_test(
    "reliable_update_channel put: times out and retries if PUT never responds",
    async () => {
        var key_suffix = 'put_timeout_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // Hang the first PUT forever; second PUT succeeds normally.
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_hang_first_put[${JSON.stringify(full_key)}] = true; res.end('ok')`
        })

        // Short timeout so the test runs fast
        var channel = reliable_update_channel(url, {
            on_update: () => {},
            timeout: 1  // 1 second
        })
        await new Promise(r => setTimeout(r, 200))

        var start = Date.now()
        var r = await channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'x'}]})
        var elapsed = Date.now() - start
        channel.close()

        // The first PUT hangs, timing out after ~1s, then there's a 1s
        // retry delay, then the second PUT succeeds. Expect elapsed ~2s.
        return JSON.stringify({
            put_succeeded: r.ok,
            elapsed_at_least_1800ms: elapsed >= 1800
        })
    },
    JSON.stringify({put_succeeded: true, elapsed_at_least_1800ms: true})
)

run_test(
    "reliable_update_channel forwards user-supplied headers to GET and PUT",
    async () => {
        var key_suffix = 'headers_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // Arm the server to log headers on every request to this key.
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_headers_log[${JSON.stringify(full_key)}] = []; res.end('ok')`
        })

        var channel = reliable_update_channel(url, {
            // Use custom headers only — browsers forbid JS from setting
            // Cookie, Host, etc. via fetch(), so we can't test those here.
            get_headers: {
                'X-Test-Header': 'hello',
                'X-Another-Header': 'world'
            },
            put_headers: {
                'X-Test-Header': 'hello',
                'X-Another-Header': 'world'
            },
            on_update: () => {}
        })
        await new Promise(r => setTimeout(r, 200))
        await channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'x'}]})
        channel.close()

        // Read back what the server saw.
        var log_res = await fetch('/eval', {
            method: 'POST',
            body: `res.end(JSON.stringify(global.braid_text_headers_log[${JSON.stringify(full_key)}]))`
        })
        var log = JSON.parse(await log_res.text())
        var get_req = log.find(r => r.method === 'GET')
        var put_req = log.find(r => r.method === 'PUT')

        return JSON.stringify({
            get_saw_header: get_req?.headers['x-test-header'] === 'hello',
            get_saw_another: get_req?.headers['x-another-header'] === 'world',
            put_saw_header: put_req?.headers['x-test-header'] === 'hello',
            put_saw_another: put_req?.headers['x-another-header'] === 'world'
        })
    },
    JSON.stringify({get_saw_header: true, get_saw_another: true, put_saw_header: true, put_saw_another: true})
)

run_test(
    "reliable_update_channel warns and aborts on subscription parse errors",
    async () => {
        var warnings = []
        var on_error_called_with = null
        var channel

        var shutdown_promise = new Promise(resolve => {
            channel = reliable_update_channel(base_url + '/parse_error', {
                on_warning: msg => warnings.push(msg),
                on_error: err => {
                    on_error_called_with = err
                    resolve()
                }
            })
        })

        // The parse_error endpoint sends garbage; parser should fail, warn,
        // and trigger shutdown via on_error.
        await Promise.race([
            shutdown_promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 5000))
        ])
        channel.close()

        return JSON.stringify({
            warned: warnings.some(w => /Parse error/i.test(w)),
            on_error_fired: on_error_called_with !== null,
            error_has_parse_message: /Parse error/i.test(on_error_called_with?.message || '')
        })
    },
    JSON.stringify({warned: true, on_error_fired: true, error_has_parse_message: true})
)

run_test(
    "reliable_update_channel on_status reports online transitions",
    async () => {
        var key_suffix = 'status_online_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // First GET returns 500, so we go: offline → reconnect → online
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_first_get_status[${JSON.stringify(full_key)}] = {status: 500}; res.end('ok')`
        })

        var statuses = []
        var channel
        var got_update = new Promise(resolve => {
            channel = reliable_update_channel(url, {
                on_update: () => resolve(),
                on_status: (status) => statuses.push({...status}),
                on_warning: () => {}
            })
        })

        await got_update
        channel.close()

        // We expect: first on_status with online:true when the retry
        // succeeds (the initial connect never goes online, so there's
        // no offline transition for it).
        return JSON.stringify({
            went_online: statuses.some(s => s.online === true),
            has_statuses: statuses.length >= 1
        })
    },
    JSON.stringify({went_online: true, has_statuses: true})
)

run_test(
    "reliable_update_channel on_status reports outstanding_puts",
    async () => {
        var url = base_url + '/braid-text-test/status_puts_' + Math.random().toString(36).slice(2)

        var statuses = []
        var channel = reliable_update_channel(url, {
            on_update: () => {},
            on_status: (status) => statuses.push({...status})
        })

        // Wait for subscription to establish
        await new Promise(r => setTimeout(r, 200))

        // Fire a PUT and wait for it to complete
        await channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'x'}]})
        channel.close()

        // We should see outstanding_puts go to 1 (enqueued) then back
        // to 0 (completed).
        var saw_one = statuses.some(s => s.outstanding_puts === 1)
        var saw_zero_after = false
        for (var i = 0; i < statuses.length; i++) {
            if (statuses[i].outstanding_puts === 1) {
                for (var j = i + 1; j < statuses.length; j++) {
                    if (statuses[j].outstanding_puts === 0) { saw_zero_after = true; break }
                }
                break
            }
        }

        return JSON.stringify({
            saw_enqueued: saw_one,
            saw_completed: saw_zero_after
        })
    },
    JSON.stringify({saw_enqueued: true, saw_completed: true})
)

run_test(
    "reliable_update_channel failure_status_codes shuts down on matching GET status",
    async () => {
        var key_suffix = 'no_retry_get_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // Make the first GET return 403
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_first_get_status[${JSON.stringify(full_key)}] = {status: 403}; res.end('ok')`
        })

        var errors = []
        var channel
        var got_error = new Promise(resolve => {
            channel = reliable_update_channel(url, {
                on_update: () => {},
                on_error: err => { errors.push(err); resolve() },
                failure_status_codes: [403]
            })
        })

        await got_error
        channel.close()

        return '' + (errors.length === 1 && /403/.test(errors[0].message))
    },
    'true'
)

run_test(
    "reliable_update_channel failure_status_codes shuts down on matching PUT status",
    async () => {
        var key_suffix = 'no_retry_put_' + Math.random().toString(36).slice(2)
        var full_key = '/braid-text-test/' + key_suffix
        var url = base_url + full_key

        // Make the first PUT return 403
        await fetch('/eval', {
            method: 'POST',
            body: `global.braid_text_first_put_status[${JSON.stringify(full_key)}] = {status: 403}; res.end('ok')`
        })

        var errors = []
        var channel
        var got_error = new Promise(resolve => {
            channel = reliable_update_channel(url, {
                on_update: () => {},
                on_error: err => { errors.push(err); resolve() },
                failure_status_codes: [403]
            })
        })

        await new Promise(r => setTimeout(r, 200))  // let subscription establish

        // The PUT should trigger shutdown, not retry
        channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'x'}]}).catch(() => {})
        await got_error
        channel.close()

        return '' + (errors.length === 1 && /403/.test(errors[0].message))
    },
    'true'
)

run_test(
    "reliable_update_channel reconnect() triggers a fresh reconnection",
    async () => {
        var url = base_url + '/braid-text-test/manual_reconnect_' + Math.random().toString(36).slice(2)

        var parents_call_count = 0
        var statuses = []
        var channel
        var first_online = new Promise(resolve => {
            channel = reliable_update_channel(url, {
                on_update: () => {},
                reconnect_from_parents: () => { parents_call_count++; return [] },
                on_status: (status) => {
                    statuses.push({...status})
                    if (status.online) resolve()
                }
            })
        })

        await first_online
        var calls_before = parents_call_count
        var online_count_before = statuses.filter(s => s.online).length

        // Manually trigger a reconnect
        channel.reconnect()

        // Wait for it to come back online
        await new Promise(resolve => {
            var check = () => {
                if (statuses.filter(s => s.online).length > online_count_before) resolve()
                else setTimeout(check, 50)
            }
            check()
        })

        channel.close()

        return JSON.stringify({
            parents_called_again: parents_call_count > calls_before,
            went_offline_then_online: statuses.some(s => !s.online) &&
                statuses.filter(s => s.online).length >= 2
        })
    },
    JSON.stringify({parents_called_again: true, went_offline_then_online: true})
)


    add_section_header("update_pipe Tests")

    // ── shared helpers for the update_pipe tests ──────────────────────────
    var rid   = () => Math.random().toString(36).slice(2)
    var sleep = ms => new Promise(r => setTimeout(r, ms))
    var drop_conn    = ep => og_fetch(ep + '?_drop')       // cut the live subscriptions
    var release_puts = ep => og_fetch(ep + '?_release')    // free the held PUT responses
    var server_puts  = async ep => (await og_fetch(ep + '?_puts')).json()  // the received-PUT log
    var decode = b => typeof b === 'string' ? b : new TextDecoder().decode(b)

    // A configurable braid server:
    // it 209-subscribes (or polls, or refuses), logs PUTs, and answers control
    // requests (?_drop / ?_release / ?_puts).  State lives in a per-test global
    // so control requests can reach it.  opts.put_behavior is a source string:
    // n => 'ok' | 'hold' | 'drop' | <status number>.  The handler runs
    // server-side (its source is shipped over the wire), so it can't close over
    // test variables — everything it needs is baked into the source here.
    function pipe_server (test_id, opts = {}) {
        var o = JSON.stringify({
            subscribe_status: opts.subscribe_status ?? null,
            poll_mode:        !!opts.poll_mode,
            send_heartbeats:  opts.send_heartbeats !== false,
            put_status:       opts.put_status ?? 200,
            fail_first_put:   !!opts.fail_first_put
        })
        var put_behavior = opts.put_behavior ? '(' + opts.put_behavior + ')' : 'null'
        return `(req, res) => {
            var G = (global._pipe_${test_id} ||= {puts: [], live: [], held: [], poll: 0, put_count: 0, holding: ${!!opts.hold_puts}})
            var o = ${o}
            var put_behavior = ${put_behavior}
            var q = new URL(req.url, 'http://x').searchParams

            // control requests
            if (q.has('_drop'))    { for (var s of G.live) s.destroy(); G.live = []; return res.end('ok') }
            if (q.has('_release')) { G.holding = false; for (var f of G.held) f(); G.held = []; return res.end('ok') }
            if (q.has('_puts'))    { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(G.puts)) }

            // subscriptions
            if (req.subscribe) {
                if (q.get('u') === 'hang')  { G.live.push(res.socket); return }          // never answer
                if (o.subscribe_status)     { res.statusCode = o.subscribe_status; return res.end() }
                if (o.poll_mode) {                                                       // plain 200, no 209
                    res.statusCode = 200
                    res.setHeader('version', JSON.stringify('v' + (++G.poll)))
                    return res.end('state' + G.poll)
                }
                if (!o.send_heartbeats) delete req.headers['heartbeats']
                G.live.push(res.socket)
                res.startSubscription()
                res.sendUpdate({version: ['v1'], body: 'hello'})
                return
            }

            // writes
            if (req.method === 'PUT') {
                var n = ++G.put_count
                var action = put_behavior ? put_behavior(n)
                           : o.fail_first_put && n === 1 ? 'drop'
                           : G.holding ? 'hold' : 'ok'
                if (action === 'drop') return req.socket.destroy()
                req.parseUpdate().then(update => {
                    G.puts.push({version: update.version, body: update.body && Buffer.from(update.body).toString()})
                    var respond = () => { res.statusCode = typeof action === 'number' ? action : o.put_status; res.end() }
                    if (action === 'hold') G.held.push(respond)
                    else respond()
                })
                return
            }

            res.statusCode = 200; res.end('ok')
        }`
    }

    run_test(
        "update_pipe: A dropped connection takes the host offline",
        async () => {
            // 0. Subscribe to a healthy 209 host.
            var ep = await add_main_handler(pipe_server('drop_' + rid()))
            var host = new URL(ep).host
            var updates = []
            var pipe = update_pipe(m => updates.push(m), {reconnect_interval: 60})
            pipe.get(ep)

            // 1. It delivers its first update (a 'set'), and the host is online.
            await sleep(300)
            assert(updates.length === 1, 'should receive one update')
            assert(updates[0].type === 'set', "delivered as a 'set' message")
            assert(decode(updates[0].body) === 'hello', 'body should be "hello"')
            assert(pipe.network.hosts[host].online === true, 'host online after 209')

            // 2. Drop the connection — the host should go offline.
            await drop_conn(ep)
            await sleep(500)
            assert(pipe.network.hosts[host].online === false, 'host offline after the drop')

            pipe.forget(ep)
        }
    )

    run_test(
        "update_pipe: A silent connection (no heartbeats) times out to offline",
        async () => {
            // 0. Subscribe to a host that ignores our heartbeat request, with a 1s timeout.
            var ep = await add_main_handler(pipe_server('hb_' + rid(), {send_heartbeats: false}))
            var host = new URL(ep).host
            var pipe = update_pipe(() => {}, {timeout: 1, reconnect_interval: 60})
            pipe.get(ep)

            // 1. The 209 arrives, so we're online.
            await sleep(300)
            assert(pipe.network.hosts[host].online === true, 'online after the 209')

            // 2. No bytes arrive for longer than the timeout — the host should go offline.
            await sleep(1200)
            assert(pipe.network.hosts[host].online === false, 'offline after the heartbeat timeout')

            pipe.forget(ep)
        }
    )

    run_test(
        "update_pipe: The reconnection poll brings a dropped host back online",
        async () => {
            // 0. Subscribe; we're online with one update.
            var ep = await add_main_handler(pipe_server('rc_' + rid()))
            var host = new URL(ep).host
            var updates = []
            var pipe = update_pipe(m => updates.push(m), {reconnect_interval: 0.3})
            pipe.get(ep)

            await sleep(300)
            assert(pipe.network.hosts[host].online === true, 'online initially')
            assert(updates.length === 1, 'one update initially')

            // 1. Drop the connection — the host goes offline.
            await drop_conn(ep)

            // 2. The poll (every 0.3s) reconnects and delivers a fresh update.
            await sleep(900)
            assert(pipe.network.hosts[host].online === true, 'back online after reconnect')
            assert(updates.length >= 2, 'reconnect delivered a fresh update')

            pipe.forget(ep)
        }
    )

    run_test(
        "update_pipe: One host going down leaves the others online (per-host isolation)",
        async () => {
            // 0. Subscribe to two URLs on each of two separate hosts.
            var ep1 = await add_main_handler(pipe_server('m1_' + rid()))     // host 1 (main server)
            var ep2 = await add_express_handler(pipe_server('m2_' + rid()))  // host 2 (express server)
            var h1 = new URL(ep1).host, h2 = new URL(ep2).host
            var urls = [ep1 + '?u=a', ep1 + '?u=b', ep2 + '?u=a', ep2 + '?u=b']
            var got = {}
            var pipe = update_pipe(m => { got[m.url] = (got[m.url] || 0) + 1 }, {reconnect_interval: 0.3})
            for (var u of urls) pipe.get(u)

            // 1. All four are online; both hosts and the network are up.
            await sleep(500)
            for (var u of urls) assert(got[u] === 1, 'one update for ' + u)
            assert(pipe.network.hosts[h1].online === true, 'host1 online')
            assert(pipe.network.hosts[h2].online === true, 'host2 online')
            assert(pipe.network.online === true, 'network online')

            // 2. Drop host 1 only — host 2 (and so the network) stay up.
            await drop_conn(ep1)
            await sleep(150)
            assert(pipe.network.hosts[h2].online === true, 'host2 unaffected by host1 drop')
            assert(pipe.network.online === true, 'network stays online while host2 is up')

            // 3. The poll reconnects host 1, cascading fresh updates to both its URLs.
            await sleep(900)
            assert(pipe.network.hosts[h1].online === true, 'host1 reconnected')
            assert(got[ep1 + '?u=a'] >= 2 && got[ep1 + '?u=b'] >= 2, 'both host1 urls got fresh updates')

            for (var u of urls) pipe.forget(u)
        }
    )

    run_test(
        "update_pipe: A write lands and its write-only host is garbage-collected",
        async () => {
            // 0. Write once to a write-only host (no subscription).
            var ep = await add_main_handler(pipe_server('pb_' + rid()))
            var host = new URL(ep).host
            var pipe = update_pipe(() => {}, {reconnect_interval: 60})
            pipe.set(ep, {version: ['a1'], body: 'hi'})

            // 1. The server receives the PUT, with the right body.
            await sleep(300)
            var puts = await server_puts(ep)
            assert(puts.length === 1, 'server received the PUT')
            assert(puts[0].body === 'hi', 'server got the body')

            // 2. On the ack the host holds no more work, so it's GC'd and the network reads idle.
            assert(pipe.network.hosts[host] === undefined, "spent write-only host is GC'd")
            assert(pipe.network.online === 'maybe', 'idle network reads maybe')
        }
    )

    run_test(
        "update_pipe: Writes pipeline up to max_outstanding_puts; the rest queue and drain",
        async () => {
            // 0. Queue 25 writes at a cap of 10, with the server holding every response.
            var ep = await add_main_handler(pipe_server('pp_' + rid(), {hold_puts: true}))
            var host = new URL(ep).host
            var pipe = update_pipe(() => {}, {reconnect_interval: 60, max_outstanding_puts: 10})
            for (var i = 0; i < 25; i++) pipe.set(ep, {version: ['v' + i], body: String(i)})

            // 1. Exactly 10 are in flight; all 25 wait in the queue, unacked.
            await sleep(300)
            var h = pipe.network.hosts[host]
            assert(h.outstanding_puts_count === 10, 'in-flight capped at 10')
            assert((await server_puts(ep)).length === 10, 'server received exactly 10')
            assert(h.urls[ep].put_queue.size === 25, 'all 25 still queued, unacked')

            // 2. Release the held responses — all 25 drain through and the host is GC'd.
            await release_puts(ep)
            await sleep(600)
            assert((await server_puts(ep)).length === 25, 'all 25 eventually sent')
            assert(pipe.network.hosts[host] === undefined, "host GC'd once all PUTs drained")
        }
    )

    run_test(
        "update_pipe: A non-2xx write is a give-up: reported as an error, then dropped",
        async () => {
            // 0. Write to a host that answers 500.
            var ep = await add_main_handler(pipe_server('pg_' + rid(), {put_status: 500}))
            var host = new URL(ep).host
            var errors = []
            var pipe = update_pipe(m => { if (m.type === 'error') errors.push(m) }, {reconnect_interval: 60})
            pipe.set(ep, {version: ['a1'], body: 'hi'})

            // 1. It's reported once as an error, carrying the status.
            await sleep(300)
            assert(errors.length === 1, 'give-up reported once')
            assert(errors[0].description === 500, 'status surfaced')

            // 2. The write is dropped, so its write-only host is GC'd.
            assert(pipe.network.hosts[host] === undefined, "gave-up PUT's host is GC'd")
        }
    )

    run_test(
        "update_pipe: A write whose pipe fails is requeued, then re-probed back to success",
        async () => {
            // 0. Write to a host that drops the first PUT's connection.
            var ep = await add_main_handler(pipe_server('prw_' + rid(), {fail_first_put: true}))
            var host = new URL(ep).host
            var pipe = update_pipe(() => {}, {reconnect_interval: 0.3})
            pipe.set(ep, {version: ['a1'], body: 'hi'})

            // 1. The pipe failure takes the host offline; the PUT is requeued, not lost.
            await sleep(300)
            var h = pipe.network.hosts[host]
            assert(h.online === false, 'write-only host offline on the pipe failure')
            assert(h.urls[ep].put_queue.size === 1, 'the PUT is requeued, not lost')

            // 2. The poll re-probes with the queued PUT; this one lands, and the host GCs.
            await sleep(600)
            assert(pipe.network.hosts[host] === undefined, "revived host GC'd after its PUT drained")
            assert(pipe.network.online === 'maybe', 'network settles at maybe')
            var puts = await server_puts(ep)
            assert(puts.length === 1, 'server got the PUT only on the retry')
            assert(puts[0].body === 'hi', 'with the right body')
        }
    )

    run_test(
        "update_pipe: A PUT ack revives a multi-write host to online='maybe' (not online=true)",
        async () => {
            // 0. Queue three writes, one at a time; the server drops #1, acks #2 (the retry), holds #3.
            var ep = await add_main_handler(pipe_server('prk_' + rid(),
                {put_behavior: 'n => n === 1 ? "drop" : n === 2 ? "ok" : "hold"'}))
            var host = new URL(ep).host
            var pipe = update_pipe(() => {}, {reconnect_interval: 0.3, max_outstanding_puts: 1})
            pipe.set(ep, {version: ['a1'], body: '1'})
            pipe.set(ep, {version: ['a2'], body: '2'})
            pipe.set(ep, {version: ['a3'], body: '3'})

            // 1. The ack lifts the offline host to 'maybe' — never online=true, since it has no subscription.
            await sleep(800)
            var h = pipe.network.hosts[host]
            assert(h.online === 'maybe', 'a landed PUT lifts the offline host to maybe')

            // 2. The remaining queued writes keep the host alive.
            assert(h.urls[ep].put_queue.size === 2, 'later writes keep the host alive')
        }
    )

    run_test(
        "update_pipe: forget() drops a subscription and garbage-collects its resource and host",
        async () => {
            // 0. Subscribe to two URLs on one host — both online, host green.
            var ep = await add_main_handler(pipe_server('fg_' + rid()))
            var host = new URL(ep).host
            var a = ep + '?u=a', b = ep + '?u=b'
            var pipe = update_pipe(() => {}, {reconnect_interval: 60})
            pipe.get(a); pipe.get(b)

            await sleep(300)
            var h = pipe.network.hosts[host]
            assert(Object.keys(h.urls).length === 2, 'two resources subscribed')
            assert(h.online === true, 'green while subscribed')

            // 1. Forget the first URL — its resource is collected; the host survives on the other sub.
            pipe.forget(a)
            await sleep(50)
            assert(h.urls[a] === undefined, 'forgotten resource collected')
            assert(Object.keys(h.urls).length === 1, 'one resource left')
            assert(pipe.network.hosts[host] === h, 'host survives on its other sub')
            assert(h.online === true, 'still green')

            // 2. Forget the second — the host is GC'd; the network settles at 'maybe'.
            pipe.forget(b)
            await sleep(50)
            assert(pipe.network.hosts[host] === undefined, "host GC'd once last sub forgotten")
            assert(pipe.network.online === 'maybe', 'network settles at maybe')
        }
    )

    run_test(
        "update_pipe: A connecting (not-yet-209) subscription can't hold its host green",
        async () => {
            // 0. Subscribe to /a (gets its 209 → online) and /hang (server never answers → still connecting).
            var ep = await add_main_handler(pipe_server('fc_' + rid()))
            var host = new URL(ep).host
            var a = ep + '?u=a', hang = ep + '?u=hang'
            var pipe = update_pipe(() => {}, {reconnect_interval: 60})
            pipe.get(a)
            pipe.get(hang)

            // 1. The host is green, but only /a counts as online — the connecting /hang doesn't.
            await sleep(300)
            var h = pipe.network.hosts[host]
            assert(h.online === true, 'green because /a is online')
            assert(h.online_subs.size === 1, 'only /a is online; hang is just connecting')

            // 2. Forget /a — the only online sub — and the host falls to 'maybe', not stuck green.
            pipe.forget(a)
            await sleep(50)
            assert(h.online_subs.size === 0, 'no online subscriptions remain')
            assert(h.online === 'maybe', 'host falls to maybe, not stuck green')

            pipe.forget(hang)
        }
    )

    run_test(
        "update_pipe: A forbidden (403) subscription is a give-up: error, then cancel the URL",
        async () => {
            // 0. Subscribe to a host that answers 403.
            var ep = await add_main_handler(pipe_server('gg_' + rid(), {subscribe_status: 403}))
            var host = new URL(ep).host
            var errors = []
            var pipe = update_pipe(m => { if (m.type === 'error') errors.push(m) }, {reconnect_interval: 60})
            pipe.get(ep)

            // 1. It's reported once as an error — the 403, on the GET.
            await sleep(300)
            assert(errors.length === 1, 'one error reported')
            assert(errors[0].description === 403, 'the 403 surfaced')
            assert(errors[0].method === 'GET', 'on the GET')

            // 2. The subscription is cancelled, so its host is GC'd.
            assert(pipe.network.hosts[host] === undefined, "subscription cancelled, host GC'd")
        }
    )

    run_test(
        "update_pipe: A 503 write retries the request without taking the host offline",
        async () => {
            // 0. Write to a host that answers 503 the first time, then 200.
            var ep = await add_main_handler(pipe_server('pr_' + rid(), {put_behavior: 'n => n === 1 ? 503 : 200'}))
            var host = new URL(ep).host
            var pipe = update_pipe(() => {}, {reconnect_interval: 0.3})
            pipe.set(ep, {version: ['a1'], body: 'hi'})

            // 1. A 503 is a per-resource retry: the host stays 'maybe' (never offline), the PUT waits.
            await sleep(150)
            var h = pipe.network.hosts[host]
            assert(h.online === 'maybe', '503 keeps the host maybe, never offline')
            assert(h.urls[ep].put_queue.size === 1, 'the PUT waits in its queue to retry')

            // 2. The retry lands (the server saw it twice); the write acks and the host is GC'd.
            await sleep(500)
            assert((await server_puts(ep)).length === 2, 'server saw the PUT twice (503 then 200)')
            assert(pipe.network.hosts[host] === undefined, "PUT finally acked; host GC'd")
        }
    )

    run_test(
        "update_pipe: A server with no 209 support is polled, and stays online='maybe'",
        async () => {
            // 0. Subscribe to a host with no 209 — it answers a plain 200 with the current state.
            var ep = await add_main_handler(pipe_server('poll_' + rid(), {poll_mode: true}))
            var host = new URL(ep).host
            var updates = []
            var pipe = update_pipe(m => { if (m.type === 'set') updates.push(m) }, {poll_interval: 0.3})
            pipe.get(ep)

            // 1. The first poll delivers the current state; the URL is 'maybe' (never green — no 209 sub).
            await sleep(150)
            assert(updates.length === 1, 'first poll delivered the current state')
            assert(decode(updates[0].body) === 'state1', 'with the right body')
            var h = pipe.network.hosts[host]
            assert(h.online === 'maybe', 'a polled url is maybe, never green')
            assert(h.online_subs.size === 0, 'no online (209) subscription')

            // 2. Polling re-fetches and delivers again.
            await sleep(500)
            assert(updates.length >= 2, 'polling re-fetched and delivered again')

            // 3. forget() stops the polling.
            pipe.forget(ep)
            var at_forget = updates.length
            await sleep(500)
            assert(updates.length === at_forget, 'forget stops the polling')
        }
    )

    // A polling server for change-detection tests.  It serves a stable state
    // (version 'v<n>', etag '"e<n>"', body 'state<n>') and bumps <n> only on a
    // ?_change request; ?_polls reports how many polls and If-None-Match's it
    // has seen.  mode picks which key it exposes: 'version', 'etag' (with 304s),
    // or 'hash' (body only, no version or etag).
    function poll_server (test_id, mode) {
        return `(req, res) => {
            var G = (global._poll_${test_id} ||= {n: 1, polls: 0, inm: 0})
            var q = new URL(req.url, 'http://x').searchParams
            if (q.has('_change')) { G.n++; return res.end('ok') }
            if (q.has('_polls'))  { res.setHeader('content-type', 'application/json')
                                    return res.end(JSON.stringify({polls: G.polls, inm: G.inm})) }
            if (!req.subscribe)   { res.statusCode = 200; return res.end('ok') }

            G.polls++
            res.statusCode = 200
            if (${JSON.stringify(mode)} === 'version') {
                res.setHeader('version', JSON.stringify('v' + G.n))
                return res.end('state' + G.n)
            }
            if (${JSON.stringify(mode)} === 'etag') {
                var etag = '"e' + G.n + '"'
                if (req.headers['if-none-match']) G.inm++
                if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end() }
                res.setHeader('etag', etag)
                return res.end('state' + G.n)
            }
            return res.end('state' + G.n)   // hash mode
        }`
    }
    var change_state = ep => og_fetch(ep + '?_change')
    var poll_status  = async ep => (await og_fetch(ep + '?_polls')).json()

    run_test(
        "update_pipe: Polling suppresses an unchanged version, and delivers a new one",
        async () => {
            // 0. Poll a server that keeps the same version until told to change.
            var ep = await add_main_handler(poll_server('cdv_' + rid(), 'version'))
            var updates = []
            var pipe = update_pipe(m => { if (m.type === 'set') updates.push(m) }, {poll_interval: 0.2})
            pipe.get(ep)

            // 1. The first poll delivers the current state.
            await sleep(150)
            assert(updates.length === 1, 'first poll delivered the state')
            assert(decode(updates[0].body) === 'state1', 'with the right body')

            // 2. Later polls see the same version: nothing delivered, but polling continues.
            await sleep(700)
            var s = await poll_status(ep)
            assert(updates.length === 1, 'an unchanged version stays silent')
            assert(s.polls >= 3, 'yet the server kept being polled')

            // 3. Bump the version — the next poll delivers again.
            await change_state(ep)
            await sleep(400)
            assert(updates.length === 2, 'a new version is delivered')
            assert(decode(updates[1].body) === 'state2', 'with the new body')

            pipe.forget(ep)
        }
    )

    run_test(
        "update_pipe: Polling sends If-None-Match; a 304 stays silent, a changed etag delivers",
        async () => {
            // 0. Poll a server that supports conditional GET (etag + 304).
            var ep = await add_main_handler(poll_server('cde_' + rid(), 'etag'))
            var updates = []
            var pipe = update_pipe(m => { if (m.type === 'set') updates.push(m) }, {poll_interval: 0.2})
            pipe.get(ep)

            // 1. The first poll (no etag held yet) delivers the current state.
            await sleep(150)
            assert(updates.length === 1, 'first poll delivered the state')
            assert(decode(updates[0].body) === 'state1', 'with the right body')

            // 2. Now holding the etag, later polls send If-None-Match and earn 304s.
            await sleep(700)
            var s = await poll_status(ep)
            assert(updates.length === 1, 'a 304 delivers nothing')
            assert(s.inm >= 1, 'the client sent If-None-Match')
            assert(s.polls >= 3, 'and kept polling')

            // 3. Change the state (new etag) — the poll 200s and delivers.
            await change_state(ep)
            await sleep(400)
            assert(updates.length === 2, 'a changed etag is delivered')
            assert(decode(updates[1].body) === 'state2', 'with the new body')

            pipe.forget(ep)
        }
    )

    run_test(
        "update_pipe: Polling with no version or etag dedups by hashing the body",
        async () => {
            // 0. Poll a server that sends only a body — no version, no etag.
            var ep = await add_main_handler(poll_server('cdh_' + rid(), 'hash'))
            var updates = []
            var pipe = update_pipe(m => { if (m.type === 'set') updates.push(m) }, {poll_interval: 0.2})
            pipe.get(ep)

            // 1. The first poll delivers the current state.
            await sleep(150)
            assert(updates.length === 1, 'first poll delivered the state')
            assert(decode(updates[0].body) === 'state1', 'with the right body')

            // 2. The same body hashes equal on later polls, so nothing is delivered.
            await sleep(700)
            var s = await poll_status(ep)
            assert(updates.length === 1, 'an identical body stays silent')
            assert(s.polls >= 3, 'yet the server kept being polled')

            // 3. Change the body — the new hash is delivered.
            await change_state(ep)
            await sleep(400)
            assert(updates.length === 2, 'a changed body is delivered')
            assert(decode(updates[1].body) === 'state2', 'with the new body')

            pipe.forget(ep)
        }
    )

}

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = define_tests
}
