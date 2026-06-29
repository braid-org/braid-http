// Standalone tests for update_pipe (kept separate from the main test
// harness, to port over once that's rebuilt).
//
// Covers: updates flow on a 209 subscription, a dropped connection goes
// offline, a silent connection times out and goes offline, and the
// reconnection poll brings a dropped host back.

var http = require('http')
var assert = require('assert')
var {braidify} = require('../../braid-http-server.js')
var {update_pipe} = require('../../braid-http-client.js')

var sleep = (ms) => new Promise(r => setTimeout(r, ms))

// A tiny braid server.  On a subscription it sends one update and holds
// the connection open.  `send_heartbeats: false` makes it ignore the
// client's Heartbeats request, so the connection goes silent.
// put_behavior(n) decides what the server does with the n-th PUT it sees:
// 'drop' (destroy the socket → pipe failure), 'hold' (park the response),
// or 'ok' (reply put_status).  Defaults derive from the simpler options.
async function start_server ({send_heartbeats = true, put_status = 200,
                              hold_puts = false, fail_first_put = false,
                              put_behavior, subscribe_status, poll_mode = false} = {}) {
    var live      = new Set()   // open subscription responses
    var hung      = new Set()   // sockets of subscriptions we never answer
    var puts      = []          // updates received via PUT/DELETE
    var held      = []          // responders parked while holding
    var holding    = hold_puts
    var put_count  = 0
    var poll_count = 0
    put_behavior = put_behavior
        || (n => fail_first_put && n === 1 ? 'drop' : holding ? 'hold' : 'ok')
    var server = http.createServer((req, res) => {
        req.socket.on('error', () => {})   // ignore resets from our own drops
        braidify(req, res, async () => {
            if (req.subscribe) {
                if (req.url.endsWith('/hang')) return hung.add(res.socket)   // never answer → stays connecting
                if (subscribe_status) { res.statusCode = subscribe_status; return res.end() }  // refuse the subscription
                if (poll_mode) {   // no 209 stream — answer the current state as a plain GET
                    puts.push({poll: ++poll_count})
                    res.statusCode = 200
                    res.setHeader('version', JSON.stringify('v' + poll_count))
                    return res.end('state' + poll_count)
                }
                if (!send_heartbeats) delete req.headers['heartbeats']
                res.startSubscription({onClose: () => live.delete(res)})
                res.sendUpdate({version: ['v1'], body: 'hello'})
                live.add(res)
            } else if (req.method === 'PUT') {
                var action = put_behavior(++put_count)
                if (action === 'drop') return req.socket.destroy()
                var update = await req.parseUpdate()
                puts.push({version: update.version,
                           body: update.body && Buffer.from(update.body).toString()})
                // A numeric behavior is the status code to reply with.
                var respond = () => { res.statusCode = typeof action === 'number' ? action : put_status; res.end() }
                if (action === 'hold') held.push(respond)
                else respond()
            } else if (req.method === 'DELETE') {
                puts.push({method: 'DELETE'})
                res.statusCode = put_status
                res.end()
            } else {
                res.statusCode = 200
                res.end('not a subscription')
            }
        })
    })
    await new Promise(r => server.listen(0, r))
    var port = server.address().port
    return {
        origin:    `http://localhost:${port}`,
        url:       `http://localhost:${port}/foo`,
        host_name: `localhost:${port}`,
        puts,
        release_puts: () => { holding = false; for (var r of held) r(); held.length = 0 },
        drop:      () => { for (var r of live) r.socket.destroy(); live.clear() },
        close:     () => { for (var sock of hung) sock.destroy(); server.close() }
    }
}

// Updates flow on a 209, and a dropped connection goes offline.
// (reconnect_interval high so the poll doesn't reconnect mid-assertion.)
async function test_drop () {
    var s = await start_server()
    var updates = []
    var pipe = update_pipe((m) => updates.push(m), {reconnect_interval: 60})
    pipe.get(s.url)

    await sleep(300)
    assert.equal(updates.length, 1, 'should have received one update')
    assert.equal(updates[0].message, 'set', 'delivered as a set message')
    assert.equal(Buffer.from(updates[0].body).toString(), 'hello', 'body should be "hello"')
    assert.equal(pipe.network.hosts[s.host_name].online, true, 'host should be online')
    console.log('PASS: updates flow on 209; host online')

    s.drop()
    await sleep(500)
    assert.equal(pipe.network.hosts[s.host_name].online, false, 'host should be offline after the drop')
    console.log('PASS: dropped connection drives go_offline')

    s.close()
}

