
// **********************************
// Braidifying the node 'http' module
// **********************************

function braidify_http (http) {
    http.normal_get = http.get
    http.get = function braid_req (arg1, arg2, arg3) {
        var url, options, cb

        // http.get() supports two forms:
        //
        //  - http.get(url[, options][, callback])
        //  - http.get(options[, callback])
        //
        // We need to know which arguments are which, so let's detect which
        // form we are looking at.

        // Detect form #1: http.get(url[, options][, callback])
        if (typeof arg1 === 'string' || arg1 instanceof URL) {
            url = arg1
            if (typeof arg2 === 'function')
                cb = arg2
            else {
                options = arg2
                cb = arg3
            }
        }

        // Otherwise it's form #2: http.get(options[, callback])
        else {
            options = arg2
            cb = arg3
        }

        options = options || {}

        // Now we know where the `options` are specified, let's set headers.
        if (!options.headers)
            options.headers = {}

        // Add the subscribe header if this is a subscription
        if (options.subscribe)
            options.headers.subscribe = '?1'   // Structured Headers for true

        // // Always add the `peer` header
        // options.headers.peer = options.headers.peer || peer

        // Wrap the callback to provide our new .on('update', ...) feature
        // on nodejs servers
        var on_update,
            on_error,
            orig_cb = cb
        cb = (res) => {
            res.orig_on = res.on
            res.on = (key, f) => {

                // Define .on('update', cb)
                if (key === 'update'
                    || key === 'version' /* Deprecated API calls it 'version' */ ) {

                    // If we have an 'update' handler, let's remember it
                    on_update = f

                    // Go through the incoming bytes to parse them...
                    var state = {input: []}
                    var chain = Promise.resolve()
                    res.orig_on('data', (chunk) => {
                        chain = chain.then(async () => {
                            for (let b of chunk) state.input.push(b)

                            // Parse and find some updates!
                            state = await parse_multiresponse(state, on_update)
                        }).catch(e => on_error?.(e))
                    })
                }

                // Forward .on('error', cb) and remember the error function
                else if (key === 'error') {
                    on_error = f
                    res.orig_on(key, f)
                }

                // Forward all other .on(*, cb) calls
                else res.orig_on(key, f)
            }
            orig_cb && orig_cb(res)
        }
            
        // Now put the parameters back in their prior order and call the
        // underlying .get() function
        if (url) {
            arg1 = url
            if (options) {
                arg2 = options
                arg3 = cb
            } else {
                arg2 = cb
            }
        } else {
            arg1 = options
            arg2 = cb
        }

        return http.normal_get(arg1, arg2, arg3)
    }
    return http
}



// ***************************
// Braidifying the fetch() API
// ***************************

var normal_fetch,
    is_nodejs = typeof window === 'undefined'

if (is_nodejs) {
    // Nodejs
    normal_fetch = typeof fetch !== 'undefined' && fetch
    braid_fetch.enable_multiplex = false
} else {
    // Web Browser
    normal_fetch = window.fetch
    AbortController = window.AbortController
    Headers = window.Headers
    // window.fetch = braid_fetch
}

// Swaps the underlying transport; returns the one it replaces, so callers
// can restore it afterwards
braid_fetch.set_fetch = f => { var old = normal_fetch; normal_fetch = f; return old }

// Global event listeners for debugging/devtools
var braid_fetch_listeners = {}
braid_fetch.on = (event, cb) => {
    if (!braid_fetch_listeners[event]) braid_fetch_listeners[event] = []
    braid_fetch_listeners[event].push(cb)
}
braid_fetch.off = (event, cb) => {
    var list = braid_fetch_listeners[event]
    if (list) braid_fetch_listeners[event] = list.filter(x => x !== cb)
}
braid_fetch.emit = (event, data) => {
    for (var cb of braid_fetch_listeners[event] || [])
        try { cb(data) } catch (e) { console.error('braid_fetch ' + event + ' listener error:', e) }
}

