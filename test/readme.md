# Testing Braid-HTTP

Run all tests from the command line:

```
npm test
```

Run tests in a browser (auto-opens):

```
npm run test:browser
```

Filter tests by name:

```
node test/test.js --filter="version"
```

### Test the server by hand

Start the browser test server with `npm run test:browser`, then curl a subscription:

```
$ curl -vk -H Subscribe:true https://localhost:9000/json
```

You should see this:

```
*   Trying 127.0.0.1:9000...
* Connected to localhost (127.0.0.1) port 9000 (#0)
> GET /json HTTP/1.1
> Host: localhost:9000
> User-Agent: curl/7.79.1
> Accept: */*
> Subscribe:true
>
* Mark bundle as not supporting multiuse
< HTTP/1.1 209 unknown
< Range-Request-Allow-Methods: PATCH, PUT
< Range-Request-Allow-Units: json
< content-type: application/json
< subscribe: true
< cache-control: no-cache, no-transform
< X-Accel-Buffering: no
< Date: Wed, 29 May 2024 13:05:38 GMT
< Connection: keep-alive
< Keep-Alive: timeout=5
< Transfer-Encoding: chunked
<
Version: "test"
Parents: "oldie"
Content-Length: 16

{"this":"stuff"}
```
...and the connection should stay open until you hit `C-c`.

### Debugging Advice

If a test fails, it will show expected vs actual output; plug these into https://glittle.org/diff to see what's wrong.

You can capture a request in unix with `nc -l 9000 > test-request.txt` to listen to
port 9000 while your browser initiates a request, and then capture a response
with `nc localhost 9000 < test-request.txt` to read the request from disk and send
it to a server running on port 9000.