// A silent connection (no heartbeats) times out and goes offline.
async function test_heartbeat_timeout () {
    var s = await start_server({send_heartbeats: false})
    var pipe = update_pipe(() => {}, {timeout: 1, reconnect_interval: 60})
    pipe.get(s.url)

    await sleep(300)
    assert.equal(pipe.network.hosts[s.host_name].online, true, 'host should be online')

    // No bytes arrive; after silence_window the timer fires.
    await sleep(1200)
    assert.equal(pipe.network.hosts[s.host_name].online, false, 'host should be offline after the heartbeat timeout')
    console.log('PASS: heartbeat timeout drives go_offline')

    s.close()
}

// After a drop, the reconnection poll probes the host back online.
async function test_reconnect () {
    var s = await start_server()
    var updates = []
    var pipe = update_pipe((m) => updates.push(m), {reconnect_interval: 0.3})
    pipe.get(s.url)

    await sleep(300)
    assert.equal(pipe.network.hosts[s.host_name].online, true, 'should be online initially')
    assert.equal(updates.length, 1, 'one update initially')

    s.drop()
    await sleep(900)   // poll ticks every 0.3s and reconnects
    assert.equal(pipe.network.hosts[s.host_name].online, true, 'should be back online after reconnect')
    assert(updates.length >= 2, 'reconnect should deliver a fresh update')
    console.log('PASS: reconnection poll brings a dropped host back online')

    s.close()
}

// Two hosts, two URLs each: all subscribe and receive; dropping one host
// leaves the other online; the poll reconnects the dropped host, cascading
// to both its URLs.
async function test_multi () {
    var s1 = await start_server()
    var s2 = await start_server()
    var got = {}   // url -> update count
    var pipe = update_pipe((m) => { got[m.url] = (got[m.url] || 0) + 1 }, {reconnect_interval: 0.3})

    var urls = [s1.origin + '/a', s1.origin + '/b', s2.origin + '/a', s2.origin + '/b']
    for (var u of urls) pipe.get(u)

    await sleep(400)
    for (var u of urls) assert.equal(got[u], 1, `should have one update for ${u}`)
    assert.equal(pipe.network.hosts[s1.host_name].online, true, 'host1 online')
    assert.equal(pipe.network.hosts[s2.host_name].online, true, 'host2 online')
    assert.equal(pipe.network.online, true, 'network online')
    console.log('PASS: 2 hosts x 2 urls all online and receiving')

    // Drop host1; host2 (and so the network) stay online.
    s1.drop()
    await sleep(150)
    assert.equal(pipe.network.hosts[s2.host_name].online, true, 'host2 unaffected by host1 drop')
    assert.equal(pipe.network.online, true, 'network stays online while host2 is up')

    // The poll reconnects host1 — one probe cascades to both its URLs.
    await sleep(800)
    assert.equal(pipe.network.hosts[s1.host_name].online, true, 'host1 reconnected')
    assert(got[s1.origin + '/a'] >= 2 && got[s1.origin + '/b'] >= 2, 'both host1 urls got fresh updates')
    console.log('PASS: one host down leaves the other online; poll reconnects it (cascade to both urls)')

    s1.close(); s2.close()
}

// A set() PUT lands and dequeues on its 2xx ack.  The write-only host now
// holds no intent, so it's garbage-collected and the network reads idle.
async function test_put_basic () {
    var s = await start_server()
    var pipe = update_pipe(() => {}, {reconnect_interval: 60})
    pipe.set(s.url, {version: ['a1'], body: 'hi'})

    await sleep(300)
    assert.equal(s.puts.length, 1, 'server received the PUT')
    assert.equal(s.puts[0].body, 'hi', 'server got the body')
    assert.equal(pipe.network.hosts[s.host_name], undefined, 'spent write-only host is GC’d')
    assert.equal(pipe.network.online, 'maybe', 'idle network reads maybe')
    console.log('PASS: a PUT lands, dequeues, and its write-only host is GC’d')

    s.close()
}

// Many sets pipeline up to max_outstanding_puts; the rest wait in the
// queue and drain as acks free slots, then the host is GC’d.
async function test_put_pipeline () {
    var s = await start_server({hold_puts: true})
    var pipe = update_pipe(() => {}, {reconnect_interval: 60, max_outstanding_puts: 10})
    for (var i = 0; i < 25; i++) pipe.set(s.url, {version: ['v' + i], body: String(i)})

    await sleep(300)
    var host = pipe.network.hosts[s.host_name]
    assert.equal(host.outstanding_puts_count, 10, 'in-flight capped at 10')
    assert.equal(s.puts.length, 10, 'server received exactly 10')
    assert.equal(host.urls[s.url].put_queue.size, 25, 'all 25 still queued, unacked')

    s.release_puts()
    await sleep(600)
    assert.equal(s.puts.length, 25, 'all 25 eventually sent')
    assert.equal(pipe.network.hosts[s.host_name], undefined, 'host GC’d once all PUTs drained')
    console.log('PASS: PUTs pipeline at the cap, drain as slots free, then GC')

    s.close()
}

