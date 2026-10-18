# TLS and reverse-proxy hosting

The gateway uses the address, port and TLS state of the server socket that accepted the MCP request for all provider HTTP reads. It forwards the original bearer and an Accept header. Host, Origin, Forwarded, X-Forwarded-* and OpenAPI servers never select an outbound destination. Redirects are refused. Core telemetry reads do not make these HTTP calls.

## TLS at a reverse proxy

Terminate HTTPS at a trusted proxy and forward to Signal K's private HTTP TCP listener. Preserve the Authorization header and forward a fixed, expected Host; configure that exact Host (including its port, if present) in `allowedHosts`. Configure any required browser Origin explicitly in `allowedOrigins`; native clients can omit Origin. Signal K's CORS policy still applies.

For example, with public `https://boat.example` and Signal K bound behind the proxy at port 3000, a proxy location can use:

```nginx
location /plugins/signalk-mcp/mcp {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host boat.example;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
}
```

Set `allowedHosts` to `["boat.example"]`. Keep the backend private, serve the public site with a valid TLS certificate, and do not replace the caller's bearer with a shared proxy credential. A proxy must propagate disconnects so the gateway can cancel pending reads. This configuration illustrates the tested topology; the automated fixture uses Node HTTPS, not an installed nginx instance.

The gateway calls the private HTTP listener directly. `localTlsServerName` is unnecessary in this topology and has no effect on an unencrypted backend socket. Forwarding `X-Forwarded-Proto: https` does not turn the internal request into HTTPS.

## Native Signal K HTTPS

Signal K 2.32.0/2.33.0 use `ssl: true`, `sslport` for HTTPS and `port` for the separate HTTP redirect listener. Their native certificate files are `ssl-cert.pem` and `ssl-key.pem` in the Signal K configuration directory (plus an optional `ssl-chain.pem`); follow Signal K's file-permission requirements. The MCP request must reach the HTTPS listener directly, not its redirect listener.

Node must trust the certificate issuer. For a private CA, configure the Signal K process with `NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem` **before starting it**. The file contains CA certificates, not a server private key. Certificate verification remains enabled.

Without extra configuration, the certificate must cover the accepted socket's local IP address. A dual-stack listener can expose an IPv4-mapped IPv6 address such as `::ffff:127.0.0.1`; the gateway uses its equivalent IPv4 literal (`127.0.0.1`) for consistent certificate matching across Node/OpenSSL versions. For ordinary DNS certificates, add the certificate's DNS name to the gateway configuration:

```json
{
  "allowedHosts": ["boat.example:3443"],
  "allowedOrigins": [],
  "localTlsServerName": "boat.example",
  "pluginOperations": []
}
```

`localTlsServerName` supplies only TLS SNI and the certificate verification name. It is a DNS name without a scheme, port or wildcard. It never changes the network address or performs DNS routing. The issuer must still be trusted, and the certificate must match that name. The setting is server configuration, never a tool argument or incoming request header.

## Failure behavior and evidence

Untrusted issuers, name mismatches and unavailable local listeners return sanitized `UPSTREAM_UNAVAILABLE` errors for affected HTTP capabilities. Missing TCP address/port returns `LOCAL_HTTP_UNAVAILABLE`. The gateway does not retry another destination, follow redirects or disable verification. Non-TCP listeners remain unsupported; socket activation is usable only if the accepted socket provides a reachable local TCP address/port and has not been separately validated.

`test/hosting.test.cjs` generates an ephemeral private PKI and starts real Signal K instances in child processes. It checks TLS termination, trusted native IP and DNS certificates, missing/wrong verification names, and an untrusted issuer. Successful topologies exercise initialization, seven-tool listing, core telemetry, plugin discovery, plugin reads and standard History forwarding with the original Signal K identity. Tests also cover spoofed routing headers, Host/Origin rejection, unavailable listeners and upstream HTTP socket cancellation on client disconnect. Existing tests cover redirects, bounded responses and permission revocation.

The fixture is synthetic. Cancelling a provider HTTP socket does not establish cancellation of work already running in a provider's database or other backend. Test teardown explicitly exits child processes after assertions because upstream Signal K retains handles; whole-server lifecycle cleanup remains issue #7. No vessel or public endpoint is used.

Run on Node 22 or 24 after `npm run build`:

```sh
node --test --test-force-exit test/hosting.test.cjs
```

The test requires `openssl` on PATH. The normal CI matrix includes it for both supported Signal K versions.