async function braid_fetch (url, params = {}) {
    params = deep_copy(params) // Copy params, because we'll mutate it
    params.url = url

    // Initialize the headers object
    if (!params.headers)
        params.headers = new Headers()
    else
        params.headers = new Headers(params.headers)

    // Sanity check inputs
    if (params.version)
        console.assert(Array.isArray(params.version),
                       'fetch(): `version` must be an array')
    if (params.parents)
        console.assert(Array.isArray(params.parents) || (typeof params.parents === 'function'),
                       'fetch(): `parents` must be an array or function')

    // // Always set the peer
    // params.headers.set('peer', peer)

    var version_to_header = (version_array) =>
        version_array.map(JSON.stringify).map(ascii_ify).join(', ')

    // We provide some shortcuts for Braid params
    if (params.version)                   // Q: Version checks truthiness...
        params.headers.set('version', version_to_header(params.version))
    if (Array.isArray(params.parents))    // Q: ...but parents checks isArray?  Why?
        params.headers.set('parents', version_to_header(params.parents))

    if (params.subscribe) {
        params.headers.set('subscribe', '?1')   // Structured Headers for true
        // Prevent this response from being cached
        params.cache = 'no-store'
    }

    if (params.peer)
        params.headers.set('peer', JSON.stringify(params.peer))

    if (params.heartbeats)
        params.headers.set('heartbeats',
                           typeof params.heartbeats === 'number'
                           ? `${params.heartbeats}s`
                           : params.heartbeats)

    // Prepare patches
    if (params.patches) {
        console.assert(!params.body, 'Cannot send both patches and body')
        console.assert(typeof params.patches === 'object', 'Patches must be object or array')

        // We accept a single patch as an array of one patch
        if (!Array.isArray(params.patches))
            params.patches = [params.patches]

        // If just one patch, send it directly!
        if (params.patches.length === 1) {
            let patch = params.patches[0]
            params.headers.set('Content-Range', `${patch.unit} ${patch.range}`)

            if (typeof patch.content === 'string')
                patch.content = new TextEncoder().encode(patch.content)

            params.body = patch.content
        }

        // Multiple patches get sent within a Patches: N block
        else {
            params.headers.set('Patches', params.patches.length)
            params.headers.set('Content-Type', 'application/http-patches; count='
                                                + params.patches.length)
            let bufs = []
            let te = new TextEncoder()
            for (let patch of params.patches) {
                if (bufs.length) bufs.push(te.encode(`\r\n`))

                if (typeof patch.content === 'string')
                    patch.content = te.encode(patch.content)

                var length = `content-length: ${get_binary_num_bytes(patch.content)}`
                var range = `content-range: ${patch.unit} ${patch.range}`
                bufs.push(te.encode(`${length}\r\n${range}\r\n\r\n`))
                bufs.push(patch.content)
                bufs.push(te.encode(`\r\n`))
            }
            params.body = new Blob(bufs)
        }
    }

    // The representation's media type travels as Repr-Type.
    if (params.repr_type) {
        params.headers.set('Repr-Type', params.repr_type)
        // A snapshot body IS the representation, so it also gets Content-Type
        if (!params.patches)
            params.headers.set('Content-Type', params.repr_type)
    }

    // Wrap the AbortController with a new one that we control.
    //
    // This is because we want to be able to abort the fetch that the user
    // passes in.  However, the fetch() command uses a silly "AbortController"
    // abstraction to abort fetches, which has both a `signal` and a
    // `controller`, and only passes the signal to fetch(), but we need the
    // `controller` to abort the fetch itself.

    var original_signal = params.signal
    var underlying_aborter = null
    if (original_signal)
        original_signal.addEventListener(
            'abort',
            () => underlying_aborter.abort()
        )

    var retry_count = 0
    var subscription_online = false
    var res = null
    var subscription_cb = null
    var subscription_error = null

    // Multiplexing book-keeping;
    // basically, if the user tries to make two or more subscriptions to the same origin,
    // then we want to multiplex
    var subscription_counts_on_close = null
    if (params.headers.has('subscribe')) {
        var origin = get_origin(url)
        if (!braid_fetch.subscription_counts)
            braid_fetch.subscription_counts = {}
        braid_fetch.subscription_counts[origin] =
            (braid_fetch.subscription_counts[origin] ?? 0) + 1

        subscription_counts_on_close = () => {
            subscription_counts_on_close = null
            braid_fetch.subscription_counts[origin]--
            if (!braid_fetch.subscription_counts[origin])
                delete braid_fetch.subscription_counts[origin]
        }

        // The count must come down on every way a subscription can die.
        // Errors and give-ups flow through handlers below that call this --
        // but only when something is reading the subscription. An abort with
        // no reader attached would otherwise never be noticed, leaking the
        // count (and skewing the multiplex {after: N} heuristic) forever.
        // This listener catches that case; the self-nulling closure makes it
        // safe for several of these paths to fire on the same subscription.
        original_signal?.addEventListener('abort',
            () => subscription_counts_on_close?.())
    }

    return await new Promise((done, fail) => {
        connect()
        async function connect() {
            // When something is wrong in a subscription, multiple errors can
            // get thrown.  So we handle all the errors with a centralized
            // error handler, here:
            function handle_connect_error (e) {
                // We only want to handle the error once:
                if (handle_connect_error.already_ran)
                    return
                else
                    handle_connect_error.already_ran = true

                // The fetch is probably down already, but there are some
                // other errors that could have happened, and in those cases,
                // we want to make sure to close the fetch
                underlying_aborter?.abort()

                // Notify subscription went offline
                if (params.onSubscriptionStatus && subscription_online) {
                    subscription_online = false
                    params.onSubscriptionStatus({online: false, error: e})
                }

                // If the error lacks a type, then it's a bug in our own code.
                if (!e.type)
                    // Launch it back into the universe!
                    throw e

                // We retry pipe errors.
                var retry = params.retry && e.type === 'pipe'

                if (retry && !original_signal?.aborted) {
                    // retry after some time..
                    var delay_ms = typeof braid_fetch.reconnect_delay_ms === 'function'
                        ? braid_fetch.reconnect_delay_ms(retry_count)
                        : braid_fetch.reconnect_delay_ms ?? Math.min(retry_count + 1, 3) * 1000
                    console.log(`retrying in ${delay_ms}ms: ${url} after error: ${e}`)
                    setTimeout(connect, delay_ms)
                    retry_count++
                } else {
                    // if we would have retried except that original_signal?.aborted,
                    // then we want to return that as the error..
                    if (retry && original_signal?.aborted)
                        e = Err({type: 'abort', message: 'already aborted'})

                    // let people know things are shutting down..
                    subscription_counts_on_close?.()
                    subscription_error?.(e)
                    return fail(e)
                }
            }

            // Now let's set up the fetch()
            try {
                if (original_signal?.aborted)
                    throw Err({type: 'abort', message: 'already aborted'})

                // We need a fresh underlying abort controller each time we connect
                underlying_aborter = new AbortController()
                params.signal = underlying_aborter.signal

                // If parents is a function,
                // call it now to get the latest parents
                if (typeof params.parents === 'function') {
                    try {
                        let parents = await params.parents()
                        if (parents)
                            params.headers.set('parents', parents.map(JSON.stringify).join(', '))
                    } catch (e) {
                        // The app's parents() callback threw — its problem, not ours.
                        e.type = 'app'
                        throw e
                    }
                }

                // Work around Chrome bug where when you restore a closed tab,
                // Chrome overrides our {cache:'no-store'} parameter and instead sets
                // SKIP_CACHE_VALIDATION, which overrides our subscription response
                // with ... a static entry from its cache!  That sucks.
                //
                // See https://issues.chromium.org/issues/490673934
                //
                // Our workaround is to detect if we are in chrome, and subscribing,
                // and are within a page restoration... and then...
                if (!is_nodejs && params.headers.has('subscribe')) {
                    var nav_entry = performance?.getEntriesByType?.('navigation')?.[0]
                    if (nav_entry?.type === 'back_forward'
                        && document.readyState !== 'complete') {

                        // ...we wait until the page has loaded to send this fetch,
                        // because Chrome's SKIP_CACHE_VALIDATION policy goes away
                        // once the page loads.

                        await new Promise(r => window.addEventListener('load', r))

                        // In practice, waiting for 'load' alone isn't enough;
                        // we also need this setTimeout(0) for it to work reliably.
                        await new Promise(done => setTimeout(done, 0))
                    }
                }

                // Braid-Chrome needs the following special (undocumented)
                // `onFetch` feature.  It's a callback with the params as they
                // are being sent to the underlying fetch().  The Braid
                // devtools wants to be able to display these in its devtools
                // panel.
                try {
                    params.onFetch?.(url, params, underlying_aborter)
                } catch (e) {
                    // The app's onFetch() callback threw — its problem, not ours.
                    e.type = 'app'
                    throw e
                }

                // Global debug events
                braid_fetch.emit('bytes-out', {req: params})
                // Every PUT is an update. PATCH/POST may also be updates
                // in the future, but nobody uses those yet in practice.
                if (params.method === 'PUT')
                    braid_fetch.emit('update-out', {req: params, update: {
                        version: params.version, parents: params.parents,
                        patches: params.patches, body: params.body
                    }})

                // Now we run the original fetch....

                // We will multiplex it under these configurations:
                //
                // - multiplex == true                  → forced on
                // - multiplex == false                 → forced off
                // - Multiplex-Through header specified → on
                // - multiplex == {after: N}            → if N subs exist
                //   - default is {after: 1}, which multiplexes the 2nd sub

                // We first look for the `multiplex` paramter to fetch().  If
                // not present, we look at `braid_fetch.enable_multiplex`.
                var mux_params = params.multiplex ?? braid_fetch.enable_multiplex,

                    // Compute the maximum subscriptions allowed
                    max_subs = ((mux_params && typeof mux_params === 'object')
                                ? (mux_params.after ?? 1)
                                : 1),

                    // Are we past that number?
                    too_many_subs = (braid_fetch.subscription_counts?.[origin]
                                     > max_subs)

                try {
                    if (!disabled_multiplex_hosts.has(get_origin(url))
                        && (mux_params === true
                            || (mux_params !== false
                                && (params.headers.has('multiplex-through')
                                    || too_many_subs)))) {
                        // Then multiplex!
                        res = await multiplex_fetch(url, params, mux_params)
                    } else
                        // Or do a regular fetch.
                        res = await normal_fetch(url, params)
                } catch (e) {
                    // An exception from the underlying fetch is, by definition, a
                    // pipe error — unless it's an abort, or the multiplexer already
                    // classified it.
                    if (typeof e === 'object' && e && !e.type)
                        e.type = e.name === 'AbortError' ? 'abort' : 'pipe'
                    throw e
                }

                braid_fetch.emit('response', {req: params, res})

                // And customize the response with a few methods:

                // ...for parsing an update from the response:
                res.update = async () =>
                    format_update(await parse_update_in_solo_response(res))

                // ...and for getting the braid subscription data:
                res.subscribe    = start_subscription
                res.subscription = {[Symbol.asyncIterator]: iterator}

                // Now define the subscription function we just used:
                function start_subscription (cb, error) {
                    subscription_cb = cb
                    subscription_error = error

                    // Heartbeats:
                    //
                    // This both sets the heartbeat header, and also sets a
                    // timer to warn us when the heartbeat has expired.
                    //
                    // However, the timer part is moving to the update_pipe.
                    // It's deprecated here, for now, but you need to
                    // explicitly opt-out with `params.heartbeat_timer: false`.
                    let on_heartbeat = () => {}
                    if (params.heartbeats && res.headers.get('heartbeats')
                        && params.heartbeat_timer !== false) {
                        let heartbeats = parseFloat(res.headers.get('heartbeats'))
                        if (isFinite(heartbeats)) {
                            let timeout = null
                            on_heartbeat = () => {
                                clearTimeout(timeout)
                                let wait_seconds = 1.2 * heartbeats + 3
                                timeout = setTimeout(() => {
                                    handle_connect_error(Err({type: 'pipe', message: `heartbeat not seen in ${wait_seconds.toFixed(2)}s`}))
                                }, wait_seconds * 1000)
                            }
                            on_heartbeat()
                        }
                    }

                    if (res.status !== 209)
                        throw Err({type: 'protocol', message: `Got unexpected subscription status code: ${res.status}. Expected 209.`})

                    if (res.bodyUsed)
                        // TODO: check if this needs a return
                        throw Err({type: 'app', message: 'This response\'s body has already been read'})

                    {
                        // Emit synthetic bytes for the initial response headers
                        var status_text = {
                            200:'OK', 201:'Created', 204:'No Content',
                            209:'Multiresponse', 304:'Not Modified',
                            400:'Bad Request', 401:'Unauthorized', 403:'Forbidden',
                            404:'Not Found', 409:'Conflict', 500:'Internal Server Error'
                        }[res.status] || ''
                        var response_line = `HTTP/1.1 ${res.status} ${status_text}\r\n`
                        res.headers.forEach((v, k) => { response_line += `${k}: ${v}\r\n` })
                        response_line += '\r\n'
                        braid_fetch.emit('bytes-in', {
                            req: params, res,
                            bytes: new TextEncoder().encode(response_line)
                        })
                    }
                    
                    // Parse the streamed response
                    handle_fetch_multiresponse(
                        res.body,

                        // Handle update
                        async (update) => {
                            // check whether we aborted
                            if (original_signal?.aborted)
                                throw Err({type: 'abort', message: 'already aborted'})

                            // Yay!  We got a new update!  Tell the callback!
                            braid_fetch.emit('update-in', {req: params, res, update})
                            try {
                                await cb(update)
                            } catch (e) {
                                // This error is happening in the user's code, so
                                // tag it 'app': surface it verbatim (keeping their
                                // stack) and don't retry — a reconnect would just
                                // re-trigger their bug.
                                e.type = 'app'
                                throw e
                            }
                        },

                        // This runs on all new bytes input
                        (chunk) => {
                            on_heartbeat()
                            params.on_heartbeat?.()
                            params.onBytes?.(chunk)
                            braid_fetch.emit('bytes-in', {req: params, res, bytes: chunk})
                        }
                    ).catch(handle_connect_error)
                }

                // And the iterator for use with "for async (...)"
                function iterator () {
                    // We'll keep this state while our iterator runs
                    var initialized = false,
                        inbox = [],
                        resolve = null,
                        reject = null,
                        last_error = null

                    return {
                        async next() {
                            // If we got an error, throw it
                            if (last_error) throw last_error

                            // If we've already received a version, return it
                            if (inbox.length > 0)
                                return {done: false, value: inbox.shift()}

                            // Otherwise, let's set up a promise to resolve when we get the next item
                            var promise = new Promise((_resolve, _reject) => {
                                resolve = _resolve
                                reject  = _reject
                            })

                            // Start the subscription, if we haven't already
                            if (!initialized) {
                                initialized = true

                                // The subscription will call whichever resolve and
                                // reject functions the current promise is waiting for
                                start_subscription(x => {
                                    inbox.push(x)
                                    resolve()
                                }, x => reject(x) )
                            }

                            // Now wait for the subscription to resolve or reject the promise.
                            await promise

                            // From here on out, we'll redirect the reject,
                            // since that promise is already done
                            reject = (err) => {last_error = err}

                            return {done: false, value: inbox.shift()}
                        }
                    }
                }

                if (params.retry && !res.ok) {
                    var give_up
                    if (typeof params.retry === 'function') {
                        give_up = !params.retry(res)
                    } else if (params.retry.retryRes) {
                        // deprecated in favor of setting retry to a function
                        give_up = !params.retry.retryRes(res)
                    } else {
                        give_up = res.status >= 400 && res.status < 600

                        switch (res.status) {
                            case 408: // Request Timeout
                            case 425: // Too Early
                            case 429: // Too Many Requests

                            case 502: // Bad Gateway
                            case 503: // Service Unavailable
                            case 504: // Gateway Timeout
                                give_up = false
                        }
                        if (res.statusText.match(/Missing Parents/i) ||
                            res.headers.get('retry-after') !== null)
                            give_up = false
                    }
                    if (give_up) {
                        // a fatal status ends the subscription for good:
                        // release its slot in the per-origin count
                        subscription_counts_on_close?.()
                        if (params.onSubscriptionStatus && subscription_online) {
                            subscription_online = false
                            params.onSubscriptionStatus({
                                online: false,
                                error: new Error(`giving up because of http status: ${res.status}`)
                            })
                        }
                        if (subscription_cb)
                            subscription_error?.(
                                new Error(`giving up because of http status: ${res.status}${(res.status === 401 || res.status === 403) ? ` (access denied)` : ''}`)
                            )
                    } else if (!res.ok) throw Err({type: 'pipe', message: `status not ok: ${res.status}`})
                }

                if (subscription_cb && res.ok) start_subscription(subscription_cb, subscription_error)

                if (params.subscribe && params.onSubscriptionStatus && res.ok) {
                    subscription_online = true
                    params.onSubscriptionStatus({online: true})
                }

                params?.retry?.onRes?.(res)
                retry_count = 0

                // parse version if it exists
                var version_header = res.headers.get('version')
                                  || res.headers.get('current-version')
                if (version_header)
                    try {
                        res.version = JSON.parse('[' + version_header + ']')
                    } catch (e) {
                        console.log('error parsing version: ' + version_header)
                    }

                done(res)
            } catch (e) { handle_connect_error(e) }
        }
    })
}

// Parse a stream of updates from the body of a fetch() multiresponse
async function handle_fetch_multiresponse (stream_body, on_update, on_bytes) {
    // Set up a reader
    var reader = stream_body.getReader(),
        // Initialize parser state
        state = {input: []}

    // Every error here — a read failure, a closed connection, a parse error, or
    // a throw from on_update — bubbles up to our caller's .catch().
    while (true) {
        // Read the next chunk of stream!
        try {
            var {done, value} = await reader.read()
        }
        catch (e) {
            // A read failure means the connection broke — a pipe error, unless
            // it's an abort.
            e.type = e.name === 'AbortError' ? 'abort' : 'pipe'
            throw e
        }

        // Check if this connection has been closed!
        if (done) {
            console.debug("Connection closed.")
            throw Err({type: 'pipe', message: 'Connection closed'})
        }

        if (on_bytes)
            on_bytes(value)

        // Add the new chunk to the parser input stream
        for (let v of value)
            state.input.push(v)

        // Run the parser on the new state.
        state = await parse_multiresponse(state, on_update)
    }
}


// The general multiresponse handler.  Parses a multiresponse into a stream of
// updates.  Reports each update as it comes in.
async function parse_multiresponse (state, on_update) {

    // Loop through the input and parse until we hit a dead end
    while (state.input.length) {

        // Try to parse an update
        state = parse_update (state)

        // Maybe we parsed an update!  That's cool!
        if (state.result === 'success') {
            var update = format_update(state)

            // Reset the parser for the next update!
            state = {input: state.input}

            // And tell the application!
            await on_update(update)
        }

        // We stop once we've run out of parseable input.
        else if (state.result === 'waiting')
            break
    }
    return state
}


// ******************************
// Braid-HTTP Parser
// ******************************


