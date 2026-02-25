
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
    normal_fetch = typeof fetch !== 'undefined' && fetch
    braid_fetch.enable_multiplex = false
} else {
    // Web Browser
    normal_fetch = window.fetch
    AbortController = window.AbortController
    Headers = window.Headers
    // window.fetch = braid_fetch
}

braid_fetch.set_fetch = f => normal_fetch = f

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
        params.headers.set('heartbeats',
                           typeof params.heartbeats === 'number'
                           ? `${params.heartbeats}s`
                           : params.heartbeats)

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

                // Notify subscription went offline
                if (params.onSubscriptionStatus && subscription_online) {
                    subscription_online = false
                    params.onSubscriptionStatus({online: false, error: e})
                }

                // see if we should retry..
                var retry = params.retry &&    // only try to reconnect if the user has chosen to
                    e.name !== "AbortError" && // don't retry if the user has chosen to abort
                    !e.dont_retry              // some errors are unlikely to be fixed by retrying

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
                    if (retry && original_signal?.aborted) e = create_error('already aborted', {name: 'AbortError'})

                    // let people know things are shutting down..
                    subscription_counts_on_close?.()
                    subscription_error?.(e)
                    return fail(e)
                }
            }

            try {
                if (original_signal?.aborted) throw create_error('already aborted', {name: 'AbortError'})

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
                params.onFetch?.(url, params, underlying_aborter)

                // Now we run the original fetch....

                // try multiplexing if the multiplex flag is set, and conditions are met
                var mux_params = params.multiplex ?? braid_fetch.enable_multiplex
                if (mux_params !== false &&
                    (params.headers.has('multiplex-through') ||
                    (params.headers.has('subscribe') &&
                        braid_fetch.subscription_counts?.[origin] >
                            (!mux_params ? 1 : (mux_params.after ?? 0))))) {
                    res = await multiplex_fetch(url, params, mux_params)
                } else
                    res = await normal_fetch(url, params)

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
                                params.heartbeat_cb?.()
                                clearTimeout(timeout)
                                let wait_seconds = 1.2 * heartbeats + 3
                                timeout = setTimeout(() => {
                                    on_error(new Error(`heartbeat not seen in ${wait_seconds.toFixed(2)}s`))
                                }, wait_seconds * 1000)
                            }
                            on_heartbeat()
                        }
                    }

                    if (res.status !== 209) {
                        throw new Error(`Got unexpected subscription status code: ${res.status}. Expected 209.`)
                    }

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
                                if (original_signal?.aborted)
                                    throw create_error('already aborted', {name: 'AbortError'})

                                // Yay!  We got a new version!  Tell the callback!
                                try {
                                    await cb(result)
                                } catch (e) {
                                    // This error is happening in the users code,
                                    // so retrying the connection
                                    // will probably still fail
                                    e.dont_retry = true
                                    throw e
                                }
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
                        if (params.onSubscriptionStatus && subscription_online) {
                            subscription_online = false
                            params.onSubscriptionStatus({online: false, error: new Error(`giving up because of http status: ${res.status}`)})
                        }
                        if (subscription_cb) subscription_error?.(new Error(`giving up because of http status: ${res.status}${(res.status === 401 || res.status === 403) ? ` (access denied)` : ''}`))
                    } else if (!res.ok) throw new Error(`status not ok: ${res.status}`)
                }

                if (subscription_cb && res.ok) start_subscription(subscription_cb, subscription_error)

                if (params.subscribe && params.onSubscriptionStatus && res.ok) {
                    subscription_online = true
                    params.onSubscriptionStatus({online: true})
                }

                params?.retry?.onRes?.(res)
                retry_count = 0

                // parse version if it exists
                var version_header = res.headers.get('version') || res.headers.get('current-version')
                if (version_header)
                    try { res.version = JSON.parse('[' + version_header + ']') } catch (e) { console.log('error parsing version: ' + version_header) }

                done(res)
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

                var body_text_cache = null
                Object.defineProperty(update, 'body_text', {
                    get: function () {
                        if (body_text_cache !== null) return body_text_cache
                        return body_text_cache = this.body != null ?
                            new TextDecoder('utf-8').decode(this.body.buffer) : undefined
                    }
                })

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
                await this.cb(null, create_error(this.state.message, {dont_retry: true}))
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
        var parsed = parse_headers(state.input, true)

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
function parse_headers (input, check_for_encoding_blocks, dont_parse_special_headers) {

    // Find the start of the headers
    var start = 0
    while (input[start] === 13 || input[start] === 10) start++
    if (start === input.length) return {result: 'waiting'}

    // Check for an "Encoding" block like this:
    //
    //   Encoding: dt
    //   Length: 411813
    //   <binary dt file>
    //
    // Such a block will start with an "e", not an "h"
    if (check_for_encoding_blocks &&
        (input[start] === 101 || input[start] === 69)) {

        // Look for two newlines
        var end = start
        var count = 0
        while (++end) {
            if (end > input.length) return {result: 'waiting'}
            if (input[end - 1] === 10) count++
            if (count === 2) break
        }

        // Extract the header string
        var headers_source = input.slice(start, end).map(x => String.fromCharCode(x)).join('')

        // Parse
        var m = headers_source.match(/Encoding:\s*(\w+)\r?\nLength:\s*(\d+)\r?\n/i)
        if (!m) return {
            result: 'error',
            message: `Parse error in encoding block: ${JSON.stringify(headers_source)}`
        }
        var headers = {
            encoding: m[1],
            length: m[2]
        }

        // Update the input
        input = input.slice(end)

        // And return the parsed result
        return { result: 'success', headers, input }
    }

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
    if (!dont_parse_special_headers) {
        if ('version' in headers)
            headers.version = JSON.parse('['+headers.version+']')
        if ('parents' in headers)
            headers.parents = JSON.parse('['+headers.parents+']')
        if ('patches' in headers)
            headers.patches = JSON.parse(headers.patches)
    }

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

    var content_length = parseInt(state.headers['content-length'] ??
        (state.headers.patches === undefined && state.headers['length']))
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
    if (x.constructor === Object)
        return Object.fromEntries(Object.entries(x).map(([k, x]) => [k, deep_copy(x)]))
    return x
}

