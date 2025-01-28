// var peer = Math.random().toString(36).substr(2)

// ***************************
// http
// ***************************

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
            options.headers.subscribe = 'true'

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

                    // And set up a subscription parser
                    var parser = subscription_parser(async (update, error) => {
                        if (!error)
                            on_update && (await on_update(update))
                        else
                            on_error && on_error(error)
                    })

                    // That will run each time we get new data
                    var chain = Promise.resolve()
                    res.orig_on('data', (chunk) => {
                        chain = chain.then(async () => {
                            await parser.read(chunk)
                        })
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
// Fetch
// ***************************

var normal_fetch,
    is_nodejs = typeof window === 'undefined'

if (is_nodejs) {
    // Nodejs
    normal_fetch = fetch
} else {
    // Web Browser
    normal_fetch = window.fetch
    AbortController = window.AbortController
    Headers = window.Headers
    // window.fetch = braid_fetch
}

async function braid_fetch (url, params = {}) {
    params = deep_copy(params) // Copy params, because we'll mutate it

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

    // We provide some shortcuts for Braid params
    if (params.version)
        params.headers.set('version', params.version.map(JSON.stringify).map(ascii_ify).join(', '))
    if (Array.isArray(params.parents))
        params.headers.set('parents', params.parents.map(JSON.stringify).map(ascii_ify).join(', '))
    if (params.subscribe)
        params.headers.set('subscribe', 'true')
    if (params.peer)
        params.headers.set('peer', params.peer)
    
    if (params.heartbeats)
        params.headers.set('heartbeats', typeof params.heartbeats === 'number' ? `${params.heartbeats}s` : params.heartbeats)

    // Prevent browsers from going to disk cache
    params.cache = 'no-cache'

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
            let bufs = []
            let te = new TextEncoder()
            for (let patch of params.patches) {
                if (bufs.length) bufs.push(te.encode(`\r\n`))

                if (typeof patch.content === 'string')
                    patch.content = te.encode(patch.content)

                var length = `content-length: ${get_binary_length(patch.content)}`
                var range = `content-range: ${patch.unit} ${patch.range}`
                bufs.push(te.encode(`${length}\r\n${range}\r\n\r\n`))
                bufs.push(patch.content)
                bufs.push(te.encode(`\r\n`))
            }
            params.body = new Blob(bufs)
        }
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

    var waitTime = 1
    var res = null
    var subscription_cb = null
    var subscription_error = null
    var cb_running = false

    // Multiplexing book-keeping;
    // basically, if the user tries to make two or more subscriptions to the same origin,
    // then we want to multiplex
    var subscription_counts_on_close = null
    if (params.headers.has('subscribe')) {
        var origin = new URL(url, typeof document !== 'undefined' ? document.baseURI : undefined).origin
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
    }

    return await new Promise((done, fail) => {
        connect()
        async function connect() {
            // we direct all error paths here so we can make centralized retry decisions
            let on_error = e => {
                on_error = () => {}

                // The fetch is probably down already, but there are some other errors that could have happened,
                // and in those cases, we want to make sure to close the fetch
                underlying_aborter?.abort()

                // see if we should retry..
                var retry = params.retry && // only try to reconnect if the user has chosen to
                    e.name !== "AbortError" && // don't retry if the user has chosen to abort
                    !e.startsWith?.('Parse error in headers') && // in this case, the server is spewing garbage, so reconnecting might be bad
                    !cb_running // if an error is thrown in the callback, then it may not be good to reconnect, and generate more errors

                if (retry && !original_signal?.aborted) {
                    // retry after some time..
                    console.log(`retrying in ${waitTime}s: ${url} after error: ${e}`)
                    setTimeout(connect, waitTime * 1000)
                    waitTime = Math.min(waitTime + 1, 3)
                } else {
                    // if we would have retried except that original_signal?.aborted,
                    // then we want to return that as the error..
                    if (retry && original_signal?.aborted) e = create_abort_error('already aborted')

                    // let people know things are shutting down..
                    subscription_counts_on_close?.()
                    subscription_error?.(e)
                    return fail(e)
                }
            }

            try {
                if (original_signal?.aborted) throw create_abort_error('already aborted')

                // We need a fresh underlying abort controller each time we connect
                underlying_aborter = new AbortController()
                params.signal = underlying_aborter.signal

                // If parents is a function,
                // call it now to get the latest parents
                if (typeof params.parents === 'function') {
                    let parents = await params.parents()
                    if (parents) params.headers.set('parents', parents.map(JSON.stringify).join(', '))
                }

                // undocumented feature used by braid-chrome
                // to see the fetch args as they are right before it is actually called,
                // to display them for the user in the dev panel
                params.onFetch?.(url, params)

                // Now we run the original fetch....

                // try multiplexing if either of these is true:
                // - they explicitly want multiplexing
                // - this is not the first subscription to the same origin
                if (braid_fetch.use_multiplexing &&
                    (params.headers.has('multiplexer') ||
                        (params.headers.has('subscribe') &&
                            braid_fetch.subscription_counts?.[origin] > 1))) {
                    res = await multiplex_fetch(url, params)
                } else {
                    res = await normal_fetch(url, params)
                }

                // And customize the response with a couple methods for getting
                // the braid subscription data:
                res.subscribe    = start_subscription
                res.subscription = {[Symbol.asyncIterator]: iterator}

                // Now we define the subscription function we just used:
                function start_subscription (cb, error) {
                    subscription_cb = cb
                    subscription_error = error

                    // heartbeat
                    let on_heartbeat = () => {}
                    if (res.headers.get('heartbeats')) {
                        let heartbeats = parseFloat(res.headers.get('heartbeats'))
                        if (isFinite(heartbeats)) {
                            let timeout = null
                            on_heartbeat = () => {
                                clearTimeout(timeout)
                                let wait_seconds = 1.2 * heartbeats + 3
                                timeout = setTimeout(() => {
                                    on_error(new Error(`heartbeat not seen in ${wait_seconds.toFixed(2)}s`))
                                }, wait_seconds * 1000)
                            }
                            on_heartbeat()
                        }
                    }

                    if (!res.ok)
                        throw new Error('Request returned not ok status:', res.status)

                    if (res.bodyUsed)
                        // TODO: check if this needs a return
                        throw new Error('This response\'s body has already been read', res)

                    // Parse the streamed response
                    handle_fetch_stream(
                        res.body,

                        // Each time something happens, we'll either get a new
                        // version back, or an error.
                        async (result, err) => {
                            if (!err) {
                                // check whether we aborted
                                if (original_signal?.aborted) throw create_abort_error('already aborted')

                                // Yay!  We got a new version!  Tell the callback!
                                cb_running = true
                                await cb(result)
                                cb_running = false
                            } else
                                // This error handling code runs if the connection
                                // closes, or if there is unparseable stuff in the
                                // streamed response.
                                on_error(err)
                        },
                        (...args) => {
                            on_heartbeat()
                            params.onBytes?.(...args)
                        }
                    )
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

                if (params.retry) {
                    let give_up = res.status >= 400 && res.status < 600
                    switch (res.status) {
                        case 408: // Request Timeout
                        case 425: // Too Early
                        case 429: // Too Many Requests

                        case 502: // Bad Gateway
                        case 504: // Gateway Timeout
                            give_up = false
                    }
                    if (give_up) {
                        let e = new Error(`giving up because of http status: ${res.status}${(res.status === 401 || res.status === 403) ? ` (access denied)` : ''}`)
                        subscription_error?.(e)
                        return fail(e)
                    }
                    if (!res.ok) throw new Error(`status not ok: ${res.status}`)
                }

                if (subscription_cb) start_subscription(subscription_cb, subscription_error)

                done(res)

                params?.retry?.onRes?.(res)
                waitTime = 1
            } catch (e) { on_error(e) }
        }
    })
}

// Parse a stream of versions from the incoming bytes
async function handle_fetch_stream (stream, cb, on_bytes) {
    // Set up a reader
    var reader = stream.getReader(),
        parser = subscription_parser(cb)
    
    while (true) {
        var versions = []

        // Read the next chunk of stream!
        try {
            var {done, value} = await reader.read()
        }
        catch (e) {
            await cb(null, e)
            return
        }

        // Check if this connection has been closed!
        if (done) {
            console.debug("Connection closed.")
            await cb(null, 'Connection closed')
            return
        }

        on_bytes?.(value)

        // Tell the parser to process some more stream
        await parser.read(value)
        if (parser.state.result === 'error')
            return await cb(null, new Error(parser.state.message))
    }
}



// ****************************
// Braid-HTTP Subscription Parser
// ****************************

var subscription_parser = (cb) => ({
    // A parser keeps some parse state
    state: {input: []},

    // And reports back new versions as soon as they are ready
    cb: cb,

    // You give it new input information as soon as you get it, and it will
    // report back with new versions as soon as it finds them.
    async read (input) {

        // Store the new input!
        for (let x of input) this.state.input.push(x)

        // Now loop through the input and parse until we hit a dead end
        while (this.state.input.length) {

            // Try to parse an update
            try {
                this.state = parse_update (this.state)
            } catch (e) {
                await this.cb(null, e)
                return
            }

            // Maybe we parsed an update!  That's cool!
            if (this.state.result === 'success') {
                var update = {
                    version: this.state.version,
                    parents: this.state.parents,
                    body:    this.state.body,
                    patches: this.state.patches,
                    status:  this.state.status,

                    // Output extra_headers if there are some
                    extra_headers: extra_headers(this.state.headers)
                }
                for (var k in update)
                    if (update[k] === undefined) delete update[k]

                Object.defineProperty(update, 'body_text', {
                    get: function () {
                        if (this.body != null) return new TextDecoder('utf-8').decode(this.body.buffer)
                    }
                })

                for (let p of update.patches ?? []) {
                    Object.defineProperty(p, 'content_text', {
                        get: () => new TextDecoder('utf-8').decode(p.content)
                    })
                }

                // Reset the parser for the next version!
                this.state = {input: this.state.input}

                try {
                    await this.cb(update)
                } catch (e) {
                    await this.cb(null, e)
                    return
                }
            }

            // Or maybe there's an error to report upstream
            else if (this.state.result === 'error') {
                await this.cb(null, this.state.message)
                return
            }

            // We stop once we've run out of parseable input.
            if (this.state.result == 'waiting') break
        }
    }
})


// ****************************
// General parsing functions
// ****************************
//
// Each of these functions takes parsing state as input, mutates the state,
// and returns the new state.
//
// Depending on the parse result, each parse function returns:
//
//  parse_<thing> (state)
//  => {result: 'waiting', ...}  If it parsed part of an item, but neeeds more input
//  => {result: 'success', ...}  If it parses an entire item
//  => {result: 'error', ...}    If there is a syntax error in the input


function parse_update (state) {
    // If we don't have headers yet, let's try to parse some
    if (!state.headers) {
        var parsed = parse_headers(state.input)

        // If header-parsing fails, send the error upstream
        if (parsed.result === 'error')
            return parsed
        if (parsed.result === 'waiting') {
            state.result = 'waiting'
            return state
        }

        state.headers = parsed.headers
        state.version = state.headers.version
        state.parents = state.headers.parents
        state.status  = state.headers[':status']

        // Take the parsed headers out of the buffer
        state.input = parsed.input
    }

    // We have headers now!  Try parsing more body.
    return parse_body(state)
}

// Parsing helpers
function parse_headers (input) {

    // Find the start of the headers
    var start = 0
    while (input[start] === 13 || input[start] === 10) start++
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
    headers_source = Array.isArray(headers_source) ? headers_source.map(x => String.fromCharCode(x)).join('') : new TextDecoder().decode(headers_source)

    // Convert "HTTP 200 OK" to a :status: 200 header
    headers_source = headers_source.replace(/^HTTP\/?\d*\.?\d* (\d\d\d).*\r?\n/,
                                            ':status: $1\r\n')

    var headers_length = headers_source.length
    
    // Let's parse them!  First define some variables:
    var headers = {},
        header_regex = /(:?[\w-_]+):\s?(.*)[\r\n]*/gy,  // Parses one line a time
        match,
        found_last_match = false

    // And now loop through the block, matching one line at a time
    while (match = header_regex.exec(headers_source)) {
        // console.log('Header match:', match && [match[1], match[2]])
        headers[match[1].toLowerCase()] = match[2]

        // This might be the last line of the headers block!
        if (header_regex.lastIndex === headers_length)
            found_last_match = true
    }

    // If the regex failed before we got to the end of the block, throw error:
    if (!found_last_match)
        return {
            result: 'error',
            message: 'Parse error in headers: "'
                + JSON.stringify(headers_source.substr(header_regex.lastIndex)) + '"',
            headers_so_far: headers,
            last_index: header_regex.lastIndex, headers_length
        }

    // Success!  Let's parse special headers
    if ('version' in headers)
        headers.version = JSON.parse('['+headers.version+']')
    if ('parents' in headers)
        headers.parents = JSON.parse('['+headers.parents+']')
    if ('patches' in headers)
        headers.patches = JSON.parse(headers.patches)

    // Update the input
    input = input.slice(end)

    // And return the parsed result
    return { result: 'success', headers, input }
}

// Content-range is of the form '<unit> <range>' e.g. 'json .index'
function parse_content_range (range_string) {
    var match = range_string.match(/(\S+)( (.*))?/)
    return match && {unit: match[1], range: match[3] || ''}
}
function parse_body (state) {

    // Parse Body Snapshot

    var content_length = parseInt(state.headers['content-length'])
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
                return {
                    result: 'error',
                    message: 'cannot parse content-range',
                    range: state.headers['content-range']
                }
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

    else if (state.headers.patches != null) {
        state.patches = state.patches || []

        var last_patch = state.patches[state.patches.length-1]

        // Parse patches until the final patch has its content filled
        while (!(state.patches.length === state.headers.patches
                 && (state.patches.length === 0 || 'content' in last_patch))) {

            // Are we starting a new patch?
            if (!last_patch || 'content' in last_patch) {
                last_patch = {}
                state.patches.push(last_patch)
            }

            // Parse patch headers
            if (!('headers' in last_patch)) {
                var parsed = parse_headers(state.input)

                // If header-parsing fails, send the error upstream
                if (parsed.result === 'error')
                    return parsed
                if (parsed.result === 'waiting') {
                    state.result = 'waiting'
                    return state
                }

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
                    return {
                        result: 'error',
                        message: 'no content-length in patch',
                        patch: last_patch, input: to_text(state.input)
                    }

                if (!('content-range' in last_patch.headers))
                    return {
                        result: 'error',
                        message: 'no content-range in patch',
                        patch: last_patch, input: to_text(state.input)
                    }

                var content_length = parseInt(last_patch.headers['content-length'])

                // Does input have the entire patch contents yet?
                if (state.input.length < content_length) {
                    state.result = 'waiting'
                    return state
                }

                var match = parse_content_range(last_patch.headers['content-range'])
                if (!match)
                    return {
                        result: 'error',
                        message: 'cannot parse content-range in patch',
                        patch: last_patch, input: to_text(state.input)
                    }

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

    return {
        result: 'error',
        message: 'cannot parse body without content-length or patches header'
    }
}

// multiplex_fetch provides a fetch-like experience for HTTP requests
// where the result is actually being sent over a separate multiplexed connection.
//
// This function assumes a header in params called 'multiplexer' with a value
// that looks like /multiplexer_id/stream_id. It creates a multiplexer if it
// doesn't exist already, then performs a fetch providing the multiplexer header.
// This tells the server to send the results to the given multiplexer.
//
async function multiplex_fetch(url, params) {
    var origin = new URL(url, typeof document !== 'undefined' ? document.baseURI : undefined).origin

    // the mux_key is the same as the origin, unless it is being overriden
    // (the overriding is done by the tests)
    var mux_key = params.headers.get('multiplexer')?.split('/')[1] ?? origin

    // create a new multiplexer if it doesn't exist for this origin
    if (!multiplex_fetch.multiplexers) multiplex_fetch.multiplexers = {}
    if (!multiplex_fetch.multiplexers[mux_key]) multiplex_fetch.multiplexers[mux_key] = (async () => {
        // make up a new multiplexer id (unless it is being overriden)
        var multiplexer = params.headers.get('multiplexer')?.split('/')[1] ?? Math.random().toString(36).slice(2)

        var streams = new Map()
        var mux_error = null
        var using_multiplex_header = false

        var mux_promise = (async () => {
            // attempt to establish a multiplexed connection
            try {
                if (params.use_multiplex_header) throw 'skip to trying header'
                var r = await braid_fetch(`${origin}/${multiplexer}`, {method: 'MULTIPLEX', retry: true})
            } catch (e) {
                // some servers don't like custom methods,
                // so let's try with a custom header
                try {
                    using_multiplex_header = true
                    r = await braid_fetch(`${origin}/${multiplexer}`, {headers: {MULTIPLEX: true}, retry: true})
                } catch (e) {
                    // fallback to normal fetch if multiplexed connection fails
                    console.error(`Could not establish multiplexed connection.\nGot error: ${e}.\nFalling back to normal connection.`)
                    return false
                }
            }

            // parse the multiplexed stream,
            // and send messages to the appropriate streams
            parse_multiplex_stream(r.body.getReader(), (stream, bytes) => {
                streams.get(stream)?.(bytes)
            }, e => {
                // the multiplexer stream has died.. let everyone know..
                mux_error = e
                for (var f of streams.values()) f()
                delete multiplex_fetch.multiplexers[mux_key]
            })
        })()

        // return a "fetch" for this multiplexer
        return async (url, params) => {
            // maybe wait for multiplexer to be connected..
            if (!params.experimental_do_not_wait_for_multiplexer) {
                if ((await mux_promise) === false) {
                    // it failed to connect the multiplexer,
                    // so fallback to normal fetch
                    return await normal_fetch(url, params)
                }
            }

            // make up a new stream id (unless it is being overriden)
            var stream = params.headers.get('multiplexer')?.split('/')[2] ?? Math.random().toString(36).slice(2)

            // add the multiplexer header without affecting the underlying params
            var mux_headers = new Headers(params.headers)
            mux_headers.set('multiplexer', `/${multiplexer}/${stream}`)
            params = {...params, headers: mux_headers}

            // setup a way to receive incoming data from the multiplexer
            var buffers = []
            var bytes_available = () => {}
            var stream_error = null

            // this utility calls the callback whenever new data is available to process
            async function process_buffers(cb) {
                while (true) {
                    // wait for data if none is available
                    if (!mux_error && !stream_error && !buffers.length)
                        await new Promise(done => bytes_available = done)
                    if (mux_error || stream_error) throw (mux_error || stream_error)

                    // process the data
                    let ret = cb()
                    if (ret) return ret
                }
            }

            // tell the multiplexer to send bytes for this stream to us
            streams.set(stream, bytes => {
                if (!bytes) {
                    streams.delete(stream)
                    buffers.push(bytes)
                } else if (!mux_error) buffers.push(bytes)
                bytes_available()
            })

            // prepare a function that we'll call to cleanly tear things down
            var unset = async e => {
                unset = () => {}
                streams.delete(stream)
                stream_error = e
                bytes_available()
                try {
                    await braid_fetch(`${origin}${params.headers.get('multiplexer')}`, {...using_multiplex_header ? {headers: {MULTIPLEX: true}} : {method: 'MULTIPLEX'}, retry: true})
                } catch (e) {
                    console.error(`Could not cancel multiplexed connection:`, e)
                    throw e
                }
            }

            // do the underlying fetch
            try {
                var res = await normal_fetch(url, params)

                if (params.experimental_do_not_wait_for_multiplexer &&
                    res.status === 422 &&
                    !(await promise_done(mux_promise))) {
                    // this error will trigger a retry if the user is using that
                    throw new Error('multiplexer not yet connected')
                }

                if (res.status !== 293) throw new Error('Could not establish multiplexed stream ' + params.headers.get('multiplexer') + ' got status: ' + res.status)

                // we want to present the illusion that the connection is still open,
                // and therefor closable with "abort",
                // so we handle the abort ourselves to close the multiplexed stream
                params.signal?.addEventListener('abort', () =>
                    unset(create_abort_error('stream aborted')))

                // first, we need to listen for the headers..
                var headers_buffer = new Uint8Array()
                var parsed_headers = await process_buffers(() => {
                    // check if the stream has been closed
                    var stream_ended = !buffers[buffers.length - 1]
                    if (stream_ended) buffers.pop()

                    // aggregate all the new buffers into our big headers_buffer
                    headers_buffer = concat_buffers([headers_buffer, ...buffers])
                    buffers = []

                    // and if the stream had ended, put that information back
                    if (stream_ended) buffers.push(null)

                    // try parsing what we got so far as headers..
                    var x = parse_headers(headers_buffer)

                    // how did it go?
                    if (x.result === 'error') {
                        // if we got an error, give up
                        console.log(`headers_buffer: ` + new TextDecoder().decode(headers_buffer))
                        throw new Error('error parsing headers')
                    } else if (x.result === 'waiting') {
                        if (stream_ended) throw new Error('Multiplexed stream ended before headers received.')
                    } else return x
                })

                // put the bytes left over from the header back
                if (parsed_headers.input.length) buffers.unshift(parsed_headers.input)

                // these headers will also have the status,
                // but we want to present the status in a more usual way below
                var status = parsed_headers.headers[':status']
                delete parsed_headers.headers[':status']

                // create our own fake response object,
                // to mimik fetch's response object,
                // feeding the user our stream data from the multiplexer
                var res = new Response(new ReadableStream({
                    async start(controller) {
                        try {
                            await process_buffers(() => {
                                var b = buffers.shift()
                                if (!b) return true
                                controller.enqueue(b)
                            })
                        } finally { controller.close() }
                    }
                }), {
                    status,
                    headers: parsed_headers.headers
                })

                // add a convenience property for the user to know if
                // this response is being multiplexed
                res.multiplexer = params.headers.get('multiplexer')

                // return the fake response object
                return res
            } catch (e) {
                // if we had an error, be sure to unregister ourselves
                await unset(e)
                throw e
            }
        }
    })()

    // call the special fetch function for the multiplexer
    return await (await multiplex_fetch.multiplexers[mux_key])(url, params)
}

// waits on reader for chunks like: 123 bytes for stream ABC\r\n..123 bytes..
// which would trigger cb("ABC", bytes)
async function parse_multiplex_stream(reader, cb, on_error) {
    try {
        var buffers = [new Uint8Array(0)]
        var buffers_size = 0
        var chunk_size = null
        var stream_id = null
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
                        var headerStr = new TextDecoder().decode(buffers[0].slice(0, header_length))
                        var m = headerStr.match(/^[\r\n]*((\d+) bytes for|close) stream ([A-Za-z0-9_-]+)\r\n$/)
                        if (!m) throw new Error('invalid multiplex header')
                        stream_id = m[3]

                        buffers[0] = buffers[0].slice(header_length)
                        buffers_size -= header_length

                        if (m[1] === 'close') {
                            cb(stream_id)
                            break
                        } else chunk_size = 1 * m[2]
                    } else break
                } else if (chunk_size !== null && buffers_size >= chunk_size) {
                    if (buffers.length > 1) buffers = [concat_buffers(buffers)]

                    var chunk = buffers[0].slice(0, chunk_size)
                    buffers[0] = buffers[0].slice(chunk_size)
                    buffers_size -= chunk_size

                    // console.log(`stream_id: ${stream_id}, ${new TextDecoder().decode(chunk)}`)

                    cb(stream_id, chunk)

                    chunk_size = null
                    stream_id = null
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
    var known_headers = ['version', 'parents', 'patches',
                         'content-length', 'content-range', ':status']
    for (var i = 0; i < known_headers.length; i++)
        delete result[known_headers[i]]

    // Return undefined if we deleted them all
    if (Object.keys(result).length === 0)
        return undefined

    return result
}

function get_binary_length(x) {
    return  x instanceof ArrayBuffer ? x.byteLength :
            x instanceof Uint8Array ? x.length :
            x instanceof Blob ? x.size : undefined
}

function deep_copy(x) {
    if (x === null || typeof x !== 'object') return x
    if (Array.isArray(x)) return x.map(x => deep_copy(x))
    if (Object.prototype.toString.call(x) === '[object Object]')
        return Object.fromEntries(Object.entries(x).map(([k, x]) => [k, deep_copy(x)]))
    return x
}

function ascii_ify(s) {
    return s.replace(/[^\x20-\x7E]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function create_abort_error(msg) {
    var e = new Error(msg)
    e.name = 'AbortError'
    return e
}

async function promise_done(promise) {
    var pending = {}
    var ret = await Promise.race([promise, Promise.resolve(pending)])
    return ret !== pending
}

// ****************************
// Exports
// ****************************

if (typeof module !== 'undefined' && module.exports)
    module.exports = {
        fetch: braid_fetch,
        http: braidify_http,
        subscription_parser,
        parse_update,
        parse_headers,
        parse_body
    }