// Format an update object for presentation, from the parsed update state.
function format_update (parser_state) {
    var update = {
        version:      parser_state.version,
        parents:      parser_state.parents,
        body:         parser_state.body,
        patches:      parser_state.patches,
        status:       parser_state.status,
        repr_type:    parser_state.repr_type,
        content_type: parser_state.content_type,

        // Output extra_headers if there are some
        extra_headers: extra_headers(parser_state.headers)
    }
    for (var k in update)
        if (update[k] === undefined) delete update[k]

    // Ignore content-type if it's application/http-patches, because that has
    // already been parsed and handled by now.
    if (update.content_type?.includes('http-patches'))
        delete update.content_type

    // Install .body_text helper on body
    var body_text_cache = null
    Object.defineProperty(update, 'body_text', {
        get: function () {
            if (body_text_cache !== null) return body_text_cache
            return body_text_cache = this.body != null ?
                new TextDecoder('utf-8').decode(this.body.buffer) : undefined
        }
    })

    // Install content_text helpers on each patch content
    for (let p of update.patches ?? []) {
        let content_text_cache = null
        Object.defineProperty(p, 'content_text', {
            get: () => {
                if (content_text_cache !== null) return content_text_cache
                return content_text_cache =
                    new TextDecoder('utf-8').decode(p.content)
            }
        })
    }

    return update
}


// ****************************
// General parsing functions
// ****************************
//
// Each of these functions takes parsing state as input and returns the new
// state.  They often mutate the input state; so don't rely on the state you
// pass in.
//
// Depending on the parse result, each parse function returns:
//
//  parse_<thing> (state)
//  => {result: 'waiting', ...}  If it parsed part of an item, but needs more input
//  => {result: 'success', ...}  If it parses an entire item
//  => {result: 'error', ...}    If there is a syntax error in the input
//
// Keep in mind the parser state is:
//   - *reset* after parsing each update.
//   - *thrown away* after a parse error.

function parse_update (state) {
    // If we don't have headers yet, let's try to parse some
    if (!state.headers) {
        var parsed = parse_headers(state.input)

        if (parsed.result === 'waiting') {
            // Gotta wait if we don't have enoug input yet
            state.result = 'waiting'
            return state
        }

        parse_header_values(parsed)  // Parse the version strings and whatnot

        state.headers       = parsed.headers
        state.version       = state.headers.version
        state.parents       = state.headers.parents
        state.status        = state.headers[':status']
        state.content_type  = state.headers['content-type']
        state.repr_type     = state.headers['repr-type']

        // Ignore the patches content-type, because we expect and handle it
        if (state.content_type?.includes('http-patches'))
            delete state.content_type

        // Take the parsed headers out of the buffer
        state.input = parsed.input
    }

    // We have headers now!  Try parsing more body.
    return parse_body(state)
}

// This one parses an update from a standalone response; not in a 209
// subscription multiresponse body.  The headers are already parsed, here, so
// we fake the parse state halfway through.
async function parse_update_in_solo_response (res) {
    var headers = Object.fromEntries(res.headers.entries())

    // Create a parser state from the already-parsed headers...
    var state = {
        headers: {
            version: headers.version,
            parents: headers.parents,
            patches: headers.patches,
            ':status': res.status,
            'content-type': headers['content-type'],
            'content-length': headers['content-length'],
            'repr-type': headers['repr-type'],
        }
    }

    // Parse the header values
    parse_header_values(state)

    // And now prepare the parser state for parse_body:
    Object.assign(state, {
        // It will parse the response body as input
        input: new Uint8Array(await res.arrayBuffer()),

        // It will want these headers pulled out for it to use
        version: state.headers.version,
        parents: state.headers.parents,
        content_type: state.headers['content-type'],
        repr_type: state.headers['repr-type'],
        status: res.status
    })

    // A snapshot body with no Content-Length: arrayBuffer() already read it to
    // the end (EOF, or the Content-Length boundary on a kept-alive socket), so
    // hand the parser that length and let the normal path read it.
    if (state.headers['content-length'] == null && num_patches_in(state.headers) == null)
        state.headers['content-length'] = state.input.length

    // Now parse the body of this update!
    return parse_body(state)
}

function parse_headers (input) {

    // Find the start of the headers
    var start = 0
    while (input[start] === 13 || input[start] === 10) start++  // Skip newlines
    if (start === input.length) return {result: 'waiting'}

    // Look for the double-newline at the end of the headers.
    var end = start
    while (++end) {
        if (end > input.length) return {result: 'waiting'}
        if (    input[end - 1] === 10
            && (input[end - 2] === 10 || (input[end - 2] === 13 && input[end - 3] === 10)))
            break
    }

    // Extract the header string
    var headers_source = input.slice(start, end)
    headers_source = Array.isArray(headers_source)
        ? headers_source.map(x => String.fromCharCode(x)).join('')
        : new TextDecoder().decode(headers_source)

    // Convert status line into a ":status" header, so we can parse it as a header.
    // Accepts both the "HTTP 200 OK" and "200 OK" forms.
    headers_source = headers_source.replace(/^(?:HTTP\/?\d*\.?\d* )?(\d\d\d).*\r?\n/,
                                            ':status: $1\r\n')

    var headers_length = headers_source.length
    
    // Let's parse them!  First define some variables:
    var headers = {},
        header_regex = /(:?[\w-_]+):\s?(.*)[\r\n]*/gy,  // Parses one line a time
        match,
        found_last_match = false

    // And now loop through the block, matching one line at a time
    while (match = header_regex.exec(headers_source)) {
        headers[match[1].toLowerCase()] = match[2]

        // This might be the last line of the headers block!
        if (header_regex.lastIndex === headers_length)
            found_last_match = true
    }

    // If the regex failed before we got to the end of the block, throw error:
    if (!found_last_match)
        throw Err({
            type: 'parse',
            message: 'Parse error in headers: '
                + JSON.stringify(
                    headers_source.substr(header_regex.lastIndex),
                )
        })

    // Success!

    // // If we have Patches: N, verify that we have the right content-type set
    // if ('patches' in headers
    //     && !(headers['content-type'].startsWith('application/http-patches'))
    //     console.warn('braid-http: update with Patches: ' + headers.patches
    //                  + ' is missing Content-Type: application/http-patches.  Has Content-Type: ' + JSON.stringify(headers['content-type']))

    // Update the input
    input = input.slice(end)

    // And return the parsed result
    return { result: 'success', headers, input }
}

// Parse the Version, Parents, Patches, and :status values into JS primitves
function parse_header_values (state) {
    var headers = state.headers
    try {
        if (headers.version !== undefined)
            headers.version = JSON.parse('['+headers.version+']')
        if (headers.parents !== undefined)
            headers.parents = JSON.parse('['+headers.parents+']')
        if (headers.patches !== undefined)
            headers.patches = JSON.parse(headers.patches)
        if (headers[':status'] !== undefined)
            headers[':status'] = parseInt(headers[':status'])
    } catch (e) {
        throw Err({
            type: 'parse',
            message: 'Parsing bad header values: ' + JSON.stringify(headers)
        })
    }
    return state
}

// Content-range is of the form '<unit> <range>' e.g. 'json .index'
function parse_content_range (range_string) {
    var match = range_string.match(/(\S+)( (.*))?/)
    return match && {unit: match[1], range: match[3] || ''}
}
function num_patches_in (headers) {
    // It's in Patches: N
    if (headers.patches != null)  // != null catches undefined and null
        return headers.patches

    // Or Content-Type: application/http-patches; count=N
    var m = headers['content-type']?.match(/\/http-patches\s*;.*\bcount\s*=\s*(\d+)/i)
    return m ? parseInt(m[1]) : undefined
}
function parse_body (state) {

    // Parse Body Snapshot

    var content_length = parseInt(state.headers['content-length']),
        num_patches = num_patches_in(state.headers)

    if (!isNaN(content_length)) {

        // We've read a Content-Length, so we have a block to parse
        if (content_length > state.input.length) {
            // But we haven't received the whole block yet
            state.result = 'waiting'
            return state
        }

        // We have the whole block!
        state.result = 'success'

        // If we have a content-range, then this is a patch
        if (state.headers['content-range']) {
            var match = parse_content_range(state.headers['content-range'])
            if (!match)
                throw Err({
                    type: 'parse',
                    message: 'Cannot parse content-range: '
                        + JSON.stringify(state.headers['content-range'])
                })
            state.patches = [{
                unit: match.unit,
                range: match.range,
                content: new Uint8Array(state.input.slice(0, content_length)),

                // Question: Perhaps we should include headers here, like we do for
                // the Patches: N headers below?

                // headers: state.headers
            }]
        }

        // Otherwise, this is a snapshot body
        else state.body = new Uint8Array(state.input.slice(0, content_length))

        state.input = state.input.slice(content_length)
        return state
    }

    // Parse Patches

    else if (num_patches != null) {
        state.patches = state.patches || []

        var last_patch = state.patches[state.patches.length-1]

        // Parse patches until the final patch has its content filled
        while (!(state.patches.length === num_patches
                 && (state.patches.length === 0 || 'content' in last_patch))) {

            // Are we starting a new patch?
            if (!last_patch || 'content' in last_patch) {
                last_patch = {}
                state.patches.push(last_patch)
            }

            // Parse patch headers
            if (!('headers' in last_patch)) {
                var parsed = parse_headers(state.input)

                if (parsed.result === 'waiting') {
                    state.result = 'waiting'
                    return state
                }

                // Now parse the values within the headers
                parse_header_values(parsed)

                // We parsed patch headers!  Update state.
                last_patch.headers = parsed.headers
                state.input = parsed.input
            }

            // Todo: support custom patches, not just range-patch

            // Parse Range Patch format
            {
                var to_text = (bytes) =>
                    new TextDecoder('utf-8').decode(new Uint8Array(bytes))

                if (!('content-length' in last_patch.headers))
                    throw Err({
                        type: 'parse',
                        message: 'Missing content-length in patch: '
                            + JSON.stringify({
                                patch: last_patch,
                                input: to_text(state.input)
                            })
                    })

                if (!('content-range' in last_patch.headers))
                    throw Err({
                        type: 'parse',
                        message: 'Missing content-range in patch: '
                            + JSON.stringify({
                                patch: last_patch,
                                input: to_text(state.input)
                            })
                    })

                var content_length = parseInt(last_patch.headers['content-length'])

                // Does input have the entire patch contents yet?
                if (state.input.length < content_length) {
                    state.result = 'waiting'
                    return state
                }

                var match = parse_content_range(last_patch.headers['content-range'])
                if (!match)
                    throw Err({
                        type: 'parse',
                        message: 'Cannot parse content-range in patch: '
                            + JSON.stringify({
                                patch: last_patch,
                                input: to_text(state.input)
                            })
                    })

                last_patch.unit = match.unit
                last_patch.range = match.range
                last_patch.content = new Uint8Array(state.input.slice(0, content_length))
                last_patch.extra_headers = extra_headers(last_patch.headers)
                delete last_patch.headers  // We only keep the extra headers ^^

                // Consume the parsed input
                state.input = state.input.slice(content_length)
            }
        }

        state.result = 'success'
        return state
    }

    throw Err({
        type: 'parse',
        message: 'Cannot parse body without content-length or patches header'
    })
}


// The "extra_headers" field is returned to the client on any *update* or
// *patch* to include any headers that we've received, but don't have braid
// semantics for.
//
// This function creates that hash from a headers object, by filtering out all
// known headers.
function extra_headers (headers) {
    // Clone headers
    var result = Object.assign({}, headers)

    // Remove the non-extra parts
    var known_headers = ['version', 'parents', 'patches', ':status',
                         'content-length', 'content-range', 'content-type',
                         'repr-type']
    for (var i = 0; i < known_headers.length; i++)
        delete result[known_headers[i]]

    // Return undefined if we deleted them all
    if (Object.keys(result).length === 0)
        return undefined

    return result
}

