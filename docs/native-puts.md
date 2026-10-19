# Individually approved native PUTs

This describes the issue #30 development extension. The published `0.1.0-alpha.1` remains read-only. Plugin POSTs are a separate follow-up and stay disabled.

## Discovery and meaning

`list_put_paths` accepts an explicit handler `source`, optional `prefix`, `offset` and `limit`. It lists path candidates advertising `supportsPut: true` whose native `put` ACL permits that source. It does not expose telemetry values, grant approval, enumerate handler sources or prove the requested source has a registered handler.

The native public metadata getter supports direct lookup but does not enumerate all runtime metadata-only targets. The gateway therefore combines model paths, bounded metadata path hints observed through the public delta-input hook, and successfully described paths. A metadata-only target advertised before the gateway starts may require an explicit `describe_put` first. Discovery is incomplete and is not a stable snapshot. The observer retains paths only, always forwards the original delta and never changes telemetry or metadata.

`describe_put` accepts `path` and an explicit `source`. It returns the target's native metadata and supplied value constraints, with schema status and a statement that native handler validation still applies. Units, names, descriptions, enums and other metadata retain their native meaning. Display scale and alarm zones do not become command limits. Missing schema information is reported; current values are not used to invent a type, range, or handler source.

Both tools require a native write-capable identity and exact-source `put` authorization. This does not grant access to current values; ordinary reads still need native read permission. Only `vessels.self` is supported. Metadata configuration paths are excluded.

## Review and execution

Call `put_value` with one `path`, explicit `source` and bounded JSON `value`. The native HTTP handler is called only after input validation, fresh native authentication, exact-source PUT authorization and a matching saved review. There is no automatic unit conversion, batch mutation or arbitrary HTTP route.

An eligible unapproved target returns `APPROVAL_PENDING` without dispatch and adds a row to **Operation requests** in native Plugin Config. Refresh the panel, inspect the exact path/source, metadata and value contract, choose **Accept** or **Reject**, and **Save Configuration**. Draft actions do not enable execution. The table shows **Read** or **Write**, with no role selector or extra PUT role policy. Native Signal K permissions determine who may run an approved operation: a PUT requires a write-capable identity and exact-source `put` ACL permission. A read-only identity cannot write. No role, metadata marker or plugin GET approval grants PUT access by itself. There is no all-PUT option.

Reviews bind exact context/path/source and canonicalized metadata/value contract. A different source, changed meaning or changed schema requires a new review. Saved rejection remains blocked. Provider upgrades still need implementation review even if metadata is unchanged. The shared queue has at most 64 GET and PUT entries; it stores review metadata, never submitted values or bearer tokens. Unsaved entries disappear on restart. Legacy GET keys/decisions remain compatible.

Delete a PUT review, confirm the removal and save to revoke it. Native PUT rows do not depend on plugin inventory, so revocation is possible while a provider remains installed. Existing GET-row deletion rules continue to apply. Native saves still lack atomic conditional writes; the panel checks for conflicting edits but cannot eliminate simultaneous-save races in the host API.

`execute_mutation` supports only `{ "id": "signalk.put", "operation": "put_value", "arguments": { ... } }` and shares `put_value`'s implementation. `execute_capability` refuses this mutation. Mutation tool annotations explicitly declare writes, potentially destructive effects, external effects and no idempotence guarantee. Client annotations are hints; server-side checks enforce the boundary.

## Native permission boundary

Native `put` ACL permission is different from telemetry `write`. Both `readwrite` and `admin` identities require the applicable PUT grant; there is no admin ACL bypass.

Signal K 2.32.0 and 2.33.0 dispatch HTTP PUTs after checking `shouldAllowPut` with a null source. This does not establish authorization for the source selected by the request body. The gateway separately requires a literal native ACL grant for the explicit source and keeps the native HTTP route's checks as well. Missing hooks and unknown results fail closed. Fixed-local requests carry only the original bearer identity, with certificate verification and redirects disabled. Public in-process PUT helpers are not used because they do not carry the authenticated request.

Checks occur immediately before submission and again when returning results or checking status. These are not an atomic transaction with another plugin's handler or with administrator configuration changes. A later permission change cannot cancel an action already accepted by the native server.

## Outcomes and request status

An accepted response contains `submitted: true`, `retrySafe: false`, an `outcome`, and a validated native request ID/reply when available. Native state and status codes are retained. `COMPLETED` with `statusCode: 502` is a completed failure, not success. No API response establishes physical operation.

`get_put_status` accepts only a native `requestId` known to this gateway. It reauthenticates the caller and rechecks ownership, exact target binding, current metadata, saved approval and native PUT permissions. Different tokens for the same native identity share that identity's access. Foreign, arbitrary, expired or lifecycle-cleared correlations remain unavailable, even though the native status endpoint itself does not enforce ownership.

Correlations are bounded to 128 entries and expire after one hour; plugin start/stop clears them. Capacity is reserved before submission. In-flight entries are never evicted to admit more writes. Unknown outcomes without a usable native ID also retain their reserved slot until expiry. Only owner/target/correlation metadata is retained, not command values or tokens.

Transport timeout, disconnect, invalid/oversized reply or authorization changes after submission can produce an explicit **unknown** outcome. Do not automatically submit the action again. Poll the validated original ID when available and still authorized; otherwise report that the result cannot be established. Disconnecting or aborting HTTP does not establish handler cancellation. Restart clears gateway correlation and cannot recover an unknown action by accepting arbitrary native IDs.

## Verification

Portable tests cover approval binding, schema/input validation, role/ACL checks, correlation bounds, expiry and truthful outcomes. Native integration uses disposable Signal K servers and synthetic PUT handlers, including metadata-only targets, actual native admin saves, source-specific denials, pending ownership, failure replies and lifecycle changes. No live hardware, vessel credentials or notification service is involved.

The supported matrix remains Signal K 2.32.0/2.33.0 on Node 22/24. Record actual runs and remaining limits in [verification](verification.md); implementation, local tests, CI, publication and deployment are separate evidence.
