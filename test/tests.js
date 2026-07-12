// Shared test definitions that work in both Node.js and browser environments
// This file exports a function that takes a test runner and context

function define_tests(run_test, context) {
    var { fetch, og_fetch, port, add_section_header, test_update, multiplex_fetch, braid_fetch, reliable_update_channel, update_pipe, base_url, assert } = context
    // base_url is 'https://localhost:${port}' in console tests; in the browser
    // we derive it from the page's origin, so that endpoints returned by the
    // add_*_handler helpers are absolute urls in both modes -- several tests
    // parse them with new URL(endpoint), which throws on a bare path
    base_url = base_url || (typeof location !== 'undefined' ? location.origin : '')

    // Registers a new handler on a test server and returns the full URL to hit
    // it. The handler runs server-side, so we send its source over the wire.
    // Any extra args are JSON-serialized and passed to the handler after
    // (req, res) -- handy for injecting values the handler needs, since it runs
    // in the server's scope and can't close over test-side variables.
    async function add_handler(server_url, handler, ...args) {
        var r = await og_fetch(`${server_url}/add-handler`, {
            method: 'POST',
            body: JSON.stringify({ handler: handler.toString(), args })
        })
        return `${server_url}${await r.text()}`
    }

    // Adds a handler to the main test server (port).
    function add_main_handler(handler, ...args) {
        return add_handler(base_url, handler, ...args)
    }

    // Adds a pre-braidify handler to the main test server -- it runs before
    // braidify on every request, gets (req, res, ...args), and should return
    // true if it handled the response. Unlike add_main_handler, this can
    // intercept MULTIPLEX / .well-known/multiplexer requests, which braidify
    // would otherwise consume. Like add_handler, any extra args are
    // JSON-serialized and passed to the handler after (req, res). See
    // /add-pre-braidify-handler in test.js.
    function add_pre_braidify_handler(handler, ...args) {
        return og_fetch(`${base_url}/add-pre-braidify-handler`, {
            method: 'POST',
            body: JSON.stringify({ handler: handler.toString(), args })
        })
    }

    // Adds a handler to the Express middleware server (port + 1).
    function add_express_handler(handler, ...args) {
        return add_handler(`https://localhost:${port + 1}`, handler, ...args)
    }

    // Adds a handler to the braidify-wrapper server (port + 2).
    function add_wrapper_handler(handler, ...args) {
        return add_handler(`https://localhost:${port + 2}`, handler, ...args)
    }

    // Adds a handler to the braidify.server()-wrapped server (port + 3).
    function add_wrapped_handler(handler, ...args) {
        return add_handler(`https://localhost:${port + 3}`, handler, ...args)
    }

    // Adds a handler to the no-multiplex server (port + 4), whose braidify
    // has multiplexing permanently disabled.
    function add_no_mux_handler(handler, ...args) {
        return add_handler(`https://localhost:${port + 4}`, handler, ...args)
    }

    // Runs a function on the main test server, and returns the response text.
    // The function is sent over the wire and eval'd server-side, so (like the
    // add_*_handler functions) it can't close over test-side variables -- but
    // it gets (req, res, ...args) and can use the server's scope (braid_fetch,
    // port, fetch, braidify, ...). Writing it as a real function -- rather than
    // a template string -- keeps it syntax-highlighted. The function is
    // responsible for ending res.
    async function server_eval(fn, ...args) {
        var r = await og_fetch('/eval', {
            method: 'POST',
            body: `(${fn})(req, res, ...${JSON.stringify(args)})`
        })
        return await r.text()
    }

    // Kills a multiplexer on the main test server: reaches into the server's
    // braidify.multiplexers map and abruptly ends that multiplexer's response
    // stream (with some trailing garbage), as if the connection dropped.
    function kill_mux(m) {
        return server_eval((req, res, m) => {
            braidify.multiplexers?.get(m)?.res.end('AAAAA')
            res.end('ok')
        }, m)
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
        await server_eval((req, res, m) => {
            if (!braidify.multiplexers) braidify.multiplexers = new Map()
            braidify.multiplexers.set(m, {requests: new Map(), res})
            res.end('ok')
        }, m)

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
        await kill_mux(m)
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
        await kill_mux(m)
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
        await add_pre_braidify_handler((req, res, m) => {
            if (req.method === 'MULTIPLEX' && req.url.startsWith(`/${m}`)) {
                res.writeHead(500)
                res.end('')
                return true
            }
        }, m)

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
        await kill_mux(m)
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
        await add_pre_braidify_handler((req, res, m) => {
            if (req.url.startsWith(`/.well-known/multiplexer/${m}`)) {
                res.writeHead(500)
                res.end('')
                return true
            }
        }, m)

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
        // add a handler that sends one update and holds the subscription open.
        // the update is passed as an arg (the handler runs server-side via
        // eval, so it can't close over test-side variables)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // strip the leading origin so we hit the endpoint with a *relative* url
        var relative_endpoint = new URL(endpoint).pathname

        // open two multiplexed subscriptions; the second multiplexes through
        // the first (multiplex: {} means "reuse an existing multiplexer")
        var a1 = new AbortController()
        await fetch(relative_endpoint, { signal: a1.signal, subscribe: true, multiplex: {} })

        var a2 = new AbortController()
        var r2 = await fetch(relative_endpoint, { signal: a2.signal, subscribe: true, multiplex: {} })

        assert(r2.multiplexed_through, 'expected second request to be multiplexed')

        // read the first update off the multiplexed subscription. it should
        // match what we sent, plus the status the server attaches on the way out
        var got = await new Promise(done => r2.subscribe(u => {
            u.body = u.body_text
            done(JSON.stringify(u))
        }))
        assert(got === JSON.stringify({ ...update, status: '200' }),
               'got unexpected update through relative-url multiplexer')

        a1.abort()
        a2.abort()
    }
)

run_test(
    "Test that multiplexer code handles a full url (rather than relative one).",
    async () => {
        // add a handler that sends one update and holds the subscription open.
        // the update is passed as an arg (the handler runs server-side via
        // eval, so it can't close over test-side variables). add_main_handler
        // returns a full (absolute) url, which is what we want to exercise here.
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // open two multiplexed subscriptions; the second multiplexes through
        // the first
        var a1 = new AbortController()
        await fetch(endpoint, { signal: a1.signal, subscribe: true, multiplex: {} })

        var a2 = new AbortController()
        var r2 = await fetch(endpoint, { signal: a2.signal, subscribe: true, multiplex: {} })

        assert(r2.multiplexed_through, 'expected second request to be multiplexed')

        // read the first update off the multiplexed subscription. it should
        // match what we sent, plus the status the server attaches on the way out
        var got = await new Promise(done => r2.subscribe(u => {
            u.body = u.body_text
            done(JSON.stringify(u))
        }))
        assert(got === JSON.stringify({ ...update, status: '200' }),
               'got unexpected update through full-url multiplexer')

        a1.abort()
        a2.abort()
    }
)

run_test(
    "Test that multiplexer code handles a full url (rather than relative one) on server.",
    async () => {
        // add a handler that sends one update and holds the subscription open
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // now, *on the server*, use braid_fetch to open a multiplexed
        // subscription to that endpoint by its full url, and echo back the
        // first update -- this exercises the client's multiplexer with a full
        // (absolute) url while running server-side. (endpoint is passed as an
        // arg, since this function is eval'd in the server's scope.)
        var got = await server_eval(async (req, res, endpoint) => {
            if (typeof fetch === 'undefined') return res.end('old node version')

            var a = new AbortController()
            var r = await braid_fetch(endpoint, {
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
        }, endpoint)

        // old node has no global fetch server-side, so braid_fetch can't run
        // there; nothing to assert in that case (counts as a pass)
        if (got === 'old node version') return
        assert(got === JSON.stringify({ ...update, status: '200' }),
               'got unexpected update through server-side full-url multiplexer')
    }
)

run_test(
    "Test closing unrecognized requests in the multiplexer.",
    async () => {
        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        // open a subscription through a multiplexer of our choosing
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        await fetch(endpoint, {
            signal: a.signal,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })

        // s2 is a request id the multiplexer has never heard of. count the
        // DELETEs the client sends to close it (letting them fall through to
        // braidify for normal handling)
        var s2 = Math.random().toString(36).slice(2)
        await add_pre_braidify_handler((req, res, m, s2) => {
            if (req.method === 'DELETE' && req.url === `/.well-known/multiplexer/${m}/${s2}`)
                global['_deletes_' + s2] = (global['_deletes_' + s2] ?? 0) + 1
        }, m, s2)

        // on the server, write some data into the multiplexer's stream tagged
        // with s2 -- an "unrecognized request". The client should react by
        // sending a DELETE to close request s2. We write the garbage twice
        // (now, and after 300ms), so the client should send two DELETEs.
        // After 600ms, report the count.
        var count = await server_eval((req, res, m, s2) => {
            braidify.multiplexers.get(m).res.write(`start response ${s2}\r\n`.repeat(3))

            setTimeout(() => {
                braidify.multiplexers.get(m).res.write(`start response ${s2}\r\n`.repeat(3))
            }, 300)

            setTimeout(() => {
                res.end('' + (global['_deletes_' + s2] ?? 0))
            }, 600)
        }, m, s2)

        assert(count === '2', 'expected the client to close the unrecognized request twice')

        a.abort()
    }
)

run_test(
    "Test receiving multiplexed message.",
    async () => {
        // add a handler that sends one update and holds the subscription open.
        // the update is passed as an arg (the handler runs server-side via
        // eval, so it can't close over test-side variables)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // open a multiplexed subscription through a multiplexer of our choosing
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // read the first update off the multiplexed subscription. it should
        // match what we sent, plus the status the server attaches on the way out
        var got = await new Promise(done => r.subscribe(u => {
            u.body = u.body_text
            done(JSON.stringify(u))
        }))
        assert(got === JSON.stringify({ ...update, status: '200' }),
               'got unexpected multiplexed message')

        a.abort()
    }
)

run_test(
    "Test receiving multiplexed message's version.",
    async () => {
        // add a handler that sends a single update with a known version
        var endpoint = await add_main_handler((req, res) => {
            res.sendUpdate({ version: ['test'], body: 'hi' })
        })

        // fetch it through a multiplexer -- the response should surface the
        // update's version as a header
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        assert(r.headers.get('version') === '"test"', 'expected version header from multiplexed message')

        a.abort()
        await kill_mux(m)
    }
)

run_test(
    "Test receiving multiplexed messages with whitespace between them.",
    async () => {
        // add a handler that writes stray whitespace directly into the
        // multiplexer stream, then sends an update -- the client should
        // tolerate the whitespace between multiplexed messages
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.multiplexer?.write('\r\r\n\r\r')
            res.sendUpdate({ version: ['test1'], body: 'hi' })
        })

        // open a multiplexed subscription through a multiplexer of our choosing
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // we should still receive the update despite the whitespace
        var got = await new Promise(done => r.subscribe(u => {
            if (u.version[0] === 'test1') done(u.version[0])
        }))
        assert(got === 'test1', 'expected to receive the update after the whitespace')

        await kill_mux(m)
        a.abort()
    }
)

run_test(
    "Test receiving multiplexed message with multiplex: true",
    async () => {
        // add a handler that sends one update and holds the subscription open.
        // the update is passed as an arg (the handler runs server-side via
        // eval, so it can't close over test-side variables)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // multiplex: true forces multiplexing on, creating a multiplexer for
        // this subscription even though none exists yet
        var a = new AbortController()
        var r = await fetch(endpoint, { signal: a.signal, subscribe: true, multiplex: true })

        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // read the first update off the multiplexed subscription. it should
        // match what we sent, plus the status the server attaches on the way out
        var got = await new Promise(done => r.subscribe(u => {
            u.body = u.body_text
            done(JSON.stringify(u))
        }))
        assert(got === JSON.stringify({ ...update, status: '200' }),
               'got unexpected multiplexed message')

        a.abort()
    }
)

run_test(
    "Test closing multiplexer",
    async () => {
        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        // open a multiplexed subscription through a multiplexer of our choosing
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // killing the multiplexer should fire the subscription's error callback
        var ended = await new Promise(async done => {
            r.subscribe(u => {}, e => done('multiplexer ended'))
            await kill_mux(m)
        })
        assert(ended === 'multiplexer ended', 'expected the subscription to end when the multiplexer was killed')

        a.abort()
    }
)

run_test(
    "Test closing multiplexer before headers received",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // kill the multiplexer partway through, before the server-side eval
        // gets around to responding (below, it waits 1000ms)
        setTimeout(() => {
            kill_mux(m)
        }, 500)

        // make a multiplexed /eval request whose response is delayed 1000ms.
        // (this is a multiplexed request, so it can't use server_eval, which
        // doesn't carry Multiplex-Through/signal.) since the multiplexer dies
        // at 500ms -- before the headers/response arrive -- the client should
        // error with 'multiplex stream ended unexpectedly'
        var body = ((res) => {
            setTimeout(() => {
                res.setHeader('test', '42')
                res.end('hi')
            }, 1000)
        }).toString()
        try {
            await fetch('/eval', {
                method: 'POST',
                signal: a.signal,
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
                body: `(${body})(res)`
            })
        } catch (e) {
            assert('' + e === 'Error: multiplex stream ended unexpectedly',
                   'expected the stream-ended-unexpectedly error')
            return
        }
        assert(false, 'expected the multiplexed request to error')
    }
)

run_test(
    "Test closing multiplexer with retry",
    async () => {
        // add a handler that sends one update and holds the subscription open.
        // the update is passed as an arg (the handler runs server-side via
        // eval, so it can't close over test-side variables)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // open a multiplexed subscription through a multiplexer of our
        // choosing, with retry on. onRes counts the responses, and onFetch
        // grabs the underlying request's aborter
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var count = 0
        var aborter = null
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: { onRes: () => count++ },
            onFetch: (url, params, _aborter) => aborter = _aborter
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // kill the multiplexer. retry should reconnect (a second response,
        // making count 2) and deliver the update again -- when it does, grab
        // the update and abort the underlying request
        var got = ''
        var err = await new Promise(async done => {
            r.subscribe(u => {
                if (count === 2 && !got) {
                    u.body = u.body_text
                    got = JSON.stringify(u)
                    aborter.abort()
                }
            }, done)
            await kill_mux(m)
        })

        // the update received after the retry should match what we sent, plus
        // the status the server attaches on the way out
        assert(got === JSON.stringify({ ...update, status: '200' }),
               'got unexpected update after retry')

        // and aborting the underlying request should end the subscription
        assert(err.message === 'request aborted', 'expected the request-aborted error')

        a.abort()
    }
)

run_test(
    "Test aborting multiplexed subscription.",
    async () => {
        // add a handler that sends one update and holds the subscription open.
        // the update is passed as an arg (the handler runs server-side via
        // eval, so it can't close over test-side variables)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // open a multiplexed subscription
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            retry: true,
            subscribe: true,
            multiplex: true
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // read the first update off the subscription, then abort -- the
        // subscription's error callback should fire with the abort
        var got = ''
        var err = await new Promise(done => r.subscribe(u => {
            if (!got) {
                u.body = u.body_text
                got = JSON.stringify(u)
                a.abort()
            }
        }, done))

        // the update should match what we sent, plus the status the server
        // attaches on the way out
        assert(got === JSON.stringify({ ...update, status: '200' }),
               'got unexpected update')

        // and the abort should have surfaced as an AbortError
        assert(err.name === 'AbortError', 'expected an AbortError')
    }
)

run_test(
    "Test ending multiplexed subscription on the server side.",
    async () => {
        // add a handler that sends one update, then gives up on the
        // subscription, ending the response from the server side. the update
        // is passed as an arg (the handler runs server-side via eval, so it
        // can't close over test-side variables)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
            setTimeout(() => res.end(), 300)
        }, update)

        // open a multiplexed subscription with retry on, counting responses
        var a = new AbortController()
        var onRes_count = 0
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: true,
            retry: { onRes: () => onRes_count++ }
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // when the server ends the subscription, retry should quietly
        // reconnect and get the update again -- wait for it to arrive twice.
        // (each response's update matches what we sent, plus the status the
        // server attaches on the way out)
        var update_count = 0
        await new Promise((done, fail) => r.subscribe(u => {
            u.body = u.body_text
            if (JSON.stringify(u) === JSON.stringify({ ...update, status: '200' })) update_count++
            if (update_count === 2) done()
        }, fail))

        // by the second update, we should be on exactly the second response
        assert(onRes_count === 2, 'expected exactly two responses')

        a.abort()
    }
)

run_test(
    "Test retry when first establishing multiplexer",
    async () => {
        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // make the server answer the first attempt to create our multiplexer
        // with 425 Too Early, and let subsequent attempts through -- counting
        // the attempts in a global keyed by m (the handler runs server-side,
        // so it can't close over test-side variables)
        await add_pre_braidify_handler((req, res, m) => {
            if (req.method === 'POST' && req.url === `/.well-known/multiplexer/${m}`) {
                var attempts = global['_mux_attempts_' + m] = (global['_mux_attempts_' + m] ?? 0) + 1
                if (attempts === 1) {
                    res.writeHead(425)
                    res.end('')
                    return true
                }
            }
        }, m)

        // subscribe through that multiplexer, with retry on -- the client
        // should shrug off the 425, retry creating the multiplexer, and end
        // up multiplexed
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: true
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // and it really took two attempts to create the multiplexer: the
        // 425'd one, plus the successful retry
        var attempts = await server_eval((req, res, m) =>
            res.end('' + global['_mux_attempts_' + m]), m)
        assert(attempts === '2', 'expected exactly two multiplexer-creation attempts')

        a.abort()
        await kill_mux(m)
    }
)

run_test(
    "Test that server multiplexer can detect closure.",
    async () => {
        // add a handler that holds a subscription open, and records in a
        // global when the subscription closes. (the handler runs server-side
        // via eval, so it can't close over test-side variables -- we pass in
        // the mux id m to key the global)
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, m) => {
            res.startSubscription({
                onClose: () => global['_closed_' + m] = true
            })
            res.sendUpdate({ body: 'hi' })
        }, m)

        // open a multiplexed subscription through a multiplexer of our
        // choosing, and wait for the first update, so we know the
        // subscription is fully established
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')
        await new Promise(done => r.subscribe(done))

        // kill the multiplexer -- the server should notice the closure and
        // fire the subscription's onClose
        await kill_mux(m)
        var closed = await server_eval((req, res, m) =>
            res.end('' + !!global['_closed_' + m]), m)
        assert(closed === 'true', "expected the subscription's onClose to fire")

        a.abort()
    }
)

run_test(
    "Test failing to establish multiplexed connection.",
    async () => {
        // add a handler (which won't actually be reached: establishing the
        // multiplexer will fail first)
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // make the server 500 every attempt to create our multiplexer
        await add_pre_braidify_handler((req, res, m) => {
            if (req.url.startsWith(`/.well-known/multiplexer/${m}`)) {
                res.writeHead(500)
                res.end('')
                return true
            }
        }, m)

        // without retry, the fetch should give up and error out
        try {
            await fetch(endpoint, {
                subscribe: true,
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
            })
        } catch (e) {
            assert(e.message === 'multiplexer failed', 'expected the multiplexer-failed error')
            return
        }
        assert(false, 'expected the fetch to error')
    }
)

run_test(
    "Test that creating duplicate multiplexed connections fails correctly.",
    async () => {
        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        // open a multiplexed subscription through a multiplexer of our
        // choosing, which creates that multiplexer
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // try to create the same multiplexer again with a MULTIPLEX request:
        // the server should answer 409 Conflict, with an explanatory body
        var r2 = await og_fetch(`/${m}`, {method: 'MULTIPLEX', headers: {'Multiplex-Version': multiplex_version}})
        assert(r2.status === 409, 'expected 409 Conflict')
        assert(JSON.stringify(await r2.json()) === JSON.stringify({
            error: 'Multiplexer already exists',
            details: `Cannot create duplicate multiplexer with ID '${m}'`
        }), 'expected the duplicate-multiplexer error body')

        a.abort()
        await kill_mux(m)
    }
)

run_test(
    "Test that creating duplicate multiplexed requests fails correctly.",
    async () => {
        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        // create a multiplexer of our choosing directly, via the well-known url
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var mux_r = await og_fetch(`/.well-known/multiplexer/${m}`, {
            method: 'POST',
            signal: a.signal,
            headers: { 'Multiplex-Version': multiplex_version }
        })
        assert(mux_r.ok, 'expected the multiplexer to be created')

        // multiplex a subscription through it, with a request id of our
        // choosing. we use raw og_fetch (not braid_fetch) here and below, so
        // that the duplicate id actually reaches the server -- braid_fetch
        // would notice the duplicate locally and pick a fresh id (that
        // behavior is covered by "Test handling duplicate request id locally")
        var r1 = await og_fetch(endpoint, {
            signal: a.signal,
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            },
        })
        assert(r1.ok, 'expected the first request to be multiplexed')

        // make a second request reusing the same request id: the server
        // should answer 409 Conflict, with an explanatory body
        var r2 = await og_fetch(endpoint, {
            signal: a.signal,
            headers: {
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            }
        })
        assert(r2.status === 409, 'expected 409 Conflict')
        assert(JSON.stringify(await r2.json()) === JSON.stringify({
            error: 'Request already multiplexed',
            details: `Cannot multiplex request with duplicate ID '${s}' for multiplexer '${m}'`
        }), 'expected the duplicate-request error body')

        a.abort()
    }
)

run_test(
    "Test random 500 error while multiplexing a request.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // make the server 500 requests to a path of our choosing -- before
        // braidify gets a chance to see them, so the request that asked to be
        // multiplexed gets a plain, unmultiplexed 500 back
        var path = '/' + Math.random().toString(36).slice(2)
        await add_pre_braidify_handler((req, res, path) => {
            if (req.url === path) {
                res.writeHead(500)
                res.end('')
                return true
            }
        }, path)

        // ask to multiplex a request to that path: the 500 should come back
        // as a resolved response -- not an error -- even with retry on
        var r = await fetch(path, {
            signal: a.signal,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: true
        })
        assert(r.status === 500, 'expected a 500 response')
        assert(!r.multiplexed_through, 'expected the response not to be multiplexed')

        a.abort()
    }
)

run_test(
    "Test failing to establish multiplexed request because of version.",
    async () => {
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // make the server acknowledge multiplexing (status 293) on a path of
        // our choosing, but with the *wrong* Multiplex-Version -- intercepting
        // the request before braidify can answer properly
        var path = '/' + Math.random().toString(36).slice(2)
        await add_pre_braidify_handler((req, res, path) => {
            if (req.url === path) {
                res.writeHead(293, {'Multiplex-Version': 'wrong'})
                res.end('ok')
                return true
            }
        }, path)

        // the client should reject the bad version as a protocol error --
        // immediately, without retrying, even with retry on
        try {
            await fetch(path, {
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
                retry: true
            })
        } catch (e) {
            assert('' + e === 'ProtocolError: Server created multiplexer, and then set a *different* '
                       + 'Multiplex-Version wrong on a multiplexed request',
                   'expected the wrong-version protocol error')
            return
        }
        assert(false, 'expected the fetch to error')
    }
)

run_test(
    "Test that failed DELETE on multiplexed request is caught (no uncaught rejection).",
    async () => {
        // listen for the tell-tale unhandled rejection (in node and browser)
        var saw_rejection = false
        var handler = (event) => {
            var message = event.reason?.message || event.message || ''
            if (message.includes('Could not cancel multiplexed request'))
                saw_rejection = true
        }
        if (typeof window !== 'undefined') window.addEventListener('unhandledrejection', handler)
        else process.on('unhandledRejection', handler)

        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // make the server 500 the DELETE that the client will send below (to
        // cancel its multiplexed request when we abort) -- counting the
        // DELETEs in a global so we can check one really happened
        await add_pre_braidify_handler((req, res, m, s) => {
            if (req.method === 'DELETE' && req.url === `/.well-known/multiplexer/${m}/${s}`) {
                global['_deletes_' + s] = (global['_deletes_' + s] ?? 0) + 1
                res.writeHead(500)
                res.end('')
                return true
            }
        }, m, s)

        // open a multiplexed subscription, and wait for the first update, so
        // we know the request is fully established
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')
        await new Promise(done => r.subscribe(done))

        // abort it: the client sends a DELETE to cancel the multiplexed
        // request, which our handler fails. give the resulting error time to
        // (wrongly) surface as an unhandled rejection
        a.abort()
        await new Promise(done => setTimeout(done, 500))

        if (typeof window !== 'undefined') window.removeEventListener('unhandledrejection', handler)
        else process.off('unhandledRejection', handler)

        // the client really did try (and fail) to cancel the request...
        var deletes = await server_eval((req, res, s) =>
            res.end('' + (global['_deletes_' + s] ?? 0)), s)
        assert(+deletes >= 1, 'expected the client to send the failing DELETE')

        // ...and the failure didn't leak
        assert(!saw_rejection, 'expected the failed DELETE error to be caught')

        await kill_mux(m)
    }
)

run_test(
    "Test header syntax error in multiplexed stream.",
    async () => {
        // add a handler that holds a subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        // open a subscription through a multiplexer of our choosing, creating
        // the multiplexer
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // add a handler that writes a malformed response for request s2
        // directly into the multiplexer's stream: the framing line announces
        // 10 bytes for s2, but those bytes ('a b\r\na b\r\n') are not valid
        // header syntax
        var s2 = Math.random().toString(36).slice(2)
        var bad_endpoint = await add_main_handler((req, res, m, s2) => {
            braidify.multiplexers.get(m).res.write(`10 bytes for response ${s2}\r\na b\r\na b\r\n`)

            // braidify only acks the direct request (with a 293) on the first
            // write to res -- and the client waits for that ack before it
            // parses any response bytes off the multiplexer. so poke res to
            // let the client at our malformed bytes, which are queued ahead
            // of this write in the multiplexer's stream
            res.write('x')
        }, m, s2)

        // requesting that endpoint through the multiplexer should error when
        // the client tries to parse those bytes as response headers
        try {
            await fetch(bad_endpoint, {
                signal: a.signal,
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s2}` }
            })
        } catch (e) {
            assert('' + e === 'Error: error parsing headers', 'expected the header-parsing error')
            a.abort()
            await kill_mux(m)
            return
        }
        assert(false, 'expected the fetch to error')
    }
)

run_test(
    "Test 2nd GET causing multiplexed connection.",
    async () => {
        // this test needs an origin whose subscription count starts at zero,
        // so we use the express server: the main server's count is inflated
        // by earlier tests, because aborting a subscription that was never
        // read leaks braid_fetch.subscription_counts (the client only
        // decrements it when a reader sees the subscription end)
        var endpoint = await add_express_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        // in the browser, tests run in parallel (launched ~70ms apart), so
        // another test's subscription could in principle land on this origin
        // between our quiescence check and our fetches, corrupting the
        // multiplex decisions we're testing. so after fetching, we check that
        // the origin's subscriptions are exactly our two, and retry if not
        var origin = `https://localhost:${port + 1}`
        var a, r, r2
        for (var attempt = 0; ; attempt++) {
            // wait for this origin's subscriptions from other tests to wind
            // down (aborts take a few ticks to propagate). the wait is
            // bounded so that if some test ever leaks a subscription on this
            // origin, we fail pointing at the leak, rather than timing out
            // mysteriously
            var give_up = Date.now() + 3000
            while (braid_fetch.subscription_counts?.[origin]) {
                assert(Date.now() < give_up,
                       `expected origin ${origin} to quiesce, but its subscription count is stuck `
                       + `at ${braid_fetch.subscription_counts?.[origin]} -- an earlier test probably `
                       + `leaked a subscription on it (aborted without reading it?)`)
                await new Promise(done => setTimeout(done, 10))
            }

            // multiplex: {} defaults to {after: 1} -- multiplex once more
            // than one subscription is open. So a first subscription should
            // go out normally, and a second concurrent one should trigger
            // multiplexing (asserted below, once we know the run was clean)
            a = new AbortController()
            r = await fetch(endpoint, {
                signal: a.signal,
                subscribe: true,
                multiplex: {}
            })
            r2 = await fetch(endpoint, {
                signal: a.signal,
                subscribe: true,
                multiplex: {}
            })

            // ours are the only two subscriptions? then the multiplex
            // decisions we just observed were uncontaminated
            if (braid_fetch.subscription_counts?.[origin] === 2) break

            // another test snuck a subscription in -- clean up and retry
            assert(attempt < 5, 'gave up: other tests kept subscribing to this origin')
            await new Promise(done => r.subscribe(done))
            await new Promise(done => r2.subscribe(done))
            a.abort()
        }

        assert(!r.multiplexed_through, 'expected the first subscription not to be multiplexed')
        assert(r2.multiplexed_through, 'expected the second subscription to be multiplexed')

        // read both subscriptions, so the abort below tears them down fully
        // (and doesn't leak this origin's count for other tests)
        await new Promise(done => r.subscribe(done))
        await new Promise(done => r2.subscribe(done))

        a.abort()
    }
)

run_test(
    "Test stream parsing error.",
    async () => {
        // add a handler that answers like a subscription (status 209), but
        // writes garbage into the update stream -- blank lines (which the
        // parser skips) followed by a block that can't parse as update
        // headers -- and holds the response open like a real subscription
        var endpoint = await add_main_handler((req, res) => {
            res.statusCode = 209
            res.write('\r\n\r\n\r\nHTP 555\r\n\r\n\r\n')
        })

        // subscribe to the garbage endpoint -- at the http level this still
        // looks like a valid subscription; only the stream inside is broken
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })
        assert(r.status === 209, `expected status 209, got: ${r.status}`)

        // read the subscription: the garbage should kill it with a parse
        // error before any update is delivered
        var updates = 0
        var e = await new Promise(done => r.subscribe(u => updates++, done))

        // the error quotes the bytes the parser choked on: the skipped
        // blank lines are gone, and the newline after the block isn't
        // included
        assert(e.type === 'parse', `expected a parse error, got: ${e}`)
        assert(e.message === 'Parse error in headers: "HTP 555\\r\\n\\r\\n"',
               `got unexpected error message: ${e.message}`)
        assert(updates === 0, 'expected no updates before the parse error')

        a.abort()
    }
)

run_test(
    "Test server getting GET for multiplexer that doesn't exist.",
    async () => {
        // add a handler that sends one update and holds the subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        // open a subscription through a multiplexer of our choosing, creating
        // the multiplexer
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })
        assert(r.multiplexed_through, 'expected the first request to be multiplexed')

        // read the first update, and capture the death of this subscription,
        // which we expect later, when its multiplexer disappears
        var on_death
        var death = new Promise(done => on_death = done)
        await new Promise(done => r.subscribe(done, on_death))

        // add a pre-braidify observer that makes the server forget
        // multiplexer m whenever a request tagged with our marker header
        // arrives -- so braidify sees that request name a multiplexer that
        // doesn't exist. it also logs whether m existed on each arrival, in a
        // global keyed by the marker, for us to read back below
        var marker = Math.random().toString(36).slice(2)
        await add_pre_braidify_handler((req, res, m, marker) => {
            if (req.headers.marker !== marker) return
            var log = global['_muxless_' + marker] = global['_muxless_' + marker] ?? []
            log.push(!!braidify.multiplexers?.has(m))
            braidify.multiplexers?.delete(m)
        }, m, marker)

        // subscribe again through multiplexer m, tagged with the marker: the
        // observer above deletes m just before braidify handles the request,
        // so the server 424s it. the client should recover on its own, by
        // tearing down the dead multiplexer and retrying the request through
        // a fresh one -- this await resolves only if the retry succeeds
        var s2 = Math.random().toString(36).slice(2)
        var r2 = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: {
                marker,
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s2}`
            }
        })

        // make sure the retry got the subscription, multiplexed through a
        // fresh multiplexer (not the dead m)
        assert(r2.status === 209, 'expected the retried request to get the subscription')
        assert(r2.multiplexed_through, 'expected the retried request to be multiplexed')
        var m2 = r2.multiplexed_through.split('/')[3]
        assert(m2 !== m, 'expected the retry to use a fresh multiplexer')

        // and the fresh multiplexer really works: it delivers the update
        var update = await new Promise(done => r2.subscribe(done))
        assert(update.body_text === 'hi', 'got unexpected body')

        // read back the observer's log: the server saw the marked request
        // exactly twice -- first finding multiplexer m (and deleting it,
        // which 424s that attempt), then the retry, sent after m was gone
        var log = await server_eval((req, res, marker) =>
            res.end(JSON.stringify(global['_muxless_' + marker] ?? [])), marker)
        assert(log === JSON.stringify([true, false]),
               `expected the marked request to hit the server twice, losing the multiplexer in between, but its arrivals saw: ${log}`)

        // the first subscription was riding the dead multiplexer, so the
        // client should tear it down too
        assert(await death, 'expected the first subscription to die with its multiplexer')

        // cleanup: abort tears down the second subscription, and we kill the
        // fresh multiplexer the retry created
        a.abort()
        await kill_mux(m2)
    }
)

run_test(
    "Test multiplexed request aborted before GET, on server",
    async () => {
        // when a fetch is aborted, the client cancels its multiplexed request
        // by naming it to the server. here we exercise the server receiving
        // such a cancel for a request whose GET never arrived: it should 404
        // naming the missing *request*, and leave the multiplexer's live
        // requests alone

        // add a handler that sends one update, holds the subscription open,
        // and parks its res in a global keyed by a random id (passed as an
        // arg, since the handler runs server-side and can't close over test
        // variables), so we can send a second update through it later
        var id = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, id) => {
            res.startSubscription()
            res.sendUpdate({ body: 'first' })
            global['_sub_' + id] = res
        }, id)

        // open a subscription through a multiplexer of our choosing
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var s2 = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s2}` }
        })

        // make sure multiplexer m really exists, occupied by request s2 --
        // otherwise the 404 below could just mean "no such multiplexer" and
        // the test would pass without exercising the aborted-request path
        assert(r.multiplexed_through, 'expected request to be multiplexed')
        assert(r.multiplexed_through.split('/')[3] === m, 'expected the multiplexer id we submitted')
        assert(r.multiplexed_through.split('/')[4] === s2, 'expected the request id we submitted')

        // collect updates as they arrive, and wait for the first one
        var updates = []
        r.subscribe(u => updates.push(u.body_text))
        while (updates.length < 1) await new Promise(done => setTimeout(done, 10))
        assert(updates[0] === 'first', 'got unexpected first update')

        // abort request s, whose GET never arrived. the server should 404
        // with a Bad-Request header naming the request -- NOT the
        // Bad-Multiplexer flavor of 404, which tells a client the whole
        // multiplexer is dead (see try_deleting_request in
        // braid-http-client.js)
        var r2 = await og_fetch(`/${m}/${s}`, {
            method: 'MULTIPLEX',
            headers: { 'Multiplex-Version': multiplex_version }
        })
        assert(r2.status === 404, 'expected 404 aborting a request with no GET')
        assert(r2.headers.get('bad-request') === s, 'expected Bad-Request header naming the missing request')
        assert(!r2.headers.get('bad-multiplexer'), 'expected the request-missing 404, not the multiplexer-missing one')

        // the stray abort must not have disturbed the live request: send a
        // second update through the parked res, and make sure it still
        // arrives over the multiplexer
        await server_eval((req, res, id) => {
            global['_sub_' + id].sendUpdate({ body: 'second' })
            delete global['_sub_' + id]
            res.end('ok')
        }, id)
        while (updates.length < 2) await new Promise(done => setTimeout(done, 10))
        assert(updates[1] === 'second', 'expected the live request to survive the stray abort')

        a.abort()
        await kill_mux(m)
    }
)

// The multiplex_wait tests all twiddle braidify.multiplex_wait -- one global
// knob shared by every test server. The console runner runs tests one at a
// time, but the BROWSER runner launches them all in parallel, so these tests
// take turns through this promise chain instead of racing each other's wait
// windows (each starts when the previous finishes, pass or fail alike)
var knob_turn = Promise.resolve()
var serialize_knob_test = fn => knob_turn = knob_turn.then(fn, fn)

run_test(
    "Test multiplex_wait suppresses 424 when POST arrives within window.",
    () => serialize_knob_test(async () => {
        // add a handler to the express server that sends one update and holds
        // the subscription open. we use the express server because its
        // middleware hands braidify a next() -- the server only holds
        // requests for multiplex_wait when it has a way to re-run them later
        var update = { version: ['test'], body: 'made it within the window' }
        var endpoint = await add_express_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // remember the server's multiplex_wait, to restore at the end (the
        // test servers share one braidify module, so twiddling it through the
        // main server's /eval reaches the express server too)
        var og_wait = JSON.parse(await server_eval((req, res) =>
            res.end(JSON.stringify(braidify.multiplex_wait))))

        // multiplex_wait is a global knob that neighboring tests also twiddle,
        // and in the browser tests run in parallel -- another test could
        // shrink our window mid-attempt and 424 our GET early. retry if so
        var m, s, r, post_r
        for (var attempt = 0; ; attempt++) {
            assert(attempt < 5, 'gave up: multiplex_wait kept getting changed under us')

            // widen the wait window from its default 10ms, so the explicit
            // park-then-POST sequencing below replaces the old version's
            // 5ms-sleep-vs-10ms-window race
            await server_eval((req, res) => {
                braidify.multiplex_wait = 1000
                res.end('ok')
            })

            // send a Multiplex-Through GET naming a multiplexer that doesn't
            // exist yet. instead of 424ing right away, the server should hold
            // the request open for up to multiplex_wait ms
            m = Math.random().toString(36).slice(2)
            s = Math.random().toString(36).slice(2)
            var get_done = false
            var get_promise = og_fetch(endpoint, {
                headers: {
                    'Subscribe': 'true',
                    'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                    'Multiplex-Version': multiplex_version
                }
            }).then(x => {
                get_done = true
                return x
            })

            // wait until the server has actually parked our GET in the wait
            // window (it registers a pending timeout keyed by our multiplexer
            // id). this proves the wait mechanism really engaged, and
            // guarantees the POST below lands *during* the window, not before
            // -- the old version could pass without ever exercising the wait
            while (!get_done && await server_eval((req, res, m) =>
                res.end('' + !!braidify.pending_timeouts?.has(m)), m) !== 'true')
                await new Promise(done => setTimeout(done, 3))

            // if the GET resolved before we ever saw it parked, the window
            // must have been stomped -- go around again
            if (get_done) continue

            // now create the multiplexer. the server should hand the waiting
            // GET over to it instead of letting the 424 timer fire
            post_r = await og_fetch(`https://localhost:${port + 1}/.well-known/multiplexer/${m}`, {
                method: 'POST',
                headers: { 'Multiplex-Version': multiplex_version }
            })
            assert(post_r.ok, 'expected the POST to create the multiplexer')

            r = await get_promise
            if (r.status !== 424) break

            // stomped after parking: the 424 timer fired before our POST's
            // multiplexer caught the GET. clean up and try again
            await kill_mux(m)
        }

        // the GET should have resolved 293 (responded via multiplexer), and
        // its headers should point back at our multiplexer and request id
        assert(r.status === 293, `expected 293, got ${r.status}`)
        assert(r.headers.get('multiplex-through') === `/.well-known/multiplexer/${m}/${s}`,
               'expected the response to name our multiplexer and request id')

        // and the handler's response should actually arrive on the
        // multiplexer's stream (the POST's response body), framed with our
        // request id and carrying our update
        var reader = post_r.body.getReader()
        var seen = ''
        while (!(seen.includes(`start response ${s}`) && seen.includes(update.body))) {
            var { done, value } = await reader.read()
            assert(!done, `expected our update on the multiplexer stream, got: ${seen}`)
            seen += new TextDecoder().decode(value)
        }

        // restore the multiplex_wait we found, and tear down our multiplexer
        await server_eval((req, res, og_wait) => {
            braidify.multiplex_wait = og_wait
            res.end('ok')
        }, og_wait)
        await kill_mux(m)
    })
)

// Note: The following multiplex_wait tests rely on tight timing (e.g. 5ms
// delays, 50ms windows) and may fail intermittently in the browser due to
// CORS preflight overhead changing who wins the race. If you see spurious
// 293-vs-424 failures, re-run to confirm. We should investigate whether
// these are real bugs or just flaky timing, and fix either way.

run_test(
    "Test multiplex_wait times out to 424 when POST never arrives.",
    () => serialize_knob_test(async () => {
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // stretch the wait window (default is only 10ms) so we can catch the
        // server mid-wait below, remembering the old value to restore later
        var old_wait = JSON.parse(await server_eval((req, res, wait) => {
            var old = braidify.multiplex_wait
            braidify.multiplex_wait = wait
            res.end(JSON.stringify(old))
        }, 300))

        // send a subscribe GET naming a multiplexer that will never be
        // created. the express server hands braidify a next() function, so
        // instead of 424ing immediately, multiplex_wait kicks in and holds
        // the request open in case the multiplexer's POST is merely late
        // (braidify intercepts this request before any route handler runs)
        var st = Date.now()
        var get_promise = og_fetch(`https://localhost:${port+1}/middleware-test`, {
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            }
        })

        // prove the wait mechanism actually engaged: while waiting, braidify
        // parks the request in pending_timeouts under our multiplexer id.
        // spin until it shows up -- if it never engages, this loop spins
        // until the test runner's timeout fails the test
        while (await server_eval((req, res, m) =>
            res.end('' + !!braidify.pending_timeouts?.has(m)), m) !== 'true')
            await new Promise(done => setTimeout(done, 5))

        // with no POST ever arriving, the GET should give up with a 424
        // naming the missing multiplexer, and only after the full window
        var r = await get_promise
        var elapsed = Date.now() - st

        // restore the wait window before asserting anything
        await server_eval((req, res, wait) => {
            braidify.multiplex_wait = wait
            res.end('ok')
        }, old_wait)

        assert(r.status === 424, 'expected a 424 status')
        assert(r.headers.get('bad-multiplexer') === m, 'expected bad-multiplexer header naming the missing multiplexer')
        assert(await r.text() === `multiplexer ${m} does not exist`, 'expected the multiplexer-does-not-exist body')
        assert(elapsed >= 290, 'expected the 424 only after the full wait window')

        // and the timed-out wait should have cleaned up after itself
        var pending = await server_eval((req, res, m) =>
            res.end('' + !!braidify.pending_timeouts?.has(m)), m)
        assert(pending === 'false', 'expected the pending timeout to be cleaned up')
    })
)

run_test(
    "Test multiplex_wait=0 disables waiting (immediate 424).",
    () => serialize_knob_test(async () => {
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)

        // add an endpoint on the express server -- which passes next() to
        // braidify, so multiplex_wait WOULD apply -- and count how many times
        // it actually runs, in a global keyed by our random id (all the test
        // servers share one process, so server_eval can read it back later)
        var endpoint = await add_express_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.end('ok')
        }, s)

        // crank the wait up to 3 seconds, then set it to 0. priming it high
        // first keeps the test honest: if the 0 fails to disable waiting, the
        // GET below stalls for seconds and trips the elapsed check, rather
        // than sneaking in under it after a stale 10ms default wait
        await server_eval((req, res) => {
            braidify.multiplex_wait = 3000
            res.end('ok')
        })
        await server_eval((req, res) => {
            braidify.multiplex_wait = 0
            res.end('ok')
        })

        // GET through a multiplexer that doesn't exist (and never will)
        var st = Date.now()
        var r = await og_fetch(endpoint, {
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            }
        })
        var elapsed = Date.now() - st

        // restore the default before asserting anything, so a failed assert
        // doesn't leave the knob broken for other tests
        await server_eval((req, res) => {
            braidify.multiplex_wait = 10
            res.end('ok')
        })

        // the request should fail right away with 424, blaming our multiplexer
        assert(r.status === 424, 'expected 424')
        assert(r.headers.get('bad-multiplexer') === m, 'expected our multiplexer to be blamed')
        assert(elapsed < 1500, 'expected the 424 without waiting')

        // and braidify should have consumed the request outright -- it should
        // never have fallen through to our endpoint
        var hits = await server_eval((req, res, s) =>
            res.end('' + (global['_hits_' + s] ?? 0)), s)
        assert(hits === '0', 'expected the request to never reach the endpoint')
    })
)

run_test(
    "Test multiple requests waiting for same multiplexer via multiplex_wait.",
    () => serialize_knob_test(async () => {
        // add a handler to the express server (whose braidify runs as
        // middleware with a next(), so multiplex_wait applies) that opens a
        // subscription and echoes back which multiplexed request id it's
        // responding to
        var endpoint = await add_express_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: `hello ${req.headers['multiplex-through'].split('/')[4]}` })
        })

        // raise multiplex_wait, giving the requests below plenty of time to
        // wait for their multiplexer (all the test servers share one braidify
        // module, so setting this on the main server sets it everywhere).
        // the window is generous because in the parallel browser runner the
        // two GETs below can arrive well apart -- each pays a CORS preflight
        // and competes with other tests for chrome's 6-connections-per-host
        // budget -- and both must be parked at the same moment for the poll
        // below. the knob tests are serialized (see serialize_knob_test), so
        // holding the window open this long can't destabilize a neighboring
        // test's timing
        await server_eval((req, res) => {
            braidify.multiplex_wait = 5000
            res.end('ok')
        })

        var m = Math.random().toString(36).slice(2)
        var s1 = Math.random().toString(36).slice(2)
        var s2 = Math.random().toString(36).slice(2)

        // send two multiplex-through GETs naming a multiplexer that doesn't
        // exist yet -- instead of 424ing, braidify should hold both open,
        // waiting for the multiplexer to show up. each GET gets a distinct
        // query string (the handler registry routes on the path alone) and
        // cache: 'no-store', because chrome holds a GET to a URL with an
        // identical GET already in flight until the first one's response
        // headers arrive -- and our first GET is deliberately parked
        // headerless in the wait window, so the second would never even be
        // sent, and the both-parked poll below would spin forever
        var mux_get = s => og_fetch(`${endpoint}?req=${s}`, {
            cache: 'no-store',
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            }
        })
        var get1 = mux_get(s1)
        var get2 = mux_get(s2)

        // wait until the server really is holding both requests on wait
        // timers for our multiplexer -- if we created it any sooner, the
        // requests could multiplex through it directly, and the test could
        // pass without ever exercising the waiting path. the wait is bounded:
        // if both requests never park together, fail with a diagnosis rather
        // than spinning forever (which would also wedge the serialized knob
        // tests queued behind us)
        var parked, give_up = Date.now() + 8000
        while ((parked = await server_eval((req, res, m) =>
            res.end(`${braidify.pending_timeouts?.get(m)?.size ?? 0}`), m)) !== '2') {
            assert(Date.now() < give_up,
                   `expected both requests parked in the wait window, but pending count is `
                   + `stuck at ${parked} -- did one 424 early, or never reach the server?`)
            await new Promise(done => setTimeout(done, 3))
        }

        // now create the multiplexer they're both waiting for
        var mux = await og_fetch(`https://localhost:${port + 1}/.well-known/multiplexer/${m}`, {
            method: 'POST',
            headers: { 'Multiplex-Version': multiplex_version }
        })

        var [r1, r2] = await Promise.all([get1, get2])

        // restore the multiplex_wait default before asserting anything, so a
        // failure below doesn't leave the raised value behind
        await server_eval((req, res) => {
            braidify.multiplex_wait = 10
            res.end('ok')
        })

        // both held GETs should have resolved with 293 ("your response will
        // arrive via the multiplexer") -- not 424
        assert(r1.status === 293, `expected 293 for first request, got ${r1.status}`)
        assert(r2.status === 293, `expected 293 for second request, got ${r2.status}`)

        // and both responses should actually arrive over the multiplexer's
        // stream: read it until we see the handler's per-request body for
        // each of them (each body is written in a single chunk, so it can't
        // be split across the stream's framing lines)
        var reader = mux.body.getReader()
        var seen = ''
        while (!(seen.includes(`hello ${s1}`) && seen.includes(`hello ${s2}`))) {
            var { done, value } = await reader.read()
            assert(!done, 'expected both responses over the multiplexer, but its stream ended')
            seen += new TextDecoder().decode(value)
        }
        assert(seen.includes(`start response ${s1}`) && seen.includes(`start response ${s2}`),
               'expected the multiplexer stream to announce both responses')

        // clean up our multiplexer (which also tears down the two
        // subscriptions the server is holding open through it)
        await kill_mux(m)
    })
)

run_test(
    "Test multiplex_wait has no effect without next (main server).",
    () => serialize_knob_test(async () => {
        // the main server calls braidify(req, res) inline, without a next().
        // with no way to re-run the request later, braidify can't park
        // Multiplex-Through requests in the multiplex_wait window, so naming
        // a multiplexer that doesn't exist should 424 immediately

        // add a handler that counts its runs in a keyed global, so we can
        // verify at the end that braidify never let our request through to it
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_ran_' + s] = (global['_ran_' + s] ?? 0) + 1
            res.end('handler ran')
        }, s)

        // remember the server's multiplex_wait to restore at the end, and
        // widen it from its default 10ms -- the old version of this test
        // checked elapsed < 50ms, which couldn't tell an immediate 424 from
        // one that waited out the window; with a wide window, a wrongly
        // parked request gets caught red-handed by the polling below instead
        var og_wait = JSON.parse(await server_eval((req, res) =>
            res.end(JSON.stringify(braidify.multiplex_wait))))
        await server_eval((req, res) => {
            braidify.multiplex_wait = 1000
            res.end('ok')
        })

        // send a Multiplex-Through GET naming a multiplexer that doesn't
        // exist (and never will)
        var m = Math.random().toString(36).slice(2)
        var get_done = false
        var get_promise = og_fetch(endpoint, {
            headers: {
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`,
                'Multiplex-Version': multiplex_version
            }
        }).then(x => {
            get_done = true
            return x
        })

        // while the GET is in flight, our multiplexer id must never show up
        // in the server's wait window (a parked request registers a pending
        // timeout keyed by its multiplexer id, and ours would sit there for
        // the full second)
        while (!get_done) {
            assert(await server_eval((req, res, m) =>
                res.end('' + !!braidify.pending_timeouts?.has(m)), m) === 'false',
                'expected the request not to be parked in the wait window')
            await new Promise(done => setTimeout(done, 3))
        }

        // the 424 should blame our multiplexer
        var r = await get_promise
        assert(r.status === 424, `expected 424, got ${r.status}`)
        assert(r.headers.get('bad-multiplexer') === m,
               'expected the 424 to blame our multiplexer')

        // and braidify should have hidden the request from our handler
        assert(await server_eval((req, res, s) =>
            res.end('' + (global['_ran_' + s] ?? 0)), s) === '0',
            'expected braidify to hide the request from the handler')

        // restore the multiplex_wait we found
        await server_eval((req, res, og_wait) => {
            braidify.multiplex_wait = og_wait
            res.end('ok')
        }, og_wait)
    })
)

run_test(
    "Test client asking for multiplexing, but server doesn't realize it.",
    async () => {
        // this test hits a dedicated server (port+4) whose braidify has
        // multiplexing permanently disabled -- simulating a server that
        // doesn't understand the multiplexing protocol at all

        // add a handler there that echoes the multiplex request headers it
        // received (so we can verify the multiplexing ask really reached the
        // server), holds a subscription open -- stashing its res in a keyed
        // global -- and sends one update
        var k = Math.random().toString(36).slice(2)
        var endpoint = await add_no_mux_handler((req, res, k) => {
            res.setHeader('Echo-Multiplex-Through', req.headers['multiplex-through'] ?? 'none')
            res.setHeader('Echo-Multiplex-Version', req.headers['multiplex-version'] ?? 'none')
            res.startSubscription()
            global['_sub_' + k] = res
            res.sendUpdate({ version: ['first'], body: 'hi' })
        }, k)

        // and a handler that sends a second update over that held-open
        // subscription, to prove later that it's still live
        var poke_endpoint = await add_no_mux_handler((req, res, k) => {
            global['_sub_' + k].sendUpdate({ version: ['second'], body: '"!"' })
            delete global['_sub_' + k]
            res.end('ok')
        }, k)

        // subscribe, explicitly asking to multiplex through a multiplexer of
        // our choosing
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })

        // the client really did ask the server for multiplexing: the request
        // carried our Multiplex-Through header, plus the Multiplex-Version
        // header that only the client's multiplexing machinery adds
        assert(r.headers.get('echo-multiplex-through') === `/.well-known/multiplexer/${m}/${s}`,
               'expected the server to receive our multiplexing ask')
        assert(r.headers.get('echo-multiplex-version') === multiplex_version,
               'expected the multiplexing machinery to have sent the request')

        // but the server didn't realize it: no multiplex ack came back, and
        // the client just returns the plain 209 subscription response
        assert(!r.multiplexed_through, 'expected the response not to be multiplexed')
        assert(!r.headers.has('multiplex-version'), 'expected no multiplexing talk in the response')
        assert(r.status === 209, `expected a plain 209 subscription, got ${r.status}`)

        // the subscription should still work over the plain connection: read
        // the first update, then poke the server for a second one -- getting
        // it proves the subscription outlives the initial response
        var versions = []
        await new Promise(done =>
            r.subscribe(u => {
                versions.push(u.version[0])
                if (versions.length === 1) og_fetch(poke_endpoint)
                if (versions.length === 2) done()
            }))
        assert(versions.join(',') === 'first,second',
               `expected updates first,second -- got ${versions}`)

        a.abort()
    }
)

add_section_header("Express Middleware Tests")

run_test(
    "Test braidify as Express middleware with subscription",
    async () => {
        // add a handler to the express server (port+1), where braidify runs
        // as express middleware on every request. it only subscribes if
        // braidify actually decorated req/res -- otherwise it 500s, so a
        // broken middleware can't pass the assertions below vacuously. it
        // also parks its res in a global keyed by a random id (passed as an
        // arg, since the handler runs server-side and can't close over test
        // variables), so we can send a second update through it later
        var id = Math.random().toString(36).slice(2)
        var update = { version: ['middleware-works'], body: 'Braidify works as Express middleware!' }
        var endpoint = await add_express_handler((req, res, id, update) => {
            if (!req.subscribe
                || typeof res.startSubscription !== 'function'
                || typeof res.sendUpdate !== 'function') {
                res.statusCode = 500
                return res.end('braidify did not decorate req/res')
            }
            res.startSubscription()
            res.sendUpdate(update)
            global['_sub_' + id] = res
        }, id, update)

        // subscribe to it. multiplex: false keeps this a direct subscription,
        // independent of the global enable_multiplex knob -- the multiplexed
        // express path has its own test in the multiplexing section
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })

        // make sure the middleware answered with a subscription
        assert(r.status === 209, `expected status 209, got: ${r.status}`)
        assert(r.headers.get('subscribe') === 'true', 'expected subscribe response header')

        // collect updates as they arrive, and wait for the first one
        var updates = []
        r.subscribe(u => updates.push(u))
        while (updates.length < 1) await new Promise(done => setTimeout(done, 10))
        assert(updates[0].version[0] === 'middleware-works', 'got unexpected version')
        assert(updates[0].body_text === 'Braidify works as Express middleware!', 'got unexpected body')

        // the middleware must hold the subscription open after the handler
        // returns: send a second update through the parked res, and make
        // sure it arrives on the same subscription
        var update2 = { version: ['still-works'], body: 'and the subscription is still open!' }
        var poke = await add_express_handler((req, res, id, update2) => {
            global['_sub_' + id].sendUpdate(update2)
            delete global['_sub_' + id]
            res.end('ok')
        }, id, update2)
        await og_fetch(poke)
        while (updates.length < 2) await new Promise(done => setTimeout(done, 10))
        assert(updates[1].version[0] === 'still-works', 'expected the subscription to stay open for a second update')
        assert(updates[1].body_text === 'and the subscription is still open!', 'got unexpected second body')

        a.abort()
    }
)

run_test(
    "Test braidify as Express middleware without subscription",
    async () => {
        // add a handler to the express server (which mounts braidify as
        // middleware) that reports how braidify decorated a plain request:
        // whether it attached its helpers to res, and whether it marked the
        // request as a subscription. the handler runs server-side, so it
        // inspects req/res there and sends its observations back in the body,
        // using express's own res.json to prove that still works after braidify
        var endpoint = await add_express_handler((req, res) => {
            res.json({
                subscribe: !!req.subscribe,
                braidified: typeof res.startSubscription === 'function'
                    && typeof res.sendUpdate === 'function',
                message: 'hello from express'
            })
        })

        // make a plain GET, without subscribing
        var r = await fetch(endpoint)

        // a non-subscribe request should get an ordinary 200 response, with
        // express's res.json content-type intact (braidify only switches the
        // content-type to a stream type for subscriptions)
        assert(r.status === 200, 'expected a plain 200 response')
        assert(r.headers.get('content-type')?.startsWith('application/json'),
            'expected express res.json content-type to survive braidify')

        // make sure braidify actually ran as middleware on this request,
        // and correctly saw that it was not a subscription
        var data = await r.json()
        assert(data.braidified, 'expected braidify to decorate res')
        assert(data.subscribe === false, 'expected req.subscribe to be falsy without subscribe')
        assert(data.message === 'hello from express', 'got unexpected body')
    }
)

add_section_header("Wrapper Function Tests")

run_test(
    "Test braidify as wrapper function with subscription",
    async () => {
        // the port+2 server wraps its whole request handler in
        // braidify(...); this test checks that a subscription works
        // end-to-end through that wrapper form

        // add a handler to the wrapper server that starts a subscription,
        // sends one update, and parks its res in a global keyed by a random
        // id (passed as an arg, since the handler runs server-side and can't
        // close over test variables), so we can send a second update through
        // it later. the update's body echoes back req.subscribe, so we can
        // check the wrapper really parsed the subscribe request header
        var id = Math.random().toString(36).slice(2)
        var endpoint = await add_wrapper_handler((req, res, id) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['first'],
                body: JSON.stringify({ subscribe: req.subscribe })
            })
            global['_wrapper_sub_' + id] = res
        }, id)

        // add a second handler that sends another update through the parked
        // res, so the test controls when the update happens (no timers)
        var poke = await add_wrapper_handler((req, res, id) => {
            global['_wrapper_sub_' + id].sendUpdate({ version: ['second'], body: 'an update!' })
            delete global['_wrapper_sub_' + id]
            res.end('ok')
        }, id)

        // subscribe to the endpoint we added
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true
        })

        // the wrapper should have answered like a subscription
        assert(r.status === 209, `expected status 209, got: ${r.status}`)

        // collect updates as they arrive, and wait for the first one
        var updates = []
        r.subscribe(u => updates.push(u))
        while (updates.length < 1) await new Promise(done => setTimeout(done, 10))

        // the first update should be the one the handler sent, and show that
        // braidify parsed the subscribe request header into req.subscribe
        assert(updates[0].version[0] === 'first', 'got unexpected first version')
        assert(JSON.parse(updates[0].body_text).subscribe === 'true',
               'expected braidify to parse the subscribe header')

        // the subscription should still be open: poke the server (over the
        // plain transport) to send a second update through the parked res,
        // and make sure it arrives
        await og_fetch(poke)
        while (updates.length < 2) await new Promise(done => setTimeout(done, 10))
        assert(updates[1].version[0] === 'second', 'got unexpected second version')
        assert(updates[1].body_text === 'an update!', 'got unexpected second body')

        a.abort()
    }
)

run_test(
    "Test braidify as wrapper function without subscription",
    async () => {
        // add a handler to the wrapper server that answers with one update
        // and ends the response, like a normal http exchange. it echoes back
        // whether braidify saw a subscribe request, so we can verify the
        // non-subscription path really ran. the update is passed as an arg
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables)
        var v = Math.random().toString(36).slice(2)
        var update = { version: [v], body: JSON.stringify({ message: 'hello from the wrapper' }) }
        var endpoint = await add_wrapper_handler((req, res, update) => {
            res.setHeader('content-type', 'application/json')
            res.setHeader('saw-subscribe', '' + !!req.subscribe)
            res.sendUpdate(update)
            res.end()
        }, update)

        // fetch the endpoint without subscribing
        var r = await fetch(endpoint)

        // make sure we got an ordinary successful response, and that the
        // wrapped handler really took the non-subscription path
        assert(r.status === 200, 'expected status 200')
        assert(r.headers.get('saw-subscribe') === 'false', 'expected the server not to see a subscription')

        // sendUpdate on a non-subscription should send the update as plain
        // http: the version as a header, which the client parses back...
        assert(r.version && r.version[0] === v, 'expected the update version on the response')

        // ...with headers the handler set left intact, and the update body
        // as the whole response body, with its length declared up front (a
        // subscription would stream instead)
        assert(r.headers.get('content-type') === 'application/json', 'expected the handler content-type to survive')
        assert(r.headers.get('content-length') === '' + update.body.length, 'expected content-length of the update body')
        var data = await r.json()
        assert(data.message === 'hello from the wrapper', 'got unexpected body')
    }
)

add_section_header("braidify.server() Tests")

// braidify.server() attaches to an existing http.Server.  Listens on port+3.

run_test(
    "Test braidify.server with subscription",
    async () => {
        // add a handler to the braidify.server()-wrapped server (port+3)
        // that starts a subscription and sends two updates back-to-back.
        // the updates are passed as args (the handler runs server-side via
        // eval, so it can't close over test-side variables)
        var update1 = { version: ['server-v1'], body: JSON.stringify({ message: 'first' }) }
        var update2 = { version: ['server-v2'], parents: ['server-v1'], body: JSON.stringify({ message: 'second' }) }
        var endpoint = await add_wrapped_handler((req, res, update1, update2) => {
            res.startSubscription()
            res.sendUpdate(update1)
            res.sendUpdate(update2)
        }, update1, update2)

        // subscribe to the endpoint we added
        var a = new AbortController()
        var r = await fetch(endpoint, {
            subscribe: true,
            signal: a.signal
        })

        // make sure the wrapped server marked the response as a subscription
        assert(r.status === 209, 'expected 209 subscription status')
        assert(r.headers.get('subscribe') === 'true', 'expected subscribe header')

        // collect both updates off the subscription
        var updates = []
        await new Promise(done => r.subscribe(update => {
            updates.push(update)
            if (updates.length >= 2) done()
        }))

        // make sure the updates arrived in order, with the versions,
        // parents, and bodies the handler sent
        assert(updates[0].version[0] === 'server-v1', 'got unexpected first version')
        assert(JSON.parse(updates[0].body_text).message === 'first', 'got unexpected first body')
        assert(updates[1].version[0] === 'server-v2', 'got unexpected second version')
        assert(updates[1].parents[0] === 'server-v1', 'got unexpected second parents')
        assert(JSON.parse(updates[1].body_text).message === 'second', 'got unexpected second body')

        a.abort()
    }
)

run_test(
    "Test braidify.server without subscription",
    async () => {
        // add a handler to the braidify.server()-attached server (port+3)
        // that answers with sendUpdate + end. the body echoes what the
        // handler saw server-side -- whether req.subscribe was set, and
        // whether the braid helpers got attached -- so we can verify that
        // braidify.server really braidified a plain non-subscribe request
        var endpoint = await add_wrapped_handler((req, res) => {
            res.setHeader('content-type', 'application/json')
            res.sendUpdate({
                version: ['plain-version'],
                body: JSON.stringify({
                    subscribe: !!req.subscribe,
                    braidified: typeof res.startSubscription === 'function'
                })
            })
            res.end()
        })

        // fetch it as a plain GET, without subscribing
        var r = await fetch(endpoint)

        // without a subscription this is a normal 200 response,
        // not a 209 multiresponse with a subscribe header
        assert(r.status === 200, 'expected a plain 200 response')
        assert(!r.headers.get('subscribe'), 'expected no subscribe header')

        // sendUpdate on a plain response turns the update's version into a
        // Version header, which braid_fetch parses back onto the response
        assert(r.version && r.version[0] === 'plain-version', 'expected the update version on the response')

        // the update's body arrives as the plain response body
        var data = await r.json()
        assert(data.subscribe === false, 'expected the server to see a non-subscribe request')
        assert(data.braidified, 'expected braidify.server to attach the braid helpers')
    }
)

run_test(
    "Test multiplexing through braidify.server endpoint",
    async () => {
        // add a handler to the braidify.server()-attached server (port + 3)
        // that sends one update and holds the subscription open
        var endpoint = await add_wrapped_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['server-mux-version'],
                body: 'hello from braidify.server'
            })
        })

        // subscribe through a multiplexer of our choosing -- the
        // Multiplex-Through header forces multiplexing, and naming the
        // multiplexer ourselves lets us inspect it server-side below
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })

        // make sure the request was multiplexed, through our multiplexer
        assert(r.multiplexed_through === `/.well-known/multiplexer/${m}/${s}`,
               'expected request to be multiplexed through our multiplexer')

        // grab the first update off the subscription, and make sure it came
        // through the multiplexer intact
        var update = await new Promise(done => r.subscribe(done))
        assert(update.version[0] === 'server-mux-version', 'got unexpected version')
        assert(update.body_text === 'hello from braidify.server', 'got unexpected body')

        // make sure braidify.server really registered our request on our
        // multiplexer. all the test servers share one braidify module, so the
        // main server's /eval can see the multiplexer created on port + 3
        var registered = await server_eval((req, res, m, s) => {
            res.end('' + !!braidify.multiplexers?.get(m)?.requests?.has(s))
        }, m, s)
        assert(registered === 'true', 'expected our request to be registered on the multiplexer')

        a.abort()
        await kill_mux(m)
    }
)

run_test(
    "Test that properties on res are accessible to res event listeners (via multiplex)",
    async () => {
        // the http2-proxy bug pattern: a handler sets a property on `res`,
        // then reads `this.<property>` from inside an event listener on
        // `res`. under the old property-forwarding hack, a multiplex-through
        // handler got the original res -- new properties landed on it, but
        // `res.on` was secretly rebound to the replacement res2, so when the
        // listener fired, `this` was res2 and the property was gone.
        // braidify.server now hands the handler the replacement res itself,
        // keeping the property and the listener on one object

        // add a handler to the braidify.server() server (port + 3), since
        // that entry point is what's under test here. it sets a property on
        // res, attaches finish/close listeners to res, sends one update, and
        // holds the subscription open. when a listener fires, it records in
        // a global (keyed by a random id passed as an arg, since the handler
        // runs server-side and can't close over test variables) whether
        // `this` still had the property
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['v' + s], parents: ['p' + s], body: JSON.stringify({ id: s }) }
        var endpoint = await add_wrapped_handler((req, res, s, update) => {
            res.my_marker = 'magic-' + s
            var record = function () {
                global['_marker_' + s] = global['_marker_' + s] ??
                    (this.my_marker === 'magic-' + s ? 'ok' : `saw ${this.my_marker}`)
            }
            res.on('finish', record)
            res.on('close', record)
            res.startSubscription()
            res.sendUpdate(update)
        }, s, update)

        // open a subscription through a multiplexer of our choosing
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s2 = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s2}` }
        })

        // make sure the request was actually multiplexed, through our multiplexer
        assert(r.multiplexed_through, 'expected request to be multiplexed')
        assert(r.multiplexed_through.split('/')[3] === m, 'expected the multiplexer id we submitted')

        // read the first update, so we know the handler has run (property
        // set, listeners attached) before we abort. it should match what we
        // sent, plus the status the server attaches on the way out
        var got = await new Promise(done => r.subscribe(u => {
            u.body = u.body_text
            done(JSON.stringify(u))
        }))
        assert(got === JSON.stringify({ ...update, status: '200' }),
               'got unexpected update through braidify.server multiplexer')

        // abort the subscription -- the client DELETEs its request on the
        // multiplexer, and the server tears down the handler's res, firing
        // its finish/close listeners
        a.abort()

        // wait for a listener to record a verdict -- if none ever fires,
        // this loop spins until the test runner's timeout fails the test
        var verdict
        while (!(verdict = await server_eval((req, res, s) =>
            res.end(global['_marker_' + s] ?? ''), s)))
            await new Promise(done => setTimeout(done, 10))

        // make sure the listener really saw the property
        assert(verdict === 'ok', `expected listener to see the res property, but it ${verdict}`)

        await kill_mux(m)
    }
)

add_section_header("Server sending binary data with sendUpdate")

run_test(
    "Server can send binary body when not subscribing",
    async () => {
        // add a handler that answers a plain (non-subscribe) request with a
        // single update whose body is binary. the bytes travel as an arg and
        // get wrapped in a Uint8Array server-side, since args are
        // JSON-serialized on their way over
        var bytes = [0, 1, 2, 3]
        var endpoint = await add_main_handler(async (req, res, bytes) => {
            await res.sendUpdate({
                version: ['bin-v1'],
                parents: ['bin-v0'],
                body: new Uint8Array(bytes)
            })
            res.end()
        }, bytes)

        // fetch it without subscribing -- the update should come back as an
        // ordinary http response rather than in subscription framing
        var r = await fetch(endpoint)
        assert(r.status === 200, 'expected a 200 response')

        // the update's version and parents should arrive as plain response
        // headers (and braid_fetch should have parsed the version for us)
        assert('' + r.version === 'bin-v1', 'expected version to be parsed from the response headers')
        assert(r.headers.get('parents') === '"bin-v0"', 'expected the parents header')

        // the body should be exactly the raw bytes -- unmangled by any text
        // decoding, with a content-length to match
        assert(r.headers.get('content-length') === '' + bytes.length, 'expected content-length to match the byte count')
        var body = new Uint8Array(await r.arrayBuffer())
        assert('' + body === '' + bytes, 'got unexpected binary body')
    }
)

run_test(
    "Server can send binary body as ArrayBuffer",
    async () => {
        // add a handler that starts a subscription and sends one update
        // whose body is an ArrayBuffer, then holds the subscription open.
        // the bytes travel as a plain array arg (the handler runs
        // server-side via eval, so it can't close over test-side variables,
        // and an ArrayBuffer doesn't JSON-serialize)
        var bytes = [0, 1, 2, 3]
        var endpoint = await add_main_handler((req, res, bytes) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: new Uint8Array(bytes).buffer
            })
        }, bytes)

        // subscribe to the endpoint we added, without multiplexing,
        // so we exercise the plain subscription path
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })

        // make sure the server actually accepted the subscription
        assert(r.status === 209, 'expected 209 subscription response')

        // grab the first update off the subscription
        var update = await new Promise(done => r.subscribe(done))

        // make sure the version and parents survived the trip
        assert(update.version[0] === 'test', 'got unexpected version')
        assert(update.parents[0] === 'oldie', 'got unexpected parents')

        // make sure the body arrived as binary -- the client hands binary
        // bodies over as a Uint8Array -- with exactly the bytes we sent
        assert(update.body instanceof Uint8Array, 'expected body to be a Uint8Array')
        assert('' + update.body === '' + bytes, 'got unexpected body bytes')

        a.abort()
    }
)

run_test(
    "Server can send binary body as Uint8Array",
    async () => {
        // add a handler that starts a subscription and sends one update whose
        // body is a Uint8Array. the bytes are passed as a plain array (handler
        // args are JSON-serialized) and reconstructed server-side
        var bytes = [0, 1, 2, 3]
        var endpoint = await add_main_handler((req, res, bytes) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: new Uint8Array(bytes)
            })
        }, bytes)

        // subscribe to the endpoint, keeping the request off any multiplexer
        // so we exercise the plain subscription wire format
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })

        // grab the first update off the subscription
        var update = await new Promise(done => r.subscribe(done))

        // make sure the version and parents survived alongside the binary body
        assert(update.version[0] === 'test', 'got unexpected version')
        assert(update.parents[0] === 'oldie', 'got unexpected parents')

        // make sure the body arrived as actual binary -- the exact bytes the
        // server sent, not some string rendering of them
        assert(update.body instanceof Uint8Array, 'expected body to be a Uint8Array')
        assert(update.body.length === bytes.length &&
               bytes.every((b, i) => update.body[i] === b),
               'got unexpected body bytes')

        a.abort()
    }
)

run_test(
    "Server can send binary body as Blob",
    async () => {
        // add a handler that starts a subscription, sends one update whose
        // body is a Blob, and holds the subscription open. the Blob is
        // constructed server-side (blobs don't survive JSON-serialization as
        // args), and its bytes are deliberately invalid utf-8, so they only
        // arrive intact if the server truly reads the Blob and sends its
        // bytes as binary -- any text round-trip would mangle them
        var endpoint = await add_main_handler(async (req, res) => {
            res.startSubscription()
            await res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: new Blob([new Uint8Array([0xde, 0xad, 0xbe, 0xef])])
            })
        })

        // subscribe to the endpoint we added
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })

        // grab the first update off the subscription
        var update = await new Promise((done, fail) => r.subscribe(done, fail))

        // make sure the update's version and parents came through,
        // and that the blob's bytes arrived exactly as sent
        assert('' + update.version === 'test', 'got unexpected version')
        assert('' + update.parents === 'oldie', 'got unexpected parents')
        assert(update.body.length === 4, 'expected exactly the 4 bytes we sent')
        assert('' + update.body === '' + new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
               'got unexpected body bytes')

        a.abort()
    }
)

run_test(
    "Server can send binary body as Buffer",
    async () => {
        // add a handler that sends one update whose body is a node Buffer,
        // then holds the subscription open. the buffer is constructed
        // server-side from a plain byte array, since handler args are
        // JSON-serialized and a Buffer wouldn't survive the trip
        var bytes = [0, 1, 2, 3]
        var endpoint = await add_main_handler((req, res, bytes) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: Buffer.from(bytes)
            })
        }, bytes)

        // subscribe to the endpoint we added
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })

        // grab the first update off the subscription
        var update = await new Promise(done => r.subscribe(done))

        // the client should hand us the body as raw bytes,
        // identical to what the server put in the buffer
        assert(update.body instanceof Uint8Array, 'expected a binary body')
        assert('' + update.body === '' + bytes, 'got unexpected body bytes')

        // the update's metadata should come through intact too
        assert(update.version[0] === 'test', 'got unexpected version')
        assert(update.parents[0] === 'oldie', 'got unexpected parents')

        a.abort()
    }
)

run_test(
    "Server can send binary patch as ArrayBuffer",
    async () => {
        // add a handler that sends one update whose single patch has an
        // ArrayBuffer as its content, then holds the subscription open. the
        // bytes travel as an arg and get wrapped server-side, since args are
        // JSON-serialized on their way over
        var bytes = [0, 1, 2, 3]
        var endpoint = await add_main_handler((req, res, bytes) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['bin-v1'],
                parents: ['bin-v0'],
                patch: {unit: 'text', range: '[0:0]', content: new Uint8Array(bytes).buffer}
            })
        }, bytes)

        // subscribe to the endpoint and grab the first update
        var a = new AbortController()
        var r = await fetch(endpoint, {subscribe: true, multiplex: false, signal: a.signal})
        var update = await new Promise(done => r.subscribe(done))

        // the update's version and parents should come through
        assert('' + update.version === 'bin-v1', 'got unexpected version')
        assert('' + update.parents === 'bin-v0', 'got unexpected parents')

        // the update should arrive as exactly one patch -- not a body
        // snapshot -- with the unit and range we sent
        assert(!update.body, 'expected a patch rather than a body')
        assert(update.patches.length === 1, 'expected exactly one patch')
        assert(update.patches[0].unit === 'text', 'got unexpected patch unit')
        assert(update.patches[0].range === '[0:0]', 'got unexpected patch range')

        // the patch content should be the raw bytes as a Uint8Array --
        // unmangled by any text decoding
        assert(update.patches[0].content instanceof Uint8Array, 'expected patch content to be a Uint8Array')
        assert('' + update.patches[0].content === '' + bytes, 'got unexpected patch content')

        a.abort()
    }
)

run_test(
    "Server can send binary patch as Uint8Array",
    async () => {
        // the bytes the server will send as a Uint8Array patch content
        var bytes = [0, 1, 2, 3]

        // add a handler that starts a subscription and sends one update whose
        // patch content is a Uint8Array. the bytes are passed as a plain array
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables, and JSON can't carry a Uint8Array) and get
        // wrapped server-side -- that Uint8Array is what this test exercises
        var endpoint = await add_main_handler((req, res, bytes) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patch: {unit: 'text', range: '[0:0]', content: new Uint8Array(bytes)}
            })
        }, bytes)

        // subscribe to the endpoint and grab the first update
        var a = new AbortController()
        var r = await fetch(endpoint, {subscribe: true, multiplex: false, signal: a.signal})
        var update = await new Promise(done => r.subscribe(done))

        // the version and parents should have made the round trip
        assert(JSON.stringify(update.version) === JSON.stringify(['test']), 'got unexpected version')
        assert(JSON.stringify(update.parents) === JSON.stringify(['oldie']), 'got unexpected parents')

        // the update should arrive as exactly one patch (and no body), with
        // the unit and range we sent
        assert(!update.body, 'expected the update to have a patch, not a body')
        assert(update.patches.length === 1, 'expected exactly one patch')
        assert(update.patches[0].unit === 'text', 'got unexpected patch unit')
        assert(update.patches[0].range === '[0:0]', 'got unexpected patch range')

        // the patch content should come back as binary, with exactly the
        // bytes we sent
        assert(update.patches[0].content instanceof Uint8Array, 'expected binary patch content')
        assert(JSON.stringify([...update.patches[0].content]) === JSON.stringify(bytes), 'got unexpected patch content bytes')

        a.abort()
    }
)

run_test(
    "Server can send binary patch as Blob",
    async () => {
        // add a handler that starts a subscription and sends one update whose
        // single patch's content is a binary Blob. the bytes travel as an arg
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables) and get wrapped in a Blob there
        var bytes = [0, 1, 2, 3]
        var endpoint = await add_main_handler(async (req, res, bytes) => {
            res.startSubscription()
            await res.sendUpdate({
                version: ['blob-patch-v1'],
                parents: ['blob-patch-v0'],
                patch: {unit: 'text', range: '[0:0]', content: new Blob([new Uint8Array(bytes)])}
            })
        }, bytes)

        // subscribe to the endpoint and grab the first update
        var a = new AbortController()
        var r = await fetch(endpoint, {subscribe: true, multiplex: false, signal: a.signal})
        var update = await new Promise(done => r.subscribe(done))

        // the version and parents should come through intact
        assert(update.version[0] === 'blob-patch-v1', 'got unexpected version')
        assert(update.parents[0] === 'blob-patch-v0', 'got unexpected parents')

        // the update should arrive as exactly one patch (not a body), with
        // the unit and range we sent
        assert(update.body === undefined, 'expected a patch update, not a body')
        assert(update.patches.length === 1, 'expected exactly one patch')
        assert(update.patches[0].unit === 'text', 'got unexpected patch unit')
        assert(update.patches[0].range === '[0:0]', 'got unexpected patch range')

        // the patch content should be exactly the blob's bytes, delivered as
        // a Uint8Array -- unmangled by any text decoding
        assert(update.patches[0].content instanceof Uint8Array, 'expected patch content to be a Uint8Array')
        assert('' + update.patches[0].content === '' + bytes, 'got unexpected patch content')

        a.abort()
    }
)

run_test(
    "Server can send binary patch as Buffer",
    async () => {
        // add a handler that sends one update whose patch content is a node
        // Buffer, and holds the subscription open. the Buffer has to be
        // constructed server-side (the handler runs there via eval, and args
        // are JSON-serialized, which would mangle a Buffer)
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patch: {unit: 'text', range: '[0:0]', content: Buffer.from([0, 1, 2, 3])}
            })
        })

        // subscribe to the endpoint over a plain (non-multiplexed) connection
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })

        // grab the first update off the subscription
        var update = await new Promise(done => r.subscribe(done))

        // the update's metadata should come through intact
        assert(JSON.stringify(update.version) === '["test"]', 'got unexpected version')
        assert(JSON.stringify(update.parents) === '["oldie"]', 'got unexpected parents')
        assert(update.status === '200', 'got unexpected status')

        // the single patch should arrive alone, with its unit and range intact
        assert(update.patches.length === 1, 'expected exactly one patch')
        assert(update.patches[0].unit === 'text', 'got unexpected patch unit')
        assert(update.patches[0].range === '[0:0]', 'got unexpected patch range')

        // and the Buffer's bytes should arrive as binary, byte for byte
        var content = update.patches[0].content
        assert(content instanceof Uint8Array, 'expected binary patch content')
        assert([...content].join() === '0,1,2,3', 'got unexpected patch bytes')

        a.abort()
    }
)

run_test(
    "Server can send multiple binary patches as ArrayBuffers",
    async () => {
        // add a handler that starts a subscription and sends one update
        // carrying two binary patches, each content an ArrayBuffer. the
        // buffers are constructed server-side, since handler args are
        // JSON-serialized and can't carry binary
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3]).buffer},
                    {unit: 'text', range: '[1:1]', content: new Uint8Array([10, 11, 12, 13]).buffer}
                ]
            })
        })

        // subscribe to the endpoint we added, and grab the first update
        var a = new AbortController()
        var r = await fetch(endpoint, {subscribe: true, multiplex: false, signal: a.signal})
        var update = await new Promise(done => r.subscribe(done))

        // the update's version and parents should come through intact
        assert(update.version[0] === 'test', 'got unexpected version')
        assert(update.parents[0] === 'oldie', 'got unexpected parents')

        // both patches should arrive as separate patches, in order, keeping
        // their units and ranges
        assert(update.patches.length === 2, 'expected two patches')
        assert(update.patches[0].unit === 'text' && update.patches[0].range === '[0:0]',
               'got unexpected unit or range on first patch')
        assert(update.patches[1].unit === 'text' && update.patches[1].range === '[1:1]',
               'got unexpected unit or range on second patch')

        // each patch's content should be its original bytes, as binary data
        assert(update.patches[0].content instanceof Uint8Array, 'expected binary content on first patch')
        assert(update.patches[1].content instanceof Uint8Array, 'expected binary content on second patch')
        assert('' + update.patches[0].content === '0,1,2,3', 'got unexpected bytes in first patch')
        assert('' + update.patches[1].content === '10,11,12,13', 'got unexpected bytes in second patch')

        a.abort()
    }
)

run_test(
    "Server can send multiple binary patches as Uint8Arrays",
    async () => {
        // the bytes we'll have the server send as two binary patches
        var bytes1 = [0, 1, 2, 3]
        var bytes2 = [10, 11, 12, 13]

        // add a handler that sends one update containing two binary patches
        // as Uint8Arrays, and holds the subscription open. the bytes are
        // passed as args (the handler runs server-side via eval, so it can't
        // close over test-side variables) and wrapped in Uint8Arrays there,
        // since JSON can't carry typed arrays directly
        var endpoint = await add_main_handler((req, res, bytes1, bytes2) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: new Uint8Array(bytes1)},
                    {unit: 'text', range: '[0:0]', content: new Uint8Array(bytes2)}
                ]
            })
        }, bytes1, bytes2)

        // subscribe to the endpoint we added, without multiplexing
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })

        // make sure the multiplex: false option was honored
        assert(!r.multiplexed_through, 'expected request not to be multiplexed')

        // grab the first update off the subscription
        var update = await new Promise((done, fail) => r.subscribe(done, fail))

        // make sure the update's version and parents came through
        assert(update.version[0] === 'test', 'got unexpected version')
        assert(update.parents[0] === 'oldie', 'got unexpected parents')

        // make sure both patches arrived in order as binary,
        // with their unit and range intact
        assert(update.patches.length === 2, 'expected two patches')
        for (var p of update.patches) {
            assert(p.unit === 'text', 'got unexpected patch unit')
            assert(p.range === '[0:0]', 'got unexpected patch range')
            assert(p.content instanceof Uint8Array, 'expected binary patch content')
        }
        assert('' + update.patches[0].content === '' + bytes1, 'got unexpected bytes in first patch')
        assert('' + update.patches[1].content === '' + bytes2, 'got unexpected bytes in second patch')

        a.abort()
    }
)

run_test(
    "Server can send multiple binary patches as Blobs",
    async () => {
        // add a handler that sends one update containing two binary patches
        // as Blobs, then holds the subscription open. the bytes are passed as
        // args (the handler runs server-side via eval, so it can't close over
        // test-side variables), and sendUpdate must be awaited because
        // reading a Blob's bytes is async
        var bytes1 = [0, 1, 2, 3]
        var bytes2 = [10, 11, 12, 13]
        var endpoint = await add_main_handler(async (req, res, bytes1, bytes2) => {
            res.startSubscription()
            await res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: new Blob([new Uint8Array(bytes1)])},
                    {unit: 'text', range: '[3:3]', content: new Blob([new Uint8Array(bytes2)])}
                ]
            })
        }, bytes1, bytes2)

        // subscribe to the endpoint we added
        var a = new AbortController()
        var r = await fetch(endpoint, {signal: a.signal, subscribe: true, multiplex: false})

        // grab the first update off the subscription
        var update = await new Promise(done => r.subscribe(done))

        // make sure the update's metadata came through
        assert(JSON.stringify(update.version) === JSON.stringify(['test']), 'got unexpected version')
        assert(JSON.stringify(update.parents) === JSON.stringify(['oldie']), 'got unexpected parents')

        // it should be a patch update, not a body snapshot
        assert(!update.body, 'expected no body')

        // both patches should arrive in order, each with its own unit/range
        // and its Blob content decoded back into the original bytes
        assert(update.patches.length === 2, 'expected two patches')
        assert(update.patches[0].unit === 'text', 'got unexpected first patch unit')
        assert(update.patches[0].range === '[0:0]', 'got unexpected first patch range')
        assert('' + update.patches[0].content === '' + new Uint8Array(bytes1), 'got unexpected first patch bytes')
        assert(update.patches[1].unit === 'text', 'got unexpected second patch unit')
        assert(update.patches[1].range === '[3:3]', 'got unexpected second patch range')
        assert('' + update.patches[1].content === '' + new Uint8Array(bytes2), 'got unexpected second patch bytes')

        a.abort()
    }
)

run_test(
    "Server can send multiple binary patches as Buffers",
    async () => {
        // add a handler that sends one update with two binary patches and
        // holds the subscription open. the patch bytes are passed as args
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables) and wrapped in node Buffers there, since
        // Buffers wouldn't survive the JSON serialization -- and sending
        // Buffers, specifically, is what this test is about
        var bytes = [[0, 1, 2, 3], [10, 11, 12, 13]]
        var endpoint = await add_main_handler((req, res, b1, b2) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: Buffer.from(b1)},
                    {unit: 'text', range: '[1:1]', content: Buffer.from(b2)}
                ]
            })
        }, bytes[0], bytes[1])

        // subscribe to the endpoint we added
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })

        // grab the first update off the subscription
        var update = await new Promise((done, fail) => r.subscribe(done, fail))

        // make sure the version and parents came through
        assert('' + update.version === 'test', 'got unexpected version')
        assert('' + update.parents === 'oldie', 'got unexpected parents')

        // make sure both patches arrived separately, in order, each with its
        // own unit, range, and bytes intact
        assert(update.patches.length === 2, 'expected two patches')
        assert(update.patches[0].unit === 'text', 'got unexpected unit on first patch')
        assert(update.patches[0].range === '[0:0]', 'got unexpected range on first patch')
        assert('' + new Uint8Array(update.patches[0].content) === '' + bytes[0], 'got unexpected bytes in first patch')
        assert(update.patches[1].unit === 'text', 'got unexpected unit on second patch')
        assert(update.patches[1].range === '[1:1]', 'got unexpected range on second patch')
        assert('' + new Uint8Array(update.patches[1].content) === '' + bytes[1], 'got unexpected bytes in second patch')

        a.abort()
    }
)

add_section_header("Client sending binary data")

run_test(
    "Client can PUT single binary patch as ArrayBuffer",
    async () => {
        // add a handler that parses the incoming update server-side and
        // echoes back everything it saw -- the wire headers plus the parsed
        // patch -- so we can check both the wire format and the parse result
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            var patch = update.patches[0]
            res.end(JSON.stringify({
                content_range: req.headers['content-range'],
                patches_header: req.headers.patches ?? null,
                num_patches: update.patches.length,
                unit: patch.unit,
                range: patch.range,
                is_binary: patch.content instanceof Uint8Array,
                bytes: Array.from(patch.content)
            }))
        })

        // PUT a single patch whose content is an ArrayBuffer of raw bytes.
        // the bytes are deliberately invalid utf-8, so they only arrive
        // intact if the client truly sends them as binary -- any text
        // round-trip would mangle them
        var bytes = [0xde, 0xad, 0xbe, 0xef]
        var r = await fetch(endpoint, {
            method: 'PUT',
            patches: {unit: 'text', range: '[0:0]', content: new Uint8Array(bytes).buffer}
        })
        assert(r.ok, 'expected ok response')
        var seen = JSON.parse(await r.text())

        // a single patch should go inline as the request body, described by
        // a content-range header, with no patches: N header
        assert(seen.content_range === 'text [0:0]', 'expected content-range: text [0:0]')
        assert(seen.patches_header === null, 'expected no patches header')

        // the server should parse exactly one binary patch out of it
        assert(seen.num_patches === 1, 'expected exactly one patch')
        assert(seen.unit === 'text', 'expected unit to survive the trip')
        assert(seen.range === '[0:0]', 'expected range to survive the trip')
        assert(seen.is_binary, 'expected patch content to be binary')

        // and the bytes should arrive exactly as sent
        assert('' + seen.bytes === '' + bytes, 'got unexpected patch bytes')
    }
)

run_test(
    "Client can PUT single binary patch as Uint8Array",
    async () => {
        // bytes that don't survive a utf-8 decode/encode round-trip -- if any
        // layer treats the patch content as text, they arrive mangled
        var bytes = [0, 255, 1, 254, 128, 3]

        // add a handler that parses the incoming update server-side, and
        // echoes back everything we want to verify about what it received
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            var patch = update.patches[0]
            res.end(JSON.stringify({
                content_range: req.headers['content-range'] ?? null,
                patches_header: req.headers.patches ?? null,
                body: update.body ?? null,
                num_patches: update.patches.length,
                unit: patch.unit,
                range: patch.range,
                is_binary: patch.content instanceof Uint8Array,
                bytes: Array.from(patch.content)
            }))
        })

        // PUT a single binary patch, passed as a bare (non-array) patch
        // object with Uint8Array content
        var r = await fetch(endpoint, {
            method: 'PUT',
            patches: {unit: 'text', range: '[0:0]', content: new Uint8Array(bytes)}
        })
        assert(r.ok, 'expected ok response')
        var got = JSON.parse(await r.text())

        // a single patch goes inline on the wire: its content is the request
        // body, described by a content-range header, with no patches: N block
        assert(got.content_range === 'text [0:0]', 'expected content-range: text [0:0] on the wire')
        assert(got.patches_header === null, 'expected no patches: N header for a single inline patch')

        // the server should parse it as exactly one patch, not a body
        assert(got.body === null, 'expected update to have patches, not a body')
        assert(got.num_patches === 1, 'expected exactly one patch')
        assert(got.unit === 'text' && got.range === '[0:0]', 'expected patch unit and range to survive the round-trip')

        // and the content should arrive as binary, byte-for-byte intact
        assert(got.is_binary, 'expected patch content to be binary')
        assert(JSON.stringify(got.bytes) === JSON.stringify(bytes), 'expected patch bytes to arrive unmangled')
    }
)

run_test(
    "Client can PUT multiple binary patches as ArrayBuffers",
    async () => {
        // add a handler that parses the incoming update with braidify and
        // echoes back everything we want to verify: the multi-patch wire
        // headers, and each parsed patch's unit, range, and raw bytes
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                patches_header: req.headers.patches,
                content_type: req.headers['content-type'],
                got_body: update.body !== undefined,
                patches: (update.patches ?? []).map(p => ({
                    unit: p.unit,
                    range: p.range,
                    is_binary: p.content instanceof Uint8Array,
                    bytes: Array.from(p.content)
                }))
            }))
        })

        // PUT two binary patches as ArrayBuffers, with distinct units and
        // ranges so we can tell the patches' headers apart on the server.
        // some bytes (0xff, 0xfe) are invalid utf-8, so they only survive
        // the round trip if the content really is treated as raw binary
        var bytes1 = [0, 1, 2, 255]
        var bytes2 = [10, 11, 254, 13]
        var r = await fetch(endpoint, {
            method: 'PUT',
            patches: [
                {unit: 'text', range: '[0:0]', content: new Uint8Array(bytes1).buffer},
                {unit: 'json', range: '[1:1]', content: new Uint8Array(bytes2).buffer}
            ]
        })
        assert(r.ok, 'expected ok response')
        var seen = JSON.parse(await r.text())

        // multiple patches must go over the wire as a Patches: N block
        // with the matching http-patches content-type
        assert(seen.patches_header === '2', 'expected a Patches: 2 header')
        assert(seen.content_type === 'application/http-patches; count=2', 'expected the http-patches content-type')

        // the server must parse the update as two patches, not as a body
        assert(!seen.got_body, 'expected patches rather than a body')
        assert(seen.patches.length === 2, 'expected exactly two patches')

        // each patch must arrive as binary, keeping its own unit, range,
        // and exact bytes
        assert(seen.patches[0].is_binary, 'expected first patch content to be binary')
        assert(seen.patches[1].is_binary, 'expected second patch content to be binary')
        assert(seen.patches[0].unit === 'text' && seen.patches[0].range === '[0:0]', 'expected first patch to keep its unit and range')
        assert(seen.patches[1].unit === 'json' && seen.patches[1].range === '[1:1]', 'expected second patch to keep its unit and range')
        assert('' + seen.patches[0].bytes === '' + bytes1, 'expected first patch bytes to survive')
        assert('' + seen.patches[1].bytes === '' + bytes2, 'expected second patch bytes to survive')
    }
)

run_test(
    "Client can PUT multiple binary patches as Uint8Arrays",
    async () => {
        // add a handler that parses the incoming PUT as an update and echoes
        // back what the server saw: the wire headers announcing the patch
        // block, and each parsed patch's unit, range, binary-ness, and bytes
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                patches_header: req.headers.patches,
                content_type: req.headers['content-type'],
                patches: update.patches.map(p => ({
                    unit: p.unit,
                    range: p.range,
                    is_binary: p.content instanceof Uint8Array,
                    bytes: Array.from(p.content)
                }))
            }))
        })

        // PUT two binary patches as Uint8Arrays, each with its own range.
        // the bytes include values above 127 that form no valid utf-8, so
        // any accidental text decode/re-encode on the way would mangle them
        var bytes1 = [0, 1, 128, 255]
        var bytes2 = [254, 128, 12, 13]
        var r = await fetch(endpoint, {
            method: 'PUT',
            patches: [
                {unit: 'text', range: '[0:0]', content: new Uint8Array(bytes1)},
                {unit: 'text', range: '[4:4]', content: new Uint8Array(bytes2)}
            ]
        })
        assert(r.ok, 'expected ok response')
        var seen = JSON.parse(await r.text())

        // make sure the client announced the patch block on the wire
        assert(seen.patches_header === '2', 'expected a Patches: 2 header')
        assert(seen.content_type === 'application/http-patches; count=2', 'got unexpected content-type')

        // make sure both patches arrived in order as binary, each keeping
        // its own unit, range, and exact bytes
        assert(seen.patches.length === 2, 'expected two patches')
        assert(seen.patches[0].unit === 'text', 'got unexpected first patch unit')
        assert(seen.patches[0].range === '[0:0]', 'got unexpected first patch range')
        assert(seen.patches[0].is_binary, 'expected first patch content to be binary')
        assert('' + seen.patches[0].bytes === '' + bytes1, 'got unexpected first patch bytes')
        assert(seen.patches[1].unit === 'text', 'got unexpected second patch unit')
        assert(seen.patches[1].range === '[4:4]', 'got unexpected second patch range')
        assert(seen.patches[1].is_binary, 'expected second patch content to be binary')
        assert('' + seen.patches[1].bytes === '' + bytes2, 'got unexpected second patch bytes')
    }
)

run_test(
    "Client can PUT multiple binary patches as Blobs",
    async () => {
        // add a handler that parses the incoming update and echoes back what
        // the server actually received: the Patches header the client sent,
        // and each parsed patch's unit, range, and raw bytes, plus whether
        // the bytes arrived as binary
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                patches_header: req.headers.patches,
                patches: update.patches.map(p => ({
                    unit: p.unit,
                    range: p.range,
                    binary: p.content instanceof Uint8Array,
                    bytes: [...p.content]
                }))
            }))
        })

        // PUT two binary patches as Blobs -- the client has to measure each
        // blob for its per-patch content-length header, and splice each
        // blob's raw bytes into the multi-patch body
        var bytes1 = [0, 1, 2, 3]
        var bytes2 = [10, 11, 12, 13]
        var r = await fetch(endpoint, {
            method: 'PUT',
            patches: [{unit: 'text', range: '[0:0]', content: new Blob([new Uint8Array(bytes1)])},
                      {unit: 'text', range: '[3:3]', content: new Blob([new Uint8Array(bytes2)])}]
        })

        // make sure the request succeeded, and went out as a Patches: 2
        // block that the server could parse back into both patches
        assert(r.ok, 'expected ok response')
        var got = JSON.parse(await r.text())
        assert(got.patches_header === '2', 'expected a Patches: 2 header')
        assert(got.patches.length === 2, 'expected the server to parse two patches')

        // make sure the first patch arrived as binary, with its own
        // unit/range and the original bytes
        assert(got.patches[0].binary, 'expected first patch content to be binary')
        assert(got.patches[0].unit === 'text', 'got unexpected first patch unit')
        assert(got.patches[0].range === '[0:0]', 'got unexpected first patch range')
        assert('' + got.patches[0].bytes === '' + bytes1, 'got unexpected first patch bytes')

        // make sure the second patch arrived as binary too, with its own
        // unit/range and bytes
        assert(got.patches[1].binary, 'expected second patch content to be binary')
        assert(got.patches[1].unit === 'text', 'got unexpected second patch unit')
        assert(got.patches[1].range === '[3:3]', 'got unexpected second patch range')
        assert('' + got.patches[1].bytes === '' + bytes2, 'got unexpected second patch bytes')
    }
)

run_test(
    "Client can PUT single patch with unicode text",
    async () => {
        // add a handler that parses the incoming update and reports back
        // everything the server saw: the wire headers that determine the
        // patch format, and the parsed patch itself (with its raw bytes)
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                content_range: req.headers['content-range'],
                patches_header: req.headers.patches ?? null,
                num_patches: update.patches.length,
                unit: update.patches[0].unit,
                range: update.patches[0].range,
                is_binary: update.patches[0].content instanceof Uint8Array,
                bytes: Array.from(update.patches[0].content),
                content_text: update.patches[0].content_text
            }))
        })

        // PUT a single patch whose content is unicode text
        var content = '🌈👽🎵'
        var r = await fetch(endpoint, {
            method: 'PUT',
            patches: [{unit: 'text', range: '[0:0]', content}]
        })
        assert(r.ok, 'expected ok response')
        var seen = JSON.parse(await r.text())

        // a lone patch should travel inline: its unit and range go in the
        // request's content-range header, with no patches: n block
        assert(seen.content_range === 'text [0:0]', 'expected patch unit and range in content-range header')
        assert(seen.patches_header === null, 'expected no patches header for a single patch')

        // the server should parse it back as exactly one patch
        assert(seen.num_patches === 1, 'expected exactly one patch')
        assert(seen.unit === 'text', 'got unexpected patch unit')
        assert(seen.range === '[0:0]', 'got unexpected patch range')

        // the content should arrive as raw utf-8 bytes -- all 12 of them,
        // since these three emoji are 4 bytes each
        assert(seen.is_binary, 'expected patch content to be binary server-side')
        assert('' + seen.bytes === '' + new TextEncoder().encode(content), 'got unexpected patch bytes')

        // and content_text should decode those bytes back to the original
        assert(seen.content_text === content, 'got unexpected patch text')
    }
)

run_test(
    "Client can PUT multiple patches with unicode texts",
    async () => {
        // add a handler that parses the incoming put as a braid update and
        // reports back what it saw: the patch-block headers on the wire, plus
        // each parsed patch's unit, range, byte count, binariness, and text
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                patches_header: req.headers.patches,
                content_type: req.headers['content-type'],
                patches: update.patches.map(p => ({
                    unit: p.unit,
                    range: p.range,
                    binary: p.content instanceof Uint8Array,
                    num_bytes: p.content.length,
                    text: p.content_text
                }))
            }))
        })

        // put two patches whose contents are multi-byte unicode strings --
        // their utf-8 byte counts (12 and 11) differ from their javascript
        // string lengths (6 and 9), so the client has to measure each
        // patch's content-length in bytes for the server to parse the block
        var r = await fetch(endpoint, {
            method: 'PUT',
            patches: [{unit: 'text', range: '[0:0]', content: '🌈👽🎵'},
                      {unit: 'text', range: '[3:5]', content: 'Hello 🌍!'}]
        })
        assert(r.ok, 'expected ok response')
        var seen = JSON.parse(await r.text())

        // make sure the client sent the patches as a Patches: 2 block
        assert(seen.patches_header === '2', 'expected a Patches: 2 header')
        assert(seen.content_type === 'application/http-patches; count=2', 'got unexpected content-type')

        // make sure both patches came through in order, with their own ranges
        assert(seen.patches.length === 2, 'expected two patches')
        assert(seen.patches[0].unit === 'text' && seen.patches[0].range === '[0:0]', 'got unexpected first patch unit or range')
        assert(seen.patches[1].unit === 'text' && seen.patches[1].range === '[3:5]', 'got unexpected second patch unit or range')

        // make sure the contents arrived as binary, sized in utf-8 bytes,
        // and decode back to the exact unicode texts
        assert(seen.patches[0].binary, 'expected first patch content to be binary')
        assert(seen.patches[1].binary, 'expected second patch content to be binary')
        assert(seen.patches[0].num_bytes === 12, 'expected first patch content to be 12 utf-8 bytes')
        assert(seen.patches[1].num_bytes === 11, 'expected second patch content to be 11 utf-8 bytes')
        assert(seen.patches[0].text === '🌈👽🎵', 'got unexpected first patch text')
        assert(seen.patches[1].text === 'Hello 🌍!', 'got unexpected second patch text')
    }
)

add_section_header("Make sure contents are binary, with property to access as text")

run_test(
    "Verify client-side patches are binary",
    async () => {
        // add a handler that starts a subscription and sends one update
        // carrying two patches with known string contents -- one ascii, one
        // unicode -- then holds the subscription open. the contents travel as
        // an arg (the handler runs server-side via eval, so it can't close
        // over test-side variables)
        var contents = ['{"a":5}', 'hello 🌍']
        var endpoint = await add_main_handler((req, res, contents) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['patch-v1'],
                patches: contents.map(content =>
                    ({unit: 'json', range: '[1]', content}))
            })
        }, contents)

        // subscribe to the endpoint we added, without multiplexing,
        // so we exercise the plain subscription path
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })

        // make sure the server actually accepted the subscription
        assert(r.status === 209, 'expected 209 subscription response')

        // grab the first update off the subscription
        var update = await new Promise(done => r.subscribe(done))

        // the update should carry both patches we sent
        assert(update.version[0] === 'patch-v1', 'got unexpected version')
        assert(update.patches.length === 2, 'expected two patches')

        // each patch's content should arrive as binary -- a Uint8Array
        // holding exactly the utf-8 bytes of the string the server sent,
        // unmangled by any text decoding along the way
        for (var i = 0; i < contents.length; i++) {
            assert(update.patches[i].content instanceof Uint8Array,
                `expected patch ${i} content to be a Uint8Array`)
            assert('' + update.patches[i].content === '' + new TextEncoder().encode(contents[i]),
                `got unexpected bytes in patch ${i} content`)
        }

        a.abort()
    }
)

run_test(
    "Verify client-side patches have content_text",
    async () => {
        // add a handler that sends one update with two patches -- one ascii,
        // one multibyte unicode -- and holds the subscription open. the
        // update is passed as an arg (the handler runs server-side via eval,
        // so it can't close over test-side variables)
        var update = {
            version: ['content-text-test'],
            patches: [{unit: 'json', range: '[1]', content: '1'},
                      {unit: 'json', range: '[2]', content: '"🌈 hello"'}]
        }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // subscribe to it. multiplex: false keeps this a direct subscription,
        // independent of the global enable_multiplex knob
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })

        // grab the first update off the subscription
        var got = await new Promise(done => r.subscribe(done))

        // make sure it's the update our handler sent
        assert(got.version[0] === 'content-text-test', 'got unexpected version')
        assert(got.patches?.length === 2, 'expected two patches')

        // each patch's content arrives as binary, and exposes a content_text
        // property holding its utf-8 decoding -- the unicode patch makes sure
        // content_text really decodes utf-8, not just ascii bytes
        for (var i = 0; i < 2; i++) {
            assert(got.patches[i].content instanceof Uint8Array, 'expected binary patch content')
            assert(got.patches[i].content_text === update.patches[i].content,
                `expected content_text: ${update.patches[i].content}, got: ${got.patches[i].content_text}`)
        }

        a.abort()
    }
)

run_test(
    "Verify that content_text can be accessed after overriding content",
    async () => {
        // add a handler that sends one update with two patches and holds the
        // subscription open. the patch texts are passed as args (the handler
        // runs server-side via eval, so it can't close over test-side
        // variables)
        var text1 = 'hello 🌍'
        var text2 = 'goodbye 🌙'
        var endpoint = await add_main_handler((req, res, text1, text2) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['test'],
                patches: [{ unit: 'json', range: '[1]', content: text1 },
                          { unit: 'json', range: '[2]', content: text2 }]
            })
        }, text1, text2)

        // subscribe and grab the first update
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })
        var update = await new Promise(done => r.subscribe(done))

        // patches arrive with binary content, which the content_text getter
        // decodes on demand
        var patch = update.patches[0]
        assert(patch.content instanceof Uint8Array, 'expected binary patch content')
        assert(patch.content_text === text1, `got unexpected content_text: ${patch.content_text}`)

        // override content with the decoded text, the way a consumer converts
        // a patch to text in place
        patch.content = patch.content_text
        assert(patch.content === text1, 'expected content to take the override')

        // content_text must survive the override: it returns the cached
        // decode instead of choking on the no-longer-binary content
        assert(patch.content_text === text1,
               `expected content_text to survive the override, got: ${patch.content_text}`)

        // the second patch's content_text, read for the first time after the
        // override, decodes its own content independently
        assert(update.patches[1].content_text === text2,
               `got unexpected content_text on the second patch: ${update.patches[1].content_text}`)

        a.abort()
    }
)

run_test(
    "Verify server-side bodies are binary",
    async () => {
        // add a handler that parses the incoming update server-side and
        // reports back what parseUpdate produced for the body: the name of
        // its constructor, and the exact bytes it holds
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                type: update.body.constructor.name,
                bytes: Array.from(update.body)
            }))
        })

        // PUT a string body, and make sure the server sees a plain
        // Uint8Array of its utf-8 bytes, rather than a string
        var body = '{"a":5}'
        var r = await fetch(endpoint, {method: 'PUT', body})
        var seen = JSON.parse(await r.text())
        assert(seen.type === 'Uint8Array', 'expected the string body to arrive as a Uint8Array')
        assert(seen.bytes.join() === new TextEncoder().encode(body).join(),
               'expected the utf-8 bytes of the string body')

        // PUT raw bytes that aren't valid utf-8 -- decoding them to a string
        // anywhere along the way would corrupt them -- and make sure they
        // arrive server-side byte-for-byte
        var bytes = [0, 150, 255, 254, 200]
        r = await fetch(endpoint, {method: 'PUT', body: new Uint8Array(bytes)})
        seen = JSON.parse(await r.text())
        assert(seen.type === 'Uint8Array', 'expected the binary body to arrive as a Uint8Array')
        assert(seen.bytes.join() === bytes.join(), 'expected the raw bytes to survive untouched')
    }
)

run_test(
    "Verify server-side bodies have body_text",
    async () => {
        // add a handler that parses the incoming update with braidify and
        // echoes back everything we want to verify about its body_text
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                got_patches: update.patches !== undefined,
                body_is_binary: update.body instanceof Uint8Array,
                body_text_is_string: typeof update.body_text === 'string',
                body_text: update.body_text
            }))
        })

        // PUT a body containing multi-byte unicode characters -- they only
        // survive the round trip if body_text really decodes the binary body
        // as utf-8
        var body = '{"a":5,"emoji":"🌈👽🎵"}'
        var r = await fetch(endpoint, {method: 'PUT', body})
        assert(r.ok, 'expected ok response')
        var seen = JSON.parse(await r.text())

        // the server must parse the update as a body, not as patches
        assert(!seen.got_patches, 'expected a body rather than patches')

        // the body itself must stay binary, with body_text as a string view
        // over it that matches exactly what we sent
        assert(seen.body_is_binary, 'expected the body to be binary')
        assert(seen.body_text_is_string, 'expected body_text to be a string')
        assert(seen.body_text === body, 'expected body_text to match the body we sent')
    }
)

run_test(
    "Verify server-side patches are binary",
    async () => {
        // a body with a multi-byte character: its utf-8 encoding has more
        // bytes than the string has characters, so the byte comparison below
        // only passes if the server hands the handler raw bytes rather than
        // a decoded string
        var body = '{"a":"café"}'

        // add a handler that parses the incoming update server-side, and
        // echoes back everything we want to verify about the parsed patch
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            var patch = update.patches[0]
            res.end(JSON.stringify({
                body: update.body ?? null,
                num_patches: update.patches.length,
                unit: patch.unit,
                range: patch.range,
                is_binary: patch.content instanceof Uint8Array,
                bytes: Array.from(patch.content)
            }))
        })

        // PUT a plain string body described by a content-range header -- the
        // wire form of a single inline patch, with no patches: N block. the
        // content leaves here as text, but the server should still represent
        // it as binary
        var r = await fetch(endpoint, {
            method: 'PUT',
            headers: {'content-range': 'text [0:0]'},
            body
        })
        assert(r.ok, 'expected ok response')
        var got = JSON.parse(await r.text())

        // the server should parse the update as exactly one patch, not a body
        assert(got.body === null, 'expected update to have patches, not a body')
        assert(got.num_patches === 1, 'expected exactly one patch')

        // with the patch's unit and range taken from the content-range header
        assert(got.unit === 'text' && got.range === '[0:0]', 'expected unit and range from the content-range header')

        // and the patch's content should be binary: a Uint8Array holding
        // exactly the body's utf-8 bytes
        assert(got.is_binary, 'expected patch content to be a Uint8Array')
        assert('' + got.bytes === '' + Array.from(new TextEncoder().encode(body)), 'expected patch bytes to match the body we sent')
    }
)

run_test(
    "Verify server-side patches have content_text",
    async () => {
        // add a handler that parses the incoming put as a braid update and
        // reports what the parse produced. content_text is a lazy
        // non-enumerable getter, so we read the fields out explicitly
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                has_body: update.body !== undefined,
                patches: update.patches.map(p => ({
                    unit: p.unit,
                    range: p.range,
                    content_is_binary: p.content instanceof Uint8Array,
                    content_text_type: typeof p.content_text,
                    content_text: p.content_text
                }))
            }))
        })

        // put a raw body with a content-range header but no patches header --
        // the server should parse it as a single patch. use multi-byte
        // unicode so the utf-8 decode behind content_text is actually
        // exercised (ascii looks the same in any encoding)
        var body = '{"a":"🌈🍕"}'
        var r = await fetch(endpoint, {
            method: 'PUT',
            headers: {'content-range': 'text [0:0]'},
            body
        })
        assert(r.status === 200, 'expected 200 response')
        var seen = JSON.parse(await r.text())

        // the update should be a single patch, not a body snapshot
        assert(!seen.has_body, 'expected parsed update to have no body')
        assert(seen.patches.length === 1, 'expected exactly one parsed patch')

        // the content-range header should have become the patch's unit and range
        assert(seen.patches[0].unit === 'text', 'expected unit to come from content-range')
        assert(seen.patches[0].range === '[0:0]', 'expected range to come from content-range')

        // the patch content stays binary, and content_text exposes it as a
        // utf-8 decoded string matching what we sent
        assert(seen.patches[0].content_is_binary, 'expected patch content to be binary')
        assert(seen.patches[0].content_text_type === 'string', 'expected content_text to be a string')
        assert(seen.patches[0].content_text === body, 'expected content_text to be the utf-8 decoded patch content')
    }
)

run_test(
    "Verify server-side 'everything' patches are binary",
    async () => {
        // add a handler that reads the incoming put with the legacy
        // req.patches() api and reports back what it saw: how many patches,
        // and the first patch's unit, range, binariness, and raw bytes
        var endpoint = await add_main_handler(async (req, res) => {
            var patches = await req.patches()
            res.end(JSON.stringify({
                num_patches: patches.length,
                unit: patches[0].unit,
                range: patches[0].range,
                is_binary: patches[0].content instanceof Uint8Array,
                bytes: Array.from(patches[0].content)
            }))
        })

        // put a plain body -- no patch headers -- whose multi-byte unicode
        // makes its utf-8 byte count (12) differ from its js string length (10)
        var body = '{"a":"🍕"}'
        var r = await fetch(endpoint, {method: 'PUT', body})
        assert(r.ok, 'expected ok response')
        var seen = JSON.parse(await r.text())

        // req.patches() should wrap the whole body in a single synthetic
        // patch that spans "everything"
        assert(seen.num_patches === 1, 'expected exactly one patch')
        assert(seen.unit === 'everything', 'expected an everything patch')
        assert(seen.range === '', 'expected an empty range')

        // the patch content should arrive as binary: a Uint8Array holding
        // exactly the body's utf-8 bytes
        assert(seen.is_binary, 'expected patch content to be binary')
        assert('' + seen.bytes === '' + new TextEncoder().encode(body), 'got unexpected patch bytes')
    }
)

run_test(
    "Verify server-side 'everything' patches have content_text",
    async () => {
        // add a handler that parses the incoming PUT with the legacy
        // req.patches() api and echoes back what it parsed. content_text is a
        // lazy, non-enumerable getter, so we have to read it out explicitly
        var endpoint = await add_main_handler(async (req, res) => {
            var patches = await req.patches()
            res.end(JSON.stringify({
                count: patches.length,
                unit: patches[0].unit,
                range: patches[0].range,
                binary: patches[0].content instanceof Uint8Array,
                content_text: patches[0].content_text
            }))
        })

        // PUT a plain body -- no content-range or patches headers -- so the
        // server sees it as a single "everything" patch. include a multi-byte
        // character to prove content_text really utf-8-decodes the binary
        // content, rather than mapping bytes to chars
        var body = '{"a":5,"b":"🌍"}'
        var r = await fetch(endpoint, {method: 'PUT', body})
        var got = JSON.parse(await r.text())

        // the whole body arrived as one "everything" patch...
        assert(got.count === 1, 'expected exactly one patch')
        assert(got.unit === 'everything', `expected an 'everything' patch`)
        assert(got.range === '', 'expected an empty range')

        // ...whose content_text decodes its binary content back to the body
        assert(got.binary, 'expected patch content to be binary')
        assert(got.content_text === body, 'expected content_text to match the body we put')
    }
)

run_test(
    "Verify that body_text can be accessed after overriding body",
    async () => {
        // add a handler that sends two updates with bodies
        // and holds the subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ version: ['test1'], body: '{"a":5}' })
            res.sendUpdate({ version: ['test2'], body: 'howdy' })
        })

        // subscribe to the endpoint and collect both updates
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })
        var updates = []
        await new Promise(done =>
            r.subscribe(update => {
                updates.push(update)
                if (updates.length === 2) done()
            }))

        // the bodies arrive as raw bytes
        assert(updates.every(u => u.body instanceof Uint8Array),
            'expected binary bodies')

        // override the first update's body with a parsed value -- the way
        // consumers (like the client's own mime-type handling) do -- before
        // ever touching body_text; accessing body_text must not throw, even
        // read twice (the second read exercises its internal cache)
        updates[0].body = JSON.parse(new TextDecoder().decode(updates[0].body))
        try {
            updates[0].body_text
            updates[0].body_text
        } catch (e) {
            assert(false, 'expected body_text to be accessible after overriding body, but got: ' + e)
        }

        // override the second update's body with new bytes before reading
        // body_text: the getter is lazy, so it should decode the overridden
        // body rather than the original
        updates[1].body = new TextEncoder().encode('partner')
        assert(updates[1].body_text === 'partner',
            'expected body_text to reflect the overridden body')

        // body_text caches its first read: overriding body yet again
        // must neither change it nor make it throw
        updates[1].body = new TextEncoder().encode('changed')
        assert(updates[1].body_text === 'partner',
            'expected body_text to be stable once read')

        a.abort()
    }
)

run_test(
    "Handle client-side undefined body_text without exceptions",
    async () => {
        // add a handler that sends a single patch-only update -- no body --
        // and holds the subscription open. the update is passed as an arg
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables)
        var update = { version: ['patchy'], patch: { unit: 'json', range: '[1]', content: '1' } }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // subscribe to the endpoint and grab that first update
        var a = new AbortController()
        var r = await fetch(endpoint, { signal: a.signal, subscribe: true, multiplex: false })
        var got = await new Promise(done => r.subscribe(done))

        // make sure we really got the body-less update: our patch arrived,
        // and no body property came with it
        assert(got.version[0] === 'patchy', 'expected our patch-only update')
        assert(got.patches.length === 1 && got.patches[0].content_text === '1', 'expected the patch to arrive')
        assert(!('body' in got), 'expected the update to have no body')

        // accessing body_text on a body-less update must not throw...
        var text
        try {
            text = got.body_text
        } catch (e) {
            assert(false, `expected accessing body_text not to throw, got: ${e}`)
        }

        // ...it should just be undefined, and stay undefined when read again
        // (the getter caches its first result)
        assert(text === undefined, 'expected body_text to be undefined')
        assert(got.body_text === undefined, 'expected body_text to stay undefined on re-access')

        a.abort()
    }
)

add_section_header("Misc")

run_test(
    "Test that startSubscription can detect closure.",
    async () => {
        // add a handler that starts a subscription with an onClose callback
        // counting its calls in a global keyed by a random id (the handler
        // runs server-side via eval, so it can't close over test-side
        // variables). the sendUpdate flushes the headers to the client
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            res.startSubscription({
                onClose: () => global['_closes_' + s] = (global['_closes_' + s] ?? 0) + 1
            })
            res.sendUpdate({ body: 'hi' })
        }, s)

        // open a plain connection to the endpoint (og_fetch, so nothing --
        // like a multiplexer -- gets between us and the connection we're
        // about to sever), and make sure the subscription really started
        var a = new AbortController()
        var r = await og_fetch(endpoint, { signal: a.signal })
        assert(r.status === 209, 'expected 209 multiresponse status')

        // wait for the first update to arrive, so we know the subscription
        // is fully established before we sever the connection...
        assert((await r.body.getReader().read()).value, 'expected first update')

        // ...and make sure onClose hasn't fired while the connection is open
        var closes = () => server_eval((req, res, s) =>
            res.end('' + (global['_closes_' + s] ?? 0)), s)
        assert(await closes() === '0', 'expected no closure before the abort')

        // sever the connection, and wait for the server to notice -- if it
        // never does, this loop spins until the test runner's timeout fails
        // the test
        a.abort()
        while (await closes() === '0')
            await new Promise(done => setTimeout(done, 10))

        // the server watches multiple events (close, finish, abort) for
        // closure, but onClose should still fire exactly once
        assert(await closes() === '1', 'expected onClose to fire exactly once')
    }
)

run_test(
    "Test set_fetch",
    async () => {
        // add a simple endpoint to fetch through a replacement transport
        var endpoint = await add_main_handler((req, res) => res.end('hello'))

        // use set_fetch to swap braid_fetch's underlying transport for a
        // replacement that records whether it saw our request -- identified
        // by a random marker in the url, so that (in the parallel browser
        // runner) a concurrent test's traffic can't trip the flag for us --
        // before delegating to the real transport
        var c = Math.random().toString(36).slice(2)
        var client_saw_it = false
        fetch.set_fetch((...args) => {
            if (('' + args[0]).includes(c)) client_saw_it = true
            return og_fetch(...args)
        })

        // fetch the endpoint, tagged with the marker, and make sure the
        // request really went through the replacement and that the
        // replacement still carried it to the server and back
        var r = await fetch(`${endpoint}?${c}`)
        var body = await r.text()
        assert(client_saw_it, 'expected braid_fetch to use the fetch given to set_fetch')
        assert(body === 'hello', 'expected the replacement fetch to still deliver the response')

        // put the original transport back before touching the server, since
        // in the console runner the client and server share one braid_fetch
        // module. braid_fetch's original transport is the environment's
        // global fetch: in the browser that's og_fetch (window.fetch, saved
        // before it was replaced with braid_fetch), but in the console
        // runner og_fetch is the harness's http2 wrapper, and the original
        // is node's global fetch
        fetch.set_fetch(typeof window === 'undefined' ? globalThis.fetch : og_fetch)

        // now do the same to the server's braid_fetch: swap in a
        // marker-watching replacement, make a server-side braid_fetch tagged
        // with the marker, and restore the server's original transport (the
        // endpoint's path and marker are passed as args, since this function
        // is eval'd in the server's scope)
        var s = Math.random().toString(36).slice(2)
        var pathname = new URL(endpoint, 'https://x').pathname
        var got = await server_eval(async (req, res, pathname, s) => {
            if (typeof fetch === 'undefined') return res.end('old node version')

            var saw_it = false
            braid_fetch.set_fetch((...args) => {
                if (('' + args[0]).includes(s)) saw_it = true
                return fetch(...args)
            })
            var r = await braid_fetch(`https://localhost:${port}${pathname}?${s}`)
            var body = await r.text()
            braid_fetch.set_fetch(fetch)
            res.end(JSON.stringify({ saw_it, body }))
        }, pathname, s)

        // old node has no global fetch server-side, so braid_fetch has no
        // transport to replace there; nothing to assert in that case
        if (got === 'old node version') return
        assert(got === JSON.stringify({ saw_it: true, body: 'hello' }),
               'expected the server-side braid_fetch to use the fetch given to set_fetch')
    }
)

run_test(
    "Test version header is parsing prints error on corrupt version",
    async () => {
        // add a handler that responds with a corrupt version header: legal
        // values are json-encoded strings, so a bare unquoted token can't
        // parse. a random id keys the value so we can spot the client's
        // error message about it below
        var v = 'corrupt-' + Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, v) => {
            res.setHeader('version', v)
            res.end('ok')
        }, v)

        // fetch it, capturing console.log for the duration -- that's where
        // the client reports version parse failures -- while passing
        // everything through to the real console.log
        var logged = []
        var og_log = console.log
        console.log = (...args) => { logged.push(args.join(' ')); og_log(...args) }
        try {
            var r = await fetch(endpoint)
        } finally {
            console.log = og_log
        }

        // the fetch itself should still succeed, corrupt header and all
        assert(r.ok, 'expected ok response')
        assert(await r.text() === 'ok', 'got unexpected body')

        // make sure the corrupt header really reached the client -- so the
        // parser genuinely ran and failed -- but never became res.version
        assert(r.headers.get('version') === v, 'expected the corrupt version header on the response')
        assert(r.version === undefined, 'expected res.version to remain undefined')

        // and make sure the client printed an error about it
        assert(logged.includes(`error parsing version: ${v}`),
               'expected an error printed for the corrupt version')
    }
)

run_test(
    "Test version header is parsed into res.version",
    async () => {
        // pick a random version string, so a passing assertion below proves
        // the value really round-tripped through this endpoint's header
        var v = Math.random().toString(36).slice(2)

        // add a handler that answers a plain 200 with a version response
        // header (a JSON-encoded string, per the braid spec). the version is
        // passed as an arg because the handler runs server-side via eval and
        // can't close over test-side variables
        var endpoint = await add_main_handler((req, res, v) => {
            res.setHeader('version', JSON.stringify(v))
            res.end('ok')
        }, v)

        // fetch it with braid_fetch, the system under test
        var r = await fetch(endpoint)

        // the client should have parsed the header into an array of version
        // strings on res.version
        assert(Array.isArray(r.version), 'expected res.version to be an array')
        assert(r.version.length === 1, 'expected exactly one version')
        assert(r.version[0] === v, 'expected res.version to hold our version string')

        // and the response should otherwise read back normally
        assert(await r.text() === 'ok', 'got unexpected body')
    }
)

run_test(
    "Test current-version header is parsed into res.version",
    async () => {
        // add a handler that responds with a current-version header -- and no
        // version header, so the client's fallback to current-version is what
        // gets exercised. the version is passed as an arg (the handler runs
        // server-side via eval, so it can't close over test-side variables)
        var v = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, v) => {
            res.setHeader('current-version', JSON.stringify(v))
            res.end('ok')
        }, v)

        // fetch the endpoint with braid_fetch, the system under test
        var r = await fetch(endpoint)

        // make sure the header really crossed the wire, and that no version
        // header snuck in -- otherwise this test could pass without ever
        // exercising the current-version fallback
        assert(r.headers.get('current-version') === JSON.stringify(v), 'expected current-version header on the response')
        assert(r.headers.get('version') === null, 'expected no version header on the response')

        // make sure the client parsed the header into res.version
        assert(JSON.stringify(r.version) === JSON.stringify([v]), 'expected res.version to be parsed from current-version')

        // make sure the body still comes through as normal
        assert(await r.text() === 'ok', 'got unexpected body')
    }
)

run_test(
    "Test version header with multiple versions",
    async () => {
        // two random version ids, so we're not matching on magic names
        var v1 = Math.random().toString(36).slice(2)
        var v2 = Math.random().toString(36).slice(2)

        // add a handler that answers with a version header listing both
        // versions (passed as args, since the handler runs server-side and
        // can't close over test-side variables)
        var endpoint = await add_main_handler((req, res, v1, v2) => {
            res.setHeader('version', `"${v1}", "${v2}"`)
            res.end('ok')
        }, v1, v2)

        // fetch it with braid_fetch, the system under test
        var r = await fetch(endpoint)
        assert(r.ok, 'expected ok response')

        // make sure the raw header really arrived with both versions, so the
        // parsing assertions below can't pass vacuously
        assert(r.headers.get('version') === `"${v1}", "${v2}"`,
               'expected the raw version header to arrive intact')

        // the client should parse the header into an array of both version
        // ids, in order
        assert(Array.isArray(r.version), 'expected res.version to be an array')
        assert(r.version.length === 2, 'expected exactly two versions')
        assert(r.version[0] === v1, 'expected the first version parsed in order')
        assert(r.version[1] === v2, 'expected the second version parsed in order')

        // and the body should still come through untouched
        assert(await r.text() === 'ok', 'expected the body to come through')
    }
)

run_test(
    "Test res.version is undefined when no version header",
    async () => {
        // add a handler that responds without setting any version header
        var endpoint = await add_main_handler((req, res) => res.end('ok'))

        // fetch it with braid_fetch, the client under test
        var r = await fetch(endpoint)

        // make sure the response really came from our handler, and that no
        // version or current-version header was on the wire -- otherwise this
        // test could pass for the wrong reason, since a corrupt version
        // header also leaves res.version undefined
        assert(r.ok, 'expected ok response')
        assert(await r.text() === 'ok', 'got unexpected body')
        assert(!r.headers.get('version') && !r.headers.get('current-version'),
               'expected no version headers on the wire')

        // with no version header, the client should leave res.version unset
        assert(r.version === undefined, 'expected res.version to be undefined')
    }
)

run_test(
    "Test calling subscribe on a non-subscription.",
    async () => {
        // add a handler that sends a plain 200 response, not a subscription
        var endpoint = await add_main_handler((req, res) => {
            res.end('ok')
        })

        // fetch it without subscribing, so we get an ordinary response back
        var r = await fetch(endpoint)
        assert(r.status === 200, 'expected a plain 200 response')

        // calling subscribe on it should throw right away,
        // without ever firing either callback
        var cb_fired = false
        try {
            r.subscribe(() => cb_fired = true, () => cb_fired = true)
        } catch (e) {
            // the client should complain about the status code, and classify
            // the error as a protocol violation
            assert('' + e === 'ProtocolError: Got unexpected subscription status code: 200. Expected 209.',
                'expected the unexpected-status-code error')
            assert(e.type === 'protocol', `expected error type 'protocol', got '${e.type}'`)
            assert(!cb_fired, 'expected neither subscribe callback to fire')

            // subscribe should have bailed before touching the body, so the
            // response should still read fine as a normal response
            assert(await r.text() === 'ok', 'expected body to still be readable')
            return
        }
        assert(false, 'expected subscribe to throw')
    }
)

run_test(
    "Verify error in cb stops retry",
    async () => {
        // add a handler that sends one update and holds the subscription
        // open. it counts connections, and records when the client hangs up,
        // in globals keyed by a random id (the handler runs server-side via
        // eval, so it can't close over test-side variables -- the id and
        // update come in as args, and server_eval reads the globals back)
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['v' + s], body: JSON.stringify({ id: s }) }
        var endpoint = await add_main_handler((req, res, s, update) => {
            global['_conns_' + s] = (global['_conns_' + s] ?? 0) + 1
            res.on('close', () => global['_hangup_' + s] = true)
            res.startSubscription()
            res.sendUpdate(update)
        }, s, update)

        // subscribe with retry on, and throw a distinctive error from the
        // update callback. an error there is the app's own bug -- retrying
        // would just re-trigger it -- so instead of reconnecting, the client
        // should give up and hand the error to the error callback
        var my_error = new Error('My Error')
        var got_update = null
        var r = await fetch(endpoint, { subscribe: true, multiplex: false, retry: true })
        var e = await new Promise(done => r.subscribe(
            update => { got_update = update; throw my_error },
            done
        ))

        // make sure the callback really ran on our update before throwing,
        // and that our error came through verbatim, tagged as an app error
        // (that tag is what tells the retry machinery not to reconnect)
        assert(got_update?.version[0] === 'v' + s, 'expected the update we sent')
        assert(e === my_error, 'expected the error callback to get our thrown error')
        assert(e.type === 'app', `expected an app error, got type: ${e.type}`)

        // giving up should also tear down the connection -- wait for the
        // server to see the hangup (if it never comes, this loop spins until
        // the test runner's timeout fails the test)
        while (await server_eval((req, res, s) =>
            res.end('' + !!global['_hangup_' + s]), s) !== 'true')
            await new Promise(done => setTimeout(done, 10))

        // a buggy retry would reconnect after the retry delay (1 second for
        // a first retry) -- wait out that window, then make sure the endpoint
        // still saw exactly the one connection
        await new Promise(done => setTimeout(done, 1500))
        var conns = await server_eval((req, res, s) =>
            res.end('' + (global['_conns_' + s] ?? 0)), s)
        assert(conns === '1', `expected no reconnect, but saw ${conns} connections`)
    }
)

run_test(
    "Verify heartbeat error in cb doesn't stop retry",
    async () => {
        // add a handler that promises heartbeats but never sends any: it
        // echoes the Heartbeats header (so the client arms its miss timer),
        // then deletes the request header before startSubscription, which
        // keeps braidify's heartbeat loop from ever starting. it also counts
        // connections in a global keyed by a random id (the handler runs
        // server-side via eval, so it can't close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update, s) => {
            global['_connects_' + s] = (global['_connects_' + s] ?? 0) + 1
            res.setHeader('Heartbeats', req.headers.heartbeats)
            delete req.headers.heartbeats
            res.startSubscription()
            res.sendUpdate(update)
        }, update, s)

        // subscribe with retry on, and watch for the reconnection: onRes
        // fires once per established connection, so a second call means the
        // client retried. we also note how many updates had arrived by then
        var a = new AbortController()
        var connects = 0
        var updates_at_retry = null
        var on_retry = null
        var retried = new Promise(done => on_retry = done)
        var updates = []
        var errors = []
        var r = await fetch(endpoint, {
            subscribe: true,
            multiplex: false,
            heartbeats: 0.5,
            signal: a.signal,
            retry: {
                onRes: () => {
                    connects++
                    if (connects === 2) {
                        updates_at_retry = updates.length
                        on_retry()
                    }
                }
            }
        })

        // read the subscription with an update callback that stalls until
        // the retry has happened, so the heartbeat error fires *while the
        // callback is still pending*. an error thrown *by* the callback
        // stops retry (see the test above) -- a heartbeat error that merely
        // interrupts a pending callback must not
        r.subscribe(async u => {
            updates.push(u)
            await retried
        }, e => errors.push(e))

        // wait for the missed heartbeats to trigger a reconnection
        await retried

        // the first update arrived before the retry, so the callback really
        // was pending (stalled on `retried`) when the heartbeat error fired
        assert(updates_at_retry === 1, 'expected the first update to arrive before the retry')
        assert(updates[0].version[0] === 'test', 'got unexpected version')
        assert(updates[0].parents[0] === 'oldie', 'got unexpected parents')
        assert(updates[0].body_text === JSON.stringify({this: 'stuff'}), 'got unexpected body')

        // the heartbeat error was retried, not surfaced to the error cb
        assert(errors.length === 0, 'expected no subscription error')

        // and the server really saw two connections: the original, plus the
        // reconnection after the heartbeat error
        var connect_count = await server_eval((req, res, s) =>
            res.end('' + global['_connects_' + s]), s)
        assert(connect_count === '2', 'expected exactly two connections to the server')

        a.abort()
    }
)

run_test(
    "Verify error in async cb stops retry",
    async () => {
        // add a handler that counts connects in a keyed global (so we can
        // spot a retry reconnecting), notes when its stream closes, then
        // sends one update and holds the subscription open
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_connects_' + s] = (global['_connects_' + s] ?? 0) + 1
            req.on('close', () => global['_closed_' + s] = true)
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        }, s)

        // subscribe with retry on, using an ASYNC callback that rejects --
        // the client awaits the callback, so the rejection should surface
        // through the error callback instead of triggering a reconnect
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false,
            retry: true
        })

        // wait for the error callback to fire, capturing the update our
        // callback saw, so we can be sure the error really came from it
        var got_update = null
        var e = await new Promise(done =>
            r.subscribe(
                async update => {
                    got_update = update
                    throw Error('My Error')
                },
                done
            ))

        // the rejection should arrive verbatim in the error callback...
        assert('' + e === 'Error: My Error', 'expected our error in the error callback')

        // ...provoked by the update we sent
        assert(got_update?.body_text === 'hi', 'expected the throw to come from our update')

        // the client should tear the fetch down, closing our stream
        // server-side -- if it never does, this loop spins until the test
        // runner's timeout fails the test
        while (await server_eval((req, res, s) =>
            res.end('' + !!global['_closed_' + s]), s) !== 'true')
            await new Promise(done => setTimeout(done, 10))

        // now wait out the first retry window (the client waits 1s before
        // its first reconnect), and make sure it never reconnected: the
        // server should have seen exactly one connect
        await new Promise(done => setTimeout(done, 1500))
        var connects = await server_eval((req, res, s) =>
            res.end('' + global['_connects_' + s]), s)
        assert(connects === '1', `expected no reconnect, got ${connects} connects`)

        a.abort()
    }
)

run_test(
    "Verify that client sends the peer param as a header, and server sets req.peer",
    async () => {
        // add a handler that echoes back the raw peer header it saw on the
        // wire, along with the req.peer that braidify derived from it
        // (JSON.stringify drops undefined values, so map those to null)
        var endpoint = await add_main_handler((req, res) => {
            res.end(JSON.stringify({ header: req.headers.peer ?? null, peer: req.peer ?? null }))
        })

        // fetch with a random peer id, so nothing else can collide with it
        var p = Math.random().toString(36).slice(2)
        var echoed = await (await fetch(endpoint, { peer: p })).json()

        // make sure the client really sent our peer as the peer header,
        // and that braidify surfaced that header as req.peer
        assert(echoed.header === p, 'expected the peer param to be sent as the peer header')
        assert(echoed.peer === p, 'expected req.peer to be set from the peer header')

        // fetch again without a peer param -- the client should not invent
        // a peer header on its own, and req.peer should stay unset
        var echoed2 = await (await fetch(endpoint)).json()
        assert(echoed2.header === null, 'expected no peer header without a peer param')
        assert(echoed2.peer === null, 'expected req.peer to be unset without a peer param')
    }
)

run_test(
    "Verify that client writes ASCII versions",
    async () => {
        // add a handler that echoes back the raw version header it saw on
        // the wire, along with the version braidify parsed from that header
        var endpoint = await add_main_handler((req, res) => {
            res.end(JSON.stringify({ raw: req.headers.version, parsed: req.version }))
        })

        // fetch with a version containing a non-ascii emoji (a surrogate
        // pair, so the escaping has to handle multiple code units)
        var version = ['hello🌍-0']
        var { raw, parsed } = await (await fetch(endpoint, { version })).json()

        // make sure the client escaped the header into pure printable ascii
        assert(/^[\x20-\x7E]*$/.test(raw), 'expected the version header to be pure ascii')

        // and specifically into the json-string form with \u escapes
        assert(raw === '"hello\\ud83c\\udf0d-0"', 'got unexpected version header encoding')

        // make sure the escaping is lossless: the server should decode the
        // header back to the original unicode version
        assert(JSON.stringify(parsed) === JSON.stringify(version), 'expected the version to round-trip unharmed')
    }
)

run_test(
    "Verify that server writes ASCII versions",
    async () => {
        // add a handler that responds with an update whose version contains
        // non-ascii characters (the update is passed as an arg, since the
        // handler runs server-side via eval and can't close over test-side
        // variables)
        var update = { version: ['hello🌍-0'], body: 'hi' }
        var endpoint = await add_main_handler((req, res, update) => {
            res.sendUpdate(update)
            res.end()
        }, update)

        // fetch it, and grab the raw version header the server wrote
        var r = await fetch(endpoint)
        var header = r.headers.get('version')

        // make sure the header is pure printable ascii -- http headers can't
        // carry raw unicode, so the server must have escaped it
        assert(header && [...header].every(c =>
            c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7e
        ), `expected an ascii version header, got: ${header}`)

        // make sure the server escaped it as json \uXXXX escapes, exactly
        assert(header === '"hello\\ud83c\\udf0d-0"',
            `got unexpected version header: ${header}`)

        // make sure the escaping round-trips: the client should parse the
        // header back into the original unicode version
        assert(r.version.length === 1 && r.version[0] === update.version[0],
            'expected the version to round-trip through the client')
    }
)

run_test(
    "Verify that client writes ASCII parents",
    async () => {
        // add a handler that echoes back the parents header exactly as it
        // arrived on the wire, along with braidify's parsed req.parents
        var endpoint = await add_main_handler((req, res) => {
            res.end(JSON.stringify({
                header: req.headers.parents,
                parsed: req.parents
            }))
        })

        // fetch with parents containing non-ASCII characters -- the client
        // should escape them, since HTTP headers can't carry raw unicode
        var parents = ['hello🌍-0', '🌈-5']
        var r = await (await fetch(endpoint, { parents })).json()

        // make sure the header on the wire was pure ASCII, with each parent
        // JSON-quoted and its unicode \u-escaped
        assert(r.header === '"hello\\ud83c\\udf0d-0", "\\ud83c\\udf08-5"',
               'expected ascii-escaped parents header')

        // make sure the escaping round-trips: the server should parse the
        // header back into the original unicode parents
        assert(JSON.stringify(r.parsed) === JSON.stringify(parents),
               'expected parents to round-trip through the header')
    }
)

run_test(
    "Verify that server writes ASCII parents",
    async () => {
        // add a handler that responds with an update whose parents contain
        // non-ascii characters -- the update is passed as an arg (the handler
        // runs server-side via eval, so it can't close over test-side
        // variables)
        var update = { parents: ['hello🌍-0', '🌈-5'], body: 'hi' }
        var endpoint = await add_main_handler((req, res, update) => {
            res.sendUpdate(update)
            res.end()
        }, update)

        // fetch it plainly (no subscription), so the update's parents land in
        // a real http response header
        var r = await fetch(endpoint)

        // the server must \u-escape the non-ascii characters when writing the
        // parents header, since http headers can't carry raw unicode
        var header = r.headers.get('parents')
        assert(header === '"hello\\ud83c\\udf0d-0", "\\ud83c\\udf08-5"',
            'expected parents header to be ascii-escaped')

        // the escaping must also be lossless: parsing the header the way a
        // braid client does must recover the original unicode parents
        assert(JSON.stringify(JSON.parse(`[${header}]`)) === JSON.stringify(update.parents),
            'expected escaped parents to decode back to the originals')

        // make sure the rest of the update came through too
        assert(await r.text() === 'hi', 'expected the update body to arrive')
    }
)

run_test(
    "Verify that fetch params are not mutated",
    async () => {
        // braid_fetch reworks its params internally -- encoding patch
        // contents into utf-8 bytes, moving them into a request body,
        // wrapping a bare patch in an array -- and must do all of that on
        // its own copy, never on the caller's object

        // add a handler that parses the incoming update and echoes back the
        // patches it saw, so we can also check each fetch really sent them
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify(update.patches.map(p =>
                ({ unit: p.unit, range: p.range, content: p.content_text }))))
        })

        // sends params through fetch, makes sure the caller's params object
        // comes back byte-for-byte identical, and returns the patches the
        // server saw
        var fetch_and_snapshot = async (params) => {
            var snapshot = JSON.stringify(params)
            var r = await fetch(endpoint, params)
            assert(r.ok, 'expected ok response')
            assert(JSON.stringify(params) === snapshot, 'expected fetch params to be unchanged')
            return JSON.parse(await r.text())
        }

        // a single patch: the client turns its string content into bytes and
        // moves it into the request body -- our object must keep its string
        // content, and must not grow a body
        var one = {
            method: 'PUT',
            headers: { 'x-marker': 'yo' },
            parents: ['test-0'],
            patches: [{ unit: 'text', range: '[0:0]', content: 'hello' }]
        }
        var seen = await fetch_and_snapshot(one)
        assert(one.patches[0].content === 'hello', 'expected the patch content to still be the string we set')
        assert(!('body' in one), 'expected no body to appear on the params')
        assert(seen.length === 1 && seen[0].unit === 'text' && seen[0].range === '[0:0]'
               && seen[0].content === 'hello', 'expected the server to receive the single patch')

        // multiple patches: the client encodes each content and bundles them
        // all into a patches: N body -- again, only on its own copy
        var many = {
            method: 'PUT',
            patches: [
                { unit: 'json', range: '[1]', content: '"first"' },
                { unit: 'json', range: '[2]', content: '"second"' }
            ]
        }
        seen = await fetch_and_snapshot(many)
        assert(many.patches.every(p => typeof p.content === 'string'),
               'expected every patch content to still be a string')
        assert(JSON.stringify(seen) === JSON.stringify(many.patches),
               'expected the server to receive both patches')

        // a bare non-array patch: the client accepts it by wrapping it in an
        // array -- the caller's params must not get rewritten to an array
        var bare = {
            method: 'PUT',
            patches: { unit: 'text', range: '[0:0]', content: 'hi' }
        }
        seen = await fetch_and_snapshot(bare)
        assert(!Array.isArray(bare.patches), 'expected the bare patch to stay a bare object')
        assert(seen.length === 1 && seen[0].content === 'hi', 'expected the server to receive the bare patch')
    }
)

run_test(
    "Verify content-type with charset=utf-8 is handled correctly",
    async () => {
        // one of every update shape: a body, an inline patch (with a custom
        // status and an extra hash header), a Patches: 1 array, a Patches: 2
        // array (with a per-patch extra header), and a final body
        var updates = [
            { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) },
            { version: ['test1'], parents: ['oldie', 'goodie'], status: 115, hash: '42',
              patch: {unit: 'json', range: '[1]', content: '1'} },
            { version: ['test2'], patches: [{unit: 'json', range: '[2]', content: '2'}] },
            { version: ['test3'], patches: [{unit: 'json', range: '[3]', content: '3', hash: '43'},
                                            {unit: 'json', range: '[4]', content: '4'}] },
            { version: ['another!'], body: '"!"' }
        ]

        // add a handler that overrides the subscription's content-type with a
        // charset=utf-8 parameter, then sends all the updates and holds the
        // subscription open. the updates are passed as an arg (the handler
        // runs server-side via eval, so it can't close over test-side variables)
        var endpoint = await add_main_handler((req, res, updates) => {
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.startSubscription()
            for (var u of updates) res.sendUpdate(u)
        }, updates)

        // subscribe without multiplexing, so the charset content-type rides
        // on the real response headers
        var a = new AbortController()
        var r = await fetch(endpoint, { signal: a.signal, subscribe: true, multiplex: false })
        assert(!r.multiplexed_through, 'expected request to not be multiplexed')

        // make sure the charset parameter really made it onto the response --
        // otherwise we'd vacuously be testing a plain content-type
        assert(r.headers.get('content-type') === 'application/json; charset=utf-8',
               'expected content-type with charset=utf-8 on the response')

        // collect as many updates as we sent
        var got = []
        await new Promise((done, fail) =>
            r.subscribe(update => {
                got.push(update)
                if (got.length === updates.length) done()
            }, fail))

        // updates arrive as binary; swap in the decoded-text views so we can
        // compare against what we sent
        for (var u of got) {
            if (u.body != null) u.body = u.body_text
            if (u.patches) for (var p of u.patches) p.content = p.content_text
        }

        // each update should come through unharmed by the charset param:
        // versions, parents, bodies, patches, the custom 115 status, and the
        // hash headers (surfacing as extra_headers on the update and patch)
        var expected = [
            { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}), status: '200' },
            { version: ['test1'], parents: ['oldie', 'goodie'],
              patches: [{unit: 'json', range: '[1]', content: '1'}],
              status: '115', extra_headers: {hash: '42'} },
            { version: ['test2'], patches: [{unit: 'json', range: '[2]', content: '2'}], status: '200' },
            { version: ['test3'],
              patches: [{unit: 'json', range: '[3]', content: '3', extra_headers: {hash: '43'}},
                        {unit: 'json', range: '[4]', content: '4'}],
              status: '200' },
            { version: ['another!'], body: '"!"', status: '200' }
        ]
        for (var i = 0; i < expected.length; i++)
            assert(JSON.stringify(got[i]) === JSON.stringify(expected[i]),
                   `got unexpected update at index ${i}: ${JSON.stringify(got[i])}`)

        a.abort()
    }
)

run_test(
    "Verify that parents option results in parents header",
    async () => {
        // add a handler that echoes back the raw parents header it received,
        // along with braidify's parsed req.parents
        var endpoint = await add_main_handler((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                header: req.headers.parents ?? null,
                parsed: req.parents || null
            }))
        })

        // fetch with the parents option set to an array of versions
        var parents = ['test-0', 'test-1']
        var y = await (await fetch(endpoint, { parents })).json()

        // the client should have put each version on the wire,
        // JSON-quoted and comma-joined
        assert(y.header === '"test-0", "test-1"', 'expected the parents header on the wire')

        // and braidify should parse that header back into the original array
        assert(JSON.stringify(y.parsed) === JSON.stringify(parents), 'expected parents to round-trip through the header')

        // a fetch without the parents option should send no parents header
        var z = await (await fetch(endpoint)).json()
        assert(z.header === null, 'expected no parents header without the option')
    }
)

run_test(
    "Verify that parents option can be a function",
    async () => {
        // add a handler that records each request's parents header in a
        // global keyed by a random id (the handler runs server-side via
        // eval, so it can't close over test-side variables), then sends one
        // update and holds the subscription open
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_parents_' + s] = (global['_parents_' + s] ?? []).concat([req.headers.parents])
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        }, s)

        // subscribe with `parents` as a function, through a multiplexer of
        // our choosing (so we can kill it later). the function runs
        // client-side, so unlike the handler it can close over test
        // variables -- the client should call it afresh on each connection
        // to get the latest parents. onRes counts the responses
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var p1 = Math.random().toString(36).slice(2)
        var p2 = Math.random().toString(36).slice(2)
        var p3 = Math.random().toString(36).slice(2)
        var parents = [p1, p2]
        var count = 0
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: { onRes: () => count++ },
            parents: () => parents
        })
        assert(r.multiplexed_through, 'expected request to be multiplexed')

        // swap in a new parent version and kill the multiplexer -- retry
        // should reconnect (a second response, making count 2) and call the
        // parents function again for the latest value. when the reconnect's
        // update arrives, we're done
        await new Promise(async done => {
            r.subscribe(u => { if (count === 2) done() })
            parents = [p3]
            await kill_mux(m)
        })

        // read back the parents header of each request the handler saw: the
        // first connection should have sent the function's initial return
        // value formatted as a parents header, and the reconnect should have
        // re-asked the function and sent the new value
        var seen = JSON.parse(await server_eval((req, res, s) => {
            res.end(JSON.stringify(global['_parents_' + s]))
        }, s))
        assert(seen.length === 2, `expected two requests, saw ${seen.length}`)
        assert(seen[0] === `"${p1}", "${p2}"`, 'expected the first connection to send the initial parents')
        assert(seen[1] === `"${p3}"`, 'expected the reconnect to send the latest parents')

        a.abort()
        await kill_mux(m)
    }
)

run_test(
    "Verify that parents option can be an async function",
    async () => {
        // add a handler that echoes back the parents header it received
        var endpoint = await add_main_handler((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ parents: req.headers.parents ?? null }))
        })

        // fetch with parents as an async function. it runs client-side, so it
        // can close over test variables: count its calls, and resolve only
        // after a real async hop, so the fetch has to actually await the
        // promise -- the function's immediate return value is a pending
        // promise with no parents in it
        var calls = 0
        var r = await fetch(endpoint, {
            parents: async () => {
                calls++
                await new Promise(done => setTimeout(done, 20))
                return ['test-0', 'test-1']
            }
        })

        // make sure the awaited array arrived as the parents header,
        // JSON-encoded and comma-separated
        var y = await r.json()
        assert(y.parents === '"test-0", "test-1"', 'expected parents header set from the async function')

        // make sure one fetch called the async function exactly once
        assert(calls === 1, 'expected exactly one call to the parents function')
    }
)


run_test(
    "onFetch test 1",
    async () => {
        // add a handler that counts its hits in a global keyed by a random id
        // (so we can check later how many requests really reached the server)
        // and echoes back the parents header it received
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({parents: req.headers.parents}))
        }, s)

        // fetch with a parents *function*, capturing the args onFetch is
        // called with just before the underlying fetch goes out
        var args = null
        var r = await fetch(endpoint, {
            parents: () => ['test'],
            onFetch: (...a) => args = a
        })

        // onFetch was called with (url, params, aborter)
        assert(args, 'expected onFetch to be called')
        assert(args.length === 3, 'expected onFetch to be called with three args')

        // the first arg is the url being fetched
        assert(args[0] === endpoint, 'expected the url being fetched')

        // the second arg is the params as they go to the underlying fetch():
        // the url is attached, headers is a real Headers object, and the
        // parents function has already been resolved into a parents header
        var params = args[1]
        assert(params.url === endpoint, 'expected params.url to be the url being fetched')
        assert(params.headers instanceof Headers, 'expected params.headers to be a Headers object')
        assert(params.headers.get('parents') === '"test"', 'expected the parents function resolved into a parents header')

        // the third arg is the aborter controlling the underlying fetch, and
        // params.signal is its signal
        assert(args[2] instanceof AbortController, 'expected the aborter to be an AbortController')
        assert(args[2].signal === params.signal, `expected params.signal to be the aborter's signal`)

        // the request onFetch saw is the one that actually went out: the
        // server received the resolved parents header
        assert((await r.json()).parents === '"test"', 'expected the server to receive the resolved parents header')

        // the aborter really controls the underlying fetch: aborting it from
        // inside onFetch kills the request
        var errored = false
        try {
            await fetch(endpoint, {onFetch: (url, params, aborter) => aborter.abort()})
        } catch (e) {
            assert(e.name === 'AbortError', 'expected an abort error')
            errored = true
        }
        assert(errored, 'expected the aborted fetch to error')

        // and the aborted request never went out: the server saw only the
        // first fetch
        var hits = await server_eval((req, res, s) => res.end(String(global['_hits_' + s])), s)
        assert(hits === '1', 'expected only the first fetch to reach the server')
    }
)

run_test(
    "onBytes test 1",
    async () => {
        // add a handler that sends one update and holds the subscription
        // open. the update is passed as an arg (the handler runs server-side
        // via eval, so it can't close over test-side variables)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // subscribe with an onBytes callback that accumulates the raw bytes
        // of the subscription stream, and remembers if any chunk arrives as
        // something other than bytes
        var a = new AbortController()
        var s = ''
        var got_non_bytes = false
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false,
            onBytes: (chunk) => {
                if (!(chunk instanceof Uint8Array)) got_non_bytes = true
                s += new TextDecoder('utf-8').decode(chunk)
            }
        })

        // wait for the update to come out of the parser -- onBytes sees every
        // chunk before it is parsed, so by now all of the update's bytes have
        // passed through our callback
        var u = await new Promise(done => r.subscribe(done))

        // make sure the parser delivered the update we sent (each update on
        // the wire carries a status line, which parses into update.status)
        assert(JSON.stringify({...u, body: u.body_text}) ===
               JSON.stringify({...update, status: '200'}), 'got unexpected update')

        // make sure onBytes got raw bytes...
        assert(!got_non_bytes, 'expected onBytes chunks to be Uint8Arrays')

        // ...spelling exactly the update's wire format -- nothing missing,
        // nothing extra (in particular, the outer 209 response headers are
        // not part of the stream, so they should not show up here)
        assert(s === 'HTTP 200 OK\r\nVersion: "test"\r\nParents: "oldie"\r\nContent-Length: 16\r\n\r\n{"this":"stuff"}\r\n\r\n',
               'got unexpected bytes')

        a.abort()
    }
)

run_test(
    "Test that a parents function returning null sends no parents header.",
    async () => {
        // add a handler that reports back the parents header it saw
        var endpoint = await add_main_handler((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ parents: req.headers.parents ?? null }))
        })

        // fetch with a parents function that returns null. the function runs
        // client-side, so it can close over test variables -- count its calls
        // to make sure the client really consults it
        var calls = 0
        var parents_fn = () => {
            calls++
            return null
        }

        // use onFetch to observe the headers as the request goes out
        var has_parents = null
        var r = await fetch(endpoint, {
            parents: parents_fn,
            onFetch: (url, params) => has_parents = params.headers.has('parents')
        })

        // make sure the client actually called the parents function
        assert(calls === 1, 'expected the parents function to be called once')

        // make sure the client left the parents header off the request...
        assert(has_parents === false, 'expected no parents header on the outgoing request')

        // ...and that the server received none either
        assert(r.ok, 'expected ok response')
        var body = await r.json()
        assert(body.parents === null, 'expected the server to see no parents header')
    }
)

add_section_header("Heartbeat Tests")

run_test(
    "Verify heartbeats don't prevent user writing headers",
    async () => {
        // add a handler that starts a heartbeating subscription, waits past a
        // heartbeat interval, and only then writes a header and an update.
        // braidify's heartbeat loop ticks once synchronously inside
        // startSubscription and again ~500ms later -- both times before this
        // handler flushes the headers. if either tick wrote its \r\n too
        // early, node would flush the headers, and the setHeader below would
        // be too late to reach the client
        var update = { version: ['v1'], body: 'hello' }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            setTimeout(() => {
                res.setHeader('post-sub-header', 'yup')
                res.sendUpdate(update)
            }, 700)
        }, update)

        // subscribe with heartbeats requested every half second. the handler
        // sends nothing after its one update, so any bytes arriving after it
        // must be heartbeats
        var a = new AbortController()
        var update_seen = false
        var saw_heartbeat = null
        var heartbeat = new Promise(done => saw_heartbeat = done)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false,
            heartbeats: 0.5,
            onBytes: () => { if (update_seen) saw_heartbeat() }
        })

        // make sure heartbeats are actually in play: the server echoes the
        // heartbeats header back only when it starts its heartbeat loop --
        // without this, the test could pass with heartbeats never running
        assert(r.headers.get('heartbeats') === '0.5s', 'expected server to echo the heartbeats header')

        // the header written after startSubscription must have reached us
        assert(r.headers.get('post-sub-header') === 'yup', 'expected the post-subscription header')

        // read the update to make sure it came through alongside the header
        var u = await new Promise(done => r.subscribe(u2 => { update_seen = true; done(u2) }))
        assert(u.version[0] === 'v1', 'got unexpected version')
        assert(u.body_text === 'hello', 'got unexpected body')

        // and make sure heartbeats really flow once the headers are out:
        // deferring them must not mean losing them
        await heartbeat

        a.abort()
    }
)

run_test(
    "Verify heartbeat reception",
    async () => {
        // add a handler that sends one update and holds the subscription open
        // without ever writing again -- braidify itself sends the heartbeats,
        // so anything on the wire past the update must be heartbeat bytes.
        // the update is passed as an arg (the handler runs server-side via
        // eval, so it can't close over test-side variables)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // this is exactly how that update looks on the wire, so we can tell
        // where the update ends and the heartbeats begin
        var update_wire = `HTTP 200 OK\r\nVersion: "test"\r\nParents: "oldie"\r\nContent-Length: ${update.body.length}\r\n\r\n${update.body}\r\n\r\n`

        // subscribe asking for a heartbeat every 0.4 seconds, recording the
        // raw bytes as they arrive, and signalling once we have the update
        // plus at least two heartbeats' worth (a heartbeat is one \r\n)
        var a = new AbortController()
        var wire = ''
        var got_two_beats = null
        var two_beats = new Promise(done => got_two_beats = done)
        var r = await fetch(endpoint, {
            subscribe: true,
            multiplex: false,
            heartbeats: 0.4,
            signal: a.signal,
            onBytes: chunk => {
                wire += new TextDecoder('utf-8').decode(chunk)
                if (wire.length >= update_wire.length + 4) got_two_beats()
            }
        })

        // the server acknowledges that it will send heartbeats by echoing the
        // heartbeats header back on the response
        assert(r.headers.get('heartbeats') === '0.4s', 'expected the heartbeats header to be echoed back')

        // read the initial update off the subscription, making sure the
        // heartbeat machinery didn't disturb normal update delivery
        var u = await new Promise(done => r.subscribe(done))
        assert(u.body_text === update.body, 'got unexpected update body')

        // wait until at least two heartbeats have arrived, proving the server
        // keeps beating rather than sending a single stray newline
        await two_beats

        // make sure the wire holds the update followed by heartbeats and
        // nothing else -- heartbeats are bare blank lines (\r\n)
        assert(wire.startsWith(update_wire), `expected wire to start with the update, got: ${JSON.stringify(wire)}`)
        assert(/^(\r\n)+$/.test(wire.slice(update_wire.length)), `expected only heartbeats after the update, got: ${JSON.stringify(wire.slice(update_wire.length))}`)

        a.abort()
    }
)

run_test(
    "Verify absence of unwanted heartbeats",
    async () => {
        // add a handler that reports back (in a response header) whether the
        // client asked for heartbeats, sends one update, and then holds the
        // subscription open in silence -- so any bytes arriving after that
        // update could only be unwanted heartbeats
        var endpoint = await add_main_handler((req, res) => {
            res.setHeader('asked-for-heartbeats', '' + ('heartbeats' in req.headers))
            res.startSubscription()
            res.sendUpdate({ body: 'quiet' })
        })

        // subscribe without the heartbeats option, counting every chunk of
        // bytes that arrives on the connection
        var a = new AbortController()
        var chunks = 0
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false,
            onBytes: () => chunks++
        })

        // since we didn't ask for heartbeats, the client should not have sent
        // the heartbeats request header, and braidify should not have offered
        // a heartbeats response header back
        assert(r.headers.get('asked-for-heartbeats') === 'false', 'expected client to omit the heartbeats request header')
        assert(!r.headers.get('heartbeats'), 'expected no heartbeats response header')

        // read the one real update off the subscription
        var update = await new Promise(done => r.subscribe(done))
        assert(update.body_text === 'quiet', 'got unexpected body')

        // the update's bytes must have been counted, or the silence check
        // below would pass vacuously
        assert(chunks > 0, 'expected onBytes to see the update arrive')

        // let the connection sit idle well past the heartbeat intervals other
        // tests use, and make sure no further bytes arrive -- a heartbeat
        // would show up as an extra chunk
        var seen = chunks
        await new Promise(done => setTimeout(done, 1000))
        assert(chunks === seen, 'expected no bytes while idle')

        a.abort()
    }
)

run_test(
    "Test heartbeat error",
    async () => {
        // add a handler that *claims* to send heartbeats -- it echoes the
        // client's requested heartbeats header back on the response, but
        // deletes it from the request before starting the subscription, so
        // braidify never actually sends any -- then sends one real update and
        // goes silent. the update is passed as an arg (the handler runs
        // server-side via eval, so it can't close over test-side variables)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.setHeader('Heartbeats', req.headers['heartbeats'])
            delete req.headers['heartbeats']
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // subscribe, asking for a heartbeat every 0.5s
        var a = new AbortController()
        var r = await fetch(endpoint, {
            subscribe: true,
            multiplex: false,
            heartbeats: 0.5,
            signal: a.signal
        })

        // the server agreed to heartbeats, so the client arms its watchdog
        assert(r.headers.get('heartbeats') === '0.5s', 'expected the response to negotiate heartbeats')

        // read the subscription: collect updates, and wait for the error that
        // kills it (only the subscription's error callback resolves here -- a
        // failure of the fetch itself would fail the test with that error)
        var st = Date.now()
        var got = null
        var error = await new Promise(done => r.subscribe(u => got = u, done))
        var elapsed = Date.now() - st

        // the subscription was really alive before it died: our update arrived
        assert(got, 'expected the update to arrive before the heartbeat error')
        assert(got.version[0] === 'test', 'got unexpected version')
        assert(got.body_text === update.body, 'got unexpected body')

        // the missing heartbeat surfaces as a retryable pipe error, and only
        // after the client waited the full 1.2 * 0.5s + 3s = 3.6s window
        assert('' + error === 'PipeError: heartbeat not seen in 3.60s', 'expected the heartbeat error, got: ' + error)
        assert(error.type === 'pipe', 'expected a pipe-type error')
        assert(elapsed >= 3500, `expected the client to wait the full heartbeat window, got ${elapsed}ms`)

        a.abort()
    }
)

run_test(
    "Restart connection on missed heartbeats",
    async () => {
        // add a handler that promises heartbeats but never sends any: it
        // echoes the Heartbeats header (so the client arms its miss timer),
        // then deletes the request header before startSubscription, which
        // keeps braidify's heartbeat loop from ever starting. it also counts
        // connections in a global keyed by a random id (the handler runs
        // server-side via eval, so it can't close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, update, s) => {
            global['_connects_' + s] = (global['_connects_' + s] ?? 0) + 1
            res.setHeader('Heartbeats', req.headers.heartbeats)
            delete req.headers.heartbeats
            res.startSubscription()
            res.sendUpdate(update)
        }, update, s)

        // subscribe with retry on, and watch for the restart: onRes fires
        // once per established connection, so a second call means the missed
        // heartbeats made the client reconnect
        var a = new AbortController()
        var connects = 0
        var on_restart = null
        var restarted = new Promise(done => on_restart = done)
        var r = await fetch(endpoint, {
            subscribe: true,
            multiplex: false,
            heartbeats: 0.5,
            signal: a.signal,
            retry: {
                onRes: () => {
                    connects++
                    if (connects === 2) on_restart()
                }
            }
        })

        // read the subscription: the handler sends its update on every
        // connection, so receiving it a second time proves the restarted
        // connection works end-to-end, not just that a retry was attempted
        var updates = []
        var errors = []
        var redelivered = new Promise(done => r.subscribe(u => {
            updates.push(u)
            if (updates.length === 2) done()
        }, e => errors.push(e)))

        // wait for the missed heartbeats to restart the connection, and for
        // the new connection to deliver the update again
        await restarted
        await redelivered

        // both connections delivered the same update
        for (var u of updates) {
            assert(u.version[0] === 'test', 'got unexpected version')
            assert(u.parents[0] === 'oldie', 'got unexpected parents')
            assert(u.body_text === JSON.stringify({this: 'stuff'}), 'got unexpected body')
        }

        // the heartbeat error was retried, not surfaced to the error cb
        assert(errors.length === 0, 'expected no subscription error')

        // and the server really saw two connections: the original, plus the
        // restart after the missed heartbeats
        var connect_count = await server_eval((req, res, s) =>
            res.end('' + global['_connects_' + s]), s)
        assert(connect_count === '2', 'expected exactly two connections to the server')

        a.abort()
    }
)

run_test(
    "Maintain connection with regular heartbeats",
    async () => {
        // add a handler that sends one update and holds the subscription
        // open, counting how many times it's hit in a global keyed by a
        // random id (the handler runs server-side via eval, so it can't
        // close over test-side variables). braidify itself honors the
        // client's heartbeats header by echoing it and writing filler
        // bytes on the requested period
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['v1'], body: JSON.stringify({ keep: 'alive' }) }
        var endpoint = await add_main_handler((req, res, s, update) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.startSubscription()
            res.sendUpdate(update)
        }, s, update)

        // subscribe asking for a heartbeat every 0.5s, with retry on,
        // counting responses and incoming heartbeats. if no bytes arrived
        // for 1.2 * 0.5 + 3 = 3.6s, the client would declare the
        // connection dead and reconnect about a second after that
        var a = new AbortController()
        var res_count = 0
        var heartbeat_count = 0
        var r = await fetch(endpoint, {
            subscribe: true,
            multiplex: false,
            heartbeats: 0.5,
            signal: a.signal,
            retry: { onRes: () => res_count++ },
            on_heartbeat: () => heartbeat_count++
        })

        // make sure the server agreed to send heartbeats -- this echoed
        // header is what arms the client's no-heartbeat timer at all
        assert(r.headers.get('heartbeats') === '0.5s', 'expected the server to echo the heartbeats header')

        // read the first update, so we know the subscription is flowing
        var u = await new Promise(done => r.subscribe(done))
        assert(u.body_text === JSON.stringify({ keep: 'alive' }), 'got unexpected body')

        // wait past the point where the client would have reconnected if
        // the heartbeats hadn't kept resetting its timer (3.6s of silence,
        // plus ~1s of reconnect delay), counting heartbeats seen meanwhile
        heartbeat_count = 0
        await new Promise(done => setTimeout(done, 5500))

        // heartbeats really were flowing while we waited...
        assert(heartbeat_count >= 3, `expected heartbeats while waiting, saw ${heartbeat_count}`)

        // ...and they kept the connection alive: the client saw exactly
        // one response, and the server saw exactly one request
        assert(res_count === 1, `expected no reconnections, but saw ${res_count} responses`)
        var hits = await server_eval((req, res, s) =>
            res.end('' + global['_hits_' + s]), s)
        assert(hits === '1', `expected exactly one request at the server, saw ${hits}`)

        a.abort()
    }
)

run_test(
    "Verify on_heartbeat is called on heartbeats",
    async () => {
        // add a handler that starts a subscription and never sends any
        // updates. the server's heartbeat loop only writes once headers are
        // sent, so we flush them with a single blank line -- the same bytes
        // as a heartbeat -- after which everything the client receives on
        // this subscription is heartbeats
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.write('\r\n')
        })

        // subscribe, asking the server for a heartbeat every 0.3 seconds.
        // heartbeat_timer: false opts out of the client's deprecated internal
        // heartbeat watchdog, whose ~3s timer would outlive the test -- we're
        // testing the on_heartbeat callback, which fires either way
        var a = new AbortController()
        var heartbeat_count = 0
        var got_heartbeats = null
        var heartbeats_arrived = new Promise(done => got_heartbeats = done)
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false,
            heartbeats: 0.3,
            heartbeat_timer: false,
            on_heartbeat: () => {
                // the first call may be the handler's header-flushing blank
                // line, so require one extra: 4 calls means at least 3 came
                // from the server's heartbeat loop
                heartbeat_count++
                if (heartbeat_count >= 4) got_heartbeats()
            }
        })

        // make sure the server really turned heartbeats on: braidify echoes
        // the requested cadence back in the response headers
        assert(r.headers.get('heartbeats') === '0.3s',
               'expected the response to echo the heartbeats header')

        // start reading the subscription -- on_heartbeat only fires once a
        // reader is consuming the byte stream -- and count any updates that
        // arrive, to prove below that none did
        var update_count = 0
        r.subscribe(() => update_count++)

        // wait for the heartbeats
        await heartbeats_arrived

        // make sure the counted calls really were heartbeats: the handler
        // sent no updates, so blank-line heartbeats were all that's on the wire
        assert(update_count === 0, 'expected heartbeats only, no updates')

        a.abort()
    }
)

run_test(
    "Test reconnect_delay_ms default path",
    async () => {
        // the reconnect delay knob is global state on braid_fetch, and the
        // browser runner runs tests in parallel -- so the reconnect_delay
        // tests serialize themselves on this shared promise chain. take our
        // turn, and release it in the finally below even if an assert throws
        await braid_fetch.reconnect_delay_test_chain
        var release_chain
        braid_fetch.reconnect_delay_test_chain = new Promise(done => release_chain = done)
        try {
            // make sure the knob is unset, so this exercises the default
            // delay formula: Math.min(retry_count + 1, 3) * 1000
            delete braid_fetch.reconnect_delay_ms

            // add a handler that always 500s, counting its hits in a global
            // keyed by a random id (passed as an arg, since the handler runs
            // server-side and can't close over test variables), so we can
            // prove later that the retry really went back to the server
            var s = Math.random().toString(36).slice(2)
            var endpoint = await add_main_handler((req, res, s) => {
                global['_500s_' + s] = (global['_500s_' + s] ?? 0) + 1
                res.writeHead(500)
                res.end('')
            }, s)

            // fetch it with a retry function that notes when each 500
            // arrives: retry the first (return true), accept the second
            // (return false), which lets the fetch resolve with it. the
            // function is needed because plain retry: true doesn't retry
            // bare 500s -- they resolve normally
            var arrivals = []
            var r = await fetch(endpoint, {
                retry: res => {
                    arrivals.push(Date.now())
                    return arrivals.length < 2
                }
            })

            // accepting the second 500 should resolve the fetch with it
            assert(r.status === 500, `expected the fetch to resolve with the second 500, got ${r.status}`)
            assert(arrivals.length === 2, `expected 2 attempts, saw ${arrivals.length}`)

            // make sure the retry actually re-hit the server, rather than
            // the client fabricating a second response locally
            var hits = await server_eval((req, res, s) =>
                res.end('' + global['_500s_' + s]), s)
            assert(hits === '2', `expected the server to see 2 requests, saw ${hits}`)

            // the first reconnect uses retry_count = 0, so the default delay
            // is Math.min(0 + 1, 3) * 1000 = 1000ms. allow slack above for
            // the retry's round-trip, but stay below the backoff ladder's
            // next rung at 2000ms
            var elapsed = arrivals[1] - arrivals[0]
            assert(elapsed >= 900 && elapsed < 1800,
                   `expected the default ~1000ms reconnect delay, measured ${elapsed}ms`)
        } finally {
            release_chain()
        }
    }
)

run_test(
    "Test reconnect_delay_ms as number",
    async () => {
        // the reconnect delay knob is a global on braid_fetch, shared with the
        // other reconnect_delay_ms tests, so the three of them take turns
        // through this promise chain. claim our turn synchronously -- awaiting
        // the chain before swapping in our own promise would let the next test
        // latch onto the same turn in the browser's parallel runner -- and
        // wait out the previous test without inheriting its failure
        var release_chain
        var prev_chain = braid_fetch.reconnect_delay_test_chain
        braid_fetch.reconnect_delay_test_chain = new Promise(done => release_chain = done)
        try { await prev_chain } catch (e) {}

        // add a handler that always responds 500, counting its hits in a
        // global keyed by a random id, so we can verify later that each retry
        // really re-sent the request over the wire
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.writeHead(500)
            res.end('')
        }, s)

        // set the knob under test: a fixed number of milliseconds between
        // reconnects, overriding the default 1000/2000/3000ms backoff
        braid_fetch.reconnect_delay_ms = 200

        // fetch with a retry function that timestamps each 500 as it arrives,
        // okays the first two retries, and gives up on the third response,
        // which lets the fetch resolve normally with that 500. forcing two
        // reconnects (not one) shows the fixed delay applies on every retry,
        // where the default backoff would grow to 2000ms for the second
        var fetch_error = null
        var attempts = []
        var r = await fetch(endpoint, {
            retry: (res) => {
                attempts.push({ status: res.status, time: Date.now() })
                return attempts.length < 3
            }
        }).catch(e => fetch_error = e)

        // restore the default backoff and let the next reconnect_delay_ms
        // test take its turn, before any assert can bail out of this one.
        // assign undefined rather than delete: in the node runner, braid_fetch
        // is a wrapper whose reconnect_delay_ms property proxies to the real
        // client and can't be deleted, and the client treats undefined as
        // unset anyway
        braid_fetch.reconnect_delay_ms = undefined
        release_chain()

        // ask the server how many requests it actually saw
        var hits = await server_eval((req, res, s) =>
            res.end('' + (global['_hits_' + s] ?? 0)), s)

        // make sure we gave up cleanly, holding the third 500
        assert(!fetch_error, `expected the fetch to resolve, got: ${fetch_error}`)
        assert(r.status === 500, 'expected the fetch to resolve with the last 500')
        assert(attempts.length === 3 && attempts.every(a => a.status === 500),
            'expected the retry callback to see three 500s')

        // make sure each retry really went back over the wire
        assert(hits === '3', `expected the server to see 3 requests, saw ${hits}`)

        // make sure both reconnects waited ~200ms -- long enough that the
        // delay clearly happened, short enough that the default backoff
        // (1000ms, then 2000ms) clearly didn't
        for (var i = 1; i < attempts.length; i++) {
            var gap = attempts[i].time - attempts[i - 1].time
            assert(gap >= 190 && gap < 800, `expected ~200ms between attempts, got ${gap}ms`)
        }
    }
)

run_test(
    "Test reconnect_delay_ms as function",
    async () => {
        // add a handler that 500s every request, counting hits in a global
        // keyed by a random id, so we can check later that the client really
        // re-sent the request over the wire
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.writeHead(500)
            res.end('')
        }, s)

        // reconnect_delay_ms is a global knob on braid_fetch, and in the
        // browser tests run in parallel, so the reconnect_delay_ms tests take
        // turns through a shared promise chain. it's our turn once the chain
        // settles without anyone having added a new link while we waited
        while (true) {
            var turn = braid_fetch.reconnect_delay_test_chain
            await turn
            if (turn === braid_fetch.reconnect_delay_test_chain) break
        }
        var run = (async () => {
            try {
                var delay_calls, response_times, r
                for (var attempt = 0; ; attempt++) {
                    // install a delay function that logs each retry_count it
                    // is asked about (with a timestamp -- see below), and
                    // answers a distinct delay per retry: 100ms for the
                    // first, 300ms for the second -- both far below the
                    // default's 1000ms minimum, so the timing checks below
                    // can tell our answers were actually used
                    delay_calls = []
                    var delay_fn = retry_count => {
                        delay_calls.push({ n: retry_count, t: Date.now() })
                        return 100 + 200 * retry_count
                    }
                    braid_fetch.reconnect_delay_ms = delay_fn

                    // fetch the 500ing endpoint with a retry function that
                    // allows exactly two retries, timestamping each response
                    // as it lands
                    response_times = []
                    r = await fetch(endpoint, { retry: res => {
                        response_times.push(Date.now())
                        return response_times.length < 3
                    }})

                    // our function still installed? then no concurrent test
                    // clobbered the knob mid-run (some tests set
                    // reconnect_delay_ms without taking a turn on the chain),
                    // and the observations below are trustworthy
                    if (braid_fetch.reconnect_delay_ms === delay_fn) break
                    assert(attempt < 3, 'gave up: other tests kept clobbering reconnect_delay_ms')
                }

                // once the retry function says stop, the 500 resolves
                // normally instead of reconnecting or throwing
                assert(r.status === 500, `expected the final 500 to resolve normally, got status ${r.status}`)

                // the client should have asked our function for a delay once
                // per reconnect, passing the number of retries so far. the
                // knob is global, so in the parallel browser runner OTHER
                // tests' retries call our function too (and the client passes
                // only retry_count -- there's nothing to filter foreign calls
                // by). so instead we match by time: the client asks for the
                // delay at the moment our retry decision fires, so our calls
                // land right after each of our recorded response arrivals
                assert([0, 1].every(i => delay_calls.some(c =>
                           c.n === i && c.t >= response_times[i] && c.t < response_times[i] + 150)),
                       `expected our two reconnects to consult reconnect_delay_ms with retry counts `
                       + `0 and 1, saw ${JSON.stringify(delay_calls)} against arrivals `
                       + `${JSON.stringify(response_times)}`)

                // and each reconnect should have waited about as long as our
                // function said -- not the >= 1000ms the default would use
                var gap1 = response_times[1] - response_times[0]
                var gap2 = response_times[2] - response_times[1]
                assert(gap1 >= 90 && gap1 < 600, `expected first reconnect after ~100ms, got ${gap1}ms`)
                assert(gap2 >= 290 && gap2 < 900, `expected second reconnect after ~300ms, got ${gap2}ms`)

                // confirm with the server that the client really made three
                // requests per attempt -- one original plus two retries
                var hits = await server_eval((req, res, s) => res.end(`${global['_hits_' + s]}`), s)
                assert(hits === `${3 * (attempt + 1)}`,
                       `expected ${3 * (attempt + 1)} requests at the server, got ${hits}`)
            } finally {
                // clean up the global knob for whoever goes next
                delete braid_fetch.reconnect_delay_ms
            }
        })()
        // publish our link in the chain, swallowing rejection there so an
        // assert failure here doesn't also fail the next test in line
        braid_fetch.reconnect_delay_test_chain = run.catch(() => {})
        await run
    }
)

add_section_header("Read Tests")

run_test(
    "Subscribe with empty Subscribe header value",
    async () => {
        // add a handler that echoes what braidify parsed out of the Subscribe
        // header, and only starts a subscription if braidify saw one -- so an
        // empty header value that gets dropped or ignored can't sneak through
        // as a 209
        var endpoint = await add_main_handler((req, res) => {
            res.setHeader('parsed-subscribe', JSON.stringify(req.subscribe ?? null))
            if (!req.subscribe) return res.end()
            res.startSubscription()
            res.sendUpdate({ version: ['v1'], body: 'hello' })
        })

        // subscribe with an EMPTY Subscribe header value, using og_fetch so
        // the header goes over the wire verbatim (braid_fetch would fill in
        // its own value)
        var a = new AbortController()
        var r = await og_fetch(endpoint, {
            signal: a.signal,
            headers: { 'Subscribe': '' }
        })

        // the server should accept the empty value as a subscription
        assert(r.status === 209, `expected status 209, got ${r.status}`)

        // and braidify should have normalized the empty value to `true` for
        // the handler, not left it as ''
        assert(r.headers.get('parsed-subscribe') === 'true',
            'expected req.subscribe to be normalized to true')

        // make sure updates really flow on this subscription: read the raw
        // stream until our update's body shows up
        var reader = r.body.getReader()
        var text = ''
        while (!text.includes('hello')) {
            var { done, value } = await reader.read()
            assert(!done, 'expected an update before the stream ended')
            text += new TextDecoder().decode(value)
        }

        a.abort()
    }
)

run_test(
    "Subscribe returns 209 with statusText 'Multiresponse' (HTTP/1.x only)",
    async () => {
        // add a handler that starts a subscription and sends one update.
        // it echoes the http version the request arrived over in a header,
        // so we know which status-line behavior to expect below
        var endpoint = await add_main_handler((req, res) => {
            res.setHeader('echo-http-version', req.httpVersion)
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        // subscribe with the raw transport, so we see the status line
        // exactly as the server put it on the wire
        var a = new AbortController()
        var r = await og_fetch(endpoint, {
            signal: a.signal,
            headers: { 'Subscribe': 'true' }
        })

        // braidify marks the subscription response with status 209
        assert(r.status === 209, `expected status 209, got ${r.status}`)

        // http/2 has no reason phrase on the wire, so statusText must be
        // empty there; on http/1.x the server must say 'Multiresponse'
        // (node would say 'unknown' for the nonstandard 209 if braidify
        // didn't set res.statusMessage)
        var http_version = r.headers.get('echo-http-version')
        assert(http_version, 'expected the handler to echo the http version')
        if (http_version.startsWith('1'))
            assert(r.statusText === 'Multiresponse',
                   `expected statusText 'Multiresponse', got '${r.statusText}'`)
        else
            assert(r.statusText === '',
                   `expected empty statusText, got '${r.statusText}'`)

        // make sure the subscription is actually streaming (we got the
        // update the handler sent) before tearing it down
        assert((await r.body.getReader().read()).value, 'expected a first update chunk')

        a.abort()
    }
)

run_test(
    "Subscribe and receive multiple updates, using promise chaining",
    async () => {
        // one of every update shape: a body, an inline patch (with a custom
        // status and an extra hash header), a Patches: 1 array, and a
        // Patches: 2 array (with a per-patch extra header)
        var updates = [
            { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) },
            { version: ['test1'], parents: ['oldie', 'goodie'], status: 115, hash: '42',
              patch: {unit: 'json', range: '[1]', content: '1'} },
            { version: ['test2'], patches: [{unit: 'json', range: '[2]', content: '2'}] },
            { version: ['test3'], patches: [{unit: 'json', range: '[3]', content: '3', hash: '43'},
                                            {unit: 'json', range: '[4]', content: '4'}] }
        ]
        var late_update = { version: ['another!'], body: '"!"' }

        // add a handler that sends the updates, then stashes res in a global
        // keyed by a random id, so a later request can push one more update
        // down the still-open subscription. the values are passed as args
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, updates, s) => {
            res.startSubscription()
            for (var u of updates) res.sendUpdate(u)
            global['_sub_' + s] = res
        }, updates, s)

        // add a handler that pushes one more update down that subscription
        var poke_endpoint = await add_main_handler((req, res, late_update, s) => {
            global['_sub_' + s].sendUpdate(late_update)
            res.end('ok')
        }, late_update, s)

        // subscribe using promise chaining -- .then() and .catch() instead of
        // await -- since that's the client api style under test here, and
        // collect updates as they arrive
        var a = new AbortController()
        var got = []
        var on_update
        var r
        await new Promise((done, fail) => {
            on_update = () => { if (got.length === updates.length) done() }
            fetch(endpoint, { signal: a.signal, subscribe: true, multiplex: false }).then(
                res => {
                    r = res
                    res.subscribe(u => { got.push(u); on_update() }, fail)
                }).catch(fail)
        })

        // make sure the request really wasn't multiplexed
        assert(!r.multiplexed_through, 'expected request to not be multiplexed')

        // the subscription is still open -- poke the server to push the late
        // update through it, and wait for that one to arrive too. (the old
        // version of this test raced a server-side timer instead)
        var late = new Promise(done =>
            on_update = () => { if (got.length > updates.length) done() })
        await og_fetch(poke_endpoint)
        await late

        // updates arrive as binary; swap in the decoded-text views so we can
        // compare against what we sent
        for (var u of got) {
            if (u.body != null) u.body = u.body_text
            if (u.patches) for (var p of u.patches) p.content = p.content_text
        }

        // each update should come back as sent, plus the protocol's
        // mechanical reshaping: statuses come back as strings (defaulting to
        // '200'), a singular patch: comes back as a one-element patches
        // array, and hash headers surface as extra_headers on the update or
        // patch. build each expected update in the field order the client
        // emits, since we compare json strings
        var expected = [...updates, late_update].map(u => {
            var e = {}
            if (u.version) e.version = u.version
            if (u.parents) e.parents = u.parents
            if (u.body != null) e.body = u.body
            if (u.patch || u.patches) e.patches = (u.patches ?? [u.patch]).map(
                ({hash, ...p}) => hash ? {...p, extra_headers: {hash}} : p)
            e.status = '' + (u.status ?? 200)
            if (u.hash) e.extra_headers = {hash: u.hash}
            return e
        })
        assert(got.length === expected.length,
               `expected ${expected.length} updates, got ${got.length}`)
        for (var i = 0; i < expected.length; i++)
            assert(JSON.stringify(got[i]) === JSON.stringify(expected[i]),
                   `got unexpected update at index ${i}: ${JSON.stringify(got[i])}`)

        a.abort()
    }
)

run_test(
    "Subscribe and receive multiple updates, using async/await",
    async () => {
        // one of every update shape: a body, an inline patch (with a custom
        // status and an extra hash header), a Patches: 1 array, and a
        // Patches: 2 array (with a per-patch extra header)
        var updates = [
            { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) },
            { version: ['test1'], parents: ['oldie', 'goodie'], status: 115, hash: '42',
              patch: {unit: 'json', range: '[1]', content: '1'} },
            { version: ['test2'], patches: [{unit: 'json', range: '[2]', content: '2'}] },
            { version: ['test3'], patches: [{unit: 'json', range: '[3]', content: '3', hash: '43'},
                                            {unit: 'json', range: '[4]', content: '4'}] }
        ]

        // add a handler that sends the updates and holds the subscription
        // open, parking its response in a global keyed by our random id so a
        // later request can push one more update down the same subscription.
        // the updates are passed as an arg (the handler runs server-side via
        // eval, so it can't close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, updates, s) => {
            res.startSubscription()
            for (var u of updates) res.sendUpdate(u)
            global['_res_' + s] = res
        }, updates, s)

        // await the fetch (this test's subject is the async/await style of
        // consuming a subscription), without multiplexing
        var a = new AbortController()
        var r = await fetch(endpoint, { signal: a.signal, subscribe: true, multiplex: false })
        assert(!r.multiplexed_through, 'expected request to not be multiplexed')

        // read updates with the subscribe callback api; wait_for(n) resolves
        // once n updates have arrived (or rejects if the subscription errors)
        var got = []
        var failure = null
        var check = () => {}
        r.subscribe(u => {
            got.push(u)
            check()
        }, e => {
            failure = e
            check()
        })
        var wait_for = n => new Promise((done, fail) => {
            check = () => {
                if (failure) fail(failure)
                else if (got.length >= n) done()
            }
            check()
        })

        // the whole batch should stream in
        await wait_for(updates.length)

        // the subscription should still be open for updates sent after the
        // fact: push one more down the parked response, server-side, and
        // watch it arrive on the same callback
        var late = { version: ['another!'], body: '"!"' }
        await server_eval((req, res, s, late) => {
            global['_res_' + s].sendUpdate(late)
            delete global['_res_' + s]
            res.end('ok')
        }, s, late)
        await wait_for(updates.length + 1)

        // updates arrive as binary; swap in the decoded-text views so we can
        // compare against what we sent
        for (var u of got) {
            if (u.body != null) u.body = u.body_text
            if (u.patches) for (var p of u.patches) p.content = p.content_text
        }

        // each sent update should arrive in order and intact, normalized by
        // the protocol: an inline patch becomes a patches array, the status
        // arrives as a string (defaulting to '200'), and unknown headers
        // (like hash) surface as extra_headers on the update and patch.
        // field order below matters, since we compare JSON strings
        var as_received = u => {
            var {version, parents, body, status, patch, patches, ...extra_headers} = u
            patches = patches ?? (patch && [patch])
            if (patches) patches = patches.map(({unit, range, content, ...extra_headers}) =>
                ({unit, range, content, ...(Object.keys(extra_headers).length && {extra_headers})}))
            return {
                ...(version && {version}),
                ...(parents && {parents}),
                ...(body != null && {body}),
                ...(patches && {patches}),
                status: '' + (status ?? 200),
                ...(Object.keys(extra_headers).length && {extra_headers})
            }
        }
        var expected = [...updates, late].map(as_received)
        assert(got.length === expected.length, `expected ${expected.length} updates, got ${got.length}`)
        for (var i = 0; i < expected.length; i++)
            assert(JSON.stringify(got[i]) === JSON.stringify(expected[i]),
                   `got unexpected update at index ${i}: ${JSON.stringify(got[i])}`)

        a.abort()
    }
)

run_test(
    "Subscribe and receive multiple updates, using 'for await'",
    async () => {
        // the updates the server will send. most parse back into exactly
        // what was sent, plus the status the server attaches (200 unless
        // told otherwise) -- but two get reshaped by the wire, so they spell
        // out their expected parsed form: a singular patch comes back in a
        // patches array, and unknown headers -- on an update or on a patch
        // -- come back as extra_headers
        var updates = [{
            send: { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        }, {
            send:   { version: ['test1'], parents: ['oldie', 'goodie'], patch: {unit: 'json', range: '[1]', content: '1'}, hash: '42', status: 115 },
            expect: { version: ['test1'], parents: ['oldie', 'goodie'], patches: [{unit: 'json', range: '[1]', content: '1'}], status: '115', extra_headers: {hash: '42'} }
        }, {
            send: { version: ['test2'], patches: [{unit: 'json', range: '[2]', content: '2'}] }
        }, {
            send:   { version: ['test3'], patches: [{unit: 'json', range: '[3]', content: '3', hash: '43'}, {unit: 'json', range: '[4]', content: '4'}] },
            expect: { version: ['test3'], patches: [{unit: 'json', range: '[3]', content: '3', extra_headers: {hash: '43'}}, {unit: 'json', range: '[4]', content: '4'}], status: '200' }
        }, {
            send: { version: ['another!'], body: '"!"' }
        }]

        // add a handler that sends all but the last update right away, sends
        // the last one a beat later (so the iterator has to wait mid-loop for
        // an update that hasn't arrived yet), and holds the subscription
        // open. the updates are passed as an arg (the handler runs
        // server-side via eval, so it can't close over test-side variables)
        var endpoint = await add_main_handler((req, res, sends) => {
            res.startSubscription()
            for (var u of sends.slice(0, -1)) res.sendUpdate(u)
            setTimeout(() => res.sendUpdate(sends[sends.length - 1]), 100)
        }, updates.map(u => u.send))

        // subscribe, without multiplexing, to get a plain 209 multiresponse
        var a = new AbortController()
        var r = await fetch(endpoint, { signal: a.signal, subscribe: true, multiplex: false })
        assert(r.status === 209, 'expected a 209 multiresponse')
        assert(!r.multiplexed_through, 'expected request not to be multiplexed')

        // read the updates off the subscription with 'for await' -- each one
        // should match what we sent, in order
        var count = 0
        for await (var u of r.subscription) {
            // the parser hands us bytes; swap in the text forms to compare
            if (u.body != null) u.body = u.body_text
            if (u.patches) for (var p of u.patches) p.content = p.content_text
            var { send, expect } = updates[count]
            assert(JSON.stringify(u) === JSON.stringify(expect ?? { ...send, status: '200' }),
                   `got unexpected update at index ${count}`)
            if (++count === updates.length) break
        }

        a.abort()
    }
)

add_section_header("Write Tests")

run_test(
    "PUT with single patch, not in array",
    async () => {
        // add a handler that parses the incoming update server-side and
        // echoes back what it saw -- the wire headers plus the parse result --
        // so we can check the patch really arrived, not just that the
        // request succeeded
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                method: req.method,
                version: req.version,
                content_range: req.headers['content-range'],
                patches_header: req.headers.patches ?? null,
                parsed_as_body: update.body !== undefined,
                num_patches: update.patches?.length,
                patch: update.patches && {
                    unit: update.patches[0].unit,
                    range: update.patches[0].range,
                    content: update.patches[0].content_text
                }
            }))
        })

        // PUT a single patch as a bare object, not wrapped in an array --
        // the client should accept it as shorthand for an array of one
        var r = await fetch(endpoint, {
            method: 'PUT',
            version: ['test1'],
            patches: {unit: 'json', range: '[0]', content: '"test1"'}
        })
        assert(r.status === 200, `expected 200, got ${r.status}`)
        var seen = JSON.parse(await r.text())

        // the server should see a PUT carrying our version
        assert(seen.method === 'PUT', 'expected the server to see a PUT')
        assert(JSON.stringify(seen.version) === '["test1"]', 'expected version to survive the trip')

        // a single patch should go inline as the request body, described by
        // a content-range header, with no patches: N header
        assert(seen.content_range === 'json [0]', 'expected content-range: json [0]')
        assert(seen.patches_header === null, 'expected no patches header')

        // the server should parse exactly one patch out of it -- not a body
        // snapshot -- with the unit, range, and content we sent
        assert(!seen.parsed_as_body, 'expected patches, not a body')
        assert(seen.num_patches === 1, 'expected exactly one patch')
        assert(seen.patch.unit === 'json', 'expected unit to survive the trip')
        assert(seen.patch.range === '[0]', 'expected range to survive the trip')
        assert(seen.patch.content === '"test1"', 'expected content to survive the trip')
    }
)

run_test(
    "PUT with single patch, in array",
    async () => {
        // add a handler that parses the incoming update server-side and
        // echoes back what it parsed, along with the wire-format headers,
        // so we can see exactly what the client put on the wire
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                version: req.version,
                content_range: req.headers['content-range'] ?? null,
                patches_header: req.headers.patches ?? null,
                parsed_as_body: update.body != null,
                patches: (update.patches ?? []).map(p =>
                    ({ unit: p.unit, range: p.range, content: p.content_text }))
            }))
        })

        // PUT a single patch wrapped in an array, with a random version.
        // snapshot the expected patch first: braid_fetch mutates the patch
        // object in place (content becomes a Uint8Array)
        var v = Math.random().toString(36).slice(2)
        var patch = { unit: 'json', range: '[0]', content: '"test2"' }
        var expected_patch = JSON.stringify(patch)
        var r = await fetch(endpoint, {
            method: 'PUT',
            version: [v],
            patches: [patch]
        })
        assert(r.status === 200, `expected status 200, got ${r.status}`)

        // the server parsed the update as our one patch, not as a body...
        var got = await r.json()
        assert(!got.parsed_as_body, 'expected the update to parse as patches, not a body')
        assert(got.patches.length === 1, `expected 1 patch, got ${got.patches.length}`)
        assert(JSON.stringify(got.patches[0]) === expected_patch,
               `got unexpected patch: ${JSON.stringify(got.patches[0])}`)

        // ...with the version we sent
        assert(JSON.stringify(got.version) === JSON.stringify([v]),
               'expected the version to round-trip')

        // a lone patch -- even wrapped in an array -- should collapse to the
        // simple wire form: its unit and range in a content-range header, its
        // content as the raw request body, and no patches header
        assert(got.content_range === 'json [0]',
               `expected content-range 'json [0]', got ${got.content_range}`)
        assert(got.patches_header === null, 'expected no patches header')
    }
)

run_test(
    "PUT with multiples patches",
    async () => {
        // add a handler that parses the incoming update server-side and
        // echoes back what it saw: the wire headers announcing the patch
        // block, the parsed version, and each patch's unit, range, and
        // text content
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                patches_header: req.headers.patches,
                content_type: req.headers['content-type'],
                version: req.version,
                got_body: update.body !== undefined,
                patches: update.patches.map(p =>
                    ({unit: p.unit, range: p.range, content: p.content_text}))
            }))
        })

        // PUT three patches, each with its own range and content, so a
        // dropped, reordered, or misspliced patch shows up server-side
        var r = await fetch(endpoint, {
            version: ['test3'],
            patches: [
                {unit: 'jsonpath', range: '[0]', content: '"zero"'},
                {unit: 'jsonpath', range: '[1]', content: '"one"'},
                {unit: 'jsonpath', range: '[2]', content: '"two"'}
            ],
            method: 'PUT'
        })
        assert(r.status === 200, 'expected a 200 response')
        var seen = JSON.parse(await r.text())

        // multiple patches must go over the wire as a Patches: N block
        // with the matching http-patches content-type
        assert(seen.patches_header === '3', 'expected a Patches: 3 header')
        assert(seen.content_type === 'application/http-patches; count=3', 'expected the http-patches content-type')

        // the version should ride along as a header and parse server-side
        assert(JSON.stringify(seen.version) === JSON.stringify(['test3']), 'expected the version to survive the trip')

        // the server must parse three patches -- not a body -- in order,
        // each keeping its own unit, range, and content
        assert(!seen.got_body, 'expected patches rather than a body')
        assert(seen.patches.length === 3, 'expected exactly three patches')
        assert(seen.patches.every(p => p.unit === 'jsonpath'), 'expected every patch to keep its unit')
        assert(seen.patches.map(p => p.range).join(' ') === '[0] [1] [2]', 'expected the patches to keep their ranges, in order')
        assert(seen.patches.map(p => p.content).join(' ') === '"zero" "one" "two"', 'expected the patches to keep their contents, in order')
    }
)

run_test(
    "PUT with empty patches array",
    async () => {
        // add a handler that parses the incoming update and echoes back what
        // the server saw: the patch-count headers on the wire, and what
        // parseUpdate() made of them
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
                patches_header: req.headers.patches,
                content_type: req.headers['content-type'],
                version: req.version,
                patches_is_array: Array.isArray(update.patches),
                num_patches: update.patches?.length,
                body: update.body ?? null
            }))
        })

        // PUT an update with an empty patches array
        var version = Math.random().toString(36).slice(2)
        var r = await fetch(endpoint, {
            version: [version],
            patches: [],
            method: 'PUT'
        })

        // the PUT should succeed
        assert(r.status === 200, `expected 200, got ${r.status}`)
        var got = await r.json()

        // the client should have sent the update as a zero-count patches
        // block, not as a body snapshot
        assert(got.patches_header === '0', 'expected a Patches: 0 header')
        assert(/http-patches\s*;.*count=0/.test(got.content_type),
               'expected content-type with count=0')

        // the version should have come through
        assert(got.version.length === 1 && got.version[0] === version,
               'got unexpected version')

        // and the server should have parsed it as zero patches, with no body
        assert(got.patches_is_array && got.num_patches === 0,
               'expected an empty patches array')
        assert(got.body === null, 'expected no body')
    }
)

add_section_header('Testing braid wrapper for node http(s).get')

run_test(
    "Subscribe and receive multiple updates",
    async () => {
        // the updates the server will send, in an assortment of braid wire
        // formats: a snapshot body, an inline patch with a custom status and
        // an extra header, a single patch in "Patches: N" form, and two
        // patches in one update (one carrying its own extra header)
        var sends = [
            { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) },
            { version: ['test1'], parents: ['oldie', 'goodie'], status: 115, hash: '42', patch: {unit: 'json', range: '[1]', content: '1'} },
            { version: ['test2'], patches: [{unit: 'json', range: '[2]', content: '2'}] },
            { version: ['test3'], patches: [{unit: 'json', range: '[3]', content: '3', hash: '43'}, {unit: 'json', range: '[4]', content: '4'}] },
            { version: ['another!'], body: '"!"' }
        ]

        // add a handler that records whether each request asks for a
        // subscription (keyed by a random id, read back at the end), then
        // sends the updates above -- all but the last right away, and the
        // last one a beat later, so it arrives in a separate chunk
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s, sends) => {
            global['_subs_' + s] = (global['_subs_' + s] ?? []).concat(!!req.subscribe)
            res.startSubscription()
            for (var u of sends.slice(0, -1)) res.sendUpdate(u)
            setTimeout(() => res.sendUpdate(sends[sends.length - 1]), 100)
        }, s, sends)

        // the braid wrapper for node's https.get lives server-side, so the
        // subscribing runs there too (via eval): collect updates as the
        // wrapper parses them off the stream, and after the last one, tear
        // down the subscription and ship them back. (the endpoint's path and
        // the update count are passed as args, since this function can't
        // close over test variables)
        var updates = JSON.parse(await server_eval((req, res, path, count) => {
            var updates = []
            var g = https.get(`https://localhost:${port}${path}`,
                              {subscribe: true, rejectUnauthorized: false}, r => {
                r.on('update', update => {
                    // raw bodies and patch contents are binary, which doesn't
                    // survive the trip back as json -- convert them to text
                    if (update.body != null) update.body = update.body_text
                    if (update.patches) for (var p of update.patches) p.content = p.content_text
                    updates.push(update)
                    if (updates.length === count) {
                        g.destroy()
                        res.end(JSON.stringify(updates))
                    }
                })
            })
        }, endpoint.slice(base_url.length), sends.length))

        // the parsed updates should mirror what we sent, with a few
        // systematic differences: an inline patch: comes back as a
        // one-element patches: array, a non-braid header (here: hash) comes
        // back under extra_headers on whatever carried it, and every update
        // gets a string status -- the one we set, or the default 200
        var hash_to_extra = ({hash, ...x}) => hash ? {...x, extra_headers: {hash}} : x
        var to_expected = u => hash_to_extra({
            ...u,
            patch: undefined,
            patches: (u.patch ? [u.patch] : u.patches)?.map(hash_to_extra),
            status: `${u.status ?? 200}`
        })

        // compare as json with object keys sorted, so key order doesn't matter
        // (and json drops the undefined fields for us)
        var stable = x => JSON.stringify(x, (k, v) =>
            v?.constructor === Object ? Object.fromEntries(Object.entries(v).sort()) : v)
        assert(updates.length === sends.length, 'expected five updates')
        for (var i = 0; i < sends.length; i++)
            assert(stable(updates[i]) === stable(to_expected(sends[i])),
                   `got unexpected update #${i}`)

        // make sure the wrapper really hit our endpoint -- exactly once, and
        // with the subscribe header set (adding that header is the wrapper's
        // whole job on the request side)
        var subs = JSON.parse(await server_eval((req, res, s) =>
            res.end(JSON.stringify(global['_subs_' + s] ?? [])), s))
        assert(subs.length === 1, 'expected exactly one request to the endpoint')
        assert(subs[0] === true, 'expected the request to ask for a subscription')
    }
)

run_test(
    "PUT with single patch, not in array",
    async () => {
        // a random marker used as both the version and the patch content
        // below, so we can check exactly where it shows up in the arriving
        // request (spoiler: nowhere -- see the assertions at the end)
        var marker = Math.random().toString(36).slice(2)

        // add a handler that records what actually arrives on the wire --
        // the method, every header, and the raw body -- and echoes it all
        // back, so we can see exactly what the wrapper sent
        var endpoint = await add_main_handler((req, res) => {
            var chunks = []
            req.on('data', chunk => chunks.push(chunk))
            req.on('end', () => {
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify({
                    method: req.method,
                    headers: req.headers,
                    body: Buffer.concat(chunks).toString()
                }))
            })
        })

        // on the server -- the node wrapper only exists there -- PUT a
        // single bare patch object (not wrapped in an array) through the
        // braidified https.get, and relay the status and body its callback
        // sees. reading the response with .on('data')/.on('end') exercises
        // the wrapper's callback rewiring, which must still forward normal
        // (non-'update') events. (endpoint and marker are passed as args,
        // since this function is eval'd in the server's scope)
        var got = JSON.parse(await server_eval((req, res, endpoint, marker) => {
            https.get(endpoint, {
                version: [marker],
                patches: {unit: 'json', range: '[0]', content: JSON.stringify(marker)},
                method: 'PUT',
                rejectUnauthorized: false
            }, put_res => {
                var body = ''
                put_res.on('data', chunk => body += chunk)
                put_res.on('end', () => res.end(JSON.stringify({
                    status: put_res.statusCode, body
                })))
            })
        }, endpoint, marker))

        // make sure the put succeeded, and that its response body came back
        // intact through the wrapped callback
        assert(got.status === 200, `expected the put to return 200, got ${got.status}`)
        var seen = JSON.parse(got.body)

        // make sure the wrapper really sent a PUT to our endpoint -- the old
        // form of this test hit /json, which 200s every PUT, so it passed
        // without proving anything reached the server
        assert(seen.method === 'PUT', 'expected the wrapper to send a PUT')

        // you might expect the version and patch to arrive here -- they do
        // not. the node wrapper braidifies the *response* side (subscribe +
        // .on('update')) and passes request options straight through to
        // node's https.get, which ignores braid options like version: and
        // patches: -- it does not serialize them into headers or a body the
        // way braid_fetch does. what this test pins down is that they also
        // don't corrupt the request: the put arrives plain and empty-bodied,
        // and the marker shows up nowhere in it. (if the wrapper ever learns
        // to send patches, these assertions are the ones to update)
        assert(seen.headers.version === undefined, 'expected no version header on the wire')
        assert(seen.headers['content-range'] === undefined, 'expected no content-range header on the wire')
        assert(seen.headers.patches === undefined, 'expected no patches header on the wire')
        assert(seen.body === '', 'expected an empty request body')
        assert(!JSON.stringify(seen).includes(marker),
               'expected the version/patch marker nowhere in the arriving request')
    }
)

run_test(
    "PUT with single patch, in array",
    async () => {
        // calling the wrapped https.get with braid write options (version,
        // patches) must still issue a working PUT. note the wrapper only
        // implements subscribe + update parsing -- write options are passed
        // through to node's https, which ignores them, and .get() ends the
        // request immediately -- so what actually goes over the wire is a
        // plain bodiless PUT. we pin that contract down here; if the wrapper
        // ever learns to send patches, this test should start asserting that
        // the patch arrives instead

        // add a handler that echoes back what the server actually received:
        // the method, any braid write headers, and the body length
        var endpoint = await add_main_handler((req, res) => {
            var chunks = []
            req.on('data', chunk => chunks.push(chunk))
            req.on('end', () => {
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({
                    method: req.method,
                    version: req.headers.version ?? null,
                    content_range: req.headers['content-range'] ?? null,
                    patches: req.headers.patches ?? null,
                    body_length: Buffer.concat(chunks).length
                }))
            })
        })

        // the wrapped https.get only exists on the server (it wraps node's
        // https module), so make the PUT from there, with a single patch in
        // an array. read the response back through the wrapper's forwarded
        // .on('data')/.on('end') events, checking that the wrapped callback
        // still behaves like a normal node response
        var result = JSON.parse(await server_eval((req, res, endpoint) => {
            https.get(endpoint, {
                version: ['test2'],
                patches: [{unit: 'json', range: '[0]', content: '"test2"'}],
                method: 'PUT',
                rejectUnauthorized: false
            }, put_res => {
                var body = ''
                put_res.on('data', chunk => body += chunk)
                put_res.on('end', () => res.end(JSON.stringify({
                    status: put_res.statusCode,
                    seen: JSON.parse(body)
                })))
            })
        }, endpoint))

        // the callback should have gotten a normal 200 response
        assert(result.status === 200, 'expected a 200 response')

        // the server should have received the PUT on our endpoint...
        assert(result.seen.method === 'PUT', 'expected the server to see a PUT')

        // ...as plain http: node ignores the braid-specific options, so no
        // version or patch headers -- and no patch content -- hit the wire
        assert(result.seen.version === null, 'expected no version header')
        assert(result.seen.content_range === null, 'expected no content-range header')
        assert(result.seen.patches === null, 'expected no patches header')
        assert(result.seen.body_length === 0, 'expected an empty request body')
    }
)

run_test(
    "PUT with multiples patches",
    async () => {
        // add a handler that parses the incoming braid update and echoes back
        // what braidify saw -- the version, the Patches header, and each
        // patch's unit/range/content -- so we can check what actually crossed
        // the wire
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
                version: req.version,
                patches_header: req.headers.patches,
                patches: (update.patches || []).map(p =>
                    ({ unit: p.unit, range: p.range, content: p.content_text }))
            }))
        })

        // three patches with distinct contents, so we can tell they arrive
        // complete and in order. we snapshot what we're sending as json now,
        // because fetch encodes each patch's content in place as it sends
        var v = Math.random().toString(36).slice(2)
        var patches = [
            { unit: 'json', range: '[0]', content: '"zero"' },
            { unit: 'json', range: '[1]', content: '"one"' },
            { unit: 'json', range: '[2]', content: '"two"' }
        ]
        var sent = patches.map(p => JSON.stringify(p))

        // PUT them with braid_fetch -- multiple patches should get serialized
        // into a Patches: N block on the wire
        var r = await fetch(endpoint, {
            method: 'PUT',
            version: [v],
            patches
        })

        // make sure the PUT succeeded
        assert(r.status === 200, 'expected the PUT to return 200')

        // make sure the client really used the multi-patch wire format
        var echoed = await r.json()
        assert(echoed.patches_header === '3', 'expected a Patches: 3 header')

        // make sure the version and all three patches survived the round trip
        assert(echoed.version.length === 1 && echoed.version[0] === v,
               'expected the version to survive the wire')
        assert(echoed.patches.length === patches.length,
               'expected all three patches to arrive')
        for (var i = 0; i < patches.length; i++)
            assert(JSON.stringify(echoed.patches[i]) === sent[i],
                   `expected patch ${i} to arrive intact and in order`)
    }
)

run_test(
    "PUT with empty patches array",
    async () => {
        // add a handler that reports back what the wrapper's PUT actually
        // looked like on the wire: the method, and how many patches and
        // body bytes a braid server parses out of it
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                method: req.method,
                num_patches: update.patches?.length ?? 0,
                body_bytes: update.body?.length ?? 0
            }))
        })

        // do a PUT with an empty patches array through the braid wrapper
        // for node's https.get -- node's https module doesn't exist in the
        // browser, so this runs server-side -- and relay the status code
        // and the handler's report back to the test
        var result = JSON.parse(await server_eval((req, res, endpoint) => {
            // the endpoint is a bare path when this test runs in the browser
            var url = endpoint.startsWith('http')
                ? endpoint : `https://localhost:${port}${endpoint}`
            https.get(url, {
                version: ['test4'],
                patches: [],
                method: 'PUT',
                rejectUnauthorized: false
            }, r => {
                var body = ''
                r.on('data', chunk => body += chunk)
                r.on('end', () => res.end(JSON.stringify(
                    { status: r.statusCode, ...JSON.parse(body) })))
            })
        }, endpoint))

        // the put should succeed
        assert(result.status === 200, 'expected the PUT to return 200')

        // and it should really have reached our endpoint as a PUT
        assert(result.method === 'PUT', 'expected the server to receive a PUT')

        // an empty patches array means an empty update: no patches -- and
        // no stray body bytes -- should arrive on the wire
        assert(result.num_patches === 0, 'expected no patches in the parsed update')
        assert(result.body_bytes === 0, 'expected an empty update body')
    }
)

add_section_header('Testing braid wrapper for node fetch')

run_test(
    "Subscribe and receive multiple updates",
    async () => {
        // the updates to stream, paired with what the client should hand
        // back: keys normalized to lowercase, a singular patch: as a patches
        // array, hash surfacing in extra_headers (on an update and on a
        // patch), and a per-update :status override. updates without an
        // explicit expect should come back exactly as sent, plus the default
        // 200 status
        var updates = [
            { send: { version: ['test'], parents: ['oldie'],
                      body: JSON.stringify({this: 'stuff'}) } },
            { send: { VersiOn: ['test1'], ParEnts: ['oldie', 'goodie'],
                      patch: {unit: 'json', range: '[1]', content: '1'},
                      hash: '42', ':status': '115' },
              expect: { version: ['test1'], parents: ['oldie', 'goodie'],
                        patches: [{unit: 'json', range: '[1]', content: '1'}],
                        status: '115', extra_headers: {hash: '42'} } },
            { send: { Version: ['test2'],
                      patch: {unit: 'json', range: '[2]', content: '2'} },
              expect: { version: ['test2'],
                        patches: [{unit: 'json', range: '[2]', content: '2'}],
                        status: '200' } },
            { send: { version: ['test3'],
                      patches: [{unit: 'json', range: '[3]', content: '3', hash: '43'},
                                {unit: 'json', range: '[4]', content: '4'}] },
              expect: { version: ['test3'],
                        patches: [{unit: 'json', range: '[3]', content: '3', extra_headers: {hash: '43'}},
                                  {unit: 'json', range: '[4]', content: '4'}],
                        status: '200' } },
            { send: { version: ['another!'], body: '"!"' } }
        ]
        var expected = updates.map(u => u.expect || { ...u.send, status: '200' })

        // add a handler that streams those updates over a subscription,
        // holding the last one back 200ms so the subscription really streams
        // over time. the updates are passed as an arg (the handler runs
        // server-side via eval, so it can't close over test-side variables)
        var endpoint = await add_main_handler((req, res, to_send) => {
            res.startSubscription()
            for (var u of to_send.slice(0, -1)) res.sendUpdate(u)
            setTimeout(() => res.sendUpdate(to_send[to_send.length - 1]), 200)
        }, updates.map(u => u.send))

        // this section tests the *node* braid_fetch, so run it on the server
        // with server_eval: subscribe to the endpoint, collect all the
        // updates, then end the subscription and echo everything back (with
        // bodies and patch contents decoded to text so they survive the json
        // trip). the endpoint path is passed as an arg, since this function
        // is eval'd in the server's scope and can't close over test variables
        var pathname = endpoint.startsWith('http') ? new URL(endpoint).pathname : endpoint
        var got = await server_eval(async (req, res, pathname, count) => {
            if (typeof fetch === 'undefined') return res.end('old node version')

            var a = new AbortController()
            var r = await braid_fetch(`https://localhost:${port}${pathname}`, {
                signal: a.signal,
                subscribe: true,
                multiplex: false
            })

            var received = []
            r.subscribe(update => {
                if (update.body != null) update.body = update.body_text
                if (update.patches) for (var p of update.patches) p.content = p.content_text
                received.push(update)
                if (received.length === count) {
                    res.end(JSON.stringify({status: r.status, multiplexed: !!r.multiplexed_through, received}))
                    a.abort()
                }
            })
        }, pathname, expected.length)

        // old node has no global fetch server-side, so braid_fetch can't run
        // there; nothing to assert in that case (counts as a pass)
        if (got === 'old node version') return
        var {status, multiplexed, received} = JSON.parse(got)

        // the subscription should have been answered with 209, and
        // multiplex: false should have kept it off any multiplexer
        assert(status === 209, `expected a 209 subscription response, got ${status}`)
        assert(!multiplexed, 'expected the request not to be multiplexed')

        // each update should come back matching its expected form, in order
        assert(received.length === expected.length, `expected ${expected.length} updates, got ${received.length}`)
        for (var i = 0; i < expected.length; i++)
            assert(JSON.stringify(received[i]) === JSON.stringify(expected[i]),
                   `update ${i} came through wrong: got ${JSON.stringify(received[i])}`)
    }
)

run_test(
    "PUT with single patch, not in array",
    async () => {
        // add a handler that parses the incoming put with braidify and echoes
        // back what it saw: the parsed version, the patch-related headers, and
        // the parsed patches themselves
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
                version: req.version,
                content_range: req.headers['content-range'] ?? null,
                patches_header: req.headers.patches ?? null,
                got_body: update.body != null,
                patches: (update.patches ?? []).map(p =>
                    ({unit: p.unit, range: p.range, content: p.content_text}))
            }))
        })

        // now, *on the server*, PUT to that endpoint with braid_fetch, passing
        // a single bare patch object -- not wrapped in an array -- as the
        // patches option, and echo back the response status and body. (this
        // section tests the braid wrapper for node fetch, so the client under
        // test must run server-side; endpoint is passed as an arg, since this
        // function is eval'd in the server's scope)
        var got = await server_eval(async (req, res, endpoint) => {
            if (typeof fetch === 'undefined') return res.end('old node version')

            var r = await braid_fetch(endpoint, {
                version: ['test1'],
                patches: {unit: 'json', range: '[0]', content: '"test1"'},
                method: 'PUT'
            })
            res.end(JSON.stringify({ status: r.status, echoed: await r.json() }))
        }, endpoint)

        // old node has no global fetch server-side, so braid_fetch can't run
        // there; nothing to assert in that case (counts as a pass)
        if (got === 'old node version') return
        var { status, echoed } = JSON.parse(got)

        // the put should have succeeded
        assert(status === 200, 'expected the PUT to return 200')

        // the version should have made the trip intact
        assert(JSON.stringify(echoed.version) === JSON.stringify(['test1']),
               'expected the version to arrive intact')

        // a lone patch should be sent inline -- a content-range header with
        // the patch content as the request body -- not as a Patches: N block
        assert(echoed.content_range === 'json [0]', 'expected the patch inline via content-range')
        assert(echoed.patches_header === null, 'expected no patches: n header for a single patch')

        // and braidify should parse it back out as exactly that one patch,
        // rather than as a request body
        assert(!echoed.got_body, 'expected the content to arrive as a patch, not a body')
        assert(JSON.stringify(echoed.patches) ===
               JSON.stringify([{unit: 'json', range: '[0]', content: '"test1"'}]),
               'expected the single patch to arrive intact')
    }
)

run_test(
    "PUT with single patch, in array",
    async () => {
        // giving braid_fetch a one-element patches ARRAY should work just
        // like giving it the bare patch: it gets sent in the single-patch
        // wire form (the unit and range in a Content-Range header, the
        // content as the request body, no Patches: N header)

        // add a handler that parses the incoming PUT as a braid update and
        // echoes back what actually arrived: the wire-form headers, plus the
        // parsed version and patches
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                content_range: req.headers['content-range'],
                patches_header: req.headers.patches ?? null,
                version: req.version,
                body: update.body ? update.body_text : null,
                patches: (update.patches ?? []).map(
                    p => ({unit: p.unit, range: p.range, content: p.content_text}))
            }))
        })

        // this section tests the node client, so run braid_fetch *on the
        // server*, PUTting one patch wrapped in an array, and pass back the
        // response status along with the handler's echo of the request.
        // the patch carries a random value v, so the echo can prove that
        // this very request round-tripped
        var v = Math.random().toString(36).slice(2)
        var got = await server_eval(async (req, res, endpoint, v) => {
            if (typeof fetch === 'undefined') return res.end('old node version')

            // in the browser runner, endpoint is a relative path
            if (!endpoint.startsWith('http'))
                endpoint = 'https://localhost:' + port + endpoint

            var r = await braid_fetch(endpoint, {
                method: 'PUT',
                version: [v],
                patches: [{unit: 'json', range: '[0]', content: JSON.stringify(v)}]
            })
            res.end(JSON.stringify({ status: r.status, echo: JSON.parse(await r.text()) }))
        }, endpoint, v)

        // old node has no global fetch server-side, so braid_fetch can't run
        // there; nothing to assert in that case (counts as a pass)
        if (got === 'old node version') return
        var { status, echo } = JSON.parse(got)

        // the PUT should have succeeded...
        assert(status === 200, 'expected the PUT to return 200')

        // ...in the single-patch wire form: the one-element array collapses
        // to a Content-Range header, with no Patches: N header
        assert(echo.content_range === 'json [0]',
               'expected the patch to be sent as a Content-Range header')
        assert(echo.patches_header === null,
               'expected no Patches: N header for a single patch')

        // and the server should have parsed back exactly the update we sent
        assert(echo.version.length === 1 && echo.version[0] === v,
               'expected the version to round-trip')
        assert(echo.body === null, 'expected a patch, not a body snapshot')
        assert(echo.patches.length === 1, 'expected exactly one patch')
        assert(echo.patches[0].unit === 'json'
               && echo.patches[0].range === '[0]'
               && echo.patches[0].content === JSON.stringify(v),
               'expected the patch to round-trip')
    }
)

run_test(
    "PUT with multiples patches",
    async () => {
        // add a handler that parses the incoming put and echoes back what the
        // server actually received: the parsed version, the raw Patches header
        // from the wire, and each parsed patch's unit/range/content
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
                version: req.version,
                patches_header: req.headers.patches,
                patches: update.patches.map(p => ({unit: p.unit, range: p.range, content: p.content_text}))
            }))
        })

        // this section is about the node braid_fetch running over node's
        // native fetch, so make the put server-side with server_eval: put
        // three patches with a random version to the echo endpoint above
        // (the endpoint's path, version, and patches are passed as args,
        // since this function is eval'd in the server's scope)
        var v = Math.random().toString(36).slice(2)
        var patches = [0, 1, 2].map(i => ({unit: 'jsonpath', range: `[${i}]`, content: `"${v}${i}"`}))
        var pathname = new URL(endpoint, 'https://x').pathname
        var got = await server_eval(async (req, res, pathname, v, patches) => {
            if (typeof fetch === 'undefined') return res.end('old node version')
            var r = await braid_fetch(`https://localhost:${port}${pathname}`, {
                method: 'PUT',
                version: [v],
                patches
            })
            res.end(JSON.stringify({ status: r.status, echo: JSON.parse(await r.text()) }))
        }, pathname, v, patches)

        // old node has no global fetch server-side, so braid_fetch has no
        // node-fetch transport to run over there; nothing to assert in that case
        if (got === 'old node version') return
        var { status, echo } = JSON.parse(got)

        // the put should succeed
        assert(status === 200, 'expected 200 response')

        // the patches should have crossed the wire as a Patches: 3 block, and
        // the server should have parsed back all three intact, plus the version
        assert(echo.patches_header === '3', 'expected a Patches: 3 header on the wire')
        assert(JSON.stringify(echo.patches) === JSON.stringify(patches), 'expected all three patches to arrive intact')
        assert(JSON.stringify(echo.version) === JSON.stringify([v]), 'expected the version to arrive intact')
    }
);

run_test(
    "PUT with empty patches array",
    async () => {
        // add a handler that parses the incoming update with braidify's
        // req.parseUpdate(), and echoes back what it saw: the raw patch
        // headers, the parsed version, and the shape of the parsed update
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
                version: req.version,
                patches_header: req.headers.patches,
                content_type: req.headers['content-type'],
                patches_is_array: Array.isArray(update.patches),
                num_patches: update.patches?.length,
                has_body: update.body !== undefined
            }))
        })

        // put an empty patches array to it (multiplex: false keeps this a
        // plain http put, independent of the global multiplexing knobs)
        var r = await fetch(endpoint, {
            method: 'PUT',
            version: ['test4'],
            patches: [],
            multiplex: false
        })

        // the put should succeed (all the old test checked)
        assert(r.status === 200, 'expected a 200 response')
        var echo = JSON.parse(await r.text())

        // the client should encode the empty array as a `Patches: 0` block,
        // not as a single patch or a body snapshot
        assert(echo.patches_header === '0', 'expected the empty array to go out as Patches: 0')
        assert(echo.content_type.includes('http-patches; count=0'),
               'expected an http-patches content-type declaring count=0')

        // and the server should parse the empty block back into an empty
        // patches array -- not mistake the empty body for a snapshot
        assert(echo.patches_is_array && echo.num_patches === 0,
               'expected the server to parse an empty patches array')
        assert(!echo.has_body, 'expected no body snapshot')

        // the version should survive the round trip too
        assert(JSON.stringify(echo.version) === JSON.stringify(['test4']),
               'expected the server to parse the version')
    }
)

add_section_header("Retry Tests")

run_test(
    "Verify that retry.retryRes gets heeded when true.",
    async () => {
        // add a handler that 500s the first request and succeeds after that,
        // counting its hits in a global keyed by a random id so we can check
        // server-side that the retry really happened (the id is passed as an
        // arg since the handler runs server-side via eval, and can't close
        // over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            var hits = global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            if (hits === 1) res.statusCode = 500
            res.end(`attempt ${hits}`)
        }, s)

        // fetch it with retryRes forcing a retry: retry alone would just
        // resolve with the 500 (it's not a retryable status), but retryRes
        // returning true tells the client to retry anyway. record each status
        // retryRes gets consulted with, to make sure it actually ran
        var consulted = []
        var r = await fetch(endpoint, {
            multiplex: false,
            retry: {
                retryRes: res => {
                    consulted.push(res.status)
                    return true
                }
            }
        })

        // the fetch should have resolved with the second (successful)
        // attempt, not the initial 500
        assert(r.status === 200, `expected the retried response, got ${r.status}`)
        assert(await r.text() === 'attempt 2', 'expected the second attempt body')

        // retryRes should have been consulted exactly once, with the 500
        assert(consulted.length === 1 && consulted[0] === 500,
               `expected retryRes to be consulted with [500], got ${JSON.stringify(consulted)}`)

        // double-check with the server that the request was really sent twice
        var hits = await server_eval((req, res, s) =>
            res.end(`${global['_hits_' + s]}`), s)
        assert(hits === '2', `expected the server to be hit twice, got ${hits}`)
    }
)

run_test(
    "Verify that retry.retryRes gets heeded when false.",
    async () => {
        // add a handler that counts its hits in a keyed global and responds
        // 425 -- a status the default retry logic would otherwise retry, so
        // the client only stops if it really heeds retryRes returning false
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.statusCode = 425
            res.end('ok')
        }, s)

        // fetch with a retryRes that refuses the retry, recording the
        // statuses it gets consulted with. if the false were ignored, the
        // client would reconnect forever and this await would never resolve,
        // spinning until the test runner's timeout fails the test
        var consulted = []
        var r = await fetch(endpoint, {
            multiplex: false,
            retry: {
                retryRes: (res) => {
                    consulted.push(res.status)
                    return false
                }
            }
        })

        // giving up hands the failing response back to the caller intact
        assert(r.status === 425, 'expected the 425 response, got ' + r.status)
        assert(await r.text() === 'ok', 'got unexpected body')

        // make sure retryRes was really consulted, once, with the response
        assert(consulted.length === 1 && consulted[0] === 425,
               'expected retryRes to be consulted once with the 425, got ' + JSON.stringify(consulted))

        // and the server saw exactly one request: no retry ever went out
        var hits = await server_eval((req, res, s) =>
            res.end('' + (global['_hits_' + s] ?? 0)), s)
        assert(hits === '1', 'expected exactly one request, got ' + hits)
    }
)

run_test(
    "Verify that setting retry as function gets heeded when true.",
    async () => {
        // add a handler that 500s the first request and succeeds after that,
        // counting hits in a global keyed by our random id so we can read the
        // count back later with server_eval
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            var hits = global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.statusCode = hits === 1 ? 500 : 200
            res.end(hits === 1 ? 'nope' : 'woohoo')
        }, s)

        // fetch it with retry set to a function that always says to retry.
        // the default retry logic gives up on a plain 500 (the fetch would
        // just resolve with the 500), so getting a 200 back proves our
        // function overrode it; record what the function gets called with
        var retry_statuses = []
        var r = await fetch(endpoint, {
            multiplex: false,
            retry: res => {
                retry_statuses.push(res.status)
                return true
            }
        })

        // the retry function should have been consulted exactly once,
        // with the failing 500 response
        assert(retry_statuses.length === 1, 'expected the retry function to be called exactly once')
        assert(retry_statuses[0] === 500, 'expected the retry function to see the 500 response')

        // and the fetch should have resolved with the successful retry
        assert(r.status === 200, 'expected the fetch to resolve with the retried 200')
        assert(await r.text() === 'woohoo', 'expected the body from the successful retry')

        // make sure the server really saw two requests: the original, and the retry
        var hits = await server_eval((req, res, s) =>
            res.end('' + (global['_hits_' + s] ?? 0)), s)
        assert(hits === '2', 'expected exactly two requests to reach the server')
    }
)

run_test(
    "Verify that setting retry as function gets heeded when false.",
    async () => {
        // add a handler that always responds 425 Too Early, counting its
        // hits in a global keyed by a random id (passed as an arg, since the
        // handler runs server-side and can't close over test variables), so
        // we can prove later exactly how many requests reached the server
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.writeHead(425)
            res.end('')
        }, s)

        // fetch it with a retry function that records each response it is
        // consulted about and always says no. 425 is one of the statuses
        // that plain retry: true silently retries, so if the client ignored
        // the function and fell back to the default policy, it would retry
        // forever and this fetch would never resolve
        var consulted = []
        var r = await fetch(endpoint, {
            retry: (res) => {
                consulted.push(res.status)
                return false
            }
        })

        // saying no should make the fetch give up and resolve with the 425
        assert(r.status === 425, `expected the fetch to resolve with the 425, got ${r.status}`)

        // the retry function was really consulted, once, with the response
        assert(consulted.length === 1 && consulted[0] === 425,
               `expected the retry function to be consulted once with the 425, saw ${JSON.stringify(consulted)}`)

        // and the server saw exactly one request: the client never retried
        var hits = await server_eval((req, res, s) =>
            res.end('' + (global['_hits_' + s] ?? 0)), s)
        assert(hits === '1', `expected the server to see exactly 1 request, saw ${hits}`)
    }
)

run_test(
    "Verify that we retry on 503",
    async () => {
        // add a handler that 503s on its first hit and succeeds on its
        // second, counting hits in a global keyed by a random id (the handler
        // runs server-side via eval, so it can't close over test-side
        // variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            if (global['_hits_' + s] === 1) {
                res.statusCode = 503
                res.end('unavailable')
            } else res.end('recovered')
        }, s)

        // fetch with retry: true -- the client should treat the 503 as
        // transient and silently retry, so this promise resolves with the
        // second attempt's response. multiplex: false keeps concurrent
        // tests' multiplexing knobs out of the picture
        var attempts = 0
        var r = await fetch(endpoint, {
            retry: true,
            multiplex: false,
            onFetch: () => attempts++
        })

        // the fetch resolved with the retried request's 200, not the 503
        assert(r.status === 200, `expected status 200, got ${r.status}`)
        assert(await r.text() === 'recovered', `expected the retried request's body`)

        // the client really sent two requests: the 503'd one and the retry
        assert(attempts === 2, `expected 2 fetch attempts, got ${attempts}`)

        // and both really reached the server
        var hits = await server_eval((req, res, s) =>
            res.end('' + (global['_hits_' + s] ?? 0)), s)
        assert(hits === '2', `expected the server to see 2 requests, got ${hits}`)
    }
)

run_test(
    "Verify that we retry on 400 Missing Parents",
    async () => {
        // retry: true gives up on a plain 400 (see "Should not retry on HTTP
        // 400"), unless the status line's reason phrase says "Missing
        // Parents". reason phrases only exist in http/1.1 -- the main test
        // server speaks http/2 in the browser -- so this test uses the
        // wrapper server (port + 2), which is plain https/1.1

        // add a handler that answers the first request with 400 Missing
        // Parents and succeeds after that, counting its hits in a global
        // keyed by a random id (passed as an arg, since the handler runs
        // server-side via eval and can't close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_wrapper_handler((req, res, s) => {
            var hits = global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            if (hits === 1) {
                res.writeHead(400, 'Missing Parents', { 'Content-Type': 'text/plain' })
                res.end('missing parents!')
            } else res.end(`attempt ${hits}`)
        }, s)

        // fetch it with plain retry: true, multiplex off (a multiplexed
        // response wouldn't carry the reason phrase). a bare 400 would
        // resolve immediately, so the only way to get the second attempt's
        // response is for "Missing Parents" to have triggered a retry
        var r = await fetch(endpoint, { retry: true, multiplex: false })

        // the fetch should resolve with the retried (successful) attempt,
        // not the initial 400
        assert(r.status === 200, `expected the retried response, got ${r.status}`)
        assert(await r.text() === 'attempt 2', 'expected the second attempt body')

        // double-check with the server that the retry was really re-sent
        // over the wire (all the test servers share one process, so the main
        // server's eval route can read the wrapper handler's counter)
        var hits = await server_eval((req, res, s) =>
            res.end(`${global['_hits_' + s]}`), s)
        assert(hits === '2', `expected the server to be hit twice, got ${hits}`)
    }
)

run_test(
    "Verify that we retry when Retry-After is set",
    async () => {
        // add a handler that answers the first request with a 500 carrying a
        // Retry-After header and succeeds after that, counting hits in a
        // global keyed by our random id so we can read the count back later
        // with server_eval
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            var hits = global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            if (hits === 1) {
                res.statusCode = 500
                res.setHeader('Retry-After', '0')
                res.end('nope')
            } else res.end('woohoo')
        }, s)

        // fetch it with retry on. the default retry logic gives up on a
        // plain 500 (the fetch would just resolve with the 500), but a
        // Retry-After header marks the failure as transient, so the client
        // should retry anyway and resolve with the successful retry
        var r = await fetch(endpoint, { multiplex: false, retry: true })
        assert(r.status === 200, 'expected the fetch to resolve with the retried 200, got ' + r.status)
        assert(await r.text() === 'woohoo', 'expected the body from the successful retry')

        // make sure the retry really went out: the server saw exactly two
        // requests, the original and the retry
        var hits = await server_eval((req, res, s) =>
            res.end('' + (global['_hits_' + s] ?? 0)), s)
        assert(hits === '2', 'expected exactly two requests to reach the server, got ' + hits)
    }
)

run_test(
    "Verify that unparsable headers do not result in retrying connection.",
    async () => {
        // add a handler that starts a subscription and then writes a garbage
        // update -- its second header line is missing the colon, so the
        // client's parser will choke on it. it also counts its hits in a
        // global keyed by our random id, so we can check below exactly how
        // many times the client connected
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.startSubscription()
            res.write('hello: true\r\n')
            res.write('hello\r\n')
            res.write('Content-Length: 2\r\n')
            res.write('\r\n')
            res.write('hi')
        }, s)

        // subscribe with retry enabled, counting responses as they arrive --
        // a retried connection would produce a second response
        var a = new AbortController()
        var responses = 0
        var r = await fetch(endpoint, {
            subscribe: true,
            multiplex: false,
            signal: a.signal,
            retry: { onRes: () => responses++ }
        })

        // read the subscription until it dies. the client only reports an
        // error here on its give-up path -- if it wrongly treated the parse
        // error as retryable, it would schedule a reconnect instead, this
        // promise would never resolve, and the test would time out
        var e = await new Promise(done => r.subscribe(u => {}, done))

        // make sure it died with the parse error itself
        assert('' + e === 'ParseError: Parse error in headers: "hello: true\\r\\nhello\\r\\nContent-Length: 2\\r\\n\\r\\n"',
               'expected the parse error')

        // make sure the client saw exactly one response, and the server saw
        // exactly one connection -- i.e. the garbage really was served, once
        assert(responses === 1, 'expected exactly one response')
        var hits = await server_eval((req, res, s) =>
            res.end('' + (global['_hits_' + s] ?? 0)), s)
        assert(hits === '1', 'expected the server to see exactly one connection')

        a.abort()
    }
)

run_test(
    "Should not retry on HTTP 400",
    async () => {
        // add a handler that counts its hits in a global keyed by a random
        // id, and answers 400 only on the first hit -- so if the client
        // wrongly retries, the retry gets a 200 saying 'retried!' instead,
        // and the asserts below catch it
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            if (global['_hits_' + s] > 1) {
                res.writeHead(200, { 'Content-Type': 'text/plain' })
                res.end('retried!')
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 400 }))
            }
        }, s)

        // fetch with retry on: 400 is a plain client error (not one of the
        // retryable statuses 408/425/429/502/503/504, and no Retry-After
        // header), so the client should give up right away and resolve with
        // the 400 response itself
        var r = await fetch(endpoint, { retry: true })
        assert(r.status === 400, `expected status 400, got ${r.status}`)

        // make sure the 400's own body came through, not a retry's
        assert((await r.json()).error === 400, 'expected the 400 body to come through')

        // read back how many requests actually reached the server -- exactly
        // one means the client never retried
        var hits = await server_eval((req, res, s) => {
            res.end('' + global['_hits_' + s])
        }, s)
        assert(hits === '1', `expected exactly one request, got ${hits}`)
    }
)

run_test(
    "Should not retry on HTTP 401 (access denied)",
    async () => {
        // add a handler that 401s every request, counting hits in a global
        // keyed by a random id (the handler runs server-side via eval, so it
        // can't close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'unauthorized' }))
        }, s)

        // fetch it with retry on -- access denied is permanent, so the fetch
        // should give up and resolve with the 401 rather than retrying (if it
        // retried, this promise would never resolve, since the server 401s
        // every attempt, and the test would time out)
        var r = await fetch(endpoint, { retry: true, multiplex: false })
        assert(r.status === 401, 'expected status 401, got ' + r.status)
        assert((await r.json()).error === 'unauthorized', 'expected the 401 body to come through')

        // and the server saw exactly one request: the client gave up without
        // firing off a retry
        var hits = await server_eval((req, res, s) =>
            res.end('' + global['_hits_' + s]), s)
        assert(hits === '1', 'expected exactly one request, got ' + hits)

        // now the subscription flavor -- the path that actually says "access
        // denied": add a handler whose first response is a subscription that
        // sends one update and then drops the connection (provoking a
        // reconnect), and whose second response is a 401
        var s2 = Math.random().toString(36).slice(2)
        var endpoint2 = await add_main_handler((req, res, s2) => {
            var hits = global['_hits_' + s2] = (global['_hits_' + s2] ?? 0) + 1
            if (hits === 1) {
                res.startSubscription()
                res.sendUpdate({ body: 'hi' })
                res.end()
            } else {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'unauthorized' }))
            }
        }, s2)

        // subscribe with retry on -- the first connection succeeds
        var r2 = await fetch(endpoint2, { retry: true, subscribe: true, multiplex: false })
        assert(r2.status === 209, 'expected the subscription to start, got status ' + r2.status)

        // read the subscription: the update arrives, the connection drops,
        // and the client reconnects -- getting the 401, which should make it
        // give up with an access-denied error instead of retrying again
        var updates = []
        var error = await new Promise(done =>
            r2.subscribe(u => updates.push(u.body_text), done))
        assert(updates.length === 1 && updates[0] === 'hi', 'expected the first update to arrive')
        assert('' + error === 'Error: giving up because of http status: 401 (access denied)',
               'expected the access-denied error, got: ' + error)

        // the server saw exactly two requests: the original subscription plus
        // the one reconnect that got denied -- and no further retries
        var hits2 = await server_eval((req, res, s2) =>
            res.end('' + global['_hits_' + s2]), s2)
        assert(hits2 === '2', 'expected exactly two requests, got ' + hits2)

        // the give-up path above never decrements the client's
        // braid_fetch.subscription_counts for the origin (known client bug,
        // like the abort-without-reading leak), so undo our +1 ourselves to
        // avoid contaminating later multiplexing tests
        var origin = new URL(endpoint2, typeof document !== 'undefined' ? document.baseURI : undefined).origin
        if (braid_fetch.subscription_counts?.[origin] && !--braid_fetch.subscription_counts[origin])
            delete braid_fetch.subscription_counts[origin]
    }
)

run_test(
    "Should not try at all if abort controller already aborted",
    async () => {
        // add a handler that counts how many times it is hit, in a global
        // keyed by a random id (the handler runs server-side via eval, so it
        // can't close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.end('hi')
        }, s)

        // fetch the endpoint with a signal that was aborted before the fetch
        // even started
        var a = new AbortController()
        a.abort()
        try {
            await fetch(endpoint, { retry: true, signal: a.signal })
        } catch (e) {
            // we want the client's pre-flight "already aborted" error, not a
            // generic AbortError from cancelling an in-flight request
            assert('' + e === 'AbortError: already aborted',
                   'expected the already-aborted error, got: ' + e)

            // the client never tried: nothing reached the endpoint
            var hits = await server_eval((req, res, s) =>
                res.end('' + (global['_hits_' + s] ?? 0)), s)
            assert(hits === '0', 'expected no request to reach the server, got: ' + hits)

            // prove the counter isn't vacuously zero: hit the endpoint for
            // real, and make sure exactly that one request gets counted
            await og_fetch(endpoint)
            hits = await server_eval((req, res, s) =>
                res.end('' + (global['_hits_' + s] ?? 0)), s)
            assert(hits === '1', 'expected only the control request to be counted, got: ' + hits)
            return
        }
        assert(false, 'expected the fetch to error')
    }
)

run_test(
    "Should not retry if aborted",
    async () => {
        // add a handler that counts its hits in a global keyed by our random
        // id (passed as an arg, since the handler runs server-side and can't
        // close over test variables), and then never responds, holding the
        // request open like a stalled server
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
        }, s)

        // start a retrying fetch to the stalled endpoint. hold onto the
        // promise -- catching it now keeps an early rejection from going
        // unhandled while we poll the server below
        var a = new AbortController()
        var pending = fetch(endpoint, { retry: true, signal: a.signal })
            .catch(e => e)

        // wait until the request has actually reached the server, so the
        // abort below hits a live, in-flight request -- aborting before the
        // request launches is a different test ("Should not try at all if
        // abort controller already aborted"), and the 30ms timer this used
        // to use raced the connection
        while (await server_eval((req, res, s) =>
            res.end('' + (global['_hits_' + s] ?? 0)), s) !== '1')
            await new Promise(done => setTimeout(done, 10))

        // abort the in-flight request
        a.abort()

        // the fetch should reject with the abort itself. a client that
        // misfiled the abort as a retryable pipe error would schedule a
        // reconnect instead of rejecting, leaving this await hanging until
        // the test runner's timeout
        var e = await pending
        assert(e?.name === 'AbortError', `expected an AbortError, got: ${e}`)

        // give a wrongly-scheduled reconnect time to have fired (the first
        // retry delay defaults to 1000ms), then make sure the abort really
        // ended things: the server must never see a second request
        await new Promise(done => setTimeout(done, 1200))
        var hits = await server_eval((req, res, s) =>
            res.end('' + (global['_hits_' + s] ?? 0)), s)
        assert(hits === '1', `expected no retry request after the abort, saw ${hits} requests`)
    }
)

// the no-retry twin of "Should not try at all if abort controller already
// aborted" above: same pre-aborted signal, but no retry option, exercising
// the plain fetch path. note the error can't tell the two paths apart -- the
// client checks the signal (and throws 'already aborted') before any retry
// logic either way -- so the twin pins the message and this test asserts the
// AbortError name
run_test(
    "Test that a fetch with an already-aborted signal rejects with AbortError (without retry)",
    async () => {
        // add an endpoint that counts its hits in a global keyed by a random
        // id, so we can prove the aborted fetch never sends a request
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.end('ok')
        }, s)

        // fetch it with a signal that has already been aborted -- the client
        // should reject immediately, before ever touching the network
        var a = new AbortController()
        a.abort()
        try {
            await fetch(endpoint, { signal: a.signal })
        } catch (e) {
            // make sure we got an AbortError
            assert(e.name === 'AbortError', `expected an AbortError, got: ${e}`)

            // make sure the request never reached the server
            var hits = await server_eval((req, res, s) =>
                res.end('' + (global['_hits_' + s] ?? 0)), s)
            assert(hits === '0', 'expected no request to reach the server')

            // hit the endpoint once for real, and make sure the counter sees
            // it -- proving the zero above wasn't vacuous
            await og_fetch(endpoint)
            hits = await server_eval((req, res, s) =>
                res.end('' + (global['_hits_' + s] ?? 0)), s)
            assert(hits === '1', 'expected exactly one request to reach the server')
            return
        }
        assert(false, 'expected the fetch to error')
    }
)

run_test(
    "Should not retry if aborted, when subscribed",
    async () => {
        // add a handler that counts its connections in a keyed global, sends
        // one update, and holds the subscription open. the key and update are
        // passed as args (the handler runs server-side via eval, so it can't
        // close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, s, update) => {
            global['_connects_' + s] = (global['_connects_' + s] ?? 0) + 1
            res.startSubscription()
            res.sendUpdate(update)
        }, s, update)

        // subscribe with retry enabled, over a plain (non-multiplexed) fetch
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            retry: true,
            subscribe: true,
            multiplex: false,
        })
        assert(!r.multiplexed_through, 'expected request to not be multiplexed')

        // grab the first update, aborting as soon as it arrives -- acting
        // inside the callback avoids racing timers against the subscription --
        // then wait for the error callback to report the abort
        var got = null
        var error = await new Promise(done => {
            r.subscribe(u => {
                got = u
                a.abort()
            }, done)
        })

        // make sure the subscription was really live before the abort: the
        // update should have arrived intact (subscription updates carry a
        // status)
        if (got.body != null) got.body = got.body_text
        assert(JSON.stringify(got) === JSON.stringify({ ...update, status: '200' }),
               'expected the update to arrive before the abort')

        // the abort must surface as an AbortError. if the client had treated
        // the aborted connection as an ordinary pipe error, it would have
        // scheduled a retry instead of calling the error callback, and we
        // would still be waiting on the promise above
        assert(error.name === 'AbortError', `expected an AbortError, got: ${error}`)

        // and the server should have seen exactly one connection -- a second
        // one would mean retry reconnected behind our back
        var connects = await server_eval((req, res, s) => {
            res.end('' + global['_connects_' + s])
        }, s)
        assert(connects === '1', `expected exactly one connection, got ${connects}`)
    }
)

run_test(
    "Verify that retry option works with subscribe",
    async () => {
        // add a handler that counts its connections in a global keyed by a
        // random id, and sends one update stamped with the connection number
        // (so the client can tell which connection each update came from).
        // the first connection drops right after its update, as if the server
        // died -- the retry option should silently reconnect and resubscribe;
        // later connections stay open
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, s, update) => {
            var conn = global['_conns_' + s] = (global['_conns_' + s] ?? 0) + 1
            res.startSubscription()
            res.sendUpdate({ ...update, version: ['conn-' + conn] })
            if (conn === 1) res.end()
        }, s, update)

        // subscribe with retry over a plain (non-multiplexed) connection
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            retry: true,
            subscribe: true,
            multiplex: false,
        })
        assert(!r.multiplexed_through, 'expected a plain (non-multiplexed) connection')

        // collect updates until we see one from the second connection -- i.e.
        // the client noticed the drop and reconnected. the error callback must
        // not fire: a dropped connection is not an error while retry is on
        var updates = []
        await new Promise((done, fail) => {
            r.subscribe(u => {
                updates.push(u)
                if (u.version[0] === 'conn-2') done()
            }, fail)
        })

        // the one subscription delivered both connections' updates, in order,
        // each intact (with the status the server attaches on the way out)
        assert(updates.length === 2, `expected 2 updates, got ${updates.length}`)
        for (var i = 0; i < 2; i++) {
            updates[i].body = updates[i].body_text
            assert(JSON.stringify(updates[i]) ===
                       JSON.stringify({ ...update, version: ['conn-' + (i + 1)], status: '200' }),
                   `got unexpected update from connection ${i + 1}`)
        }

        // make sure the reconnect really happened over the wire: the server
        // should have seen exactly two connections
        var conns = await server_eval((req, res, s) => res.end('' + global['_conns_' + s]), s)
        assert(conns === '2', `expected the server to see 2 connections, saw ${conns}`)

        a.abort()
    }
)

run_test(
    "Should retry on HTTP 408",
    async () => {
        // add a handler that 408s its first two requests, then succeeds with
        // a json body. it counts every request it sees in a global keyed by a
        // random id, so we can verify later that the client really did retry
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables -- we pass in the id and body as args)
        var s = Math.random().toString(36).slice(2)
        var body = { this: 'stuff' }
        var endpoint = await add_main_handler((req, res, s, body) => {
            var requests = global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            if (requests <= 2) {
                res.writeHead(408, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 408 }))
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(body))
            }
        }, s, body)

        // fetch it with retry on -- retry gives up on most 4xx statuses, but
        // 408 request timeout is transient, so the client should quietly
        // reconnect through both 408s and resolve with the eventual 200
        var r = await fetch(endpoint, { retry: true })
        assert(r.status === 200, `expected status 200, got ${r.status}`)

        // and the body should be the 200's json, not a 408's
        assert(JSON.stringify(await r.json()) === JSON.stringify(body),
               'got unexpected body')

        // confirm with the server that the client really made three requests:
        // the original, plus one retry per 408
        var requests = await server_eval((req, res, s) =>
            res.end('' + global['_hits_' + s]), s)
        assert(requests === '3', `expected exactly three requests at the server, got ${requests}`)
    }
)

run_test(
    "Verify that onRes is called on first connection",
    async () => {
        // add a simple endpoint that counts its hits in a global keyed by a
        // random id -- passed as an arg, since the handler runs server-side
        // and can't close over test-side variables
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            res.end('hello')
        }, s)

        // fetch it once with retry on, recording each response onRes is given
        var onRes_args = []
        var r = await fetch(endpoint, { retry: { onRes: res => onRes_args.push(res) } })

        // onRes fires just before the fetch resolves, so by now it should
        // have been called for this very first connection -- exactly once,
        // and with the same response object the fetch resolved to
        assert(onRes_args.length === 1, 'expected onRes to be called exactly once')
        assert(onRes_args[0] === r, 'expected onRes to get the response the fetch resolved to')

        // the response should be the one our handler sent
        assert(r.status === 200, 'expected a 200 response')
        assert(await r.text() === 'hello', 'got unexpected body')

        // and the server should have seen exactly one request, so the
        // connection onRes reported really was the first (and only) one
        var hits = await server_eval((req, res, s) => res.end('' + global['_hits_' + s]), s)
        assert(hits === '1', 'expected exactly one request at the server')
    }
)

run_test(
    "Verify that onRes is called on reconnections",
    async () => {
        // add a handler that sends one update on a subscription, ending the
        // first response right away -- as if the connection dropped -- and
        // holding later ones open. connections are counted in a global keyed
        // by a random id, so we can check later that the client really
        // reconnected. the update is passed as an arg (the handler runs
        // server-side via eval, so it can't close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, s, update) => {
            var conns = global['_conns_' + s] = (global['_conns_' + s] ?? 0) + 1
            res.startSubscription()
            res.sendUpdate(update)
            if (conns === 1) res.end()
        }, s, update)

        // subscribe with retry on, recording the status of each response
        // handed to onRes
        var a = new AbortController()
        var onRes_statuses = []
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false,
            retry: { onRes: res => onRes_statuses.push(res.status) }
        })

        // onRes runs before the fetch resolves, and nothing reads the body
        // (which is what triggers a reconnect) until we subscribe below, so
        // exactly the first connection's response should be counted by now
        assert(onRes_statuses.length === 1, `expected onRes once after connecting, got ${onRes_statuses.length}`)

        // when the server drops the first response, retry should quietly
        // reconnect and get the update again -- wait for it to arrive twice.
        // (each response's update matches what we sent, plus the status the
        // server attaches on the way out)
        var update_count = 0
        await new Promise((done, fail) => r.subscribe(u => {
            u.body = u.body_text
            if (JSON.stringify(u) === JSON.stringify({ ...update, status: '200' })) update_count++
            if (update_count === 2) done()
        }, fail))

        // the second update can only have arrived over a second response, so
        // onRes should have fired for the reconnection too, each time with
        // the real 209 subscription response
        assert(onRes_statuses.length === 2, `expected onRes twice after reconnecting, got ${onRes_statuses.length}`)
        assert(onRes_statuses.every(status => status === 209), `expected onRes to get 209 responses, got ${onRes_statuses}`)

        // confirm with the server that the client really connected twice
        var conns = await server_eval((req, res, s) => res.end('' + global['_conns_' + s]), s)
        assert(conns === '2', `expected exactly two connections at the server, got ${conns}`)

        a.abort()
    }
)

run_test(
    "Verify that retry works with for-await style subscription",
    async () => {
        // add a handler that counts its connections in a global keyed by a
        // random id, sends one update, and then drops the connection shortly
        // after -- so the only way to collect multiple updates is to keep
        // reconnecting. (the handler runs server-side via eval, so it can't
        // close over test-side variables; s and the update are passed as args)
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, s, update) => {
            global['_connects_' + s] = (global['_connects_' + s] ?? 0) + 1
            res.startSubscription()
            res.sendUpdate(update)
            setTimeout(() => res.end(), 100)
        }, s, update)

        // subscribe with retry on, and read updates for-await style: each
        // connection dies after one update, so collecting three means the
        // iterator transparently survived two reconnections
        var a = new AbortController()
        var r = await fetch(endpoint, { retry: true, signal: a.signal, subscribe: true, multiplex: false })
        var updates = []
        for await (var u of r.subscription) {
            u.body = u.body_text
            updates.push(u)
            if (updates.length === 3) break
        }
        a.abort()

        // each update should match what the handler sent. the status only
        // rides on the first update of a response, so seeing it on all three
        // confirms each one arrived on a fresh connection
        for (var u of updates)
            assert(JSON.stringify(u) === JSON.stringify({ ...update, status: '200' }),
                   'got unexpected update after reconnection')

        // and make sure the client really did reconnect: the server should
        // have seen exactly three connections -- the original plus two retries
        var connects = await server_eval((req, res, s) =>
            res.end('' + global['_connects_' + s]), s)
        assert(connects === '3', `expected exactly three connections, got ${connects}`)
    }
)

run_test(
    "Should stop retrying in a subscription if reconnection attempt returns HTTP 500",
    async () => {
        // add a handler that counts its hits in a global keyed by a random id
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables). the first hit gets a subscription with one
        // update and then the connection drops, provoking the client into
        // retrying; every later hit gets a plain HTTP 500, which should make
        // the client give up
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({ this: 'stuff' }) }
        var endpoint = await add_main_handler(async (req, res, s, update) => {
            var hits = global['_gets_' + s] = (global['_gets_' + s] ?? 0) + 1
            if (hits > 1) {
                res.statusCode = 500
                return res.end()
            }
            res.startSubscription()
            await res.sendUpdate(update)
            res.end()
        }, s, update)

        // subscribe with retry on, collecting updates until the error
        // callback fires
        var updates = []
        var r = await fetch(endpoint, { retry: true, subscribe: true, multiplex: false })
        var error = await new Promise(done =>
            r.subscribe(u => updates.push(u), done))

        // the client should give up on the 500 rather than keep retrying,
        // and say why through the error callback
        assert('' + error === 'Error: giving up because of http status: 500',
               `expected the giving-up error, got: ${error}`)

        // we should have received the one update from before the connection
        // dropped, and nothing else
        assert(updates.length === 1, `expected exactly one update, got ${updates.length}`)
        if (updates[0].body != null) updates[0].body = updates[0].body_text
        assert(JSON.stringify(updates[0]) === JSON.stringify({ ...update, status: '200' }),
               'got unexpected update')

        // make sure the 500 came from a real reconnection attempt: the server
        // saw exactly two requests -- the original, plus the 500'd reconnect
        var hits = await server_eval((req, res, s) =>
            res.end('' + global['_gets_' + s]), s)
        assert(hits === '2', `expected exactly two requests, got ${hits}`)

        // and the client really stopped: wait past the worst-case reconnect
        // delay (min(retry_count + 1, 3) * 1000 = 2000ms here) and make sure
        // no further request snuck in
        await new Promise(done => setTimeout(done, 2500))
        hits = await server_eval((req, res, s) =>
            res.end('' + global['_gets_' + s]), s)
        assert(hits === '2', `expected no more requests after giving up, got ${hits}`)
    }
)

run_test(
    "Should throw an exception in for-await style when subscription encounters HTTP 500",
    async () => {
        // add a handler that acts like a subscription that dies: the first
        // request gets one update and then the connection drops, and every
        // request after that gets a plain http 500 -- counting requests in a
        // global keyed by the random id s (the handler runs server-side via
        // eval, so it can't close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['test'], parents: ['oldie'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, s, update) => {
            var hits = global['_hits_' + s] = (global['_hits_' + s] ?? 0) + 1
            if (hits > 1) {
                res.statusCode = 500
                return res.end()
            }
            res.startSubscription()
            res.sendUpdate(update)
            res.end()
        }, s, update)

        // subscribe with retry on, reading updates for-await style. the
        // first connection delivers one update and drops; retry reconnects,
        // gets the 500, and gives up -- which should throw out of the loop
        var updates = []
        try {
            for await (var u of (await fetch(endpoint, {retry: true, subscribe: true, multiplex: false})).subscription) {
                u.body = u.body_text
                updates.push(u)
            }
        } catch (e) {
            // the loop should throw the giving-up error
            assert('' + e === 'Error: giving up because of http status: 500',
                   'expected the giving-up error')

            // and the update from before the drop should have come through
            // intact (with the status the server attaches on the way out)
            assert(updates.length === 1,
                   `expected exactly one update before the error, got ${updates.length}`)
            assert(JSON.stringify(updates[0]) === JSON.stringify({ ...update, status: '200' }),
                   'got unexpected update before the error')

            // and the 500 really came from a reconnection attempt: the
            // handler saw exactly two requests -- the original, plus the
            // retry it 500'd
            var hits = await server_eval((req, res, s) =>
                res.end('' + global['_hits_' + s]), s)
            assert(hits === '2', 'expected exactly two requests: the original plus one retry')
            return
        }
        assert(false, 'expected the for-await loop to throw')
    }
)

add_section_header('Binary Tests')

run_test(
    "Verify basic binary GET",
    async () => {
        // add a handler that answers a plain GET with a raw binary response
        // -- writeHead/end, no braid framing -- whose body holds every
        // possible byte value, 0 through 255. any text decoding along the
        // way would mangle the bytes >= 0x80
        var endpoint = await add_main_handler((req, res) => {
            var buffer = Buffer.alloc(256)
            for (var i = 0; i < 256; i++) buffer[i] = i
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': buffer.length
            })
            res.end(buffer)
        })

        // GET it with braid_fetch, without subscribing -- just a basic
        // request for a binary resource
        var r = await fetch(endpoint)
        assert(r.status === 200, `expected a 200 response, got ${r.status}`)

        // the binary-ish headers should come through untouched
        assert(r.headers.get('content-type') === 'application/octet-stream',
               'expected the octet-stream content type to survive')
        assert(r.headers.get('content-length') === '256',
               'expected content-length to match the byte count')

        // and the body should round-trip byte for byte: exactly 256 bytes,
        // with byte i holding value i
        var bytes = new Uint8Array(await r.arrayBuffer())
        assert(bytes.length === 256, `expected 256 bytes, got ${bytes.length}`)
        for (var i = 0; i < 256; i++)
            assert(bytes[i] === i, `expected byte ${i} to be ${i}, got ${bytes[i]}`)
    }
)

run_test(
    "Verify binary data in subscription update",
    async () => {
        // add a handler that starts a subscription and sends one update
        // whose body is raw binary: all 256 possible byte values in order,
        // including the \r, \n, and nul bytes that could trip up the update
        // framing. the buffer is built server-side because handler args are
        // JSON-serialized, which a Buffer doesn't survive
        var endpoint = await add_main_handler((req, res) => {
            var buffer = Buffer.alloc(256)
            for (var i = 0; i < 256; i++) buffer[i] = i
            res.startSubscription()
            res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: buffer
            })
        })

        // subscribe and grab the first update
        var a = new AbortController()
        var r = await fetch(endpoint, {subscribe: true, multiplex: false, signal: a.signal})
        var update = await new Promise((done, fail) => r.subscribe(done, fail))

        // the body should arrive as actual binary -- a Uint8Array, not a
        // string the client decoded on the way in
        assert(update.body instanceof Uint8Array, 'expected the body to be a Uint8Array')

        // and every byte should survive the round trip unmangled
        assert(update.body.length === 256, `expected 256 bytes, got ${update.body.length}`)
        assert(update.body.every((byte, i) => byte === i),
               'expected byte values 0 through 255 in order')

        // the update's metadata should come through alongside the binary
        // body, with the status the server attaches on the way out
        assert(JSON.stringify(update.version) === JSON.stringify(['test']), 'got unexpected version')
        assert(JSON.stringify(update.parents) === JSON.stringify(['oldie']), 'got unexpected parents')
        assert(update.status === '200', 'expected status 200 on the update')

        a.abort()
    }
)

add_section_header("onSubscriptionStatus Tests")

run_test(
    "onSubscriptionStatus fires online:true on initial connection",
    async () => {
        // add a handler that sends one update and holds the subscription open.
        // the update is passed as an arg (the handler runs server-side via
        // eval, so it can't close over test-side variables)
        var update = { version: ['test'], body: JSON.stringify({hello: 'world'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // subscribe with an onSubscriptionStatus callback,
        // recording every status event it fires
        var a = new AbortController()
        var events = []
        var r = await fetch(endpoint, {
            subscribe: true,
            multiplex: false,
            signal: a.signal,
            onSubscriptionStatus: (s) => events.push(s)
        })

        // the online:true event fires as part of establishing the connection,
        // so it should already be recorded by the time the fetch resolves
        assert(events.length === 1, `expected one status event on connect, got ${events.length}`)
        assert(events[0].online === true, 'expected the status event to say online:true')

        // read the first update, proving the subscription really connected
        // and delivered data (and giving any spurious event a chance to fire)
        var got = await new Promise(done => r.subscribe(done))
        assert(got.body_text === update.body, 'got unexpected update body')

        // a healthy connection fires online:true exactly once -- make sure
        // no extra event snuck in while the update was in flight
        assert(events.length === 1, `expected no extra status events, got ${events.length}`)

        a.abort()
    }
)

run_test(
    "onSubscriptionStatus fires online:true on reconnect",
    async () => {
        // add a handler that counts its connections in a global keyed by a
        // random id (passed as an arg, since the handler runs server-side and
        // can't close over test variables), sends one update, and then ends
        // the response -- dropping the subscription so a retrying client has
        // to reconnect
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['test'], body: JSON.stringify({this: 'stuff'}) }
        var endpoint = await add_main_handler((req, res, s, update) => {
            global['_connects_' + s] = (global['_connects_' + s] ?? 0) + 1
            res.startSubscription()
            res.sendUpdate(update)
            res.end()
        }, s, update)

        // subscribe with retry on, recording every onSubscriptionStatus
        // event. the initial {online: true} fires before this fetch resolves
        var a = new AbortController()
        var events = []
        var waiter = null
        var r = await fetch(endpoint, {
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            onSubscriptionStatus: status => {
                events.push(status)
                waiter?.()
            }
        })

        // read the subscription, so the client notices the dropped connection
        // (the drop, the retry, and the reconnect all happen behind this same
        // response object)
        r.subscribe(() => {}, () => {})

        // wait for three events: the initial online:true, the offline event
        // from the dropped connection, and the reconnect's online:true
        await new Promise(done => {
            waiter = () => { if (events.length >= 3) done() }
            waiter()
        })

        // the events should trace the reconnect: online, dropped, back online
        assert(events[0].online === true, 'expected online:true on the initial connection')
        assert(events[1].online === false, 'expected online:false when the connection dropped')
        assert(events[1].error, 'expected the offline event to carry the error')
        assert(events[2].online === true, 'expected online:true on reconnect')

        // and the reconnect's online:true must come from a real second
        // connection -- make sure the server actually saw one
        var connects = await server_eval((req, res, s) =>
            res.end('' + global['_connects_' + s]), s)
        assert(+connects >= 2, `expected the server to see a second connection, saw ${connects}`)

        a.abort()
    }
)

run_test(
    "onSubscriptionStatus online:true has no extra fields",
    async () => {
        // the online status event should be exactly {online: true} -- one
        // field, nothing else. only the offline event carries extras (error)

        // add a handler that sends one update and holds the subscription open
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        })

        // subscribe, collecting every status event that fires
        var a = new AbortController()
        var events = []
        var r = await fetch(endpoint, {
            subscribe: true,
            multiplex: false,
            signal: a.signal,
            onSubscriptionStatus: e => events.push(e)
        })

        // the client reports online as soon as the fetch resolves: exactly
        // one event so far, with exactly one field
        assert(events.length === 1, 'expected one status event after connecting')
        assert(events[0].online === true, 'expected the event to be online')
        assert(Object.keys(events[0]).length === 1, 'expected no extra fields on the online event')

        // read the first update before aborting. this dodges a known client
        // bug: braid_fetch's per-origin subscription_counts (which drive the
        // multiplex-after-N heuristic) only get decremented when a reader
        // sees the subscription die, so aborting a never-read subscription
        // would leak the count into later tests
        await new Promise(done => r.subscribe(done, () => {}))
        a.abort()
    }
)

run_test(
    "onSubscriptionStatus lifecycle: true, false, true",
    async () => {
        // speed up the client's reconnect delay so the retry happens fast
        braid_fetch.reconnect_delay_ms = 150

        // add a handler that counts its connections in a global keyed by a
        // random id (the handler runs server-side via eval, so it can't close
        // over test-side variables). it sends one update, then ends the first
        // connection -- dropping the subscription so the client should go
        // offline and retry -- and holds later connections open
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            var conns = global['_conns_' + s] = (global['_conns_' + s] ?? 0) + 1
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
            if (conns === 1) res.end()
        }, s)

        // subscribe with retry on, recording every status event and resolving
        // a promise when the third one (the reconnect) arrives
        var a = new AbortController()
        var events = []
        var reconnected = null
        var full_lifecycle = new Promise(done => reconnected = done)
        var r = await fetch(endpoint, {
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            onSubscriptionStatus: (e) => {
                events.push(e)
                if (events.length === 3) reconnected()
            }
        })

        // read the subscription, so the client notices the dropped connection
        r.subscribe(() => {}, () => {})

        // wait for the full connect -> disconnect -> reconnect lifecycle
        await full_lifecycle

        // make sure the events came in the order online, offline, online,
        // with the offline event carrying the connection error
        assert(events.length === 3, 'expected exactly three status events')
        assert(events[0].online === true, 'expected the first event to be online')
        assert(events[1].online === false, 'expected the second event to be offline')
        assert(events[1].error, 'expected the offline event to carry an error')
        assert(events[2].online === true, 'expected the third event to be online again')

        // make sure the client really did reconnect: the server should have
        // seen exactly two connections
        var conns = await server_eval((req, res, s) =>
            res.end('' + global['_conns_' + s]), s)
        assert(conns === '2', `expected exactly two connections, got ${conns}`)

        a.abort()
        delete braid_fetch.reconnect_delay_ms
    }
)

run_test(
    "onSubscriptionStatus offline event has error, no status",
    async () => {
        // add a handler that starts a subscription, sends one update, and
        // hangs up right away, dropping the connection mid-subscription
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ version: ['v1'], body: 'hi' })
            res.end()
        })

        // subscribe with retry on, collecting status events as they fire.
        // when the offline event arrives, abort right inside the callback:
        // the client then tears down synchronously instead of scheduling a
        // reconnect, so no retry timer outlives the test
        var a = new AbortController()
        var events = []
        var got_offline
        var offline = new Promise(done => got_offline = done)
        var r = await fetch(endpoint, {
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            onSubscriptionStatus: e => {
                events.push(e)
                if (!e.online) {
                    a.abort()
                    got_offline(e)
                }
            }
        })

        // read the first update, proving the subscription was really
        // flowing before the hangup (and giving the client a reader, so it
        // can clean up its subscription bookkeeping when the stream ends)
        var update = await new Promise(done => r.subscribe(done, () => {}))
        assert(update.body_text === 'hi', 'expected the first update to arrive')

        // wait for the offline event the hangup should trigger
        var e = await offline

        // it should say offline, and carry the connection error...
        assert(e.online === false, 'expected the event to say offline')
        assert(e.error instanceof Error, 'expected the offline event to carry an error')

        // ...but no http status, since the connection dropped
        // without the server sending any response
        assert(e.status === undefined, 'expected no status on the offline event')

        // and we should have seen exactly two events: online, then offline
        assert(events.length === 2 && events[0].online === true,
               'expected exactly an online event, then the offline event')
    }
)

run_test(
    "onSubscriptionStatus offline error is descriptive",
    async () => {
        // add a handler that starts a subscription, sends one update, and then
        // ends the response, as if the connection dropped
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ body: 'hello' })
            res.end()
        })

        // subscribe with retry on, recording every status event; abort as soon
        // as the subscription goes offline, so the client doesn't reconnect
        var a = new AbortController()
        var statuses = []
        var went_offline = null
        var offline = new Promise(done => went_offline = done)
        var r = await fetch(endpoint, {
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            onSubscriptionStatus: s => {
                statuses.push(s)
                if (!s.online) {
                    a.abort()
                    went_offline(s)
                }
            }
        })

        // the subscription should have come up online first
        assert(statuses.length === 1 && statuses[0].online === true,
               'expected an online event when the subscription starts')

        // read the subscription, so the client notices the connection ending
        var got_update = new Promise(done => r.subscribe(done, () => {}))

        // wait for the server's close to knock the subscription offline
        var offline_event = await offline

        // the update should have arrived before the connection dropped,
        // proving the subscription was really up and then knocked down
        assert((await got_update).body_text === 'hello',
               'expected the update before the connection dropped')

        // the offline event's error should say descriptively what went wrong
        assert('' + offline_event.error === 'PipeError: Connection closed',
               'expected a descriptive offline error')

        // and there should be exactly two events: online, then offline
        assert(statuses.length === 2, 'expected exactly one online and one offline event')
    }
)

run_test(
    "onSubscriptionStatus cycles through 5 transitions",
    async () => {
        // add a handler that sends one update and then ends the response,
        // dropping the subscription -- each retry reconnects to it and gets
        // dropped again, cycling the connection up and down. it counts its
        // connections in a global keyed by the random id s (the handler runs
        // server-side via eval, so it can't close over test-side variables),
        // and tags each update's version with the connection number
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            var n = global['_conns_' + s] = (global['_conns_' + s] ?? 0) + 1
            res.startSubscription()
            res.sendUpdate({ version: ['v' + n], body: 'hi' })
            res.end()
        }, s)

        // speed up the retry loop so the cycling doesn't take seconds
        braid_fetch.reconnect_delay_ms = 150

        // subscribe with retry on, recording every status callback
        var a = new AbortController()
        var events = []
        var versions = []
        var waiter = null
        var res = await fetch(endpoint, {
            subscribe: true,
            retry: true,
            multiplex: false,
            signal: a.signal,
            onSubscriptionStatus: status => {
                events.push(status)
                if (events.length === 5) waiter?.()
            }
        })

        // read the subscription (updates only flow -- and drops are only
        // noticed -- once there's a reader), and wait for 5 status events:
        // online, offline, online, offline, online
        await new Promise(done => {
            waiter = done
            res.subscribe(update => versions.push(update.version[0]), () => {})
        })

        // tear down before asserting, so a failed assert doesn't leave the
        // subscription retrying or the global retry knob set
        a.abort()
        delete braid_fetch.reconnect_delay_ms

        // the callback must have alternated: online on each (re)connect,
        // offline on each drop
        var pattern = events.slice(0, 5).map(e => e.online).join(', ')
        assert(pattern === 'true, false, true, false, true',
               'expected alternating online/offline, got: ' + pattern)

        // each offline event carries the pipe error that dropped us...
        assert('' + events[1].error === 'PipeError: Connection closed' &&
               '' + events[3].error === 'PipeError: Connection closed',
               'expected offline events to carry the connection-closed error')

        // ...and online events carry no error
        assert(!events[0].error && !events[2].error && !events[4].error,
               'expected online events to carry no error')

        // updates kept flowing across the reconnects: each of the first two
        // connections delivered its update before its drop was reported
        assert(versions[0] === 'v1' && versions[1] === 'v2',
               'expected an update from each of the first two connections, got: ' + versions)

        // and the cycling was real reconnections: the server saw exactly 3
        var conns = await server_eval((req, res, s) =>
            res.end('' + (global['_conns_' + s] ?? 0)), s)
        assert(conns === '3', 'expected the server to see exactly 3 connections, got: ' + conns)
    }
)

run_test(
    "onSubscriptionStatus offline from parse error has descriptive error",
    async () => {
        // add a handler that counts its connections in a global keyed by a
        // random id (the handler runs server-side via eval, so it can't close
        // over test-side variables). every connection starts a subscription
        // and sends one update; the first connection then closes cleanly -- a
        // retryable pipe error -- and the second follows its update with
        // garbage that can't parse as update headers -- a fatal parse error
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            var n = global['_conns_' + s] = (global['_conns_' + s] ?? 0) + 1
            res.startSubscription()
            res.sendUpdate({ version: ['v' + n], body: 'hi' })
            if (n === 1) res.end()
            else res.write('bad_header_no_colon\r\n\r\n')
        }, s)

        // subscribe with retry, recording each status event as it fires
        var a = new AbortController()
        var events = []
        var on_event = () => {}
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            retry: true,
            multiplex: false,
            onSubscriptionStatus: e => { events.push(e); on_event() }
        })

        // read the subscription, collecting its updates and capturing the
        // error that finally kills it
        var updates = []
        var dead = new Promise(done => r.subscribe(u => updates.push(u), done))

        // wait for all four status transitions: online, offline when the
        // first connection drops, online again after the retry reconnects,
        // and offline again when the second connection sends garbage
        await new Promise(done => {
            on_event = () => { if (events.length >= 4) done() }
            on_event()
        })
        assert(events.map(e => e.online).join(', ') === 'true, false, true, false',
               `expected online, offline, online, offline; got: ${events.map(e => e.online).join(', ')}`)

        // the first offline came from the clean close: a retryable pipe error
        assert('' + events[1].error === 'PipeError: Connection closed',
               `expected the first offline to be a pipe error, got: ${events[1].error}`)

        // the second offline's error describes the parse failure, quoting the
        // exact garbage the parser choked on
        assert('' + events[3].error === 'ParseError: Parse error in headers: "bad_header_no_colon\\r\\n\\r\\n"',
               `got unexpected error on the second offline: ${events[3].error}`)

        // each connection's update arrived -- v1 before the drop, v2 after --
        // so the offline/online pair really was a reconnect to the server
        assert(updates.map(u => u.version[0]).join(', ') === 'v1, v2',
               `expected updates v1, v2; got: ${updates.map(u => u.version?.[0]).join(', ')}`)

        // a parse error is fatal: instead of retrying again, the client kills
        // the subscription, handing the reader the same descriptive error
        var e = await dead
        assert('' + e === '' + events[3].error,
               `expected the subscription to die with the same parse error, got: ${e}`)

        // and since the client gave up, the connection count on the server is
        // final: the original connection plus the one retry, never a third
        var conns = await server_eval((req, res, s) =>
            res.end('' + global['_conns_' + s]), s)
        assert(conns === '2', `expected the server to see 2 connections, saw ${conns}`)

        // the parse error already tore the subscription down (and freed its
        // subscription count); the abort just releases the signal listener
        a.abort()
    }
)

run_test(
    "onSubscriptionStatus not called without subscribe",
    async () => {
        // onSubscriptionStatus reports the connectivity of a subscription, so
        // a plain non-subscribe fetch must never call it. the client has three
        // places that fire it -- on a successful connect, on a connection
        // error, and when retry gives up on a bad status -- so we drive a
        // non-subscribe fetch down all three paths and count every event
        var events = []
        var status_cb = (s) => events.push(s)

        // add a handler that responds normally
        var endpoint = await add_main_handler((req, res) => {
            res.end('hi')
        })

        // add a handler that drops the connection without responding, and
        // counts its hits in a global keyed by a random id, so we can prove
        // later that it really ran. this lives on the WRAPPER server, which
        // speaks plain HTTPS/1.1: the main server speaks h2 to browsers, and
        // destroying an h2 stream mid-request sends an RST_STREAM that
        // chrome may treat as retryable -- auto-retrying forever into a
        // handler that kills every attempt. an h1 socket reset is an
        // unambiguous connection error on every transport
        var s = Math.random().toString(36).slice(2)
        var drop_endpoint = await add_wrapper_handler((req, res, s) => {
            global['_drops_' + s] = (global['_drops_' + s] ?? 0) + 1
            req.socket.destroy()
        }, s)

        // add a handler that responds with a plain 404
        var notfound_endpoint = await add_main_handler((req, res) => {
            res.writeHead(404)
            res.end('nope')
        })

        // a successful fetch: with subscribe, this is where the client would
        // fire {online: true}
        var r = await fetch(endpoint, { multiplex: false, onSubscriptionStatus: status_cb })
        assert(r.ok, 'expected ok response')
        assert(await r.text() === 'hi', 'got unexpected body')
        assert(events.length === 0, `expected no status events after success, got ${events.length}`)

        // a fetch whose connection drops before any response: with subscribe,
        // this is where the client's connection-error handler would fire
        // {online: false}
        var errored = false
        try {
            await fetch(drop_endpoint, { multiplex: false, onSubscriptionStatus: status_cb })
        } catch (e) { errored = true }
        assert(errored, 'expected the dropped-connection fetch to error')
        assert(events.length === 0, `expected no status events after connection drop, got ${events.length}`)

        // make sure the drop handler really ran, so the fetch failed for the
        // reason we think it did
        var drops = await server_eval((req, res, s) => res.end('' + global['_drops_' + s]), s)
        assert(+drops >= 1, `expected the drop handler to have run, got ${drops} hits`)

        // a retrying fetch that gives up on a 404: with subscribe, this is
        // where the client would fire {online: false, error: 'giving up...'}
        var r2 = await fetch(notfound_endpoint, { retry: true, multiplex: false, onSubscriptionStatus: status_cb })
        assert(r2.status === 404, `expected status 404, got ${r2.status}`)
        assert(await r2.text() === 'nope', 'got unexpected 404 body')
        assert(events.length === 0, `expected no status events after retry gave up, got ${events.length}`)
    }
)

add_section_header("already_buffered_body Tests")

run_test(
    "already_buffered_body works for multiple patches",
    async () => {
        // add a handler that simulates a framework (like express with
        // body-parser, or fastify) that consumes the request stream before
        // braid sees it: it buffers the raw body itself, sets
        // req.already_buffered_body, and only then calls parseUpdate() --
        // by that point the stream is spent, so the parse can only succeed
        // by reading the buffer (a parseUpdate that tried the stream would
        // wait forever on events that already fired, and this test would
        // time out). it reports back what it parsed
        var endpoint = await add_main_handler((req, res) => {
            var chunks = []
            req.on('data', chunk => chunks.push(chunk))
            req.on('end', async () => {
                req.already_buffered_body = Buffer.concat(chunks)
                var update = await req.parseUpdate()
                res.end(JSON.stringify({
                    stream_was_spent: req.readableEnded,
                    body: update.body ?? null,
                    patches: (update.patches ?? []).map(p => ({
                        unit: p.unit, range: p.range, content_text: p.content_text
                    }))
                }))
            })
        })

        // PUT two patches at that endpoint
        var r = await fetch(endpoint, {
            method: 'PUT',
            patches: [
                {unit: 'text', range: '[0:0]', content: 'first'},
                {unit: 'text', range: '[5:5]', content: 'second'}
            ]
        })
        assert(r.ok, 'expected ok response')
        var got = JSON.parse(await r.text())

        // make sure the request stream really was consumed before
        // parseUpdate ran, so the parse could only have used
        // already_buffered_body
        assert(got.stream_was_spent, 'expected the request stream to be spent before parseUpdate ran')

        // the buffer should parse as exactly our two patches, in order,
        // with units, ranges, and contents intact -- and no body
        assert(got.body === null, 'expected update to have patches, not a body')
        assert(got.patches.length === 2, 'expected exactly two patches')
        assert(got.patches[0].unit === 'text', 'got unexpected unit on first patch')
        assert(got.patches[0].range === '[0:0]', 'got unexpected range on first patch')
        assert(got.patches[0].content_text === 'first', 'got unexpected content in first patch')
        assert(got.patches[1].unit === 'text', 'got unexpected unit on second patch')
        assert(got.patches[1].range === '[5:5]', 'got unexpected range on second patch')
        assert(got.patches[1].content_text === 'second', 'got unexpected content in second patch')
    }
)

add_section_header("Content-Type: application/http-patches Tests")

run_test(
    "Multi-patch PUT sends Content-Type: application/http-patches",
    async () => {
        // add a handler that reports what the server received: the raw
        // content-type header, and the patches braidify parses out of the
        // body (proving the body really holds the patches the content-type
        // advertises)
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                content_type: req.headers['content-type'],
                patches: update.patches.map(p =>
                    ({unit: p.unit, range: p.range, content: p.content_text}))
            }))
        })

        // send a two-patch PUT with braid_fetch, the system under test
        var r = await fetch(endpoint, {
            method: 'PUT',
            patches: [
                {unit: 'text', range: '[0:0]', content: 'a'},
                {unit: 'text', range: '[1:1]', content: 'b'}
            ]
        })
        var seen = JSON.parse(await r.text())

        // multiple patches must be declared with the new content-type,
        // whose count matches the number of patches sent
        assert(seen.content_type === 'application/http-patches; count=2',
            `expected content-type "application/http-patches; count=2", got "${seen.content_type}"`)

        // and the body must actually parse back into the patches we sent
        // (compare against fresh literals: braid_fetch encodes the content
        // of the patch objects it was passed in place)
        assert(JSON.stringify(seen.patches) === JSON.stringify([
            {unit: 'text', range: '[0:0]', content: 'a'},
            {unit: 'text', range: '[1:1]', content: 'b'}
        ]), 'expected both patches to round-trip through the wire body')
    }
)

run_test(
    "Single-patch PUT does not send Content-Type: application/http-patches",
    async () => {
        // add a handler that parses the incoming PUT as an update and echoes
        // back what the server saw: the wire headers that announce (or
        // inline) patches, and each parsed patch's unit, range, and content
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                content_type: req.headers['content-type'] ?? null,
                patches_header: req.headers.patches ?? null,
                content_range: req.headers['content-range'] ?? null,
                got_body: update.body !== undefined,
                patches: (update.patches ?? []).map(p => ({
                    unit: p.unit, range: p.range, content: p.content_text
                }))
            }))
        })

        // a single patch can be passed as a bare object or as an array of
        // one; both should take the inline wire form, so try each
        for (var form of ['a bare object', 'an array of one']) {
            var patch = {unit: 'text', range: '[0:0]', content: 'a'}
            var r = await fetch(endpoint, {
                method: 'PUT',
                patches: form === 'a bare object' ? patch : [patch]
            })
            assert(r.ok, `expected ok response (patches as ${form})`)
            var seen = JSON.parse(await r.text())

            // a lone patch goes inline -- a Content-Range header with the
            // raw content as the body -- rather than as an http-patches
            // block, so neither multi-patch wire header should appear
            assert(!seen.content_type?.startsWith('application/http-patches'),
                   `expected no http-patches content-type (patches as ${form})`)
            assert(seen.patches_header === null, `expected no Patches header (patches as ${form})`)
            assert(seen.content_range === 'text [0:0]', `expected the patch inlined via a Content-Range header (patches as ${form})`)

            // and the inline form must still parse server-side as that one
            // patch, not as a body snapshot
            assert(!seen.got_body, `expected patches rather than a body (patches as ${form})`)
            assert(seen.patches.length === 1, `expected exactly one patch (patches as ${form})`)
            assert(seen.patches[0].unit === 'text', `got unexpected patch unit (patches as ${form})`)
            assert(seen.patches[0].range === '[0:0]', `got unexpected patch range (patches as ${form})`)
            assert(seen.patches[0].content === 'a', `got unexpected patch content (patches as ${form})`)
        }
    }
)

add_section_header("Parsing patches with new vs legacy patch-count headers")
// //
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
        // add a handler that parses the incoming update with braidify's
        // req.parseUpdate(), and echoes back everything it parsed -- plus
        // whether a Patches: header arrived -- so we can assert on it all
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.end(JSON.stringify({
                saw_patches_header: req.headers.patches != null,
                body: update.body ?? null,
                patches: (update.patches ?? []).map(p =>
                    ({ unit: p.unit, range: p.range, content: p.content_text }))
            }))
        })

        // PUT two patches in wire format, declaring the patch count ONLY the
        // new way -- in the Content-Type -- with no legacy Patches: N header.
        // og_fetch sends exactly the headers we give it
        var r = await og_fetch(endpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/http-patches; count=2' },
            body:
                'Content-Length: 1\r\n' +
                'Content-Range: text [0:0]\r\n' +
                '\r\n' +
                'a\r\n' +
                '\r\n' +
                'Content-Length: 1\r\n' +
                'Content-Range: text [1:1]\r\n' +
                '\r\n' +
                'b'
        })
        var parsed = JSON.parse(await r.text())

        // make sure the count really had to come from the Content-Type:
        // the request arrived with no Patches: header
        assert(!parsed.saw_patches_header,
               'expected the request to arrive without a Patches: header')

        // make sure the server parsed the body as patches, not as a snapshot
        assert(parsed.body === null, 'expected a patch update, not a body snapshot')

        // make sure both patches came through, with the right units, ranges,
        // and contents
        assert(JSON.stringify(parsed.patches) === JSON.stringify([
            { unit: 'text', range: '[0:0]', content: 'a' },
            { unit: 'text', range: '[1:1]', content: 'b' }
        ]), `got unexpected patches: ${JSON.stringify(parsed.patches)}`)
    }
)

run_test(
    "Server parses multi-patch PUT with only Patches: N header (no Content-Type)",
    async () => {
        // add a handler that parses the incoming PUT with req.parseUpdate()
        // and echoes back what the server saw: the patch-count headers it
        // received, and the parsed update (the handler runs server-side via
        // eval, so it reports over the wire rather than closing over
        // test-side variables)
        var endpoint = await add_main_handler(async (req, res) => {
            var update = await req.parseUpdate()
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
                patches_header: req.headers.patches,
                content_type: req.headers['content-type'] ?? '',
                body: update.body ?? null,
                patches: update.patches.map(p =>
                    ({ unit: p.unit, range: p.range, content: p.content_text }))
            }))
        })

        // hand-craft a two-patch body in the braid wire format
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

        // PUT it declaring the patch count only via the legacy Patches: N
        // header -- no Content-Type: application/http-patches; count=N. we
        // use og_fetch so the braid client can't add braid headers of its own
        var r = await og_fetch(endpoint, {
            method: 'PUT',
            headers: { 'Patches': '2' },
            body
        })
        assert(r.ok, 'expected ok response')
        var seen = JSON.parse(await r.text())

        // make sure the count really arrived via the legacy header alone --
        // the transport may add a default content-type (like text/plain),
        // but nothing resembling application/http-patches
        assert(seen.patches_header === '2', 'expected the server to see Patches: 2')
        assert(!/http-patches/.test(seen.content_type), 'expected no http-patches content-type')

        // the server should parse both patches, in order, with no body snapshot
        assert(seen.body === null, 'expected patches rather than a body snapshot')
        assert(seen.patches.length === 2, 'expected two patches')
        assert(JSON.stringify(seen.patches[0]) ===
               JSON.stringify({ unit: 'text', range: '[0:0]', content: 'a' }),
               'got unexpected first patch')
        assert(JSON.stringify(seen.patches[1]) ===
               JSON.stringify({ unit: 'text', range: '[1:1]', content: 'b' }),
               'got unexpected second patch')
    }
)

run_test(
    "Client parses subscription update with only Content-Type: application/http-patches; count=N (no Patches: header)",
    async () => {
        // add a handler that starts a subscription, hand-writes a raw
        // two-patch update whose patch count is declared ONLY by
        // Content-Type: application/http-patches; count=2 (no Patches: 2
        // header), and holds the subscription open. if the client fails to
        // read the count out of the content-type, it can't frame the patches
        // and errors instead of delivering the update
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.write('HTTP 200 OK\r\n' +
                      'Version: "v1"\r\n' +
                      'Content-Type: application/http-patches; count=2\r\n' +
                      '\r\n' +
                      'Content-Length: 1\r\n' +
                      'Content-Range: text [0:0]\r\n' +
                      '\r\n' +
                      'a\r\n\r\n' +
                      'Content-Length: 1\r\n' +
                      'Content-Range: text [1:1]\r\n' +
                      '\r\n' +
                      'b\r\n\r\n')
        })

        // subscribe to the endpoint we added
        var a = new AbortController()
        var r = await fetch(endpoint, {
            signal: a.signal,
            subscribe: true,
            multiplex: false
        })

        // read the first update off the subscription, then abort -- the
        // subscription's error callback should fire with the abort
        var update = null
        var err = await new Promise(done => r.subscribe(u => {
            if (!update) {
                update = u
                a.abort()
            }
        }, done))

        // the update should carry the version and status from its status line
        // and headers...
        assert(JSON.stringify(update.version) === '["v1"]', 'got unexpected version')
        assert(update.status === '200', 'got unexpected status')

        // ...and both patches, framed by the count=2 in the content-type
        assert(update.patches.length === 2, 'expected two patches')
        assert(update.patches[0].unit === 'text', 'got unexpected unit in first patch')
        assert(update.patches[0].range === '[0:0]', 'got unexpected range in first patch')
        assert(update.patches[0].content_text === 'a', 'got unexpected content in first patch')
        assert(update.patches[1].unit === 'text', 'got unexpected unit in second patch')
        assert(update.patches[1].range === '[1:1]', 'got unexpected range in second patch')
        assert(update.patches[1].content_text === 'b', 'got unexpected content in second patch')

        // it's a patch update with no Parents: header, so it should have no
        // body and no parents, and the http-patches content-type is framing
        // for the patches, not surfaced as the update's content_type
        assert(update.body === undefined, 'expected no body on a patch update')
        assert(update.parents === undefined, 'expected no parents')
        assert(update.content_type === undefined, 'expected the http-patches content-type to be consumed')

        // and the abort should have surfaced as an AbortError
        assert(err.name === 'AbortError', 'expected an AbortError')
    }
)

add_section_header("Parsing updates from a single 200 response body")
run_test(
    "Parse a single 200 response body snapshot",
    async () => {
        // add a handler that sends one update as a plain 200 response -- no
        // subscription -- so the version and parents travel as response
        // headers and the update's body is just the response body. the update
        // is passed as an arg (the handler runs server-side via eval, so it
        // can't close over test-side variables). two parents, to exercise the
        // structured-headers list format
        var update = { version: ['3'], parents: ['1', '2'], body: JSON.stringify({hello: 'world'}) }
        var endpoint = await add_main_handler((req, res, update) => {
            res.setHeader('Content-Type', 'application/json')
            res.sendUpdate(update)
            res.end()
        }, update)

        // peek at the raw response first, to make sure the server really put
        // the version and parents in structured headers, and sent the
        // update's body as the whole response body, with no braid framing
        var raw = await og_fetch(endpoint)
        assert(raw.status === 200, 'expected the raw response to be a 200')
        assert(raw.headers.get('version') === '"3"', 'expected the version as a structured header')
        assert(raw.headers.get('parents') === '"1", "2"', 'expected the parents as a structured header')
        assert(raw.headers.get('content-length') === '' + update.body.length, 'expected a content-length for the body')
        assert(await raw.text() === update.body, 'expected the raw body to be exactly the update body')

        // now fetch it with braid_fetch (multiplex off, so we really get a
        // single plain 200 response) and parse the update out of it
        var r = await fetch(endpoint, { multiplex: false })
        assert(r.status === 200, 'expected a 200 response')
        var u = await r.update()

        // make sure the parsed update round-trips what the server sent
        assert(JSON.stringify(u.version) === JSON.stringify(update.version), 'got unexpected version')
        assert(JSON.stringify(u.parents) === JSON.stringify(update.parents), 'got unexpected parents')
        assert(u.body_text === update.body, 'got unexpected body')
        assert(u.status === 200, 'expected the update to carry the response status')
        assert(u.content_type === 'application/json', 'expected the json content type')
        assert(u.patches === undefined, 'expected no patches on a snapshot')
    }
)
run_test(
    "Parse a single 200 response body with patches",
    async () => {
        // add a handler that answers a plain (non-subscription) GET with a
        // single update containing patches. the update is passed as an arg
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables)
        var update = {
            version: ['4'],
            parents: ['3'],
            patches: [{unit: 'json', range: '.hello', content: 'worlds'},
                      {unit: 'json', range: '.and',   content: 'wonderverses'}]
        }
        var endpoint = await add_main_handler((req, res, update) => {
            res.sendUpdate(update)
            res.end()
        }, update)

        // fetch it as a regular request. force multiplexing off so we always
        // exercise the solo-response parse path, even when concurrent tests
        // twiddle the global multiplex knobs
        var r = await fetch(endpoint, { multiplex: false })
        assert(r.status === 200, 'expected a 200 response')

        // make sure the patches really went over the wire as a Patches: N
        // block, rather than as a snapshot body
        assert(r.headers.get('patches') === '2', 'expected a Patches: 2 header')
        assert(r.headers.get('content-type') === 'application/http-patches; count=2',
               'expected the http-patches content-type')

        // parse the single update out of the response body
        var u = await r.update()

        // make sure the version and parents came through
        assert(JSON.stringify(u.version) === JSON.stringify(update.version), 'got unexpected version')
        assert(JSON.stringify(u.parents) === JSON.stringify(update.parents), 'got unexpected parents')

        // make sure we got exactly the patches we sent, in order, each with
        // its unit, range, and content intact
        assert(u.patches.length === update.patches.length, 'expected exactly two patches')
        for (var i = 0; i < update.patches.length; i++) {
            assert(u.patches[i].unit === update.patches[i].unit, `got unexpected unit on patch ${i}`)
            assert(u.patches[i].range === update.patches[i].range, `got unexpected range on patch ${i}`)
            assert(u.patches[i].content_text === update.patches[i].content, `got unexpected content on patch ${i}`)
        }

        // an update made of patches should not also carry a body
        assert(u.body === undefined, 'expected no body on a patches update')
    }
)

add_section_header("Server patch: vs patches: wire format")

run_test(
    "patch: (singular) inlines without Patches: N",
    async () => {
        // add a handler that sends one update using the singular patch:
        // field, then ends the subscription so the reads below terminate
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({
                version: ['v1'],
                patch: {unit: 'text', range: '[0:0]', content: 'hello'},
            })
            res.end()
        })

        // subscribe with the plain transport, to see the exact bytes the
        // server put on the wire
        var r = await og_fetch(endpoint, {headers: {subscribe: 'true'}})
        assert(r.status === 209, 'expected a 209 Multiresponse')

        // a singular patch: should inline the patch into the update -- its
        // Content-Length/Content-Range ride right on the update's own
        // headers, with no Patches: N header or application/http-patches
        // wrapper around the patch
        var raw = await r.text()
        assert(raw === 'HTTP 200 OK\r\n' +
                       'Version: "v1"\r\n' +
                       'Content-Length: 5\r\n' +
                       'Content-Range: text [0:0]\r\n' +
                       '\r\n' +
                       'hello\r\n\r\n',
               `got unexpected wire format: ${JSON.stringify(raw)}`)

        // and the braid client should parse the inlined form back into the
        // same single patch
        var a = new AbortController()
        var r2 = await fetch(endpoint, {signal: a.signal, subscribe: true, multiplex: false})
        var update = await new Promise(done => r2.subscribe(done))
        assert(update.version[0] === 'v1', 'got unexpected version')
        assert(update.patches.length === 1, 'expected exactly one patch')
        assert(update.patches[0].unit === 'text', 'got unexpected patch unit')
        assert(update.patches[0].range === '[0:0]', 'got unexpected patch range')
        assert(update.patches[0].content_text === 'hello', 'got unexpected patch content')

        a.abort()
    }
)

run_test(
    "patches: (array of 1) uses Patches: 1",
    async () => {
        // add a handler that starts a subscription, sends one update whose
        // patches: is an array of a single patch, and ends the response so
        // the raw read below terminates. the update is passed as an arg
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables)
        var v = Math.random().toString(36).slice(2)
        var patch = {unit: 'text', range: '[0:0]', content: 'world'}
        var update = {version: [v], patches: [patch]}
        var endpoint = await add_main_handler(async (req, res, update) => {
            res.startSubscription()
            await res.sendUpdate(update)
            res.end()
        }, update)

        // subscribe with the plain transport and read the raw bytes off the
        // wire -- this test is about the exact framing braidify emits, which
        // braid_fetch would parse away
        var raw = ''
        var r = await og_fetch(endpoint, {headers: {subscribe: 'true'}})
        var reader = r.body.getReader()
        while (true) {
            var {done, value} = await reader.read()
            if (done) break
            raw += new TextDecoder().decode(value)
        }

        // the whole stream is that one update: a status line plus update
        // headers, then the patch as its own header+content block, with
        // blank lines between the three
        var [update_headers, patch_headers, patch_content] = raw.split('\r\n\r\n')
        assert(update_headers.startsWith('HTTP 200 OK\r\n'), 'expected the update status line')
        assert(update_headers.includes(`Version: ${JSON.stringify(v)}`), 'expected the update version header')

        // an array of one patch must use the Patches: N block form, and
        // declare the matching content-type with its count...
        assert(update_headers.includes('Patches: 1'), 'expected a Patches: 1 header')
        assert(update_headers.includes('Content-Type: application/http-patches; count=1'),
               'expected the http-patches content-type with count=1')

        // ...so the range belongs to the patch's own block below, NOT
        // inlined into the update headers (that's the patch: singular form,
        // covered by the neighboring tests)
        assert(!update_headers.includes('Content-Range:'), 'expected no Content-Range inlined into the update headers')
        assert(patch_headers.includes(`Content-Range: ${patch.unit} ${patch.range}`), 'expected the patch block to carry the range')
        assert(patch_headers.includes(`Content-Length: ${patch.content.length}`), 'expected the patch block to declare its length')

        // and the patch content itself follows the patch headers
        assert(patch_content === patch.content, 'got unexpected patch content')
    }
)

run_test(
    "patches: (array of 2) uses Patches: 2",
    async () => {
        // add a handler that sends one subscription update whose patches: is
        // an array of two patches, and holds the subscription open. the
        // update is passed as an arg (the handler runs server-side via eval,
        // so it can't close over test-side variables)
        var update = {
            version: ['v3'],
            patches: [{unit: 'text', range: '[0:0]', content: 'aaa'},
                      {unit: 'text', range: '[1:1]', content: 'bbb'}]
        }
        var endpoint = await add_main_handler((req, res, update) => {
            res.startSubscription()
            res.sendUpdate(update)
        }, update)

        // subscribe with the raw transport, and read the stream until the
        // second patch's content shows up, so we can inspect the exact bytes
        // the server put on the wire
        var a = new AbortController()
        var r = await og_fetch(endpoint, {
            signal: a.signal,
            headers: { 'Subscribe': 'true' }
        })
        var raw = ''
        var reader = r.body.getReader()
        while (!raw.includes('bbb')) {
            var {done, value} = await reader.read()
            assert(!done, 'expected the update before the stream ended')
            raw += new TextDecoder().decode(value)
        }

        // a patches: array must be announced in the update's headers -- the
        // block before the first blank line -- with Patches: 2 and an
        // http-patches content-type counting both patches
        var headers = raw.split('\r\n\r\n')[0]
        assert(headers.startsWith('HTTP 200 OK'), 'expected the update to start with a status line')
        assert(headers.includes('Version: "v3"'), 'expected the version header')
        assert(headers.includes('Patches: 2'), 'expected a Patches: 2 header')
        assert(headers.includes('Content-Type: application/http-patches; count=2'),
               'expected the http-patches content-type to count 2 patches')

        // and NOT inlined like the singular patch: form, which puts a
        // Content-Range directly in the update's headers
        assert(!headers.includes('Content-Range:'), 'expected no inlined patch in the update headers')

        // both patches follow as their own pseudoheader blocks, each with its
        // own range and content -- and only those two, in the one update
        assert(raw.includes('Content-Range: text [0:0]\r\n\r\naaa'), 'expected the first patch on the wire')
        assert(raw.includes('Content-Range: text [1:1]\r\n\r\nbbb'), 'expected the second patch on the wire')
        assert(raw.match(/Content-Range:/g).length === 2, 'expected exactly two patches on the wire')
        assert(raw.match(/HTTP \d+ /g).length === 1, 'expected both patches inside one update, not spread over several')

        // make sure the wire format is not just shaped right but actually
        // parseable: subscribe with braid_fetch and check the parsed update
        var a2 = new AbortController()
        var r2 = await fetch(endpoint, {
            signal: a2.signal,
            subscribe: true,
            multiplex: false
        })
        var parsed = await new Promise(done => r2.subscribe(done))
        assert(parsed.version[0] === 'v3', 'expected the parsed version')
        assert(parsed.patches.length === 2, 'expected two parsed patches')
        assert(parsed.patches[0].content_text === 'aaa'
               && parsed.patches[0].range === '[0:0]', 'got unexpected first parsed patch')
        assert(parsed.patches[1].content_text === 'bbb'
               && parsed.patches[1].range === '[1:1]', 'got unexpected second parsed patch')

        a.abort()
        a2.abort()
    }
)

run_test(
    "status: false suppresses the HTTP status line in a subscription update",
    async () => {
        // add a handler that sends two updates and holds the subscription
        // open: the first suppresses its status line with status: false,
        // the second leaves status unset, which defaults to 200
        var endpoint = await add_main_handler((req, res) => {
            res.startSubscription()
            res.sendUpdate({ version: ['no-status'], status: false, body: '"hidden"' })
            res.sendUpdate({ version: ['with-status'], body: '"shown"' })
        })

        // subscribe over the raw transport and collect wire bytes until
        // both updates have arrived
        var a = new AbortController()
        var r = await og_fetch(endpoint, { signal: a.signal, headers: { subscribe: 'true' } })
        var reader = r.body.getReader()
        var raw = ''
        while (!raw.includes('"shown"')) {
            var { done, value } = await reader.read()
            assert(!done, `expected both updates on the wire, got: ${raw}`)
            raw += new TextDecoder().decode(value)
        }

        // the whole stream should contain exactly one status line, the
        // default-200 one -- status: false must not print one
        var status_lines = raw.match(/HTTP \d+ [^\r\n]*/g) || []
        assert(status_lines.length === 1,
            `expected exactly one status line, got: ${JSON.stringify(status_lines)}`)
        assert(status_lines[0] === 'HTTP 200 OK',
            `expected an HTTP 200 OK status line, got: ${JSON.stringify(status_lines[0])}`)

        // and that line must open the SECOND update: first the suppressed
        // update's headers and body, then the status line, then the rest
        var i = s => raw.indexOf(s)
        assert(i('Version: "no-status"') >= 0
            && i('Version: "no-status"') < i('"hidden"')
            && i('"hidden"') < i('HTTP 200 OK')
            && i('HTTP 200 OK') < i('Version: "with-status"')
            && i('Version: "with-status"') < i('"shown"'),
            `expected the status line to sit between the two updates, got: ${raw}`)

        a.abort()

        // now subscribe with braid_fetch: a status-suppressed update should
        // still parse cleanly, and not corrupt the update after it. we force
        // multiplex off because a multiplexed response would attach the outer
        // status to the first update, defeating the check below
        var a2 = new AbortController()
        var r2 = await fetch(endpoint, {
            signal: a2.signal,
            subscribe: true,
            multiplex: false
        })
        var updates = []
        await new Promise(done =>
            r2.subscribe(update => {
                updates.push(update)
                if (updates.length === 2) done()
            }))

        // the suppressed update parses with no status at all...
        assert(updates[0].version[0] === 'no-status', 'got unexpected first version')
        assert(updates[0].status === undefined,
            `expected no status on the first update, got: ${updates[0].status}`)
        assert(updates[0].body_text === '"hidden"', 'got unexpected first body')

        // ...and the following update still carries its default 200
        assert(updates[1].version[0] === 'with-status', 'got unexpected second version')
        assert(updates[1].status === '200',
            `expected status '200' on the second update, got: ${updates[1].status}`)
        assert(updates[1].body_text === '"shown"', 'got unexpected second body')

        a2.abort()
    }
)

add_section_header("reliable_update_channel Tests")

run_test(
    "reliable_update_channel receives updates via on_update and put sends a PUT",
    async () => {
        // a fresh braid-text key for this test, and a random id for keying
        // server-side state
        var s = Math.random().toString(36).slice(2)
        var key = `/braid-text-test/rug_${s}`
        var url = base_url + key

        // count the PUTs that actually reach the server for our key
        // (observing passively -- the request falls through to braid-text)
        await add_pre_braidify_handler((req, res, key, s) => {
            if (req.method === 'PUT' && req.url.split('?')[0] === key)
                global['_puts_' + s] = (global['_puts_' + s] ?? 0) + 1
        }, key, s)

        // open the channel -- braid-text greets a new subscriber with the
        // current state as a first update, and our PUT below should be
        // echoed back as a second update
        var resolve_first, resolve_second
        var got_first = new Promise(done => resolve_first = done)
        var got_second = new Promise(done => resolve_second = done)
        var update_count = 0
        var channel = reliable_update_channel(url, {
            on_update: update => {
                update_count++
                if (update_count === 1) resolve_first(update)
                if (update_count === 2) resolve_second(update)
            }
        })

        // wait for the initial update -- once it arrives the subscription is
        // established and the channel is online (no timer racing), and a
        // fresh key's initial state should be empty
        var first = await got_first
        assert(first.body_text === '', 'expected the initial update to be the empty state')

        // put a patch inserting some text, and make sure the put succeeds
        var r = await channel.put({
            patches: [{unit: 'text', range: '[0:0]', content: 'hello'}]
        })
        assert(r.ok, 'expected the put to succeed')

        // make sure put() really sent a PUT over the wire, exactly once
        var puts = await server_eval((req, res, s) =>
            res.end('' + (global['_puts_' + s] ?? 0)), s)
        assert(puts === '1', 'expected exactly one PUT to reach the server')

        // the put should come back over the subscription as a second update
        // carrying our patch
        var second = await got_second
        assert(second.patches?.[0]?.content_text === 'hello',
               'expected the second update to carry our patch')
        assert(update_count === 2, 'expected exactly two updates')

        channel.close()
    }
)

run_test(
    "reliable_update_channel retries the fetch if it throws",
    async () => {
        // add a handler that kills its first request's connection before
        // writing any response -- making the client's fetch throw -- and
        // serves a normal subscription from then on. attempts are counted in
        // a global keyed by a random id, so we can read the count back later
        // and prove the retry really happened
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_gets_' + s] = (global['_gets_' + s] ?? 0) + 1
            if (global['_gets_' + s] === 1)
                // destroy just the stream on http/2, or the whole socket on
                // http/1.1, as if the connection dropped
                return req.stream ? req.stream.destroy() : req.socket.destroy()
            res.startSubscription()
            res.sendUpdate({ version: ['v1'], body: 'hello' })
        }, s)

        // open a channel to it, collecting warnings -- the first fetch
        // throws, and the channel should retry ~1s later and succeed
        var warnings = []
        var channel
        var update = await new Promise(resolve => {
            channel = reliable_update_channel(endpoint, {
                on_update: update => resolve(update),
                on_warning: msg => warnings.push(msg)
            })
        })
        channel.close()

        // make sure the update is the one served by the retried connection
        assert(update.version[0] === 'v1', 'got unexpected version')
        assert(update.body_text === 'hello', 'got unexpected body')

        // a thrown fetch is network trouble, not a protocol problem -- the
        // channel should have retried it silently, without warning
        assert(warnings.length === 0, `expected no warnings, got: ${warnings}`)

        // make sure the server really saw two fetches: the one whose
        // connection it killed, and the retry
        var gets = await server_eval((req, res, s) =>
            res.end('' + global['_gets_' + s]), s)
        assert(gets === '2', `expected 2 fetch attempts, got ${gets}`)
    }
)

run_test(
    "reliable_update_channel retries put if it throws, and fires parallel puts in order",
    async () => {
        // a fresh doc path and id for this test's server-side state
        var s = Math.random().toString(36).slice(2)
        var key = '/put-retry-' + s
        var url = base_url + key

        // take over the doc path with a handler backed by the server's
        // braid-text instance: it logs every request it sees (puts by their
        // tag header), 500s the first put, and delays serving each surviving
        // put by 300ms -- so the two puts in flight alongside the failing one
        // can't succeed before the client reacts to the 500 by aborting them,
        // guaranteeing all three puts are still queued when the channel
        // reconnects, and must all be re-fired
        await add_pre_braidify_handler((req, res, s, key) => {
            if (!req.url.startsWith(key)) return
            var log = global['_reqs_' + s] = global['_reqs_' + s] ?? []
            log.push(req.method === 'PUT' ? req.headers['put-tag'] : req.method)

            // fail the first put with a 500 (and remember that we did)
            if (req.method === 'PUT' && !global['_put_failed_' + s]) {
                global['_put_failed_' + s] = true
                res.writeHead(500)
                res.end('')
            }
            // hold the surviving puts for 300ms before braid-text serves them
            else if (req.method === 'PUT')
                setTimeout(() => braid_text_instance.serve(req, res, {key}), 300)
            // braid-text serves everything else (the subscription gets)
            else
                braid_text_instance.serve(req, res, {key})
            return true
        }, s, key)

        // warm up a pool of connections against a trivial endpoint, and
        // consume the responses, which returns each connection to the pool.
        // without this the parallel puts below race: a put that finds an
        // idle connection reaches the server (and gets its 500 back) in
        // ~1ms, while the others are still in the tls handshake of a fresh
        // connection -- so the reboot triggered by the 500 aborts them
        // before they ever hit the wire, and the server never sees three
        // puts in flight together, breaking the asserted request sequence.
        // 8 covers every connection this test uses at once, plus the ones
        // destroyed when the client aborts them mid-request
        var warm_endpoint = await add_main_handler((req, res) => res.end('ok'))
        await Promise.all(Array.from({length: 8}, () =>
            og_fetch(warm_endpoint).then(r => r.text())))

        // open a channel, collecting warnings, and wait for the initial
        // update so we know the subscription is up before we put
        var warnings = []
        var channel
        await new Promise(done => {
            channel = reliable_update_channel(url, {
                on_warning: w => warnings.push(w),
                on_update: () => done()
            })
        })

        // fire 3 puts in parallel, each tagged with a header so the server's
        // log can tell them apart. the server 500s the first one, which makes
        // the channel abort the other two in flight, wait 1s, rebuild the
        // subscription, and re-fire all three in their original order
        var put = tag => channel.put({
            headers: {'put-tag': tag},
            patches: [{unit: 'text', range: '[0:0]', content: tag}]
        })
        var results = await Promise.all([put('a'), put('b'), put('c')])

        // every put should have resolved ok despite the failure
        assert(results.every(r => r.ok), 'expected all three puts to resolve ok')

        // the put failure was reported through on_warning
        assert(warnings.some(w => w.includes('put got unexpected status 500')),
               'expected a warning about the failed put')

        // read back what the server saw on this doc, and the doc's final
        // text, straight from the braid-text instance (and clean up)
        var seen = JSON.parse(await server_eval(async (req, res, s, key) => {
            var requests = global['_reqs_' + s]
            var failed = global['_put_failed_' + s]
            delete global['_reqs_' + s]
            delete global['_put_failed_' + s]
            res.end(JSON.stringify({
                requests, failed,
                text: await braid_text_instance.get(key)
            }))
        }, s, key))

        // the server really did 500 a put...
        assert(seen.failed, 'expected the server to have failed a put')

        // ...and it saw: the subscription, the three puts in order (the first
        // one failed), then the rebuilt subscription, then all three puts
        // retried, again in order
        assert(seen.requests.join(' ') === 'GET a b c GET a b c',
               `expected in-order puts and an in-order retry of all three, got: ${seen.requests.join(' ')}`)

        // the retried puts each inserted at position 0, in order a, b, c, so
        // the document should now read 'cba' -- proving they were applied in
        // order, and that the puts the client aborted mid-flight were not
        assert(seen.text === 'cba', `expected final text 'cba', got: '${seen.text}'`)

        channel.close()
    }
)

run_test(
    "reliable_update_channel reconnects when heartbeats stop",
    async () => {
        // add a handler that promises heartbeats but never sends any: it
        // echoes the Heartbeats header (arming the client's heartbeat timer),
        // then deletes the request header so braidify's startSubscription()
        // never starts its heartbeat loop. it sends one update, goes silent,
        // and counts each connection in a global keyed by our random id
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_conns_' + s] = (global['_conns_' + s] ?? 0) + 1
            res.setHeader('Heartbeats', req.headers.heartbeats)
            delete req.headers.heartbeats
            res.startSubscription()
            res.sendUpdate({ body: 'still alive' })
        }, s)

        // open a channel with a short timeout: the client expects a heartbeat
        // every 0.5s, gives up after 1.2 * 0.5 + 3 = 3.6s of silence, and
        // reconnects 1s later -- receiving the handler's one update again
        var bodies = []
        var statuses = []
        var got_second
        var second_update = new Promise(done => got_second = done)
        var channel = reliable_update_channel(endpoint, {
            timeout: 0.5,
            on_status: x => statuses.push(x.online),
            on_update: update => {
                bodies.push(update.body_text)
                if (bodies.length === 2) got_second()
            }
        })

        // wait for the reconnect to deliver the update a second time (if it
        // never comes, the test runner's timeout fails the test)
        await second_update

        // make sure both updates carried the body the handler sent
        assert(bodies.every(b => b === 'still alive'), 'got unexpected update bodies')

        // make sure the channel reported going offline when the heartbeats
        // stopped, and back online when it reconnected
        assert(JSON.stringify(statuses) === JSON.stringify([true, false, true]),
            'expected the channel to go online, offline, then online again')

        // make sure the second update really came over a second connection
        var conns = await server_eval((req, res, s) =>
            res.end('' + (global['_conns_' + s] ?? 0)), s)
        assert(conns === '2', `expected the server to see exactly 2 connections, saw ${conns}`)

        channel.close()
    }
)

run_test(
    "reliable_update_channel on_warning is called for non-silent status codes",
    async () => {
        // add a handler that 500s the first GET -- 500 is not in the client's
        // silent-retry list, and we send no Retry-After, so the channel should
        // warn about it -- and serves a normal subscription after that. it
        // counts GETs in a global keyed by a random id so we can check
        // server-side that the failure and the reconnect really happened (the
        // id is passed as an arg since the handler runs server-side via eval,
        // and can't close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            var gets = global['_gets_' + s] = (global['_gets_' + s] ?? 0) + 1
            if (gets === 1) {
                res.statusCode = 500
                return res.end('')
            }
            res.startSubscription()
            res.sendUpdate({ body: 'hello' })
        }, s)

        // open a channel on the endpoint, collecting warnings, and wait for
        // the first update -- it can only arrive after the 500 has been
        // handled and the channel has reconnected
        var warnings = []
        var channel
        var update = await new Promise(done => {
            channel = reliable_update_channel(endpoint, {
                on_warning: msg => warnings.push(msg),
                on_update: done
            })
        })
        channel.close()

        // make sure the update is the one served by the reconnected GET
        assert(update.body_text === 'hello', 'got unexpected body')

        // double-check with the server that it really served the failing GET
        // plus exactly one reconnect
        var gets = await server_eval((req, res, s) =>
            res.end('' + global['_gets_' + s]), s)
        assert(gets === '2', `expected 2 GETs, got ${gets}`)

        // the 500 should have produced exactly one warning naming the status,
        // and the silent successful reconnect none
        assert(warnings.length === 1,
               `expected exactly one warning, got ${JSON.stringify(warnings)}`)
        assert(warnings[0] === `subscription to ${endpoint} got unexpected status 500`,
               `got unexpected warning: ${warnings[0]}`)
    }
)

run_test(
    "reliable_update_channel does not warn on silent-retry status codes",
    async () => {
        // add a handler that answers its first GET with 503 (a code on the
        // channel's silent-retry list) and serves a real subscription from
        // then on, counting GETs in a global keyed by a random id so we can
        // later prove the 503 actually fired. the update is passed as an arg
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables)
        var s = Math.random().toString(36).slice(2)
        var update = { version: ['v1'], body: 'hello after retry' }
        var endpoint = await add_main_handler((req, res, s, update) => {
            var gets = global['_gets_' + s] = (global['_gets_' + s] ?? 0) + 1
            if (gets === 1) {
                res.writeHead(503)
                return res.end('')
            }
            res.startSubscription()
            res.sendUpdate(update)
        }, s, update)

        // open a reliable_update_channel on that endpoint, collecting any
        // warnings it emits, and wait for an update to come through
        var warnings = []
        var channel
        var received = await new Promise(resolve => {
            channel = reliable_update_channel(endpoint, {
                on_warning: msg => warnings.push(msg),
                on_update: resolve
            })
        })
        channel.close()

        // getting an update at all means the channel survived the 503; make
        // sure it's the one from the retried subscription
        assert(received.version[0] === 'v1' && received.body_text === update.body,
            'expected the update from the retried subscription')

        // and the interesting path really ran: the endpoint saw the 503'd
        // GET plus exactly one reconnect attempt
        var gets = await server_eval((req, res, s) =>
            res.end('' + global['_gets_' + s]), s)
        assert(gets === '2', 'expected the 503 plus exactly one retry')

        // the whole point: a silent-retry code recovers without a warning
        assert(warnings.length === 0, `expected no warnings, got: ${warnings.join('; ')}`)
    }
)

run_test(
    "reliable_update_channel honors Retry-After header on subscription responses",
    async () => {
        // add a handler whose first GET answers 200 -- a status that is not
        // in the channel's silent-retry list -- with a Retry-After: 4 header,
        // and serves a real subscription after that. it logs each GET's
        // arrival time in a global keyed by our random id, so we can measure
        // the reconnect delay server-side (the id is passed as an arg since
        // the handler runs server-side via eval, and can't close over
        // test-side variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            var gets = global['_gets_' + s] = global['_gets_' + s] ?? []
            gets.push(Date.now())
            if (gets.length === 1) {
                res.writeHead(200, { 'Retry-After': '4' })
                return res.end('')
            }
            res.startSubscription()
            res.sendUpdate({ version: ['v1'], body: 'reconnected' })
        }, s)

        // open a channel on it, collecting warnings, and wait for the first
        // update -- it can only come from the subscription the handler
        // serves after the reconnect
        var warnings = []
        var channel
        var update = await new Promise(done => {
            channel = reliable_update_channel(endpoint, {
                on_warning: msg => warnings.push(msg),
                on_update: done
            })
        })
        channel.close()

        // the update should be the one from the post-reconnect subscription
        assert(update.version[0] === 'v1', 'got unexpected version')
        assert(update.body_text === 'reconnected', 'got unexpected body')

        // a 200 on a subscription is a failure (only 209 is success), and
        // it's not in the silent-retry list -- but Retry-After marks it
        // transient, so the channel should retry without warning
        assert(warnings.length === 0,
               'expected no warnings, got ' + JSON.stringify(warnings))

        // read back the server-side GET log: exactly two GETs should have
        // arrived, the rigged failure and one reconnect
        var gets = JSON.parse(await server_eval((req, res, s) =>
            res.end(JSON.stringify(global['_gets_' + s])), s))
        assert(gets.length === 2, 'expected exactly two GETs, got ' + gets.length)

        // and the reconnect should have waited out the Retry-After: 4 --
        // longer than both built-in fallback delays (1s for a first failure,
        // 3s after that), so clearing this bound proves the header was
        // honored rather than either default kicking in
        assert(gets[1] - gets[0] >= 3600,
               `expected the reconnect to wait ~4s, waited ${gets[1] - gets[0]}ms`)
    }
)

run_test(
    "reliable_update_channel calls parents() callback on each (re)connect",
    async () => {
        // add a handler that logs the parents header it sees on each GET
        // (into a global keyed by our random id) and then 500s the request,
        // so the channel keeps failing and reconnecting
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_parents_' + s] = global['_parents_' + s] ?? []
            global['_parents_' + s].push(req.headers.parents ?? null)
            res.writeHead(500)
            res.end('')
        }, s)

        // open a channel whose parents() callback returns nothing on the
        // first connect and a fresh version on the second, so a client that
        // memoized the first result instead of re-invoking the callback
        // would send no parents header on the reconnect. each failing GET
        // warns, so waiting for two warnings sequences us past both the
        // initial connect and the first reconnect
        var parents_calls = 0
        var warnings = []
        var channel
        await new Promise(done => {
            channel = reliable_update_channel(endpoint, {
                reconnect_from_parents: () => (++parents_calls === 1) ? null : ['abc-1'],
                on_warning: msg => {
                    warnings.push(msg)
                    if (warnings.length === 2) done()
                }
            })
        })
        channel.close()

        // the client re-invoked parents() for the reconnect...
        assert(parents_calls === 2, 'expected parents() to be called once per connect')

        // ...and both connect attempts really did fail with our 500s
        assert(warnings.every(w => w.includes('status 500')), 'expected both warnings to report the 500s')

        // read back the parents headers the server saw
        var log = JSON.parse(await server_eval((req, res, s) =>
            res.end(JSON.stringify(global['_parents_' + s])), s))

        // the first connect sent no parents; the reconnect sent the fresh
        // value from the re-invoked callback
        assert(log.length === 2, 'expected the server to see exactly two GETs')
        assert(log[0] === null, 'expected no parents header on the first connect')
        assert(log[1] === '"abc-1"', 'expected the reconnect to send the fresh parents')
    }
)

run_test(
    "reliable_update_channel retries all queued PUTs in parallel after reconnect",
    async () => {
        // when a PUT fails, the channel tears down the whole connection,
        // resubscribes, and re-fires everything still queued all at once --
        // no one-at-a-time probe step. we queue 3 PUTs across a failure and
        // check that the server sees all 3 in flight together afterwards

        // add a handler that plays the whole channel endpoint: GETs become
        // subscriptions, the first PUT fails fast with a 500 (knocking the
        // channel over), and every later PUT is held open 200ms so overlap
        // is observable. state lives in a global keyed by a random id, since
        // the handler runs server-side and can't close over test variables
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            var state = global['_fanout_' + s] = global['_fanout_' + s]
                ?? {gets: 0, puts: 0, in_flight: 0, retry_puts: 0, retry_max: 0}
            if (req.method === 'GET') {
                state.gets++
                res.startSubscription()
                return res.sendUpdate({version: [`v${state.gets}`], body: 'hi'})
            }
            // fail the first PUT immediately -- the client should abort its
            // other in-flight PUTs (still inside their 200ms hold, so they
            // can't have resolved) and reconnect with all 3 still queued
            state.puts++
            if (state.puts === 1) {
                res.statusCode = 500
                return res.end('')
            }
            // count the PUTs that arrive after the reconnect (the second
            // GET), and how many of them overlap: if the client re-fired the
            // queue one at a time, each 200ms hold would end before the next
            // PUT arrived, and retry_max would never get past 1
            var retrying = state.gets >= 2
            if (retrying) {
                state.retry_puts++
                state.in_flight++
                if (state.in_flight > state.retry_max) state.retry_max = state.in_flight
            }
            setTimeout(() => {
                if (retrying) state.in_flight--
                res.end('ok')
            }, 200)
        }, s)

        // open a channel, collecting warnings, and wait for the first update
        // so we know the subscription is up -- puts only fan out immediately
        // once the channel is online
        var warnings = []
        var channel
        await new Promise(online => {
            channel = reliable_update_channel(endpoint, {
                on_warning: msg => warnings.push(msg),
                on_update: online
            })
        })

        // fire 3 parallel PUTs. whichever reaches the server first gets the
        // 500; the rest die mid-hold when the failure reboots the channel
        var results = await Promise.all([
            channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'a'}]}),
            channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'b'}]}),
            channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'c'}]})
        ])

        // all 3 PUTs eventually succeeded, on the retried connection
        assert(results.every(r => r.ok), 'expected all 3 queued PUTs to succeed after reconnect')

        // the failing PUT's 500 got warned about -- proof the failure path
        // actually ran, and the channel really had a queue to retry
        assert(warnings.some(w => /500/.test(w)), 'expected a warning about the PUT that got a 500')

        // read back what the server saw: exactly one reconnect, all 3 PUTs
        // re-fired after it, and all 3 in flight at once -- the parallel
        // fan-out, with no probe step
        var state = JSON.parse(await server_eval((req, res, s) =>
            res.end(JSON.stringify(global['_fanout_' + s])), s))
        assert(state.gets === 2, `expected exactly one reconnect, saw ${state.gets} GETs`)
        assert(state.retry_puts === 3, `expected all 3 PUTs re-fired after reconnect, saw ${state.retry_puts}`)
        assert(state.retry_max === 3, `expected 3 PUTs in flight in parallel, saw ${state.retry_max}`)

        channel.close()
    }
)

run_test(
    "reliable_update_channel put: on_warning is called for non-silent status codes",
    async () => {
        // add a handler whose GET holds a subscription open, and whose first
        // PUT fails with 500 -- a status that is not in the silent-retry list
        // and carries no Retry-After, so the channel should warn about it --
        // counting the PUTs in a global keyed by a random id (the handler
        // runs server-side, so it can't close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            if (req.method === 'PUT') {
                var puts = global['_puts_' + s] = (global['_puts_' + s] ?? 0) + 1
                res.writeHead(puts === 1 ? 500 : 200)
                return res.end('')
            }
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        }, s)

        // open a channel to it, collecting warnings, and wait for the first
        // update so we know the subscription is established
        var warnings = []
        var subscribed
        var first_update = new Promise(done => subscribed = done)
        var channel = reliable_update_channel(endpoint, {
            on_warning: msg => warnings.push(msg),
            on_update: () => subscribed()
        })
        await first_update

        // send a PUT -- the server 500s it, so the channel should warn,
        // reconnect, and retry the PUT until it succeeds
        var r = await channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'x'}]})
        assert(r.status === 200, 'expected the retried put to succeed')

        // the failing PUT produced exactly one warning, naming its status
        assert(warnings.length === 1, 'expected exactly one warning')
        assert(warnings[0] === 'put got unexpected status 500', 'expected a warning about the 500')

        // and the server really saw two PUTs: the 500'd one, plus the
        // successful retry
        var puts = await server_eval((req, res, s) =>
            res.end('' + (global['_puts_' + s] ?? 0)), s)
        assert(puts === '2', 'expected exactly two puts to reach the server')

        channel.close()
    }
)

run_test(
    "reliable_update_channel put: does not warn on silent-retry status codes",
    async () => {
        // add a handler that serves a subscription on GET, and answers each
        // PUT with the next status from a schedule: the first put's first
        // attempt gets a 503, its retry a 200, then the second put's first
        // attempt gets a 432, its retry a 200. both failure codes are in the
        // client's silent-retry list. the attempts are counted in a global
        // keyed by a random id, so we can read the count back later and
        // prove the rejections and retries really happened
        var s = Math.random().toString(36).slice(2)
        var statuses = [503, 200, 432, 200]
        var endpoint = await add_main_handler((req, res, s, statuses) => {
            if (req.method === 'PUT') {
                var puts = global['_puts_' + s] = (global['_puts_' + s] ?? 0) + 1
                res.writeHead(statuses[puts - 1] ?? 200)
                return res.end('')
            }
            res.startSubscription()
            res.sendUpdate({ version: ['v1'], body: 'hello' })
        }, s, statuses)

        // open a channel to it, collecting warnings, and wait for the
        // greeting update -- once it arrives the channel is online (no
        // timer racing)
        var warnings = []
        var channel
        await new Promise(resolve => {
            channel = reliable_update_channel(endpoint, {
                on_update: () => resolve(),
                on_warning: msg => warnings.push(msg)
            })
        })

        // put an update -- its first attempt gets the 503, so the channel
        // reconnects and retries ~1s later; the put should resolve with the
        // retry's 200, not the 503
        var r = await channel.put({ body: 'x' })
        assert(r.ok, 'expected the first put to succeed on retry')

        // put again -- same dance, with the 432 this time
        var r2 = await channel.put({ body: 'y' })
        assert(r2.ok, 'expected the second put to succeed on retry')
        channel.close()

        // make sure the server really saw all four PUTs (two rejections,
        // two successful retries) -- otherwise "no warnings" would pass
        // vacuously, without the silent-retry path ever running
        var puts = await server_eval((req, res, s) =>
            res.end('' + (global['_puts_' + s] ?? 0)), s)
        assert(puts === '4', `expected 4 put attempts, got ${puts}`)

        // 503 and 432 are silent-retry codes: the whole dance should have
        // happened without a single warning
        assert(warnings.length === 0, `expected no warnings, got: ${warnings}`)
    }
)

run_test(
    "reliable_update_channel put: honors Retry-After header",
    async () => {
        // add a handler serving both halves of a channel: every GET gets a
        // real subscription greeted with one update, and the first PUT is
        // answered 500 -- a status not in the channel's silent-retry list --
        // with a Retry-After: 4 header, while later PUTs succeed. it logs
        // each PUT's arrival time (and counts GETs) in globals keyed by our
        // random id, so we can measure the retry delay server-side (the id
        // is passed as an arg since the handler runs server-side via eval,
        // and can't close over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            if (req.method === 'PUT') {
                var puts = global['_puts_' + s] = global['_puts_' + s] ?? []
                puts.push(Date.now())
                if (puts.length === 1) {
                    res.writeHead(500, { 'Retry-After': '4' })
                    return res.end('')
                }
                res.writeHead(200)
                return res.end('')
            }
            global['_gets_' + s] = (global['_gets_' + s] ?? 0) + 1
            res.startSubscription()
            res.sendUpdate({ body: 'hello' })
        }, s)

        // open a channel on it, collecting warnings, and wait for the
        // greeting update -- once it arrives the channel is online, so the
        // put below fires immediately (no timer racing)
        var warnings = []
        var channel
        await new Promise(done => {
            channel = reliable_update_channel(endpoint, {
                on_warning: msg => warnings.push(msg),
                on_update: done
            })
        })

        // put a patch: the handler 500s it, and the channel should retry it
        // after the Retry-After delay and resolve once the retry succeeds
        var r = await channel.put({
            patches: [{unit: 'text', range: '[0:0]', content: 'x'}]
        })
        channel.close()
        assert(r.ok, 'expected the retried put to succeed')

        // a 500 is not in the silent-retry list, but Retry-After marks it
        // transient, so the failed put should have retried without warning
        assert(warnings.length === 0,
               'expected no warnings, got ' + JSON.stringify(warnings))

        // read back the server-side logs: the endpoint should have seen
        // exactly two PUTs -- the rigged failure and one retry -- and two
        // GETs, since a put failure reboots the whole channel, subscription
        // included
        var log = JSON.parse(await server_eval((req, res, s) =>
            res.end(JSON.stringify({
                puts: global['_puts_' + s],
                gets: global['_gets_' + s]
            })), s))
        assert(log.puts.length === 2, 'expected exactly two PUTs, got ' + log.puts.length)
        assert(log.gets === 2, 'expected the put failure to rebuild the subscription')

        // and the retry should have waited out the Retry-After: 4 -- longer
        // than both built-in fallback delays (1s for a first failure, 3s
        // after that), so clearing this bound proves the header was honored
        // rather than either default kicking in
        assert(log.puts[1] - log.puts[0] >= 3600,
               `expected the retry to wait ~4s, waited ${log.puts[1] - log.puts[0]}ms`)
    }
)

run_test(
    "reliable_update_channel put: times out and retries if PUT never responds",
    async () => {
        // add a handler that serves the channel's subscription normally, but
        // hangs its first PUT forever (never responding) and answers 200 to
        // later PUTs. the PUTs are counted in a global keyed by a random id
        // (the handler runs server-side via eval, so it can't close over
        // test-side variables) so we can verify the retry really happened
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            if (req.method === 'PUT') {
                var n = global['_puts_' + s] = (global['_puts_' + s] ?? 0) + 1
                if (n === 1) return   // hang forever: never respond
                req.on('data', () => {})
                return req.on('end', () => res.end())
            }
            res.startSubscription()
            res.sendUpdate({ version: ['v1'], body: 'hi' })
        }, s)

        // open a channel with a short 1s timeout so the test runs fast,
        // recording status transitions and warnings, and wait for the first
        // update so we know the subscription is up before we put
        var statuses = []
        var warnings = []
        var got_update
        var first_update = new Promise(done => got_update = done)
        var channel = reliable_update_channel(endpoint, {
            on_update: () => got_update(),
            on_status: status => statuses.push(status),
            on_warning: msg => warnings.push(msg),
            timeout: 1  // 1 second
        })
        await first_update

        // fire a put: the first PUT hangs and times out after ~1s, the
        // channel reboots, waits the ~1s retry delay, resubscribes, and
        // re-sends the put, which succeeds this time
        var start = Date.now()
        var r = await channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'x'}]})
        var elapsed = Date.now() - start
        channel.close()

        // the put promise resolved with the retry's 2xx response
        assert(r.ok, 'expected the retried put to succeed')

        // the timeout-then-retry path takes ~2s (1s put timeout + 1s retry
        // delay) -- much faster would mean the first put never hung
        assert(elapsed >= 1800, `expected put to take ~2s, took ${elapsed}ms`)

        // the channel really rebooted: it reported going offline, and the
        // server saw exactly two puts (the hung one, then the retry)
        assert(statuses.some(status => !status.online), 'expected the channel to go offline while rebooting')
        var puts = await server_eval((req, res, s) => res.end('' + global['_puts_' + s]), s)
        assert(puts === '2', `expected 2 puts (hung + retry), got ${puts}`)

        // a put timeout is a transient failure: it retries without warning
        assert(warnings.length === 0, `expected no warnings, got: ${warnings}`)
    }
)

run_test(
    "reliable_update_channel forwards user-supplied headers to GET and PUT",
    async () => {
        // add a handler that logs each request's method and headers in a
        // global keyed by a random id (the handler runs server-side via eval,
        // so it can't close over test-side variables), then serves a
        // subscription to GETs and a 200 to PUTs
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            var log = global['_headers_' + s] = global['_headers_' + s] ?? []
            log.push({ method: req.method, headers: { ...req.headers } })
            if (req.method === 'PUT') {
                // drain the body before acknowledging
                req.on('data', () => {})
                req.on('end', () => res.end())
                return
            }
            res.startSubscription()
            res.sendUpdate({ body: 'hi' })
        }, s)

        // open a channel with custom headers on both the GET and the PUT --
        // custom (x-...) names only, since browsers forbid JS from setting
        // Cookie, Host, etc. via fetch(). wait for the first update, so we
        // know the subscription's GET has reached the server
        var got_update
        var first_update = new Promise(done => got_update = done)
        var channel = reliable_update_channel(endpoint, {
            get_headers: { 'X-Test-Header': 'hello', 'X-Another-Header': 'world' },
            put_headers: { 'X-Test-Header': 'hello', 'X-Another-Header': 'world' },
            on_update: () => got_update()
        })
        await first_update

        // send a put, and make sure the server accepted it
        var r = await channel.put({ patches: [{ unit: 'text', range: '[0:0]', content: 'x' }] })
        assert(r.ok, 'expected the put to succeed')
        channel.close()

        // read back what the server saw: exactly one GET (the subscription)
        // and one PUT -- no stray retries or reconnects
        var log = JSON.parse(await server_eval((req, res, s) =>
            res.end(JSON.stringify(global['_headers_' + s] ?? [])), s))
        var gets = log.filter(r => r.method === 'GET')
        var puts = log.filter(r => r.method === 'PUT')
        assert(gets.length === 1, `expected exactly one GET, but the server saw ${gets.length}`)
        assert(puts.length === 1, `expected exactly one PUT, but the server saw ${puts.length}`)

        // both requests carried both custom headers (node lowercases
        // incoming header names)
        for (var req of [...gets, ...puts]) {
            assert(req.headers['x-test-header'] === 'hello',
                   `expected the ${req.method} to carry x-test-header`)
            assert(req.headers['x-another-header'] === 'world',
                   `expected the ${req.method} to carry x-another-header`)
        }

        // and the custom headers supplemented -- not replaced -- the
        // channel's own headers: the subscription's Heartbeats header
        // survived the merge
        assert(gets[0].headers.heartbeats, `expected the GET to still carry the channel's heartbeats header`)
    }
)

run_test(
    "reliable_update_channel warns and aborts on subscription parse errors",
    async () => {
        // add a handler that starts a subscription and then writes raw bytes
        // that aren't a legal update -- the second header line has no colon,
        // so the client's parser will choke on it. GETs are counted in a
        // global keyed by a random id, so we can check later that the channel
        // never reconnected (the id is passed as an arg since the handler
        // runs server-side via eval, and can't close over test-side
        // variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_gets_' + s] = (global['_gets_' + s] ?? 0) + 1
            res.startSubscription()
            res.write('hello: true\r\n')
            res.write('hello\r\n')
            res.write('Content-Length: 2\r\n')
            res.write('\r\n')
            res.write('hi')
        }, s)

        // open a channel on the endpoint, collecting warnings, errors, and
        // updates -- a corrupt stream won't be fixed by reconnecting, so the
        // channel should shut itself down, reporting the error via on_error
        // (if it never does, the test runner's timeout fails the test)
        var warnings = []
        var errors = []
        var updates = []
        var channel
        await new Promise(done => {
            channel = reliable_update_channel(endpoint, {
                on_update: update => updates.push(update),
                on_warning: msg => warnings.push(msg),
                on_error: err => { errors.push(err); done() }
            })
        })

        // make sure on_error received the parser's error
        assert(errors[0]?.type === 'parse', `expected a parse error, got: ${errors[0]}`)
        assert(/^Parse error in headers/.test(errors[0].message),
               `got unexpected error message: ${errors[0].message}`)

        // the shutdown should be preceded by exactly one warning naming the
        // same error
        assert(warnings.length === 1,
               `expected exactly one warning, got ${JSON.stringify(warnings)}`)
        assert(warnings[0] === 'subscription error: ' + errors[0].message,
               `got unexpected warning: ${warnings[0]}`)

        // the garbage must not have been misread as a valid update
        assert(updates.length === 0, 'expected no updates from the garbage stream')

        // "aborts" means aborts for good: wait past the client's 1s reconnect
        // delay, and make sure it never reconnected -- the server saw just
        // the one GET, and the client reported nothing further
        await new Promise(done => setTimeout(done, 1500))
        var gets = await server_eval((req, res, s) =>
            res.end('' + global['_gets_' + s]), s)
        assert(gets === '1', `expected exactly 1 GET, got ${gets}`)
        assert(errors.length === 1 && warnings.length === 1 && updates.length === 0,
               'expected nothing further after shutdown')

        channel.close()
    }
)

run_test(
    "reliable_update_channel on_status reports online transitions",
    async () => {
        // add a handler that 500s its first request and serves a normal
        // subscription from then on. requests are counted in a global keyed
        // by a random id, so we can read the count back later and prove the
        // 500 and the retry really happened
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_gets_' + s] = (global['_gets_' + s] ?? 0) + 1
            if (global['_gets_' + s] === 1) {
                res.writeHead(500)
                return res.end('')
            }
            res.startSubscription()
            res.sendUpdate({ version: ['v1'], body: 'hello' })
        }, s)

        // open a channel to it, collecting statuses and warnings -- the
        // first subscription attempt gets the 500, and the channel should
        // retry ~1s later, succeed, and report going online
        var statuses = []
        var warnings = []
        var channel
        var update = await new Promise(resolve => {
            channel = reliable_update_channel(endpoint, {
                on_update: update => resolve(update),
                on_status: status => statuses.push({...status}),
                on_warning: msg => warnings.push(msg)
            })
        })

        // the update carries what the retried subscription served, proving
        // the channel really reconnected after the 500
        assert(update.version[0] === 'v1', 'got unexpected version')
        assert(update.body_text === 'hello', 'got unexpected body')

        // by the time the update arrives, the only transition reported
        // should be going online -- the initial connect never went online,
        // so its 500 must not produce an offline report
        assert(statuses.length === 1,
               `expected exactly one status, got ${JSON.stringify(statuses)}`)
        assert(statuses[0].online === true, 'expected the channel to report going online')
        assert(statuses[0].outstanding_puts === 0, 'expected no outstanding puts')

        channel.close()

        // a 500 is not one of the channel's silent-retry codes, so it should
        // have warned about it -- which also proves the first attempt really
        // was rejected with a 500
        assert(warnings.length === 1 && /status 500/.test(warnings[0]),
               `expected one warning about the 500, got: ${warnings}`)

        // make sure the server really saw two subscription attempts: the
        // one it 500'd, and the successful retry
        var gets = await server_eval((req, res, s) =>
            res.end('' + global['_gets_' + s]), s)
        assert(gets === '2', `expected 2 subscription attempts, got ${gets}`)
    }
)

run_test(
    "reliable_update_channel on_status reports outstanding_puts",
    async () => {
        // a fresh braid-text key for this test, and a random id for keying
        // server-side state
        var s = Math.random().toString(36).slice(2)
        var key = `/braid-text-test/status_puts_${s}`
        var url = base_url + key

        // count the PUTs that actually reach the server for our key
        // (observing passively -- the request falls through to braid-text)
        await add_pre_braidify_handler((req, res, key, s) => {
            if (req.method === 'PUT' && req.url.split('?')[0] === key)
                global['_puts_' + s] = (global['_puts_' + s] ?? 0) + 1
        }, key, s)

        // open the channel, recording every status report -- braid-text
        // greets a new subscriber with the current state, so waiting for
        // that first update tells us the subscription is established
        // (no timer racing)
        var statuses = []
        var channel
        await new Promise(resolve => {
            channel = reliable_update_channel(url, {
                on_update: () => resolve(),
                on_status: status => statuses.push({...status})
            })
        })

        // before the put, the only status should be the channel coming
        // online, with nothing outstanding
        assert(statuses.length === 1,
               `expected exactly one status before the put, got ${statuses.length}`)
        assert(statuses[0].online === true, 'expected the channel to report online')
        assert(statuses[0].outstanding_puts === 0, 'expected no outstanding puts before the put')

        // fire a put and wait for it to complete
        var r = await channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'x'}]})
        assert(r.ok, 'expected the put to succeed')

        // the put should produce exactly two more statuses: outstanding_puts
        // rising to 1 the moment it is enqueued, and falling back to 0 when
        // the server acknowledges it -- with the channel online throughout
        assert(statuses.length === 3,
               `expected exactly three statuses after the put, got ${statuses.length}`)
        assert(statuses[1].outstanding_puts === 1, 'expected the enqueued put to be reported as outstanding')
        assert(statuses[2].outstanding_puts === 0, 'expected outstanding_puts to drop back to 0 when the put completes')
        assert(statuses[1].online === true && statuses[2].online === true,
               'expected the channel to stay online across the put')

        // make sure the put was acknowledged for real: exactly one PUT
        // reached the server
        var puts = await server_eval((req, res, s) =>
            res.end('' + (global['_puts_' + s] ?? 0)), s)
        assert(puts === '1', `expected exactly one PUT to reach the server, got ${puts}`)

        channel.close()
    }
)

run_test(
    "reliable_update_channel failure_status_codes shuts down on matching GET status",
    async () => {
        // add a handler that 403s every subscription attempt, counting the
        // attempts in a global keyed by a random id, so we can read the
        // count back later and prove the channel really stopped asking
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            global['_gets_' + s] = (global['_gets_' + s] ?? 0) + 1
            res.writeHead(403)
            res.end('')
        }, s)

        // open a channel that treats 403 as fatal -- instead of retrying
        // like it would for other statuses, it should shut itself down and
        // report the failure through on_error
        var errors = []
        var warnings = []
        var went_online = false
        var update_count = 0
        var channel
        await new Promise(resolve => {
            channel = reliable_update_channel(endpoint, {
                on_update: () => update_count++,
                on_status: status => { if (status.online) went_online = true },
                on_warning: msg => warnings.push(msg),
                on_error: err => { errors.push(err); resolve() },
                failure_status_codes: [403]
            })
        })

        // the shutdown error should name the fatal status
        assert('' + errors[0] === 'Error: status 403', `got unexpected error: ${errors[0]}`)

        // a fatal status shuts the channel down directly -- it should not
        // have taken the warn-and-retry path
        assert(warnings.length === 0, `expected no warnings, got: ${warnings}`)

        // the subscription never got established
        assert(!went_online, 'expected the channel to never go online')
        assert(update_count === 0, 'expected no updates')

        // "shuts down" means no reconnecting: wait past the ~1s backoff a
        // retrying channel would use, then make sure the server saw only
        // the one GET and no more errors surfaced
        await new Promise(done => setTimeout(done, 1500))
        var gets = await server_eval((req, res, s) =>
            res.end('' + global['_gets_' + s]), s)
        assert(gets === '1', `expected exactly one GET, got ${gets}`)
        assert(errors.length === 1, `expected exactly one error, got ${errors.length}`)

        channel.close()
    }
)

run_test(
    "reliable_update_channel failure_status_codes shuts down on matching PUT status",
    async () => {
        // add a handler that serves a normal subscription on GET, and 403s
        // every PUT, counting the PUTs in a global keyed by a random id so we
        // can later prove the failing PUT really fired (the id is passed as
        // an arg since the handler runs server-side via eval, and can't close
        // over test-side variables)
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            if (req.method === 'PUT') {
                global['_puts_' + s] = (global['_puts_' + s] ?? 0) + 1
                res.statusCode = 403
                return res.end('')
            }
            res.startSubscription()
            res.sendUpdate({ body: 'hello' })
        }, s)

        // open a channel that treats 403 as fatal, collecting errors and
        // warnings, and wait for the first update -- once it arrives the
        // subscription is established and the channel is online (no timer
        // racing), so the put below fires immediately
        var errors = []
        var warnings = []
        var got_error
        var errored = new Promise(done => got_error = done)
        var channel
        await new Promise(done => {
            channel = reliable_update_channel(endpoint, {
                on_update: done,
                on_error: err => { errors.push(err); got_error() },
                on_warning: msg => warnings.push(msg),
                failure_status_codes: [403]
            })
        })

        // fire a put: its 403 matches failure_status_codes, so instead of
        // reconnecting and retrying, the channel should shut itself down --
        // which rejects the still-queued put with the channel's abort error
        var put_error
        await channel.put({patches: [{unit: 'text', range: '[0:0]', content: 'x'}]})
            .then(() => assert(false, 'expected the put to be rejected'),
                  err => put_error = err)
        assert('' + put_error === 'Error: reliable_update_channel aborted',
               `expected the shutdown to reject the queued put, got: ${put_error}`)

        // the shutdown should report the fatal status through on_error,
        // exactly once, and a fatal code should not also produce a warning
        await errored
        assert(errors.length === 1, `expected exactly one error, got ${errors.length}`)
        assert('' + errors[0] === 'Error: status 403', `got unexpected error: ${errors[0]}`)
        assert(warnings.length === 0, `expected no warnings, got: ${warnings}`)

        // make sure the put really sent a PUT over the wire, exactly once --
        // if the channel had rebooted instead of shutting down, it would
        // retry the put on reconnect
        var puts = await server_eval((req, res, s) =>
            res.end('' + (global['_puts_' + s] ?? 0)), s)
        assert(puts === '1', `expected exactly one PUT to reach the server, saw ${puts}`)

        channel.close()
    }
)

run_test(
    "reliable_update_channel reconnect() triggers a fresh reconnection",
    async () => {
        // add a handler that logs the parents of each subscription request in
        // a global keyed by a random id (passed as an arg, since the handler
        // runs server-side and can't close over test variables), then
        // subscribes the client and sends one update
        var s = Math.random().toString(36).slice(2)
        var endpoint = await add_main_handler((req, res, s) => {
            (global['_subs_' + s] ||= []).push(req.parents)
            res.startSubscription()
            res.sendUpdate({ version: ['v1'], body: 'hello' })
        }, s)

        // open a channel that computes fresh parents for every connection and
        // records each status change, and wait for the first connection's
        // update to arrive
        var parents_calls = 0
        var statuses = []
        var next_update = () => {}
        var channel
        var first = await new Promise(done => {
            next_update = done
            channel = reliable_update_channel(endpoint, {
                on_update: u => next_update(u),
                reconnect_from_parents: () => ['r' + (++parents_calls)],
                on_status: status => statuses.push({...status})
            })
        })
        assert(first.body_text === 'hello', 'got unexpected body on the first connection')

        // manually trigger a reconnect: the channel should immediately report
        // offline and tear down the current connection
        var got_update_again = new Promise(done => next_update = done)
        channel.reconnect()
        assert(statuses.length && !statuses[statuses.length - 1].online,
               'expected the channel to report offline after reconnect()')

        // ...then reconnect on its own: a fresh connection delivers the
        // update again
        var second = await got_update_again
        assert(second.body_text === 'hello', 'got unexpected body on the fresh connection')

        // the status callback saw the full round trip: online, offline, online
        assert(JSON.stringify(statuses.map(x => x.online)) === JSON.stringify([true, false, true]),
               `expected the channel to go online, offline, then back online, but got: ${JSON.stringify(statuses)}`)

        // read back the server's log: exactly two subscription requests
        // arrived, each carrying the parents freshly computed by
        // reconnect_from_parents for that connection
        var subs = await server_eval((req, res, s) =>
            res.end(JSON.stringify(global['_subs_' + s] ?? [])), s)
        assert(subs === JSON.stringify([['r1'], ['r2']]),
               `expected two subscriptions with freshly computed parents, but the server saw: ${subs}`)

        channel.close()
    }
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