// A non-2xx status is a give-up: report it via cb('error', ...), drop the
// PUT, and GC the now-empty write-only host.
async function test_put_giveup () {
    var s = await start_server({put_status: 500})
    var errors = []
    var pipe = update_pipe((m) => { if (m.message === 'error') errors.push(m) },
                            {reconnect_interval: 60})
    pipe.set(s.url, {version: ['a1'], body: 'hi'})

    await sleep(300)
    assert.equal(errors.length, 1, 'give-up reported once via cb(error)')
    assert.equal(errors[0].status, 500, 'status surfaced')
    assert.equal(pipe.network.hosts[s.host_name], undefined, 'gave-up PUT’s host is GC’d')
    console.log('PASS: a non-2xx PUT reports cb(error), drops, and GCs')

    s.close()
}

// A write-only host whose pipe fails goes red; the poll re-probes with the
// queued PUT, which lands.  With nothing left queued, the host is GC’d.
async function test_put_revives_writeonly () {
    var s = await start_server({fail_first_put: true})
    var pipe = update_pipe(() => {}, {reconnect_interval: 0.3})
    pipe.set(s.url, {version: ['a1'], body: 'hi'})

    // First PUT's connection is dropped → pipe failure → host goes red.
    await sleep(300)
    var host = pipe.network.hosts[s.host_name]
    assert.equal(host.online, false, 'write-only host goes offline on the pipe failure')
    assert.equal(host.urls[s.url].put_queue.size, 1, 'the PUT is requeued, not lost')

    // The poll re-probes with the queued PUT; this one lands and drains.
    await sleep(600)
    assert.equal(pipe.network.hosts[s.host_name], undefined, 'revived host GC’d after its PUT drained')
    assert.equal(pipe.network.online, 'maybe', 'network settles at maybe')
    assert.equal(s.puts.length, 1, 'server got the PUT on the retry')
    assert.equal(s.puts[0].body, 'hi', 'with the right body')
    console.log('PASS: a write-only host fails, a re-probed PUT lands, then it GCs')

    s.close()
}

// When a revived write-only host still has queued writes, the landed PUT
// lifts it to 'maybe' and it stays alive (orange, not green, not GC’d)
// while the rest drain.  (max_outstanding_puts:1 so they go one at a time;
// the server drops #1, acks #2 (the retry), and holds #3 to freeze us.)
async function test_put_revives_keeps_maybe () {
    var s = await start_server({
        put_behavior: n => n === 1 ? 'drop' : n === 2 ? 'ok' : 'hold'
    })
    var pipe = update_pipe(() => {}, {reconnect_interval: 0.3, max_outstanding_puts: 1})
    pipe.set(s.url, {version: ['a1'], body: '1'})
    pipe.set(s.url, {version: ['a2'], body: '2'})
    pipe.set(s.url, {version: ['a3'], body: '3'})

    await sleep(800)
    var host = pipe.network.hosts[s.host_name]
    assert.equal(host.online, 'maybe', 'a landed PUT lifts the offline host to maybe')
    assert.equal(host.urls[s.url].put_queue.size, 2, 'later writes keep the host alive')
    console.log('PASS: a landed PUT revives a multi-write host to maybe (alive, not green)')

    s.close()
}

// forget() drops a subscription, GCs its now-empty resource, and GCs the
// host once its last subscription is gone.
async function test_forget () {
    var s = await start_server()
    var pipe = update_pipe(() => {}, {reconnect_interval: 60})
    var a = s.origin + '/a', b = s.origin + '/b'
    pipe.get(a)
    pipe.get(b)

    await sleep(300)
    var host = pipe.network.hosts[s.host_name]
    assert.equal(Object.keys(host.urls).length, 2, 'two resources subscribed')
    assert.equal(host.online, true, 'green while subscribed')

    pipe.forget(a)
    await sleep(50)
    assert.equal(host.urls[a], undefined, 'forgotten resource is collected')
    assert.equal(Object.keys(host.urls).length, 1, 'one resource left')
    assert.equal(pipe.network.hosts[s.host_name], host, 'host survives on its other sub')
    assert.equal(host.online, true, 'still green')

    pipe.forget(b)
    await sleep(50)
    assert.equal(pipe.network.hosts[s.host_name], undefined, 'host GC’d once its last sub is forgotten')
    assert.equal(pipe.network.online, 'maybe', 'network settles at maybe')
    console.log('PASS: forget drops subscriptions and GCs empty resources and hosts')

    s.close()
}

