// Shared test definitions that work in both Node.js and browser environments
// This file exports a function that takes a test runner and context

function defineTests(runTest, context) {
    var { fetch, og_fetch, port, addSectionHeader, waitForTests, test_update, multiplex_fetch, braid_fetch, baseUrl } = context
    // baseUrl is empty in browser, 'https://localhost:${port}' in console tests
    baseUrl = baseUrl || ''

addSectionHeader("Multiplexing Tests")

var multiplex_version = '1.0'
braid_fetch.enable_multiplex = {}

runTest(
    "Basic MULTIPLEX method test.",
    async () => {
        await fetch('/eval', {
            method: 'POST',
            body: `
                braidify.enable_multiplex = true
                res.end('ok')
            `
        })

        var m = Math.random().toString(36).slice(2)
        var r = await og_fetch(`/${m}`, {method: 'MULTIPLEX', headers: {'Multiplex-Version': multiplex_version}})
        var {done, value} = await r.body.getReader().read()
        return !!(r.ok && value)
    },
    true
)

waitForTests(() => {})

runTest(
    "Test multiplexing with Express middleware endpoint",
    async () => {
        var a = new AbortController()
        var r = await fetch(`https://localhost:${port + 1}/middleware-test`, {
            signal: a.signal,
            subscribe: true,
            multiplex: {via: 'POST'},
            retry: true
        })

        if (!r.multiplexed_through) throw new Error('not multiplexed')
        var result = await new Promise(async done => {
            r.subscribe(u => {
                u.body = u.body_text
                done(JSON.stringify({
                    multiplexed: !!r.multiplexed_through,
                    message: u.body
                }))
            })
        })
        a.abort()
        return result
    },
    '{"multiplexed":true,"message":"Braidify works as Express middleware!"}'
)

runTest(
    "Test multiplexing with wrapper function endpoint",
    async () => {
        var a = new AbortController()
        var r = await fetch(`https://localhost:${port + 2}/wrapper-test`, {
            signal: a.signal,
            subscribe: true,
            multiplex: {via: 'POST'},
            retry: true
        })
        if (!r.multiplexed_through) throw new Error('not multiplexed')
        var result = await new Promise(async done => {
            r.subscribe(u => {
                u.body = u.body_text
                var parsed = JSON.parse(u.body)
                done(JSON.stringify({
                    multiplexed: !!r.multiplexed_through,
                    message: parsed.message,
                    version: u.version[0]
                }))
            })
        })
        a.abort()
        return result
    },
    '{"multiplexed":true,"message":"Braidify works as a wrapper function!","version":"wrapper-test-version"}'
)

runTest(
    "Test that when DELETE gets 404 for multiplexer, it kills the multiplexer",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })

        await fetch('/eval_pre_braidify', {
            method: 'POST',
            body: `braidify.multiplexers.delete(${JSON.stringify(m)})`
        })

        a.abort()

        await new Promise(done => setTimeout(done, 300))

        return '' + !!multiplex_fetch.multiplexers[m]
    },
    `false`
)

runTest(
    "Test that multiplex request sets cache-control: no-store.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` }
        })

        var s2 = Math.random().toString(36).slice(2)
        var r2 = await og_fetch('/json', {
            subscribe: true,
            headers: {
                'Subscribe': 'true',
                'Multiplex-Through': `/.well-known/multiplexer/${m}/${s2}`,
                'Multiplex-Version': multiplex_version                
            }
        })
        console.log(`r2 status = ${r2.status}`)
        return r2.headers.get('cache-control')
    },
    `no-store`
)

runTest(
    "Test multiplexer timing out because of no requests.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            multiplex: {not_used_timeout: 1000},
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: true
        })
        var t1 = !!multiplex_fetch.multiplexers[m]
        a.abort()
        await new Promise(done => setTimeout(done, 800))
        var t2 = !!multiplex_fetch.multiplexers[m]

        var a = new AbortController()
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            multiplex: {not_used_timeout: 1000},
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: true
        })
        a.abort()
        await new Promise(done => setTimeout(done, 800))
        var t3 = !!multiplex_fetch.multiplexers[m]

        await new Promise(done => setTimeout(done, 400))
        var t4 = !!multiplex_fetch.multiplexers[m]

        return `t1=${t1}, t2=${t2}, t3=${t3}, t4=${t4}`
    },
    `t1=true, t2=true, t3=true, t4=false`
)

runTest(
    "Test retrying MULTIPLEX if duplicate id (with new id).",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: true
        })
        delete multiplex_fetch.multiplexers[m]
        s = Math.random().toString(36).slice(2)
        var st = Date.now()
        var retried = false
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: true,
            multiplex: {
                onFetch: (url, params) => {
                    if (m) {
                        m = null
                    } else {
                        retried = true
                    }
                }
            }
        })
        return `is_mux=${!!r.multiplexed_through}, retried=${retried}, fast=${Date.now() < st + 300}`
    },
    'is_mux=true, retried=true, fast=true'
)

