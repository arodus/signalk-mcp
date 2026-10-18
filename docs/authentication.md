# Signal K authentication compatibility

Scope: the read-only gateway's existing-token authentication and authorization bridge. This does not certify production providers, vessel deployments or every Signal K release.

## Supported releases

The compatibility set is **Signal K 2.32.0 and 2.33.0**, on Node 22 and 24. CI runs the complete suite for each of the four combinations, including the TypeScript and Python MCP clients. The main development dependency remains pinned to 2.33.0; the older runtime and its matching `@signalk/server-api` package are installed separately and do not replace the project lockfile. Other dependencies resolve using npm normally; this is not a reconstruction of a historical frozen dependency tree.

The integration test prints the actual server version and asserts `MCP_TEST_SERVER_VERSION` when supplied. This prevents a matrix job from silently testing the default dependency instead of its requested release. Tests exercise native plugin loading, routing and token/ACL decisions; mocks are used only for focused invalid-contract cases.

Older releases, prereleases and untested future releases are not declared supported. Detecting the expected hooks is necessary but does not establish version compatibility. Expand this set only after reviewing the source and passing the real-server tests.

## Current bridge

`src/auth.ts` is the only production module that accesses `securityStrategy`. It requires the tested synchronous contract:

- `isDummy()` must return the boolean `false`; missing, disabled or unknown security state is rejected.
- `authorizeWS()` authenticates a fresh object containing only the supplied bearer header. Cookies, query tokens and a principal previously attached by HTTP middleware are not reused.
- Authentication must explicitly set `skIsAuthenticated` to `true` and provide a nonempty string identifier with a known `readonly`, `readwrite` or `admin` permission. Anonymous `AUTO` identities are rejected.
- Principal snapshots contain only identifier and permission; they do not copy arbitrary private fields from the native object.
- `checkACL(identifier, context, path, source, 'read')` must return the boolean `true` to expose a measurement. Truthy objects, strings and promises do not grant access.

`anyACLs()` is an additional version-sensitive hook used only for history queries without a source filter. It must return literal `false`, alongside a native read grant, to allow such a query. Missing hooks, unknown results and configured ACLs fail closed for unfiltered reads. The gateway never reads security configuration or assumes that an admin or wildcard-source check bypasses source rules. Both tested releases exercise this hook and ACL insertion while a request is pending.

Every invocation resolves identity again. History rechecks the requested paths/sources after the provider responds. Generic provider responses revalidate the native principal and any gateway admin requirement before return; arbitrary provider JSON still depends on the provider's own data-level authorization, as described in the capability design.

Native integration tests cover user and device tokens, removal of each identity type, unknown permission levels, concurrent callers, conflicting cookies, source/path denials, and changes while asynchronous responses are pending. The gateway does not mint credentials, read the server signing key, cache identities across invocations, or substitute a privileged principal. Test credentials are disposable fixtures, not operational accounts.

## Public API assessment

Source review on 2026-10-18 covered the published `@signalk/server-api` declarations used by releases 2.32.0 and 2.33.0 and current upstream commit [`340d5bb`](https://github.com/SignalK/signalk-server/tree/340d5bb62c17ec58d2a3497dbbf081cd87af2a96).

- [`PluginRouter.access`](https://github.com/SignalK/signalk-server/blob/340d5bb62c17ec58d2a3497dbbf081cd87af2a96/packages/server-api/src/plugin.ts) classifies native HTTP routes. It does not provide a public per-invocation bearer verifier or telemetry ACL evaluator.
- [`ServerAPI`](https://github.com/SignalK/signalk-server/blob/340d5bb62c17ec58d2a3497dbbf081cd87af2a96/packages/server-api/src/serverapi.ts) exposes data getters and feature discovery, but no equivalent public authentication/read-authorization bridge was found. Data getters do not accept an authenticated read context.
- [`tokensecurity.ts`](https://github.com/SignalK/signalk-server/blob/340d5bb62c17ec58d2a3497dbbf081cd87af2a96/src/tokensecurity.ts) supplies the internal hooks used here. The exact release runtime is tested separately; master source inspection alone is not release evidence.

No verified public replacement is available from this assessment. Keep the private dependency isolated and fail closed. A [local draft of the needed public contract](proposals/signalk-auth-api.md) records the integration gap; it has not been submitted upstream and is not an existing API.

## Reproduce against a separate runtime

Build the gateway, install the target server in a disposable directory, then point the native integration harness at that package. For example:

```sh
npm ci --ignore-scripts --omit=optional
npm install --prefix /tmp/signalk-mcp-server-2.32.0 --ignore-scripts --omit=optional signalk-server@2.32.0 @signalk/server-api@2.32.0
MCP_TEST_SERVER_DIR=/tmp/signalk-mcp-server-2.32.0/node_modules/signalk-server \
MCP_TEST_SERVER_VERSION=2.32.0 \
MCP_TEST_PYTHON=/tmp/signalk-mcp-python/bin/python \
npm run check
```

Run under the selected Node version. Create the Python environment using the README instructions first. Without `MCP_TEST_SERVER_DIR`, the harness uses the project's pinned server dependency. `MCP_TEST_PLUGIN_DIR` can independently select an installed gateway tarball; the server and plugin package selections are separate.