// The case online_subs exists for: a host is green only because /a is
// online; /hang is still connecting (the server withholds its 209).
// Forgetting /a must drop the host to 'maybe' — a connecting subscription
// isn't online, so it can't hold the host green.
async function test_forget_with_other_connecting () {
    var s = await start_server()
    var pipe = update_pipe(() => {}, {reconnect_interval: 60})
    pipe.get(s.origin + '/a')        // gets its 209 → online
    pipe.get(s.origin + '/hang')     // server never answers → stays connecting

    await sleep(300)
    var host = pipe.network.hosts[s.host_name]
    assert.equal(host.online, true, 'green because /a is online')
    assert.equal(host.online_subs.size, 1, 'only /a is online; /hang is just connecting')

    pipe.forget(s.origin + '/a')
    await sleep(50)
    assert.equal(host.online_subs.size, 0, 'no online subscriptions remain')
    assert.equal(host.online, 'maybe', 'host falls to maybe, not stuck green')
    console.log('PASS: forgetting the only online sub drops to maybe while another is mid-connect')

    s.close()
}

// A 403 to a subscription is a give-up: report cb('error') and cancel the
// URL (so the dead sub leaves online_subs and the host GCs).
async function test_get_giveup () {
    var s = await start_server({subscribe_status: 403})
    var errors = []
    var pipe = update_pipe((m) => { if (m.message === 'error') errors.push(m) },
                            {reconnect_interval: 60})
    pipe.get(s.url)

    await sleep(300)
    assert.equal(errors.length, 1, 'one error reported')
    assert.equal(errors[0].status, 403, 'the 403 surfaced')
    assert.equal(errors[0].method, 'GET', 'on the GET')
    assert.equal(pipe.network.hosts[s.host_name], undefined, 'subscription cancelled, host GC’d')
    console.log('PASS: a forbidden (403) subscription reports cb(error) and cancels the URL')

    s.close()
}

// A 503 is a per-resource retry, NOT a host-down: the host stays 'maybe'
// and the request re-fires after a delay, then succeeds.
async function test_put_retries_503 () {
    var s = await start_server({put_behavior: n => n === 1 ? 503 : 200})
    var pipe = update_pipe(() => {}, {reconnect_interval: 0.3})
    pipe.set(s.url, {version: ['a1'], body: 'hi'})

    // First attempt 503s → retry scheduled; the host is 'maybe', not offline.
    await sleep(150)
    var host = pipe.network.hosts[s.host_name]
    assert.equal(host.online, 'maybe', '503 keeps the host maybe, never offline')
    assert.equal(host.urls[s.url].put_queue.size, 1, 'the PUT waits in its queue to retry')

    // The retry lands.
    await sleep(500)
    assert.equal(s.puts.length, 2, 'server saw the PUT twice (503 then 200)')
    assert.equal(pipe.network.hosts[s.host_name], undefined, 'PUT finally acked; host GC’d')
    console.log('PASS: a 503 PUT retries this request (no host escalation) and then succeeds')

    s.close()
}

// A server with no 209 multiresponse answers a subscribe with a plain 200
// (the current state).  We poll it: deliver each response as an update,
// stay 'maybe' (never green), and re-GET at poll_interval.
async function test_poll () {
    var s = await start_server({poll_mode: true})
    var updates = []
    var pipe = update_pipe((m) => { if (m.message === 'set') updates.push(m) },
                            {poll_interval: 0.3})
    pipe.get(s.url)

    await sleep(150)
    assert.equal(updates.length, 1, 'first poll delivered the current state as an update')
    assert.equal(Buffer.from(updates[0].body).toString(), 'state1', 'with the right body')
    var host = pipe.network.hosts[s.host_name]
    assert.equal(host.online, 'maybe', 'a polled url is maybe, never green')
    assert.equal(host.online_subs.size, 0, 'no online (209) subscription')

    await sleep(500)
    assert(updates.length >= 2, 'polling re-fetched and delivered again')

    pipe.forget(s.url)
    var count_at_forget = updates.length
    await sleep(500)
    assert.equal(updates.length, count_at_forget, 'forget stops the polling')
    console.log('PASS: a 200 (no 209) is polled — delivers updates, stays maybe, forget stops it')

    s.close()
}

async function main () {
    await test_poll()
    await test_get_giveup()
    await test_put_retries_503()
    await test_forget_with_other_connecting()
    await test_drop()
    await test_heartbeat_timeout()
    await test_reconnect()
    await test_multi()
    await test_put_basic()
    await test_put_pipeline()
    await test_put_giveup()
    await test_put_revives_writeonly()
    await test_put_revives_keeps_maybe()
    await test_forget()
    console.log('\nAll tests passed.')
    process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