runTest(
    "Test retrying MULTIPLEX-POST if duplicate id (with new id).",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: true
        })
        delete multiplex_fetch.multiplexers[m]
        s = Math.random().toString(36).slice(2)
        var st = Date.now()
        var retried = false
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: true,
            multiplex: {
                via: 'POST',
                onFetch: (url, params) => {
                    if (m) {
                        m = null
                    } else {
                        retried = true
                    }
                }
            }
        })
        return `is_mux=${!!r.multiplexed_through}, retried=${retried}, fast=${Date.now() < st + 600}`
    },
    'is_mux=true, retried=true, fast=true'
)

runTest(
    `Test for "Incremental: ?1" header in multiplexer response.`,
    async () => {
        var m = Math.random().toString(36).slice(2)
        var r = await og_fetch(`/${m}`, {method: 'MULTIPLEX', headers: {'Multiplex-Version': multiplex_version}})
        return r.headers.get('Incremental')
    },
    '?1'
)

runTest(
    "Test handling duplicate request id locally",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var through = `/.well-known/multiplexer/${m}/${s}`
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': through },
        })

        var saw_delayed_update
        r.subscribe(update => {
            if (update.version[0] === 'another!')
                saw_delayed_update = true
        })

        s = r.multiplexed_through.split('/')[4]

        var st = Date.now()
        var r2 = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through':
                `/.well-known/multiplexer/${m}/${s}` },
        })
        var et = Date.now()

        await new Promise(done => setTimeout(done, 300))

        a.abort()
        await og_fetch('/kill_mux', {headers: {mux: m}})

        return `same mux = ${r.multiplexed_through.split('/')[3] === r2.multiplexed_through.split('/')[3]}, ` + 'same_request: ' + (r.multiplexed_through === r2.multiplexed_through) + ', fast=' + (et < st + 300) + ', ' + (saw_delayed_update ? 'got' : 'did not get') + ' update'
    },
    'same mux = true, same_request: false, fast=true, got update'
)

runTest(
    "Test falling back to MULTIPLEX well-known url, if method doesn't work.",
    async () => {
        var a = new AbortController()
        var m = 'bad_mux_method'
        var s = Math.random().toString(36).slice(2)
        var st = Date.now()
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,
            headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
            retry: true
        })
        await og_fetch('/kill_mux', {headers: {mux: m}})
        return 'is_mux=' + !!r.multiplexed_through + ', fast=' + (Date.now() < st + 300)
    },
    'is_mux=true, fast=true'
)

runTest(
    "Test option to use MULTIPLEX well-known url regardless.",
    async () => {
        var a = new AbortController()
        var m = 'bad_mux_well_known_url'
        var s = Math.random().toString(36).slice(2)
        var count = 0
        return new Promise(async done => {
            var r = await fetch('/json', {
                signal: a.signal,
                subscribe: true,
                multiplex: {via: 'POST'},
                retry: true,
                onFetch: (url, params) => {
                    count++
                    if (count === 2) done('' + count)
                    params.headers.set('Multiplex-Through', `/.well-known/multiplexer/${m}/${s}`)
                    m = Math.random().toString(36).slice(2)
                }
            })
        })
        return 'hm..'
    },
    '2'
)

runTest(
    "Test that when multiplexer doesn't exist, it returns the proper header.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await og_fetch('/json', {headers: {'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}`, 'Multiplex-Version': multiplex_version}})
        return r.headers.get('bad-multiplexer') === m
    },
    true
)