function get_binary_num_bytes (binary) {
    return  binary instanceof ArrayBuffer ? binary.byteLength :
            binary instanceof Uint8Array  ? binary.length :
            binary instanceof Blob        ? binary.size : undefined
}

function deep_copy(x) {
    if (x === null || typeof x !== 'object') return x
    if (Array.isArray(x)) return x.map(x => deep_copy(x))
    if (x.constructor === Object)
        return Object.fromEntries(Object.entries(x).map(([k, x]) => [k, deep_copy(x)]))
    return x
}

function ascii_ify(s) {
    return s.replace(/[^\x20-\x7E]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

// Each of our errors has a `type`:
//   pipe:     retry
//   parse:    give up and tell the app.
//   app:      the application broke.  stop and tell it.
//   protocol: the server violated the spec.  stop and tell app.
//   abort:    the app cancelled.  give up.
// Any other error is a bug in our own code.
function Err ({message, type}) {
    var e = Error(message)
    e.type = type
    e.name = type[0].toUpperCase() + type.slice(1) + 'Error'
    return e
}

async function promise_done(promise) {
    var pending = {}
    var ret = await Promise.race([promise, Promise.resolve(pending)])
    return ret !== pending
}

function random_base64url(n) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    var result = ''
    for (let i = 0; i < n; i++)
        result += chars[Math.floor(Math.random() * 64)]
    return result
}

function get_origin(url) {
    // If url is relative like /foo, then we need to use the baseURI
    var base_uri = typeof document !== 'undefined' ? document.baseURI : undefined
    return new URL(url, base_uri).origin
}

// ****************************
// Multiplexing
// ****************************

// multiplex_fetch provides a fetch-like experience for HTTP requests
// where the result is actually being sent over a separate multiplexed connection.
async function multiplex_fetch(url, params, mux_params) {
    var origin = get_origin(url)

    // the mux_key is the same as the origin, unless it is being overriden
    // (the overriding is done by the tests)
    var mux_key = params.headers.get('multiplex-through')?.split('/')[3] ?? origin

    // create a new multiplexer if it doesn't exist for this origin
    if (!multiplex_fetch.multiplexers)
        multiplex_fetch.multiplexers = {}

    // this for-loop allows us to retry right away,
    // in case of duplicate ids
    for (let attempt = 1; ; attempt++) {
        await new Promise(done => setTimeout(done, attempt >= 3 ? 1000 : 0))

        // Create a multiplexer if it does not exist yet
        multiplex_fetch.multiplexers[mux_key] ||=
            create_multiplexer(origin, mux_key, params, mux_params, attempt)

        // call the special fetch function for the multiplexer
        try {
            return await (await multiplex_fetch.multiplexers[mux_key])(url, params, mux_params, attempt)
        } catch (e) {
            if (e === 'retry') continue
            throw e
        }
    }
}

async function duplicate_multiplexer_error(res, error_text) {
    // Some 409 errors are for duplicate multiplexers, and look like this:
    //
    //    409 Conflict
    //    
    //    Content-Type: application/json
    //    
    //    {
    //        "error": "Multiplexer already exists",  // or "Request already multiplexed"
    //        "details": "Cannot create duplicate multiplexer with ID 'xyz'"
    //    }

    try {
        if (res.status === 409) {
            var e = await res.clone().json()
            console.log('duplicate: we got a 409!!!!', e)
            // Now look to see if the JSON matches our 409 error
            return e.error === error_text
        }
    } catch (e) {}

    // Then this is not a duplicate multiplexer error
    return false
}

var disabled_multiplex_hosts = new Set([])

// returns a function with a fetch-like interface that transparently multiplexes the fetch
async function create_multiplexer(origin, mux_key, params, mux_params, attempt) {
    var multiplex_version = '1.0'

    // make up a new multiplexer id (unless it is being overriden)
    var multiplexer = (attempt === 1 &&
        params.headers.get('multiplex-through')?.split('/')[3])
        || random_base64url(Math.ceil((mux_params?.id_bits ?? 72) / 6))

    var requests = new Map()
    var burned_ids = new Set()  // request ids the server has 409'd as duplicates
    var mux_error = null
    var try_deleting = new Set()
    var not_used_timeout = null
    var mux_aborter = new AbortController()

    function cleanup_multiplexer(e, stay_dead) {
        // the multiplexer stream has died.. let everyone know..
        mux_aborter.abort()
        mux_error = e
        if (!stay_dead) delete multiplex_fetch.multiplexers[mux_key]
        for (var f of requests.values()) f()
    }

    async function try_deleting_request(request) {
        if (!try_deleting.has(request)) {
            // If the multiplexer is already known to be dead, skip the DELETE
            if (mux_error) return
            try_deleting.add(request)
            try {
                var mux_was_done = await promise_done(mux_created_promise)

                var res = await braid_fetch(`${origin}/.well-known/multiplexer/${multiplexer}/${request}`, {
                    method: 'DELETE',
                    headers: { 'Multiplex-Version': multiplex_version },
                    retry: true
                })

                // if we know the multiplexer was created,
                // but it isn't there now,
                // and our client doesn't realize it,
                // then shut it down ourselves
                if (res.status === 404 && res.headers.get('Bad-Multiplexer')
                    && mux_was_done && !mux_error) {
                    cleanup_multiplexer(new Error('multiplexer detected to be closed'))
                }

                if (!res.ok) throw new Error('status not ok: ' + res.status)
                if (res.headers.get('Multiplex-Version') !== multiplex_version)
                    throw new Error('wrong multiplex version: '
                                    + res.headers.get('Multiplex-Version')
                                    + ', expected ' + multiplex_version)
            } catch (e) {
                e = new Error(`Could not cancel multiplexed request: ${e}`)
                // console.error('' + e)
                throw e
            } finally { try_deleting.delete(request) }
        }
    }

    // This promise resolves when the create_multiplexer request responds.
    //  - its value is undefined if successfully created
    //  - its value is false if creation failed
    var mux_created_promise = (async () => {
        // Create the multiplexer!

        // There are two ways to create multiplexer:
        //   - MULTIPLEX method
        //   - POST to /.well-know/multiplexer/<id>

        try {
            // First, try to create multiplexer via MULTIPLEX method.
            // If it fails, we'll fall back to POST.
            //
            // Or if we are configured to use POST, we will do that.
            //
            // Note: MULTIPLEX is Disabled!  We always use POST.
            if (true
                || mux_params?.via === 'POST'
                || multiplex_fetch.post_only?.has(origin))

                throw 'skip multiplex method'

            var res = await braid_fetch(`${origin}/${multiplexer}`, {
                signal: mux_aborter.signal,
                method: 'MULTIPLEX',
                headers: {'Multiplex-Version': multiplex_version},
                retry: true,
                multiplex: false
            })
            if (await duplicate_multiplexer_error(res, "Multiplexer already exists"))
                return cleanup_multiplexer('retry')

            if (!res.ok || res.headers.get('Multiplex-Version') !== multiplex_version)
                throw 'bad'

        } catch (e) {
            // Create multiplexer via POST /.well-known/multiplexer/<id>
            //
            // Remember this so we skip trying to MULTIPLEX next time.
            ;(multiplex_fetch.post_only ||= new Set()).add(origin)
            try {
                res = await braid_fetch(`${origin}/.well-known/multiplexer/${multiplexer}`,
                                        {method: 'POST',
                                         signal: mux_aborter.signal,
                                         headers: {'Multiplex-Version': multiplex_version},
                                         retry: true,
                                         multiplex: false})
                if (await duplicate_multiplexer_error(res, "Multiplexer already exists"))
                    return cleanup_multiplexer('retry')

                if (!res.ok) throw new Error('status not ok: ' + res.status)
                if (res.headers.get('Multiplex-Version') !== multiplex_version) {
                    // Warn the user that there is a multiplex mismatch, and
                    // then we'll fall back to a regular non-multiplex
                    // request.
                    console.warn("Multiplexer version mismatch:",
                                 {client: multiplex_version,
                                  server: res.headers.get('Multiplex-Version')},
                                 'Disabling multiplexing on host.')
                    disabled_multiplex_hosts.add(origin)
                    throw new Error()
                }
            } catch (e) {
                // fallback to normal fetch if multiplexed connection fails
                // console.error(`Could not establish multiplexer.\n`
                //                 + `Got error: ${e}.\nFalling back to normal connection.`)
                cleanup_multiplexer('retry', true)
                return false
            }
        }

        // parse the multiplexed stream,
        // and send messages to the appropriate requests
        parse_multiplex_stream(res.body.getReader(), async (request, bytes) => {
            if (requests.has(request)) requests.get(request)(bytes)
            else try_deleting_request(request).catch(e => {})
        }, e => cleanup_multiplexer(e))
    })()

    // This wrapper for fetch sends its request over the multiplexer
    var fetch_wrapper = async (url, params, mux_params, attempt) => {

        // if we already know the multiplexer is not working,
        // then fallback to normal fetch
        if ((await promise_done(mux_created_promise)) && (await mux_created_promise) === false) {
            // if the user is specifically asking for multiplexing,
            // throw an error instead
            if (params.headers.get('multiplex-through'))
                throw new Error('multiplexer failed')

            return await normal_fetch(url, params)
        }

        // make up a new request id -- or use the caller's pinned id from
        // Multiplex-Through, honored whenever it isn't known to be taken
        // (in use by a live request here, or burned by a server 409)
        var submitted_mux_request_id = params.headers.get('multiplex-through')?.split('/')[4]
        var request_id = (submitted_mux_request_id
                          && !requests.has(submitted_mux_request_id)
                          && !burned_ids.has(submitted_mux_request_id))
            ? submitted_mux_request_id
            : random_base64url(Math.ceil((mux_params?.id_bits ?? 72) / 6))

        // make sure this request id is not already in use
        if (requests.has(request_id)) throw "retry"

        // add the Multiplex-Through header without affecting the underlying params
        var mux_headers = new Headers(params.headers)
        mux_headers.set('Multiplex-Through', `/.well-known/multiplexer/${multiplexer}/${request_id}`)
        mux_headers.set('Multiplex-Version', multiplex_version)

        // also create our own aborter in case we need to abort ourselves
        var aborter = new AbortController()
        params.signal?.addEventListener('abort', () => aborter.abort())

        // now create a new params with the new headers and abort signal
        params = {...params, headers: mux_headers, signal: aborter.signal}

        // setup a way to receive incoming data from the multiplexer
        var buffers = []
        var bytes_available = () => {}
        var request_error = null
        var established = false

        // this utility calls the callback whenever new data is available to process
        async function process_buffers(cb) {
            while (true) {
                // wait for data if none is available
                if (!mux_error && !request_error && !buffers.length)
                    await new Promise(done => bytes_available = done)
                if (mux_error || request_error) throw (mux_error || request_error)

                // process the data
                let ret = cb()
                if (ret) return ret
            }
        }

        // tell the multiplexer to send bytes for this request to us
        requests.set(request_id, bytes => {
            if (!bytes) buffers.push(bytes)
            else if (!mux_error) buffers.push(bytes)
            bytes_available()
        })

        // prepare a function that we'll call to cleanly tear things down
        clearTimeout(not_used_timeout)
        var unset = async e => {
            unset = () => {}
            requests.delete(request_id)
            if (!requests.size)
                not_used_timeout = setTimeout(() =>
                    mux_aborter.abort(),
                    mux_params?.not_used_timeout ?? 1000 * 20
                )
            request_error = e
            bytes_available()
            if (e !== 'retry' && established)
                await try_deleting_request(request_id).catch(e => {})
        }

        // Do the underlying fetch
        try {

            // For speed, a first attempt fires without waiting for the
            // multiplexer to finish being created.  (If it arrives early,
            // the server just sends a 424, and we retry.)  Retries wait.
            if (attempt > 1)
                await mux_created_promise

            // Wait until we know that the multiplexer has been created!
            var mux_was_done = await promise_done(mux_created_promise)

            // Yay, now we know that the multiplexer exists!  We can use it
            // now, and send a fetch over it.

            mux_params?.onFetch?.(url, params)  // Used only in our test/test.js

            // ==================================
            // Do the actual fetch()!  Yay!
            var res = await normal_fetch(url, params)
            // ===================================

            // The server received our request — if we need to tear it
            // down later, send a DELETE. (Skip for network errors, where
            // normal_fetch throws and we never reach here.)
            established = true

            if (await duplicate_multiplexer_error(res, "Request already multiplexed")) {
                burned_ids.add(request_id)
                throw "retry"
            }

            if (res.status === 424) {
                // the multiplexer isn't there,
                // could be we arrived before the multiplexer,
                // or after it was shutdown;
                // in either case we want to retry right away

                // but before we do,
                // if we know the multiplexer was created,
                // but it isn't there now,
                // and our client doesn't realize it,
                // then shut it down ourselves before retrying,
                // so when we retry,
                // a new multiplexer is created
                if (mux_was_done && !mux_error)
                    cleanup_multiplexer(new Error('multiplexer detected to be closed'))

                throw "retry"
            }

            // If this LOOKS like a successful multiplexer request, sanity check it:
            if (res.status === 293 || res.headers.has('Multiplex-Version')) {
                // Check for an eggregious multiplexing error: did the multiplexer
                // give the right version when creating a multiplexer... but the
                // WRONG version for this request?
                if (res.headers.get('Multiplex-Version') !== multiplex_version)
                    throw Err({type: 'protocol',
                               message: `Server created multiplexer, and then set a *different* `
                                   + `Multiplex-Version ${res.headers.get('Multiplex-Version')} `
                                   + `on a multiplexed request`})

                if (res.status !== 293)
                    throw Err({type: 'protocol', message: `Multiplexed request status ${res.status} is not 293`})
                if (!res.headers.has('Multiplex-Version'))
                    throw Err({type: 'protocol', message: 'Multiplexed request is missing Multiplex-Version header'})
            } else
                // If we got a response that doesn't talk about multiplexing...
                // then something probably went wrong before touching the server's
                // multiplexer code.  Let's just return it.
                return res

            // ===========================================================
            // Now we have a functioning multiplex-through 293 response!
            // ===========================================================

            // we want to present the illusion that the connection is still open,
            // and therefor closable with "abort",
            // so we handle the abort ourselves to close the multiplexed request
            params.signal.addEventListener('abort', () =>
                unset(Err({type: 'abort', message: 'request aborted'})))

            // first, we need to listen for the headers..
            var headers_buffer = new Uint8Array()
            var parsed_headers = await process_buffers(() => {
                // check if the request has been closed
                var request_ended = !buffers[buffers.length - 1]
                if (request_ended) buffers.pop()

                // aggregate all the new buffers into our big headers_buffer
                headers_buffer = concat_buffers([headers_buffer, ...buffers])
                buffers = []

                // and if the request had ended, put that information back
                if (request_ended) buffers.push(null)

                // try parsing what we got so far as headers..
                try {
                    var headers = parse_headers(headers_buffer)
                } catch (e) {
                    // A malformed multiplex header — give up on this request.
                    throw new Error('error parsing headers')
                }

                if (headers.result === 'waiting') {
                    if (request_ended)
                        throw new Error('Multiplexed request ended before headers received.')
                } else return headers
            })

            // put the bytes left over from the header back
            if (parsed_headers.input.length) buffers.unshift(parsed_headers.input)

            // these headers will also have the status,
            // but we want to present the status in a more usual way below
            var status = parsed_headers.headers[':status']
            delete parsed_headers.headers[':status']

            // create our own fake response object,
            // to mimik fetch's response object,
            // feeding the user our request data from the multiplexer
            var res = new Response(new ReadableStream({
                async start(controller) {
                    try {
                        await process_buffers(() => {
                            var b = buffers.shift()
                            if (!b) return true
                            controller.enqueue(b)
                        })
                    } catch (e) {
                        controller.error(e)
                    } finally { controller.close() }
                }
            }), {
                status,
                headers: parsed_headers.headers
            })

            // add a convenience property for the user to know if
            // this response is being multiplexed
            res.multiplexed_through = params.headers.get('multiplex-through')

            // return the fake response object
            return res
        } catch (e) {
            // if we had an error, be sure to unregister ourselves
            unset(e)
            throw (e === 'retry' && e) || mux_error || e
        }
    }
    fetch_wrapper.cleanup = () => cleanup_multiplexer(new Error('manual cleanup'))
    return fetch_wrapper
}

// waits on reader for chunks like: 123 bytes for request ABC\r\n..123 bytes..
// which would trigger cb("ABC", bytes)
async function parse_multiplex_stream(reader, cb, on_error) {
    try {
        var buffers = [new Uint8Array(0)]
        var buffers_size = 0
        var chunk_size = null
        var request_id = null
        var header_length = 0
        var header_started = false

        while (true) {
            var { done, value } = await reader.read()
            if (done) throw new Error('multiplex stream ended unexpectedly')
            buffers.push(value)
            buffers_size += value.length

            while (true) {
                if (chunk_size === null && buffers_size) {
                    if (buffers.length > 1) buffers = [concat_buffers(buffers)]

                    var headerComplete = false
                    while (buffers[0].length > header_length) {
                        const byte = buffers[0][header_length]
                        header_length++

                        if (byte !== 13 && byte !== 10) header_started = true
                        if (header_started && byte === 10) {
                            headerComplete = true
                            break
                        }
                    }
                    if (headerComplete) {
                        var headerStr = new TextDecoder().decode(
                            buffers[0].slice(0, header_length)
                        )
                        var m = headerStr.match(
                            /^[\r\n]*((\d+) bytes for|close|start) response ([A-Za-z0-9_-]+)\r\n$/
                        )

                        if (!m) throw new Error('invalid multiplex header')
                        request_id = m[3]

                        buffers[0] = buffers[0].slice(header_length)
                        buffers_size -= header_length

                        if (m[1] === 'close' || m[1] === 'start') {
                            cb(request_id, m[1] === 'start' ? new Uint8Array() : undefined)
                            header_length = 0
                            header_started = false
                        } else chunk_size = 1 * m[2]
                    } else break
                } else if (chunk_size !== null && buffers_size >= chunk_size) {
                    if (buffers.length > 1) buffers = [concat_buffers(buffers)]

                    var chunk = buffers[0].slice(0, chunk_size)
                    buffers[0] = buffers[0].slice(chunk_size)
                    buffers_size -= chunk_size

                    // console.log(`request_id: ${request_id}, ${new TextDecoder().decode(chunk)}`)

                    cb(request_id, chunk)

                    chunk_size = null
                    header_length = 0
                    header_started = false
                } else break
            }
        }
    } catch (e) { on_error(e) }
}

// concatenates an array of Uint8Array's, into a single one
function concat_buffers(buffers) {
    const x = new Uint8Array(buffers.reduce((a, b) => a + b.length, 0))
    let offset = 0
    for (const b of buffers) {
        x.set(b, offset)
        offset += b.length
    }
    return x
}

// Provides an abstraction over a GET Subscription and many PUTs as a single
// channel that can be online or offline.
//
// Guarantees that the GET will resubscribe and the PUTs will send when they
// can.
//
// Models there being a single network "connection" to the server, that can go
// online and offline, even though it's actually sending multiple distinct
// requests and responses, and doesn't get any information about an underlying
// TCP or QUIC connection.
//
// Infers online or offline status as follows:
//
//   - Goes offline when:
//     - Missing a heartbeat in N seconds
//     - Missing a PUT acknowledgement in N seconds
//     - Receiving HTTP status codes (408, 502, 503, 504) that indicate network problems
//     - Receiving TLS errors that signal we're behind a captive portal
//
//   - When it goes offline:
//     - It stops the GET and all PUTs
//     - Then tries going online
//
//   - To go online, it repeatedly sends a GET subscription request
//     - Once that connects, it sends all PUTs, in order
//
// Also will slow down PUTs, when receiving:
//   - 429: Too many Requests
//
// Will silently swallow and retry on:
//   - 432 (version unknown, might just need to wait until it reaches)
//     - But maybe we should eventually give up?  Or print error?
//   - ??

// [TODO] Will send a warning to the console on rate limit indicators:
//   - 429: Too Many Requests
//   - 503: Service Unavailable
//
// [TODO] Handle 3XX redirects
//   - 301 Moved Permanently and 306 Permanent Redirect:
//     - Move channel to this other URL instead, and remember it
//   - 302 Found and 307 Temporary Redirect:
//     - Redo just this request, at this other URL instead
//   - Weird ones, we don't expect -- likely indicate some kind of error:
//     - 300 Multiple Choices.  Not sure what to do.  Warn user, and retry?
//     - 304 Not Modified.  Only happens if client issues If-None-Match, and we won't.
//     - 303 See Other.  Only happens from POST.  Says where the URL now lives.

function reliable_update_channel (url, params) {
    var {
        on_update,
        on_status,
        on_warning,
        on_error,
        reconnect_from_parents,
        get_headers,
        put_headers = {},
        timeout = 20,

        // Used in simpleton to abort and crash if digests mismatch on the server
        failure_status_codes = [],
        no_retry_status_codes     // Deprecated rename of prior
    } = params || {}

    failure_status_codes = // Remove this in braid-http version 1.4+
        no_retry_status_codes || failure_status_codes

    // The repr-type that we got from the subscription
    var repr_type = null

    // Per the reliable-updates spec, these subscription response codes
    // indicate a transient failure we should retry without warning.
    var silent_retry_codes = [
        309,  // "Version Unknown Here" (deprecated? replaced with 432 in versions spec.)
        432,  // "Version Not Found":
              //  - Might be out of order.  Wait and retry after a delay.
        408,  // Request Timeout
              //  - The network is probably bad.
              //  - But maybe rebooting will just overload it
        425,  // Too Early (for TLS 1.3 0-RTT)
              //  - Network ok.  Just re-send after a delay.  Keep everything else going.
        429,  // Too Many Requests:
              //  - Network ok.  Perhaps send just one, until it goes through.
        502,  // "Bad Gateway".  Origin server is broken/crashing.
              //  - Server down.  Restart.
        503,  // "Service Unavailable":  Server is answering that it is unavailable.
              //  - Something is wrong.  Restart.
              //  - It would be confusing if PUTs were getting 503, but GET was fine, and
              //    we acted like everything is fine.  So let's go offline.
        504   // "Gateway Timeout": Network path to server is down.
              //  - Offline.
    ]

    // Todo:
    //  - We need to console warn on rate limiting: 429 and 503.
    //    - These could indicate that a rate limit variable needs changing somewhere.
    //  - Handle 3xx redirects?

    // Status codes that we should NOT retry:

    // Delay for the next reconnect attempt. If the server sent a Retry-After
    // header (seconds), honor that. Otherwise use our 1s / 3s backoff.
    var delay = (err, count) =>
        err?.retry_after_ms ?? (count === 1 ? 1000 : 3000)

    var warn = (msg) => {
        if (on_warning) on_warning(msg)
        else console.warn('reliable_update_channel:', msg)
    }

    // Captive-portal-ish fetch failures get a plain console.log.
    var note_fetch_error = (err) => {
        if (err?.cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID')
            console.warn('connection not up: TLS hostname mismatch, likely a captive portal')
    }

    // Internal abort controller — aborting this shuts down the whole
    // channel (the GET subscription and the PUT queue). It aborts when
    // the caller calls close() or when shutdown() is called (self-
    // initiated shutdown due to a fatal error like a parse error).
    var total_aborter = new AbortController()
    var shut_down = false
    var shutdown = (err) => {
        if (shut_down) return
        shut_down = true
        total_aborter.abort()
        on_error?.(err)
    }

    // Status tracking
    var online = false
    var notify_status = () => on_status?.({online, outstanding_puts: put_queue.size})

    // ============================================================
    // Single channel: subscription + PUT queue
    //
    // connect() manages both the GET subscription and the PUT queue.
    // If anything fails (subscription error, PUT error, heartbeat
    // timeout, PUT timeout) the entire channel is torn down and
    // rebuilt: reconnect() aborts the current connection and schedules
    // a fresh connect(), which re-establishes the subscription and
    // re-fires any queued PUTs.
    //
    // Backoff: failure_count tracks consecutive failures so that the
    // first retry waits delay(err, 1) and later retries delay(err, 2+).
    // A successful subscription or PUT resets it to 0.
    // ============================================================
    var heartbeat_timeout_ms = (1.2 * timeout + 3) * 1000
    var put_queue = new Set()   // entries: {update, resolve, reject}
    var send_put                // current connection's PUT sender, set once online
    var channel_reconnect       // current connection's reconnect function (for the manual reconnect() method)
    var failure_count = 0
    var conn_aborter = null     // current connection's abort controller

    // Closing the channel: tear down the in-flight connection and reject
    // anything still queued.
    total_aborter.signal.addEventListener('abort', () => {
        conn_aborter?.abort()
        for (var entry of put_queue)
            entry.reject(new Error('reliable_update_channel aborted'))
        put_queue.clear()
        notify_status()
    })

    subscribe()
    async function subscribe () {
        if (total_aborter.signal.aborted) return

        // This connection's own abort controller, aborted by reconnect()
        // to tear down the in-flight GET and any in-flight PUTs.
        conn_aborter = new AbortController()
        var inner_signal = conn_aborter.signal

        // Tear down this connection and schedule a fresh connect().
        // Captured into a local so the callbacks scheduled inside run()
        // (heartbeat timer, subscribe/PUT error handlers, PUT timeout)
        // always retire THIS connection — never a later one that has
        // since reassigned the shared var. The two guards make it a
        // no-op once the whole channel has been shut down, or once this
        // connection has already torn down. channel_reboot exposes
        // the current connection's reboot to the manual reboot()
        // method.
        var reboot = (err) => {
            if (total_aborter.signal.aborted || inner_signal.aborted) return
            if (online) { online = false; notify_status() }
            conn_aborter.abort()
            setTimeout(subscribe, delay(err, ++failure_count))
        }
        channel_reboot = reboot

        // ── Heartbeat timer ──────────────────────────────────────
        // Starts as a no-op; armed after we confirm the server echoed
        // the Heartbeats header.
        var heartbeat_timer = null
        var reset_heartbeat_timer = () => {}
        inner_signal.addEventListener('abort', () => clearTimeout(heartbeat_timer))

        // ── Subscription (GET) ───────────────────────────────────
        try {
            var res = await braid_fetch(url, {
                subscribe: true,
                signal: inner_signal,
                headers: {'Heartbeats': timeout, ...get_headers},
                parents: reconnect_from_parents,
                on_heartbeat: () => reset_heartbeat_timer()
            })

            // Per the spec: any non-209 status is a failure. Some status
            // codes (and any response with Retry-After) retry silently; the
            // rest emit a warning including the status code, then retry.
            if (res.status !== 209) {
                var err = new Error(`status ${res.status}`)
                if (failure_status_codes.includes(res.status))
                    return shutdown(err)
                var retry_after = parseFloat(res.headers.get('retry-after'))
                if (isFinite(retry_after)) err.retry_after_ms = retry_after * 1000
                if (!silent_retry_codes.includes(res.status) && !isFinite(retry_after))
                    warn(`subscription to ${url} got unexpected status ${res.status}`)
                return reboot(err)
            }

            failure_count = 0
            online = true; notify_status()
            if (res.headers.get('heartbeats')) {
                reset_heartbeat_timer = () => {
                    clearTimeout(heartbeat_timer)
                    heartbeat_timer = setTimeout(() => {
                        reboot(new Error(`heartbeat not seen in ${heartbeat_timeout_ms / 1000}s`))
                    }, heartbeat_timeout_ms)
                }
                reset_heartbeat_timer()
            }
            if (res.headers.get('repr-type'))
                repr_type = res.headers.get('repr-type')
            res.subscribe(
                update => {
                    // Mirror the server's repr-type into our PUTs
                    if (update.repr_type) repr_type = update.repr_type
                    on_update?.(update)
                },
                err => {
                    if (inner_signal.aborted) return
                    // Some errors won't be fixed by reconnecting — a corrupt
                    // stream ('parse'), a bug in on_update ('app'), or a server
                    // that violates the spec ('protocol'). Warn and shut the
                    // whole reliable_update_channel down.
                    if (err?.type === 'parse' || err?.type === 'app' || err?.type === 'protocol') {
                        warn('subscription error: ' + err.message)
                        return shutdown(err)
                    }
                    reboot(err)
                }
            )
        } catch (err) {
            if (inner_signal.aborted) return
            note_fetch_error(err)
            return reboot(err)
        }

        // ── PUT queue ────────────────────────────────────────────
        send_put = async (entry) => {
            if (inner_signal.aborted) return
            // Per the spec: each PUT has a timeout. If it doesn't
            // complete in time, trigger reboot which aborts all
            // in-flight PUTs and schedules a retry of the queue.
            var timed_out = false
            var timeout_handle = setTimeout(() => {
                timed_out = true
                reboot(new Error(`put timeout after ${timeout}s`))
            }, timeout * 1000)
            try {
                var res = await braid_fetch(url, {
                    method: 'PUT',
                    signal: inner_signal,
                    repr_type,
                    ...entry.update,
                    headers: {...put_headers, ...entry.update.headers}
                })
                if (timed_out) return

                // Per the spec: 2xx is success. Any non-2xx is a failure
                // — silent-retry codes (and any non-2xx response with
                // Retry-After) reconnect silently; other non-2xx status
                // codes warn and reconnect.
                if (res.status < 200 || res.status >= 300) {
                    var err = new Error(`status ${res.status}`)
                    if (failure_status_codes.includes(res.status))
                        return shutdown(err)
                    var retry_after = parseFloat(res.headers.get('retry-after'))
                    if (isFinite(retry_after)) err.retry_after_ms = retry_after * 1000
                    if (!silent_retry_codes.includes(res.status) && !isFinite(retry_after))
                        warn(`put got unexpected status ${res.status}`)
                    return reboot(err)
                }

                // Success! The server received it, so count it regardless
                // of whether inner_signal was aborted in the meantime.
                failure_count = 0
                put_queue.delete(entry)
                notify_status()
                entry.resolve(res)
            } catch (err) {
                if (inner_signal.aborted || timed_out) return
                note_fetch_error(err)
                reboot(err)
            } finally {
                clearTimeout(timeout_handle)
            }
        }

        // Fire any queued PUTs now that we're online.
        for (var entry of put_queue) send_put(entry)
    }

    return {
        put (update) {
            return new Promise((resolve, reject) => {
                var entry = {update, resolve, reject}
                put_queue.add(entry)
                notify_status()
                if (online) send_put(entry)
            })
        },
        close () { total_aborter.abort() },

        // Mike: Where is the following used?  I don't think it should be necessary.
        reconnect () { channel_reboot?.(new Error('manual reconnect')) }
    }
}

// ============================================================
// http_bus
//
// Abstracts HTTP behind a statebus.
//
// This maps between concrete braid_fetch() HTTP requests and responses, and
// the standard Interstate messages:
//
//   - get
//   - set
//   - delete
//   - forget
//   - ack
//
// Usage:
// > state = http_bus(cb)
// > state.get('https://foo.com/bar')
// > // Updates will stream to you via cb({type: 'set', url: 'https://foo.com/bar', update})
// > state.set('https://foo.com/bar', update)
// > state.forget('https://foo.com/bar')
//
// Models the network as pipes that go online and offline:
//
//   - one internet pipe                    (network.online)
//   - one pipe per host                    (host.online)
//
// Reports online/offline to the app.
//
// When the network or pipe is offline, it throttles reconnection attempts
// with little probes, rather than sending 10,000s of useless requests off a
// cliff to their death.
//
// More API, once you want it:
//
//   - get(url, {repr: {type, merge_type}}) asks the server for that
//     representation.  Sets arrive stamped with the repr it agreed to.
//   - Every set(url, update) ends in exactly one ack:
//     cb({type: 'ack', valid: true | 'abort', ...the write, repr, message})
//   - Connectivity is state: get('online') or get('online/<host>')
//     reports true | false | 'maybe', via ordinary sets.
//   - bus.type_of = (url) => type supplies a default type for reads and
//     writes that don't specify one.

function http_bus (cb, options = {}) {

    var base_url             = options.base_url,
        reconnect_interval   = options.reconnect_interval   ?? 3,    // Probe offline pipes every N seconds
        poll_interval        = options.poll_interval        ?? 30,   // For URLs that don't support 209 subscriptions
        max_outstanding_puts = options.max_outstanding_puts ?? 10,   // Per host

        // How long to wait on a GET/PUT response, or a subscription
        // heartbeat, before declaring a pipe offline.
        timeout              = options.timeout              ?? 30,
        heartbeat_period     = (timeout - 3) / 1.2

    // A pipe's "online" state can be true, false, or 'maybe'.
    //
    //  - true:    Has an active subscription.  Send freely!
    //  - false:   Requests failing.  Nothing sends.
    //  - 'maybe': No active subscription, but the last thing sent.  Try!

    // Each new host is born into `initial_online_status`.
    var initial_online_status = options.birth ?? 'maybe'

    // Sent on every request, so servers don't echo our writes back to us
    var peer = Math.random().toString(36).slice(2)

    var network = {
        online: initial_online_status,
        hosts: {}                     // hostname -> host
    }

    var hostname = (url) => new URL(url, base_url).host
    var host_of  = (url) => network.hosts[hostname(url)]
    var currently_idle = () => Object.keys(network.hosts).length === 0

    // Derive network.online from the state of each pipe in network.hosts.
    function recompute_network_online () {
        var hosts = Object.values(network.hosts)
        // Invariant: a host is green exactly when it has an online subscription.
        for (var h of hosts)
            console.assert((h.online === true) === (h.online_subs.size > 0),
                'host.online out of sync with online_subs',
                {online: h.online, online_subs: h.online_subs.size})

        network.online =
            // Online is true if any host is true
            hosts.some(h => h.online === true)    ? true
            // or 'maybe' if any is 'maybe'
          : hosts.some(h => h.online === 'maybe') ? 'maybe'
            // or 'maybe' while idle (because a host only disappears once its
            // work has completed successfully)
          : hosts.length === 0                    ? 'maybe'
            // Otherwise, we're sitting in a world of network errors, so online === false
          :                                         false

        report_online()
    }

    // == Online Status ==
    // Apps subscribe to 'online' or 'online/<host>' with ordinary get()s.
    var online_url = (url) => url === 'online' || url.startsWith('online/')
    var online_of  = (url) => url === 'online'
        ? network.online
        : network.hosts[url.slice('online/'.length)]?.online ?? 'maybe'

    var online_watchers = new Map()          // url -> value we last reported
    function report_online () {
        for (var [url, last] of online_watchers)
            if (online_of(url) !== last) {
                online_watchers.set(url, online_of(url))
                cb({type: 'set', url, body: online_of(url)})
            }
    }

    function create_host_state (name) {
        network.hosts[name] = {

            online: initial_online_status,

            // Note ^^^: A new host is born into initial_online_status (usually
            // 'maybe'), so its first request sends optimistically even when
            // every other host is currently offline.  Open question: maybe a
            // new host should instead inherit network.online (and so stay
            // held when the network is known down).  If you need that, set
            // its online from network.online here.

            online_subs: new Set(),       // subscription requests that are online (got 209)
            // last_heard_from: 0,           // timestamp; 0 = never heard
            urls: {},                     // url -> resource
            active_requests_count: 0,     // active subs + in-flight PUTs (GC at 0)
            outstanding_puts_count: 0     // in-flight PUTs.  Iff 0, we are "synced."
        }
        recompute_network_online()
        return network.hosts[name]
    }

    // We have a request to send!  Do the bookkeeping, and send it if the host
    // is sendable.
    function schedule_request (req) {
        var host = host_of(req.url) || create_host_state(hostname(req.url))

        // File the request into its resource object:
        var resource = host.urls[req.url] || (host.urls[req.url] = {
            subscription: null, put_queue: new Set(),
            last_version: null, last_etag: null, last_hash: null,
            repr: null
        })

        // A GET becomes a subscription
        if (req.method === 'GET')   resource.subscription = req

        // A PUT or DELETE joins the ordered put_queue:
        else                        resource.put_queue.add(req)
        // (We think of DELETE as a type of "put".)

        // And now send anything we can!
        if (host.online) send_host_requests(host)
    }

    function run_request (req) {
        var host = host_of(req.url)

        // Give the request an abort controller
        req.aborter = new AbortController()

        // The presence of req.aborter marks the request as "active".
        // Otherwise, it is "pending."

        // Count the newly-active request
        host.active_requests_count++
        if (req.method !== 'GET') host.outstanding_puts_count++

        // And fire the request
        if (req.method === 'GET') GET(req)
        else PUT(req)                 // PUT carries DELETE too
    }

    // Run every request this host can send right now: restart its pending
    // subscriptions, then fill the PUT pipeline up to max_outstanding_puts.
    function send_host_requests (host) {
        for (var url in host.urls) {
            var sub = host.urls[url].subscription
            if (sub && !sub.aborter) run_request(sub)
        }
        for (var url in host.urls)
            for (var put of host.urls[url].put_queue) {
                if (host.outstanding_puts_count >= max_outstanding_puts) return
                if (!put.aborter) run_request(put)
            }
    }

    // == Going online, offline, and 'maybe' ==

    // Go online at host when a subscription is alive
    function subscription_became_alive (host) {
        // A subscription reached 209!   The pipe is up!

        if (host.online !== true) {
            // Take the host online
            host.online = true              // Go green
            recompute_network_online()      // The network might need to go green, too
            send_host_requests(host)        // Run everything the host was holding
        }
    }

    // If we receive any positive signal from the host, we can transition to 'maybe'
    function host_showed_life (host) {
        if (host.online === false) {
            // The pipe answered but isn't streaming a subscription: a write
            // never earns green, so an offline host settles at 'maybe'.
            host.online = 'maybe'           // Go orange
            recompute_network_online()
        }
    }

    // We go offline when pipes fail.  Pipes "fail" in two cases:
    //
    //   (1) Exceptions from fetch()
    //   (2) Timeouts, while waiting for PUT ack or GET heartbeat
    //
    function pipe_failed (host) {
        // Todo: if we fail to receive a heartbeat from an origin server
        // through a proxy, we don't want to kill the whole proxy.  But this
        // doesn't distinguish yet.

        // The pipe to this host is down
        host.online = false                 // Go red

        // For every resource on this host
        for (var url in host.urls) {
            var resource = host.urls[url]

            // Deactivate every request:
            //  - It will abort()
            //  - and go back to "pending"
            deactivate_request(resource.subscription)
            for (var put of resource.put_queue) deactivate_request(put)
        }

        // Now recompute the network's online status
        recompute_network_online()
    }


    // Abort a request's in-flight attempt and mark it pending again.
    function deactivate_request (req) {
        if (!req || !req.aborter) return

        // Kill the timers.  We don't want these firing anymore.
        clearTimeout(req.timeout_timer); req.timeout_timer = null
        clearTimeout(req.retry_timer);   req.retry_timer   = null

        // Abort the request!
        req.aborter.abort()
        req.aborter = null             // Only active requests have an aborter

        var host = host_of(req.url)
        host.online_subs.delete(req)   // no-op unless this was an online subscription

        // And decrement our active request counters:
        host.active_requests_count--
        if (req.method !== 'GET') host.outstanding_puts_count--
    }

    // Remove a request from our bookkeeping.
    function delete_request (req) {
        var host     = host_of(req.url)
        var resource = host.urls[req.url]

        // Abort it, if it's active
        deactivate_request(req)

        // Drop it from the resource state
        if (req.method === 'GET') resource.subscription = null
        else                      resource.put_queue.delete(req)

        // This dropped request frees up a slot in max_outstanding_puts
        if (host.online)
            // So if the host is online, it can send another requesta, up to
            // max_outstanding_puts
            send_host_requests(host)

        // Garbage Collection!
        //
        // 1. The resource might now be empty of requests:
        if (!resource.subscription && resource.put_queue.size === 0) {
            delete host.urls[req.url]

            // 2. The host might now be empty of resources:
            if (Object.keys(host.urls).length === 0) {
                delete network.hosts[hostname(req.url)]

                // 3. And the network might now be idle:
                recompute_network_online()
            }
        }

        // A surviving host left with no online subscription settles at 'maybe'.
        if (host_of(req.url) && host.online === true && host.online_subs.size === 0) {
            host.online = 'maybe'
            recompute_network_online()
        }
    }


    // Remember the repr the server says it's speaking. We keep the same
    // object until it changes, so apps can compare reprs with !==
    function remember_repr (resource, type, merge_type) {
        var r = resource.repr
        if (!r || r.type !== type || r.merge_type !== merge_type)
            resource.repr = {type, merge_type}
        return resource.repr
    }

    // Turn a wire update into an app update: stamp its repr, decode its
    // content, and drop the wire fields the bus has already consumed
    function decode_update (update, resource) {
        if (update.repr_type)
            remember_repr(resource, update.repr_type, resource.repr?.merge_type)
        update.repr = resource.repr
        delete update.repr_type
        delete update.content_type
        delete update.status

        // Decode text/* content to strings, and json to parsed values
        var type = update.repr?.type ?? ''
        function decode (bytes) {
            if (type.includes('json') && bytes.length)
                return JSON.parse(new TextDecoder().decode(bytes))
            if (type.includes('json') || type.startsWith('text/'))
                return new TextDecoder().decode(bytes)
            return bytes
        }
        if (update.body != null) update.body = decode(update.body)
        for (var p of update.patches ?? [])
            if (p.content != null) p.content = decode(p.content)

        return update
    }

    // Fold an event into the version frontier: its parents stop being
    // leaves, and it becomes one
    function advance_frontier (frontier, event) {
        var leaves = (frontier ?? []).filter(v => !event.parents.includes(v))
        for (var v of event.version ?? [])
            if (!leaves.includes(v)) leaves.push(v)
        return leaves.sort()
    }


    // Map a HTTP response status to what we do about it:
    function classify_response_status (method, status) {
        // Note that the success cases (209 / 2xx) are handled inline by GET/PUT.
        var is_get = method === 'GET'
        switch (status) {

            // Any well-formed HTTP response (any status) proves the pipe to
            // the next hop is up.
            case 209:                       // subscription established
                                            return 'online'

            case 200: case 201: case 204:   // regular response
                                            return is_get ? 'poll' : 'acked'

            case 304:                       // If-None-Match matched: unchanged
                                            return is_get ? 'poll-noop' : 'give_up'

            // Transient at this URL: retry just this request after a delay.
            case 502: case 503: case 504:   // origin down / unavailable / gateway timeout
            case 408: case 425:             // request timeout / too early
            case 423: case 409:             // locked / conflict
            case 309: case 432:             // version unknown here
            case 429:                       // rate-limited (Retry-After)
            case 507:                       // insufficient storage
                                            return 'retry'

            case 500: case 404: case 410:   // GET may recover / poll; a write fails
                                            return is_get ? 'retry' : 'give_up'

            case 401: case 403: case 413:   // permanent
            case 422: case 415: case 501:   // unprocessable write
                                            return 'give_up'
        }

        // unknown: surface it, keep trying
        console.warn('Unknown status code', status, 'retrying...')
        return 'retry'
    }

    // A well-formed response: lift the host out of false, then retry or give up.
    function handle_issue (req, res, disposition) {
        host_showed_life(host_of(req.url))
        if (disposition === 'retry')
            return retry_request(req, compute_retry_after(res))
        if (req.method === 'GET') {
            delete_request(req)   // give up on this resource
            cb({type: 'error', url: req.url, message: `status ${res.status}`})
        } else
            abort_writes_built_on(req, `rejected with status ${res.status}`)
    }

    // Abort a write, plus every queued write built on it
    function abort_writes_built_on (req, message) {
        var resource = host_of(req.url)?.urls[req.url]

        // Find the descendants
        var dead = new Set(req.params?.version ?? [])
        var descendants = []
        if (resource && dead.size)
            for (var put of resource.put_queue)
                if (put !== req && put.params?.parents?.some(p => dead.has(p))) {
                    for (var v of put.params.version ?? []) dead.add(v)
                    descendants.push(put)
                }

        // Resolve the acks now, before deletions can GC the repr they report
        var ack_of = (r, why) => ({type: 'ack', valid: 'abort', url: r.url, ...r.params,
                                   repr: r.sent_repr ?? repr_for_write(r), message: why})
        var acks = [ack_of(req, message)].concat(descendants.map(put =>
            ack_of(put, `builds on rejected write ${req.params.version[0]}`)))

        // Remove the descendants first: the rejected write still holds its
        // queue slot, so removing them can't pump one onto the wire
        for (var put of descendants) delete_request(put)
        delete_request(req)

        // Then report the deaths, in causal order
        for (var a of acks) cb(a)
    }

    // Re-fire this request after a delay.
    function retry_request (req, delay) {
        // The request will stay "active" (its aborter lives on) so nothing
        // else will re-send it.

        req.retry_timer = setTimeout(() => {
            req.retry_timer = null
            if (req.method === 'GET') GET(req)
            else                      PUT(req)
        }, delay * 1000)
        // ^^ If the request ever gets torn down during the retry period,
        // deactivate_request() will clear this retry_timer.
    }

    function compute_retry_after (res) {
        var base = (res.status === 408 || res.status === 425) ? 1 : reconnect_interval
        var retry_after = parseFloat(res.headers.get('retry-after'))
        return isFinite(retry_after) ? Math.max(base, retry_after) : base
    }


    // == Network requests ==

    // Open a subscription and stream its updates.
    async function GET (req) {
        var host     = host_of(req.url)
        var resource = host.urls[req.url]

        // Set the timer that triggers pipe_failed(host) when we haven't heard
        // from the server in too long!
        var reset_timeout = () => {
            clearTimeout(req.timeout_timer)
            req.timeout_timer = setTimeout(() => pipe_failed(host), timeout * 1000)
        }
        reset_timeout()

        // Ask for the repr the caller wants, or the app's default
        var wanted = req.params?.repr
        var accept = wanted?.type ?? self.type_of?.(req.url)

        // Now fire the fetch()!
        try {
            var res = await braid_fetch(req.url, {
                subscribe:       true,
                retry:           false,
                heartbeats:      heartbeat_period,
                heartbeat_timer: false,
                peer,
                parents:         req.params?.parents ?? resource.last_version,
                headers:         {...accept && {'Accept': accept},
                                  ...wanted?.merge_type && {'Merge-Type': wanted.merge_type},
                                  ...resource.last_etag && {'If-None-Match': resource.last_etag}},
                signal:          req.aborter.signal,
                on_heartbeat:    reset_timeout
            })
            clearTimeout(req.timeout_timer)
            if (!req.aborter || req.aborter.signal.aborted) return

            // We got a response!  Its headers say which repr the server chose
            var served = res.headers.get('repr-type') ?? res.headers.get('content-type')
            if (served || res.headers.get('merge-type'))
                remember_repr(resource, served, res.headers.get('merge-type'))

            // Figure out how to respond to the response:
            var disposition = classify_response_status('GET', res.status)

            // Maybe we got a working subscription!
            if (disposition === 'online') {
                host.online_subs.add(req)            // this connection is now online
                subscription_became_alive(host)
                reset_timeout()                      // now guard the stream
                res.subscribe(
                    update => {
                        var status = parseInt(update.status) || 200

                        // Remember the new version
                        if (update.version)
                            resource.last_version = update.parents?.length
                                // With parents, it advances our frontier
                                ? advance_frontier(resource.last_version, update)
                                // Without, it's a snapshot that resets it
                                : update.version

                        // Announce a delete
                        if (status === 404 || status === 410)
                            cb({type: 'delete', url: req.url,
                                version: update.version, repr: resource.repr})

                        // Report other errors, but keep the subscription alive
                        else if (status < 200 || status >= 300) {
                            console.error(`http_bus: got ${status} in the subscription to ${req.url}`)
                            cb({type: 'error', url: req.url,
                                message: `status ${status} in subscription`})
                        }

                        // Or an update!
                        else
                            cb({...decode_update(update, resource), type: 'set', url: req.url})
                    },
                    err => get_failed(req, err)
                )

            // Or maybe we're just polling
            } else if (disposition === 'poll') {
                if (!req.aborter || req.aborter.signal.aborted) return

                // Host's online is now at least 'maybe'
                host_showed_life(host)

                // The update is in the respones
                var update = await res.update()
                if (await polled_update_differs(resource, update, res))
                    cb({...decode_update(update, resource), type: 'set', url: req.url})

                // And poll again in 30s!
                retry_request(req, poll_interval)

            // Or the server says nothing changed since our If-None-Match.
            } else if (disposition === 'poll-noop') {
                host_showed_life(host)
                retry_request(req, poll_interval)

            // Or... we have a real issue to contend with...
            } else
                handle_issue(req, res, disposition)
        }

        // Exceptions in fetch() are either an intentional abort(), or a pipe
        // failure, in which case we'll go offline.
        catch (err) {
            clearTimeout(req.timeout_timer)
            if (!req.aborter || req.aborter.signal.aborted) return
            get_failed(req, err)
        }
    }

    // Route a thrown connection/stream error by its type.
    function get_failed (req, err) {
        if (err.type === 'abort') return
        if (err.type === 'pipe') {
            if (err.cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID')
                console.warn(`TLS hostname mismatch on ${req.url}, likely a captive portal`)
            return pipe_failed(host_of(req.url))
        }
        // parse / protocol / app: reconnecting won't help — cancel the URL.
        delete_request(req)
        cb({type: 'error', url: req.url, message: err.message})
    }

    function repr_for_write (req) {
        // A write can choose its own repr
        var asked = req.params?.repr

        // Otherwise it inherits whatever the GET negotiated
        var known = host_of(req.url)?.urls[req.url]?.repr

        // Each field falls back separately; up to the app's default
        var type       = asked?.type       ?? known?.type ?? self.type_of?.(req.url)
        var merge_type = asked?.merge_type ?? known?.merge_type

        // We either found a repr
        return (type || merge_type)
            ? {type, merge_type}
            // or... if we have an empty repr, give no repr at all
            : undefined
    }

    // Send one PUT (or DELETE).
    //
    //  - A complete HTTP response (even with an error response status) proves
    //    the pipe is up.
    //  - Only a thrown or timed-out request is a pipe failure.
    async function PUT (req) {
        var host = host_of(req.url)

        // Fail the pipe if the PUT doesn't answer in time.  deactivate_request
        // clears this, so we need no abort listener.
        req.timeout_timer = setTimeout(() => pipe_failed(host), timeout * 1000)

        // Resolve the repr now, and remember it, so the ack reports what we sent
        var repr = req.sent_repr = repr_for_write(req)

        // braid_fetch encodes patches in place, so give it a copy, keeping
        // the caller's write pristine for its ack
        var params = {...req.params}
        delete params.repr
        if (params.patches) params.patches = params.patches.map(p => ({...p}))

        try {

            // Send the PUT!!
            var res = await braid_fetch(req.url, {
                ...params,              // version, parents, patches/body, headers
                repr_type: repr?.type,
                headers: {...repr?.merge_type && {'Merge-Type': repr.merge_type},
                          ...params.headers},
                peer,
                method: req.method,     // PUT or DELETE
                retry:  false,
                signal: req.aborter.signal
            })
            clearTimeout(req.timeout_timer)
            if (!req.aborter || req.aborter.signal.aborted) return

            // Classify the response status code
            var disposition = classify_response_status(req.method, res.status)
            if (disposition === 'acked') {
                host_showed_life(host)

                // Our writes never echo back down the subscription, so acks
                // are what advance the frontier
                var resource = host.urls[req.url]
                if (resource && req.params.version && req.params.parents)
                    resource.last_version =
                        advance_frontier(resource.last_version, req.params)

                cb({type: 'ack', valid: true, url: req.url, ...req.params, repr})
                delete_request(req)
            } else
                handle_issue(req, res, disposition)
        } catch (err) {
            clearTimeout(req.timeout_timer)
            if (!req.aborter || req.aborter.signal.aborted) return
            if (err.type === 'pipe')
                return pipe_failed(host)   // host down; PUT stays queued for a resend
            // parse / protocol / app: the write itself is bad
            abort_writes_built_on(req, `${err.type} error: ${err.message}`)
        }
    }

    // == Reconnection poll ==
    // Every three seconds, send a probe to see if we're back online.
    var next_host_to_probe = 0
    function reconnection_poll () {
        if (currently_idle()) return

        // If the network itself is up, send a probe to each offline host
        if (network.online)
            for (var name in network.hosts) {
                var host = network.hosts[name]
                if (!host.online && host.active_requests_count === 0)
                    probe_host(host)
            }

        // Otherwise, send out just one single probe, to a single host, until
        // we have any signal at all.
        else {
            // First, check if we already have a probe in-progress:
            var probing = Object.values(network.hosts)
                .some(h => h.active_requests_count > 0)
            if (!probing) {

                // Pick one host to probe, round-robin style, and probe it:
                var names = Object.keys(network.hosts)
                probe_host(network.hosts[names[next_host_to_probe++ % names.length]])
            }
        }
    }

    // Launch one held request on a host
    function probe_host (host) {
        // Choose a URL round-robin style
        for (var url in host.urls) {
            // Loop through URLs, skipping those whose request is already
            // in-flight or empty, until we find one to probe

            var resource = host.urls[url]
            var put = resource.put_queue.values().next().value

            // Within a url, probe with its subscription, if it exists.
            var req = resource.subscription && !resource.subscription.aborter
                ? resource.subscription

                // Else a PUT.
                : put && !put.aborter ? put : null

            // If we got one, probe it
            if (req) {
                delete host.urls[url]       // Move this url to the back of the
                host.urls[url] = resource   // iteration order, to implement round-robin
                return run_request(req)
            }
        }
    }

    // == Subscription Poll Fallback Helpers ==

    // Does this update differ from the last one?
    async function polled_update_differs (resource, update, res) {
        // Fast non-cryptographic 53-bit hash; pure-JS fallback for when
        // WebCrypto's SHA-256 is unavailable (e.g. insecure http: pages).
        function cyrb53_bytes (bytes, seed = 0) {
            let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed
            for (let i = 0; i < bytes.length; i++) {
                let ch = bytes[i]
                h1 = Math.imul(h1 ^ ch, 2654435761)
                h2 = Math.imul(h2 ^ ch, 1597334677)
            }
            h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
            h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
            h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
            h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
            return 4294967296 * (2097151 & h2) + (h1 >>> 0)
        }
        // Helper to compare versions
        var same_version = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

        var etag = res.headers.get('etag')
        var changed
        if (resource.last_version != null && update.version != null)
            changed = !same_version(update.version, resource.last_version)
        else if (resource.last_etag != null && etag != null)
            changed = etag !== resource.last_etag
        else {
            // No shared version or etag: hash the body.
            var bytes = update.body ?? new Uint8Array(0)
            var hash
            if (globalThis.crypto?.subtle) {
                var digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
                hash = [...new Uint8Array(digest)]
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('')
            } else
                hash = cyrb53_bytes(bytes)
            changed = resource.last_hash == null || hash !== resource.last_hash
            resource.last_hash = hash
        }

        // Adopt the server's latest tokens (etag may be null: next GET omits it).
        if (update.version != null)
            resource.last_version = update.version
        resource.last_etag = etag

        return changed
    }

    var poll_timer = setInterval(reconnection_poll, reconnect_interval * 1000)
    poll_timer.unref?.()


    // == The Abstract Braid Protocol interface ==
    var self = {
        get (url, params) {
            // Online status answers immediately, from local state
            if (online_url(url)) {
                online_watchers.set(url, online_of(url))
                return cb({type: 'set', url, body: online_of(url)})
            }

            var host = host_of(url)
            var resource = host && host.urls[url]
            console.assert(!(resource && resource.subscription),
                           'Already subscribed to ' + url)
            schedule_request({url, method: 'GET', params})
        },
        forget (url) {
            if (online_url(url)) return online_watchers.delete(url)

            var host     = host_of(url)
            var resource = host && host.urls[url]
            if (!resource) return
            if (resource.subscription)
                delete_request(resource.subscription)

            // Forget what reading taught us, but leave queued writes alone
            resource.last_version = resource.last_etag = null
            resource.last_hash = resource.repr = null
        },
        set (url, update) {
            schedule_request({url, method: 'PUT', params: update})
        },
        delete (url, params) {
            schedule_request({url, method: 'DELETE', params})
        },

        // The app's default type for urls that don't specify one:
        // bus.type_of = (url) => 'text/plain'
        type_of: null,

        // Internal state, exposed for inspection and testing.
        network
    }
    return self
}


// ****************************
// Exports
// ****************************

if (typeof module !== 'undefined' && module.exports)
    module.exports = {
        fetch: braid_fetch,
        multiplex_fetch,
        http: braidify_http,   // Deprecated: use fetch instead
        parse_update,
        parse_headers,
        parse_header_values,
        parse_body,
        reliable_update_channel,
        http_bus
    }