function ascii_ify(s) {
    return s.replace(/[^\x20-\x7E]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function create_error(msg, override) {
    var e = new Error(msg)
    if (override) Object.assign(e, override)
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


// ****************************
// Multiplexing
// ****************************

// multiplex_fetch provides a fetch-like experience for HTTP requests
// where the result is actually being sent over a separate multiplexed connection.
async function multiplex_fetch(url, params, mux_params) {
    var origin = new URL(url, typeof document !== 'undefined' ? document.baseURI : undefined).origin

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

// returns a function with a fetch-like interface that transparently multiplexes the fetch
async function create_multiplexer(origin, mux_key, params, mux_params, attempt) {
    var multiplex_version = '1.0'

    // make up a new multiplexer id (unless it is being overriden)
    var multiplexer = (attempt === 1 &&
        params.headers.get('multiplex-through')?.split('/')[3])
        || random_base64url(Math.ceil((mux_params?.id_bits ?? 72) / 6))

    var requests = new Map()
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

                var r = await braid_fetch(`${origin}/.well-known/multiplexer/${multiplexer}/${request}`, {
                    method: 'DELETE',
                    headers: { 'Multiplex-Version': multiplex_version },
                    retry: true
                })

                // if we know the multiplexer was created,
                // but it isn't there now,
                // and our client doesn't realize it,
                // then shut it down ourselves
                if (r.status === 404 && r.headers.get('Bad-Multiplexer')
                    && mux_was_done && !mux_error) {
                    cleanup_multiplexer(new Error('multiplexer detected to be closed'))
                }

                if (!r.ok) throw new Error('status not ok: ' + r.status)
                if (r.headers.get('Multiplex-Version') !== multiplex_version)
                    throw new Error('wrong multiplex version: '
                                    + r.headers.get('Multiplex-Version')
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
        // attempt to establish a multiplexed connection
        try {
            // Disable MULTIPLEX method for now — go straight to POST
            if (true || mux_params?.via === 'POST'
                || multiplex_fetch.post_only?.has(origin)) throw 'skip multiplex method'
            var r = await braid_fetch(`${origin}/${multiplexer}`, {
                signal: mux_aborter.signal,
                method: 'MULTIPLEX',
                headers: {'Multiplex-Version': multiplex_version},
                retry: true,
                multiplex: false
            })
            if (r.status === 409) {
                var e = await r.json()
                if (e.error === 'Multiplexer already exists')
                    return cleanup_multiplexer('retry')
            }
            if (!r.ok || r.headers.get('Multiplex-Version') !== multiplex_version)
                throw 'bad'
        } catch (e) {
            // some servers don't like custom methods,
            // so let's try with a well-known url;
            // remember this so we skip MULTIPLEX next time
            ;(multiplex_fetch.post_only ||= new Set()).add(origin)
            try {
                r = await braid_fetch(`${origin}/.well-known/multiplexer/${multiplexer}`,
                                        {method: 'POST',
                                        signal: mux_aborter.signal,
                                        headers: {'Multiplex-Version': multiplex_version},
                                        retry: true,
                                        multiplex: false})
                if (r.status === 409) {
                    var e = await r.json()
                    if (e.error === 'Multiplexer already exists')
                        return cleanup_multiplexer('retry')
                }
                if (!r.ok) throw new Error('status not ok: ' + r.status)
                if (r.headers.get('Multiplex-Version') !== multiplex_version)
                    throw new Error('wrong multiplex version: '
                                    + r.headers.get('Multiplex-Version')
                                    + ', expected ' + multiplex_version)
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
        parse_multiplex_stream(r.body.getReader(), async (request, bytes) => {
            if (requests.has(request)) requests.get(request)(bytes)
            else try_deleting_request(request).catch(e => {})
        }, e => cleanup_multiplexer(e))
    })()

    // return a "fetch" for this multiplexer
    var f = async (url, params, mux_params, attempt) => {

        // if we already know the multiplexer is not working,
        // then fallback to normal fetch
        if ((await promise_done(mux_created_promise)) && (await mux_created_promise) === false) {
            // if the user is specifically asking for multiplexing,
            // throw an error instead
            if (params.headers.get('multiplex-through')) throw new Error('multiplexer failed')

            return await normal_fetch(url, params)
        }

        // make up a new request id (unless it is being overriden)
        var request = (attempt === 1
            && params.headers.get('multiplex-through')?.split('/')[4])
            || random_base64url(Math.ceil((mux_params?.id_bits ?? 72) / 6))
        
        // make sure this request id is not already in use
        if (requests.has(request)) throw "retry"

        // add the Multiplex-Through header without affecting the underlying params
        var mux_headers = new Headers(params.headers)
        mux_headers.set('Multiplex-Through', `/.well-known/multiplexer/${multiplexer}/${request}`)
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
        requests.set(request, bytes => {
            if (!bytes) buffers.push(bytes)
            else if (!mux_error) buffers.push(bytes)
            bytes_available()
        })

        // prepare a function that we'll call to cleanly tear things down
        clearTimeout(not_used_timeout)
        var unset = async e => {
            unset = () => {}
            requests.delete(request)
            if (!requests.size) not_used_timeout = setTimeout(() => mux_aborter.abort(), mux_params?.not_used_timeout ?? 1000 * 20)
            request_error = e
            bytes_available()
            if (e !== 'retry' && established) await try_deleting_request(request).catch(e => {})
        }

        // do the underlying fetch
        try {
            if (attempt > 1) await mux_created_promise

            var mux_was_done = await promise_done(mux_created_promise)

            // callback for testing
            mux_params?.onFetch?.(url, params)

            var res = await normal_fetch(url, params)

            // The server received our request — if we need to tear it
            // down later, send a DELETE. (Skip for network errors, where
            // normal_fetch throws and we never reach here.)
            established = true

            if (res.status === 409) {
                var e = await res.json()
                if (e.error === 'Request already multiplexed') {
                    // the id is already in use,
                    // so we want to retry right away with a different id
                    throw "retry"
                }
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

            // if the response says it's ok,
            // but it's is not a multiplexed response,
            // fall back to as if it was a normal fetch
            if (res.ok && res.status !== 293) return res

            if (res.status !== 293)
                throw create_error('Could not establish multiplexed request '
                                    + params.headers.get('multiplex-through')
                                    + ', got status: ' + res.status,
                                    { dont_retry: true })

            if (res.headers.get('Multiplex-Version') !== multiplex_version)
                throw create_error('Could not establish multiplexed request '
                                    + params.headers.get('multiplex-through')
                                    + ', got unknown version: '
                                    + res.headers.get('Multiplex-Version'),
                                    { dont_retry: true })

            // we want to present the illusion that the connection is still open,
            // and therefor closable with "abort",
            // so we handle the abort ourselves to close the multiplexed request
            params.signal.addEventListener('abort', () =>
                unset(create_error('request aborted', {name: 'AbortError'})))

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
                var x = parse_headers(headers_buffer, false, true)

                // how did it go?
                if (x.result === 'error') {
                    // if we got an error, give up
                    // console.log(`headers_buffer: ` + new TextDecoder().decode(headers_buffer))
                    throw new Error('error parsing headers')
                } else if (x.result === 'waiting') {
                    if (request_ended)
                        throw new Error('Multiplexed request ended before headers received.')
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
    f.cleanup = () => cleanup_multiplexer(new Error('manual cleanup'))
    return f
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
                        var headerStr = new TextDecoder().decode(buffers[0].slice(0, header_length))
                        var m = headerStr.match(/^[\r\n]*((\d+) bytes for|close|start) response ([A-Za-z0-9_-]+)\r\n$/)

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


// ****************************
// Exports
// ****************************

if (typeof module !== 'undefined' && module.exports)
    module.exports = {
        fetch: braid_fetch,
        multiplex_fetch,
        http: braidify_http,
        subscription_parser,
        parse_update,
        parse_headers,
        parse_body
    }