runTest(
    "Test that multiplexer code handles a full url (rather than relative one).",
    async () => {
        var a1 = new AbortController()
        var r1 = await fetch(`https://localhost:${port}/json`, {
            signal: a1.signal,
            subscribe: true,
        })

        var a2 = new AbortController()
        var r2 = await fetch(`https://localhost:${port}/json`, {
            signal: a2.signal,
            subscribe: true,
        })

        if (!r2.multiplexed_through) throw new Error('not multiplexed')

        return await new Promise(async (outter_done, outter_fail) => {
            let ret = await new Promise(done => r2.subscribe(u => {
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
    "Test aborting multiplexed subscription.",
    async () => {
        await fetch('/json', {subscribe: true})
        let good = false
        let a = new AbortController()
        try {
            let res = await fetch("/json", {
                signal: a.signal,
                retry: true,
                subscribe: true,
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
    "Test failing to establish multiplexed request.",
    async () => {
        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        try {
            var r = await fetch('/500', {
                signal: a.signal,
                headers: { 'Multiplex-Through': `/.well-known/multiplexer/${m}/${s}` },
                retry: true
            })
        } catch (e) { return ('' + e).slice(0, 'Error: Could not establish multiplexed request'.length) }
        return 'hm..'
    },
    'Error: Could not establish multiplexed request'
);

runTest(
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
        } catch (e) { return ('' + e).slice(0, 'Error: Could not establish multiplexed request'.length) }
        return 'hm..'
    },
    'Error: Could not establish multiplexed request'
);

runTest(
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

runTest(
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

runTest(
    "Test 2nd GET causing multiplexed connection.",
    async () => {
        var a = new AbortController()
        var r = await fetch('/json', {
            signal: a.signal,
            subscribe: true,

            multiplex: true
        })
        var r2 = await fetch('/json', {
            signal: a.signal,
            subscribe: true,

            multiplex: true
        })
        setTimeout(() => a.abort(), 0)
        return '' + !!r2.multiplexed_through
    },
    'true'
);

runTest(
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
    'Parse error in headers: ""HTP 555\\r\\n\\r\\n""'
);

runTest(
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

runTest(
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

waitForTests(() => {})

runTest(
    "Test client asking for multiplexing, but server doesn't realize it.",
    async () => {
        await fetch('/eval', {
            method: 'POST',
            body: `
                braidify.enable_multiplex = false
                res.end('ok')
            `
        })

        var a = new AbortController()
        var m = Math.random().toString(36).slice(2)
        var s = Math.random().toString(36).slice(2)
        var r = await fetch('/json', {
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

waitForTests(() => braid_fetch.enable_multiplex = false)

addSectionHeader("Express Middleware Tests")

runTest(
    "Test braidify as Express middleware with subscription",
    async () => {
        let a = new AbortController()
        let updates = []
        
        // Note: Using port+1 for the Express server
        let res = await fetch(`https://localhost:${port + 1}/middleware-test`, {
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

runTest(
    "Test braidify as Express middleware without subscription",
    async () => {
        let res = await fetch(`https://localhost:${port + 1}/middleware-test`)
        let data = await res.json()
        return data.message
    },
    "Braidify works as Express middleware!"
)

addSectionHeader("Wrapper Function Tests")

runTest(
    "Test braidify as wrapper function with subscription",
    async () => {
        let a = new AbortController()
        let updates = []
        
        // Using port+2 for the wrapper function server
        let res = await fetch(`https://localhost:${port + 2}/wrapper-test`, {
            subscribe: true,
            signal: a.signal
        })
        
        await new Promise(resolve => {
            res.subscribe(
                update => {
                    if (update.body != null) update.body = update.body_text
                    let parsed = JSON.parse(update.body)
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

runTest(
    "Test braidify as wrapper function without subscription",
    async () => {
        let res = await fetch(`https://localhost:${port + 2}/wrapper-test`)
        let data = await res.json()
        return data.message
    },
    "Braidify works as a wrapper function!"
)

addSectionHeader("Server sending binary data with sendUpdate")

runTest(
    "Server can send binary body when not subscribing",
    async () => {
        let a = new AbortController()
        let x = await new Promise((resolve, reject) => {
            fetch('/json', {headers: {skip_first: true, send_binary_body: true, giveup: true}}).then(x => x.arrayBuffer()).then(resolve)
        })
        return '' + new Uint8Array(x)
    },
    '0,1,2,3'
)

runTest(
    "Server can send binary body as ArrayBuffer",
    async () => {
        let a = new AbortController()
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

runTest(
    "Server can send binary body as Uint8Array",
    async () => {
        let a = new AbortController()
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

runTest(
    "Server can send binary body as Blob",
    async () => {
        let a = new AbortController()
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

runTest(
    "Server can send binary body as Buffer",
    async () => {
        let a = new AbortController()
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

runTest(
    "Server can send binary patch as ArrayBuffer",
    async () => {
        let a = new AbortController()
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

runTest(
    "Server can send binary patch as Uint8Array",
    async () => {
        let a = new AbortController()
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

runTest(
    "Server can send binary patch as Blob",
    async () => {
        let a = new AbortController()
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

runTest(
    "Server can send binary patch as Buffer",
    async () => {
        let a = new AbortController()
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_patch_buffer: true, giveup: true}}).then(
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

runTest(
    "Server can send multiple binary patches as ArrayBuffers",
    async () => {
        let a = new AbortController()
        let x = await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, signal: a.signal, headers: {skip_first: true, send_binary_patches_arraybuffer: true, giveup: true}}).then(
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

runTest(
    "Server can send multiple binary patches as Uint8Arrays",
    async () => {
        let a = new AbortController()
        let x = await new Promise((resolve, reject) => {
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

runTest(
    "Server can send multiple binary patches as Blobs",
    async () => {
        let a = new AbortController()
        let x = await new Promise((resolve, reject) => {
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

runTest(
    "Server can send multiple binary patches as Buffers",
    async () => {
        let a = new AbortController()
        let x = await new Promise((resolve, reject) => {
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

addSectionHeader("Client sending binary data")

runTest(
    "Client can PUT single binary patch as ArrayBuffer",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true}, patches: {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3]).buffer}}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '0,1,2,3\n'
)

runTest(
    "Client can PUT single binary patch as Uint8Array",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true}, patches: {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3])}}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '0,1,2,3\n'
)

runTest(
    "Client can PUT multiple binary patches as ArrayBuffers",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true}, patches: [{unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3]).buffer}, {unit: 'text', range: '[0:0]', content: new Uint8Array([10, 11, 12, 13]).buffer}]}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '0,1,2,3\n10,11,12,13\n'
)

runTest(
    "Client can PUT multiple binary patches as Uint8Arrays",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true}, patches: [{unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3])}, {unit: 'text', range: '[0:0]', content: new Uint8Array([10, 11, 12, 13])}]}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '0,1,2,3\n10,11,12,13\n'
)

runTest(
    "Client can PUT multiple binary patches as Blobs",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true}, patches: [{unit: 'text', range: '[0:0]', content: new Blob([new Uint8Array([0, 1, 2, 3])])}, {unit: 'text', range: '[0:0]', content: new Blob([new Uint8Array([10, 11, 12, 13])])}]}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '0,1,2,3\n10,11,12,13\n'
)

runTest(
    "Client can PUT single patch with unicode text",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_content_text: true}, patches: [{unit: 'text', range: '[0:0]', content: '🌈👽🎵'}]}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '🌈👽🎵\n'
)

runTest(
    "Client can PUT multiple patches with unicode texts",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_content_text: true}, patches: [{unit: 'text', range: '[0:0]', content: '🌈👽🎵'}, {unit: 'text', range: '[0:0]', content: 'Hello 🌍!'}]}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '🌈👽🎵\nHello 🌍!\n'
)

addSectionHeader("Make sure contents are binary, with property to access as text")

runTest(
    "Verify client-side patches are binary",
    async () => {
        let a = new AbortController()
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

runTest(
    "Verify client-side patches have content_text",
    async () => {
        let a = new AbortController()
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

runTest(
    "Verify that content_text can be accessed after overriding content",
    async () => {
        let a = new AbortController()
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

runTest(
    "Verify server-side bodies are binary",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_body_binary: true}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '123,34,97,34,58,53,125'
)

runTest(
    "Verify server-side bodies have body_text",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_body_text: true}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '{"a":5}'
)

runTest(
    "Verify server-side patches are binary",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_binary: true, 'content-range': 'text [0:0]'}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '123,34,97,34,58,53,125\n'
)

runTest(
    "Verify server-side patches have content_text",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_patch_content_text: true, 'content-range': 'text [0:0]'}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '{"a":5}\n'
)

runTest(
    "Verify server-side 'everything' patches are binary",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_everything_patch_binary: true}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '123,34,97,34,58,53,125'
)

runTest(
    "Verify server-side 'everything' patches have content_text",
    async () => {
        return '' + await new Promise((resolve, reject) => {
            fetch('/json', {method: 'PUT', headers: {check_everything_patch_content_text: true}, body: '{"a":5}'}).then(
                async res => resolve(res.text())).catch(reject)
        })
    },
    '{"a":5}'
)

runTest(
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

runTest(
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

addSectionHeader("Misc")

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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
    'Error: Got unexpected subscription status code: 200. Expected 209.'
)

runTest(
    "Verify error in cb stops retry",
    async () => {
        return await new Promise((resolve, reject) => {
            let a = new AbortController()
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

runTest(
    "Verify heartbeat error in cb doesn't stop retry",
    async () => {
        return await new Promise((resolve, reject) => {
            let a = new AbortController()
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

runTest(
    "Verify error in async cb stops retry",
    async () => {
        return await new Promise((resolve, reject) => {
            let a = new AbortController()
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

runTest(
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

runTest(
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

runTest(
    "Verify that server writes ASCII versions",
    async () => {
        let x = await fetch('/json', {headers: {skip_first: true, send_unicode_version: true, giveup: true}})
        return x.headers.get('version')
    },
    '"hello\\ud83c\\udf0d-0"'
)

runTest(
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

runTest(
    "Verify that server writes ASCII parents",
    async () => {
        let x = await fetch('/json', {headers: {skip_first: true, send_unicode_parents: true, giveup: true}})
        return x.headers.get('parents')
    },
    '"hello\\ud83c\\udf0d-0", "\\ud83c\\udf08-5"'
)

runTest(
    "Verify that fetch params are not mutated",
    async () => {
        let x = {
            method: 'PUT',
            patches: [{
                unit: 'text', range: '[0:0]', content: 'hello'
            }]
        }
        let y = await (await fetch("/check_parents", x)).json()
        return x.patches[0].content
    },
    'hello'
)

runTest(
    "Verify content-type with charset=utf-8 is handled correctly",
    async () => {
        let updates = []
        await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false, headers: {charset: true}}).then(
                res => res.subscribe(
                    (update) => {
                        if (update.body != null) update.body = update.body_text
                        if (update.patches) for (let p of update.patches) p.content = p.content_text
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

runTest(
    "Verify that parents option results in parents header",
    async () => {
        let x = { parents: ["test-0", "test-1"] }
        let y = await (await fetch("/check_parents", x)).json()
        return y.parents
    },
    '"test-0", "test-1"'
)

runTest(
    "Verify that parents option can be a function",
    async () => {
        let x = { parents: ["test-0", "test-1"] }
        let y = await (await fetch("/check_parents", { parents: () => x.parents })).json()
        return y.parents
    },
    '"test-0", "test-1"'
)

runTest(
    "Verify that parents option can be an async function",
    async () => {
        let x = { parents: ["test-0", "test-1"] }
        let y = await (await fetch("/check_parents", { parents: async () => x.parents })).json()
        return y.parents
    },
    '"test-0", "test-1"'
)


runTest(
    "onFetch test 1",
    async () => {
        let x = await new Promise(async (done, fail) => {
            await fetch('/json', {
                parents: () => ['test'],
                onFetch: (...args) => done(args)
            })
        })
        x[1].headers = Object.fromEntries([...x[1].headers])
        return JSON.stringify(x)
    },
    `["${baseUrl}/json",{"headers":{"parents":"\\"test\\""},"cache":"no-cache","signal":{}},{}]`
)

runTest(
    "onBytes test 1",
    async () => {
        return await new Promise(async (done, fail) => {
            let s = ''
            let x = await fetch('/json', {
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

runTest(
    "parents-function test 1",
    async () => {
        let has_parents = null
        let x = { parents: null }
        let res = await (await fetch("/check_parents", { parents: () => x.parents, onFetch: (url, params) => {
            has_parents = JSON.stringify(params.headers.has('parents'))
        } })).json()
        return JSON.stringify({has_parents, res})
    },
    '{"has_parents":"false","res":{}}'
)

addSectionHeader("Heartbeat Tests")

runTest(
    "Verify heartbeats don't prevent user writing headers",
    async () => {
        let a = new AbortController()
        var res = await fetch('/json', {subscribe: true, multiplex: false, heartbeats: 0.5, signal: a.signal})
        a.abort()
        return 'post-sub-header: ' + res.headers.get('post-sub-header')
    },
    'post-sub-header: yup'
)

runTest(
    "Verify heartbeat reception",
    async () => {
        let a = new AbortController()
        let x = await new Promise((resolve, reject) => {
            let st = Date.now()
            fetch('/json', {subscribe: true, multiplex: false, heartbeats: 0.5, signal: a.signal, onBytes: () => {
                if (Date.now() - st > 500) resolve('got beat!')
            }}).then(res => res.subscribe(() => {}, reject)).catch(reject)
        })
        a.abort()
        return x
    },
    'got beat!'
)

runTest(
    "Verify absence of unwanted heartbeats",
    async () => {
        let a = new AbortController()
        let x = await new Promise((resolve, reject) => {
            let st = Date.now()
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

runTest(
    "Test heartbeat error",
    async () => {
        let res_count = 0
        let a = new AbortController()
        let x = '' + await new Promise(resolve => {
            fetch('/noheartbeat', {heartbeats: 0.5, signal: a.signal}).then(res => res.subscribe(() => {}, resolve)).catch(resolve)
        })
        a.abort()
        return x
    },
    'Error: heartbeat not seen in 3.60s'
)

runTest(
    "Restart connection on missed heartbeats",
    async () => {
        let res_count = 0
        let a = new AbortController()
        let x = await new Promise((resolve, reject) => {
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

runTest(
    "Maintain connection with regular heartbeats",
    async () => {
        let res_count = 0
        let a = new AbortController()
        let x = await new Promise((resolve, reject) => {
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

runTest(
    "Verify heartbeat_cb is called on heartbeats",
    async () => {
        let a = new AbortController()
        let heartbeat_count = 0
        let x = await new Promise((resolve, reject) => {
            fetch('/json', {
                subscribe: true,
                multiplex: false,
                heartbeats: 0.3,
                signal: a.signal,
                heartbeat_cb: () => {
                    heartbeat_count++
                    if (heartbeat_count >= 3) resolve(`heartbeat_cb called ${heartbeat_count} times`)
                }
            }).then(res => res.subscribe(() => {}, reject)).catch(reject)
        })
        a.abort()
        return x
    },
    'heartbeat_cb called 3 times'
)

runTest(
    "Test reconnect_delay_ms default path",
    async () => {
        await braid_fetch.reconnect_delay_test_chain
        braid_fetch.reconnect_delay_test_chain = (async () => {
            // Ensure reconnect_delay_ms is not set
            delete braid_fetch.reconnect_delay_ms
            let a = new AbortController()
            let res_count = 0
            let start_time = null
            let x = await new Promise((resolve, reject) => {
                // Use retry function that returns true to force retry on 500
                fetch('/500', {signal: a.signal, retry: (res) => {
                    res_count++
                    if (res_count === 1) {
                        start_time = Date.now()
                    } else if (res_count > 1) {
                        let elapsed = Date.now() - start_time
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

runTest(
    "Test reconnect_delay_ms as number",
    async () => {
        await braid_fetch.reconnect_delay_test_chain
        braid_fetch.reconnect_delay_test_chain = (async () => {
            braid_fetch.reconnect_delay_ms = 200
            let a = new AbortController()
            let res_count = 0
            let start_time = null
            let x = await new Promise((resolve, reject) => {
                fetch('/500', {signal: a.signal, retry: (res) => {
                    res_count++
                    if (res_count === 1) {
                        start_time = Date.now()
                    } else if (res_count > 1) {
                        let elapsed = Date.now() - start_time
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

runTest(
    "Test reconnect_delay_ms as function",
    async () => {
        await braid_fetch.reconnect_delay_test_chain
        braid_fetch.reconnect_delay_test_chain = (async () => {
            let received_retry_count = null
            braid_fetch.reconnect_delay_ms = (retry_count) => {
                received_retry_count = retry_count
                return 150
            }
            let a = new AbortController()
            let res_count = 0
            let start_time = null
            let x = await new Promise((resolve, reject) => {
                fetch('/500', {signal: a.signal, retry: (res) => {
                    res_count++
                    if (res_count === 1) {
                        start_time = Date.now()
                    } else if (res_count > 1) {
                        let elapsed = Date.now() - start_time
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

addSectionHeader("Read Tests")

runTest(
    "Subscribe with empty Subscribe header value",
    async () => {
        let a = new AbortController()
        // Use og_fetch with empty Subscribe header to test server accepts it
        let res = await og_fetch('/json', {
            signal: a.signal,
            headers: { 'Subscribe': '' }
        })
        // If server accepts empty subscribe header, we should get 209 status
        let status = res.status
        a.abort()
        return `status: ${status}`
    },
    'status: 209'
)

runTest(
    "Subscribe returns 209 with statusText 'Multiresponse' (HTTP/1.x only)",
    async () => {
        let a = new AbortController()
        let res = await og_fetch('/json', {
            signal: a.signal,
            headers: { 'Subscribe': 'true' }
        })
        let status = res.status
        let statusText = res.statusText
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

runTest(
    "Subscribe and receive multiple updates, using promise chaining",
    async () => {
        let updates = []
        await new Promise((resolve, reject) => {
            fetch('/json', {subscribe: true, multiplex: false}).then(
                res => res.subscribe(
                    update => {
                        if (update.body != null) update.body = update.body_text
                        if (update.patches) for (let p of update.patches) p.content = p.content_text
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

runTest(
    "Subscribe and receive multiple updates, using async/await",
    async () => {
        let updates = []
        await new Promise(async (resolve, reject) => {
            try {
                (await fetch('/json', {subscribe: true, multiplex: false})).subscribe(
                    update => {
                        if (update.body != null) update.body = update.body_text
                        if (update.patches) for (let p of update.patches) p.content = p.content_text
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

runTest(
    "Subscribe and receive multiple updates, using 'for await'",
    async () => {
        let updates = []
        for await (var update of (await fetch('/json', {subscribe: true, multiplex: false})).subscription) {
            if (update.body != null) update.body = update.body_text
            if (update.patches) for (let p of update.patches) p.content = p.content_text
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

addSectionHeader("Write Tests")

runTest(
    "PUT with single patch, not in array",
    async () => {
        let res = await fetch('/json', {
            version: ['test1'],
            patches: {unit: 'json', range: '[0]', content: '"test1"'},
            method: 'PUT'
        })
        return `returned ${res.status}`
    },
    "returned 200"
)

runTest(
    "PUT with single patch, in array",
    async () => {
        let res = await fetch('/json', {
            version: ['test2'],
            patches: [{unit: 'json', range: '[0]', content: '"test2"'}],
            method: 'PUT'
        })
        return `returned ${res.status}`
    },
    "returned 200"
)

runTest(
    "PUT with multiples patches",
    async () => {
        let res = await fetch('/json', {
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

runTest(
    "PUT with empty patches array",
    async () => {
        let res = await fetch('/json', {
            version: ['test4'],
            patches: [],
            method: 'PUT'
        })
        return `returned ${res.status}`
    },
    "returned 200"
)

addSectionHeader('Testing braid wrapper for node http(s).get')

runTest(
    "Subscribe and receive multiple updates",
    async () => {
        const codeToEval = `
            let updates = []
            ;(new Promise((resolve, reject) => {
                https.get(
                    'https://localhost:' + port + '/json',
                    {subscribe: true, multiplex: false, rejectUnauthorized: false},
                    (res) => {
                        res.on('update', (update) => {
                            if (update.body != null) update.body = update.body_text
                            if (update.patches) for (let p of update.patches) p.content = p.content_text
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

        const response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: codeToEval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        const result = await response.json();
        
        return result.map(JSON.stringify).join('\n')
    },
    '{"version":["test"],"parents":["oldie"],"body":"{\\\"this\\\":\\\"stuff\\\"}","status":"200"}\n' +
    '{"version":["test1"],"parents":["oldie","goodie"],"patches":[{"unit":"json","range":"[1]","content":"1"}],"status":"115","extra_headers":{"hash":"42"}}\n' +
    '{"version":["test2"],"patches":[{"unit":"json","range":"[2]","content":"2"}],"status":"200"}\n' +
    '{"version":["test3"],"patches":[{"unit":"json","range":"[3]","content":"3","extra_headers":{"hash":"43"}},{"unit":"json","range":"[4]","content":"4"}],"status":"200"}\n' +
    '{"version":["another!"],"body":"\\\"!\\\"","status":"200"}'
);

runTest(
    "PUT with single patch, not in array",
    async () => {
        const codeToEval = `
            let p = new Promise((resolve, reject) => {
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

        const response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: codeToEval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        const result = await response.json();
        return result
    },
    'returned 200'
);

runTest(
    "PUT with single patch, in array",
    async () => {
        const codeToEval = `
            let p = new Promise((resolve, reject) => {
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

        const response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: codeToEval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        const result = await response.json();
        return result
    },
    'returned 200'
);

runTest(
    "PUT with multiples patches",
    async () => {
        const codeToEval = `
            let p = new Promise((resolve, reject) => {
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

        const response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: codeToEval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        const result = await response.json();
        return result
    },
    'returned 200'
);

runTest(
    "PUT with empty patches array",
    async () => {
        const codeToEval = `
            let p = new Promise((resolve, reject) => {
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

        const response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: codeToEval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        const result = await response.json();
        return result
    },
    'returned 200'
);

addSectionHeader('Testing braid wrapper for node fetch')

runTest(
    "Subscribe and receive multiple updates",
    async () => {
        const codeToEval = `
        void (() => {
            if (typeof fetch === 'undefined') return res.end('"old node version"')
            let updates = []
            ;(new Promise(async (resolve, reject) => {
                try {
                    (await braid_fetch('https://localhost:' + port + '/json',
                        {subscribe: true, multiplex: false})).subscribe(
                        update => {
                            if (update.body != null) update.body = update.body_text
                            if (update.patches) for (let p of update.patches) p.content = p.content_text
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

        const response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: codeToEval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        const result = await response.json();
        if (typeof result === 'string') return result
        
        return result.map(JSON.stringify).join('\n')
    },
    '{"version":["test"],"parents":["oldie"],"body":"{\\\"this\\\":\\\"stuff\\\"}","status":"200"}\n' +
    '{"version":["test1"],"parents":["oldie","goodie"],"patches":[{"unit":"json","range":"[1]","content":"1"}],"status":"115","extra_headers":{"hash":"42"}}\n' +
    '{"version":["test2"],"patches":[{"unit":"json","range":"[2]","content":"2"}],"status":"200"}\n' +
    '{"version":["test3"],"patches":[{"unit":"json","range":"[3]","content":"3","extra_headers":{"hash":"43"}},{"unit":"json","range":"[4]","content":"4"}],"status":"200"}\n' +
    '{"version":["another!"],"body":"\\\"!\\\"","status":"200"}'
);

runTest(
    "PUT with single patch, not in array",
    async () => {
        const codeToEval = `
        void (() => {
            if (typeof fetch === 'undefined') return res.end('"old node version"')
            let p = new Promise(async (resolve, reject) => {
                let res = await braid_fetch(
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

        const response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: codeToEval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        const result = await response.json();
        return result
    },
    'returned 200'
);

runTest(
    "PUT with single patch, in array",
    async () => {
        const codeToEval = `
        void (() => {
            if (typeof fetch === 'undefined') return res.end('"old node version"')
            let p = new Promise(async (resolve, reject) => {
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

        const response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: codeToEval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        const result = await response.json();
        return result
    },
    'returned 200'
);

runTest(
    "PUT with multiples patches",
    async () => {
        const codeToEval = `
        void (() => {
            if (typeof fetch === 'undefined') return res.end('"old node version"')
            let p = new Promise(async (resolve, reject) => {
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

        const response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: codeToEval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        const result = await response.json();
        return result
    },
    'returned 200'
);

runTest(
    "PUT with empty patches array",
    async () => {
        const codeToEval = `
        void (() => {
            if (typeof fetch === 'undefined') return res.end('"old node version"')
            let p = new Promise(async (resolve, reject) => {
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

        const response = await fetch('/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: codeToEval
        });

        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);

        const result = await response.json();
        return result
    },
    'returned 200'
);

addSectionHeader("Retry Tests")

runTest(
    "Verify that retry.retryRes gets heeded when true.",
    async () => {
        return await new Promise(done => {
            var count = 0
            let a = new AbortController()            
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

runTest(
    "Verify that retry.retryRes gets heeded when false.",
    async () => {
        return await new Promise(done => {
            var count = 0
            let a = new AbortController()
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

runTest(
    "Verify that setting retry as function gets heeded when true.",
    async () => {
        return await new Promise(done => {
            var count = 0
            let a = new AbortController()            
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

runTest(
    "Verify that setting retry as function gets heeded when false.",
    async () => {
        return await new Promise(done => {
            var count = 0
            let a = new AbortController()
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

runTest(
    "Verify that we retry on 503",
    async () => {
        return await new Promise(done => {
            var count = 0
            let a = new AbortController()            
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

runTest(
    "Verify that we retry on 400 Missing Parents",
    async () => {
        return await new Promise(done => {
            var count = 0
            let a = new AbortController()
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

runTest(
    "Verify that we retry when Retry-After is set",
    async () => {
        return await new Promise(done => {
            var count = 0
            let a = new AbortController()            
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

runTest(
    "Verify that unparsable headers do not result in retrying connection.",
    async () => {
        let a = new AbortController()
        let count = 0
        return '' + await new Promise(async (done, fail) => {
            let res = await fetch("/parse_error", { retry: {
                onRes: () => {
                    count++
                    if (count === 2) fail('retried')
                }
            }, subscribe: true, multiplex: false, signal: a.signal })
            res.subscribe((u) => {}, done)
        })
    },
    'Error: Parse error in headers: ""hello: true\\r\\nhello\\r\\nContent-Length: 2\\r\\n\\r\\n""'
)

runTest(
    "Should not retry on HTTP 400",
    async () => {
        var r = await fetch("/400", { retry: true })
        return '' + r.status
    },
    "400"
)

runTest(
    "Should not retry on HTTP 401 (access denied)",
    async () => {
        var r = await fetch("/401", { retry: true })
        return '' + r.status
    },
    "401"
)

runTest(
    "Should not try at all if abort controller already aborted",
    async () => {
        let a = new AbortController()
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

runTest(
    "Should not retry if aborted",
    async () => {
        let a = new AbortController()
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

runTest(
    "Should not retry if already aborted",
    async () => {
        let a = new AbortController()
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

runTest(
    "Should not retry if aborted, when subscribed",
    async () => {
        let good = false
        let a = new AbortController()
        try {
            let res = await fetch("/json", {
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

runTest(
    "Verify that retry option works with subscribe",
    async () => {
        let a = new AbortController()
        let x = await new Promise(async (done, fail) => {
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
runTest(
    "Should retry on HTTP 408",
    async () => {
        let x = await (await fetch("/retry", { retry: true })).json()
        return JSON.stringify(x)
    },
    JSON.stringify(test_update_without_status)
)

runTest(
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

runTest(
    "Verify that onRes is called on reconnections",
    async () => {
        let onRes_count = 0
        let update_count = 0
        try {
            await new Promise(async (done, fail) => {
                let a = new AbortController()
                let res = await fetch("/json", {
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

runTest(
    "Verify that retry works with for-await style subscription",
    async () => {
        let updates = []
        let a = new AbortController()
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

runTest(
    "Should stop retrying in a subscription if reconnection attempt returns HTTP 500",
    async () => {
        let giveup_completely = Math.random().toString(36).slice(2)
        let updates = []
        return await new Promise(async (done, fail) => {
            let res = await fetch('/json', {retry: true, subscribe: true, multiplex: false, headers: {giveup_completely}, multiplex: false})
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

runTest(
    "Should throw an exception in for-await style when subscription encounters HTTP 500",
    async () => {
        let giveup_completely = Math.random().toString(36).slice(2)
        let updates = []
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

addSectionHeader('Binary Tests')

runTest(
    "Verify basic binary GET",
    async () => {
        let x = await fetch('/binary')
        x = await x.arrayBuffer()
        x = new Uint8Array(x)
        x = [...x]
        return x.join(', ')
    },
    new Array(256).fill(0).map((x, i) => i).join(', ')
)

runTest(
    "Verify binary data in subscription update",
    async () => {
        let a = new AbortController()
        let x = await new Promise(async (done, fail) => {
            let x = await fetch('/binary', {subscribe: true, multiplex: false, signal: a.signal})
            x.subscribe(done, fail)
        })
        a.abort()
        return '' + x.body
    },
    '' + new Array(256).fill(0).map((x, i) => i)
)

addSectionHeader('Encoding Block Tests')

runTest(
    "Basic encoding block test",
    async () => {
        var r = await fetch('/eval', {
            method: 'POST',
            body: `
                res.startSubscription()
                res.sendUpdate({
                    encoding: 'dt',
                    body: 'hello'
                })
            `
        })
        return await new Promise(done => {
            r.subscribe(u => {
                done(u.body_text)
            })
        })
    },
    'hello'
)

runTest(
    "Test multiple block types in stream",
    async () => {
        var stream1 = `


HTTP 200 OK\r
Yo: hi\r
Content-Length: 2

yo

encoding: d`

        var stream2 = `t
length: 5\r
HELLO


HTTP 300 OK\r
Content-Length: 3

abc

        `

        var r = await fetch('/eval', {
            method: 'POST',
            body: `
                void (async () => {
                    res.statusCode = 209
                    res.write(${JSON.stringify(stream1)})
                    await new Promise(done => setTimeout(done, 200))
                    res.write(${JSON.stringify(stream2)})
                })()
            `
        })
        var result = ''
        return await new Promise(done => {
            r.subscribe(u => {
                if (u.status === '200') {
                    result += u.body_text
                } else if (!u.status) {
                    result += u.body_text
                } else if (u.status === '300') {
                    result += u.body_text
                    done(result)
                }
            })
        })
    },
    'yoHELLOabc'
)

runTest(
    "Test malformed encoding block",
    async () => {
        var r = await fetch('/eval', {
            method: 'POST',
            body: `
                res.statusCode = 209
                res.write('Encoing: dt\\r\\nLength: 5\\r\\nhello')
            `
        })
        return await new Promise(done => {
            r.subscribe(u => {}, e => done(e.message.slice(0, 'Parse error in encoding block'.length)))
        })
    },
    'Parse error in encoding block'
)

runTest(
    "Test that Patches with a Length header still works",
    async () => {
        var stream = `


HTTP 200 OK\r
Length: 1\r
Patches: 1\r

Version: "me-0"
Parents: "mom-0"
Content-Range: "[0:0]"
Content-Length: 8

my patch`

        var r = await fetch('/eval', {
            method: 'POST',
            body: `
                void (async () => {
                    res.statusCode = 209
                    res.write(${JSON.stringify(stream)})
                })()
            `
        })
        return await new Promise(done => {
            r.subscribe(u => {
                done(u.patches[0].content_text)
            })
        })
    },
    'my patch'
)

addSectionHeader("onSubscriptionStatus Tests")

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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

runTest(
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
    'Connection closed'
)

runTest(
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

runTest(
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

runTest(
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

}

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = defineTests
}
