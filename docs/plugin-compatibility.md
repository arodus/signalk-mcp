# Reviewed plugin operations: Signal K Alert Center

This compatibility test uses the `arodus/signalk-alert-center` plugin. It is a test fixture and an explicit configuration example; the MCP gateway does not install Alert Center at runtime or approve its operations automatically.

## Exact package and operation

| Component                | Reviewed target                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider                 | `signalk-alert-center@0.4.1`                                                                                                               |
| Published source         | [`2397918db0551d64c88afd7495607bd992900590`](https://github.com/arodus/signalk-alert-center/tree/2397918db0551d64c88afd7495607bd992900590) |
| Native route             | `GET /plugins/signalk-alert-center/definitions`                                                                                            |
| Gateway operation        | `get.definitions` (derived from method and route; the provider omits operation IDs)                                                        |
| Native permission        | Signal K readonly                                                                                                                          |
| Example gateway approval | Admin, because the endpoint does not filter results by telemetry path/source ACLs                                                          |
| CI matrix                | Signal K 2.32.0 / 2.33.0 × Node 22 / 24                                                                                                    |

The exact npm package is pinned as a development dependency with lockfile integrity `sha512-hbUQvsO4RQUXnY4U83lMHFEoh9ur4e3pZ7M2eXsqGi0ZQjxKJQTPcc/RAGt1Bm3mQLDxucNxiep7RPHhF0UIWg==`. Tests load the published package unchanged, using a fresh temporary configuration and SQLite database. No local Alert Center checkout, operational database, real credentials or live notification services are used.

## Handler and permission review

The pinned [`src/api/routes.ts`](https://github.com/arodus/signalk-alert-center/blob/2397918db0551d64c88afd7495607bd992900590/src/api/routes.ts) registers `/definitions` with `router.access("readonly")`. It parses pagination and filters, then calls `repository.listDefinitions`. The [`runtime repository`](https://github.com/arodus/signalk-alert-center/blob/2397918db0551d64c88afd7495607bd992900590/src/runtime.ts) reads stored definitions, applies provider-owned filters, and returns a page. That GET does not acknowledge, silence, send notifications or change alert policy. The gateway forwards the resulting JSON; it does not perform the provider's calculations or transformations itself.

The endpoint does not apply Signal K telemetry path/source ACL filtering. The example therefore adds an admin requirement in the gateway; this is a conservative approval, not a claim that Alert Center itself requires admin. The original bearer still reaches Signal K's native route. Tests distinguish the two layers: readonly callers are refused by the example approval, native readonly GET succeeds, and native readonly attempts to POST snooze are refused. A deliberately relaxed test approval confirms that the gateway follows the actual native read permission rather than substituting credentials.

## Configure and call

For this conservative admin-only GET example, add a manual `pluginOperations` entry. The review table has no role selector:

```json
{
  "pluginOperations": [
    {
      "pluginId": "signalk-alert-center",
      "operationId": "get.definitions",
      "method": "GET",
      "path": "/definitions",
      "readOnly": true,
      "permission": "admin"
    }
  ]
}
```

Inspect `describe_capability({"id":"plugin.signalk-alert-center"})`, then call with an existing admin bearer:

```json
{
  "id": "plugin.signalk-alert-center",
  "operation": "get.definitions",
  "arguments": { "limit": 1, "sourceType": "recognized", "enabled": true }
}
```

Use this object as arguments to `execute_capability`. The response's `data` contains Alert Center's original page, including `items` and an optional `nextCursor`. Pass that cursor unchanged on the next request. The provider owns pagination and filtering. Limits are 1–100 items and at most 512 characters for the cursor, as declared by its OpenAPI document; gateway response-byte and timeout limits still apply. No pages are automatically combined or truncated.

## OpenAPI compatibility

Alert Center's published [`OpenAPI document`](https://github.com/arodus/signalk-alert-center/blob/2397918db0551d64c88afd7495607bd992900590/src/api/openapi.ts) omits optional `operationId` fields. The gateway derives a name only when the field is absent: lowercase method plus dot-separated route segments, with `{id}` represented as `by-id`. Examples are `get.definitions` and `get.definitions.by-id`. Published valid IDs take precedence; invalid supplied IDs are omitted. Generated/published ID collisions disable every operation with that ID. Exact plugin, operation, method and route approval is still required. Renaming a route or publishing a different ID does not retain its old approval.

The primitive input subset accepts an explicitly declared string maximum up to 512 characters, while unspecified strings remain bounded to 256. Larger limits and unsupported schemas remain disabled. Date-time formats, arrays and arbitrary JSON inputs are not enabled by this change. Detail IDs containing punctuation rejected by the existing safe path-parameter rule remain unsupported; the definition-list cursor is a query parameter and preserves those identifiers through URL encoding.

GET alone is not proof of a safe read. Unknown reads, event streams, notifier tests, acknowledgements, snooze writes, retries, policy changes and deletion remain unapproved or non-executable. Installing a new provider version requires a fresh handler review; an approval does not pin the installed version automatically.

## Verification

Run with Node 24:

```sh
npm ci --ignore-scripts --omit=optional
npm run build
node --test --test-force-exit test/production-plugin.test.cjs
```

The isolated fixture seeds two synthetic notification deltas through Signal K outside MCP. It configures no notifiers, disables sound/speech, connectivity management and retention, and connects no audio service or hardware. Tests exercise native discovery, exact JSON forwarding across pages, boolean/integer/enum/cursor validation, independent gateway/native permissions, disabled and absent packages, changed schemas/routes/IDs, collision refusal and sanitized native errors. Every documented mutation is refused through MCP, and native alert, occurrence, snooze and delivery snapshots remain unchanged afterward.

Schema-drift tests temporarily replace the test server's published OpenAPI record and restore it; the installed package is never patched. Node's built-in SQLite support is required by Alert Center. The CI matrix uses current Node 22/24 releases, not every historical patch release. These checks establish the reviewed read contract with synthetic data, not delivery, audibility, vessel safety or complete provider lifecycle correctness.

Relevant diagnostics remain `NOT_ALLOWLISTED`, `PERMISSION_DENIED`, `METHOD_NOT_READONLY`, `AMBIGUOUS_OPERATION_ID`, `UNSUPPORTED_SCHEMA`, `INVALID_ARGUMENTS`, `PLUGIN_DISABLED`, `CAPABILITY_NOT_FOUND`, `CAPABILITY_UNAVAILABLE` and `UPSTREAM_PERMISSION_DENIED`. Native error bodies are not exposed to clients.

## Individually reviewed POST acceptance

The same unchanged package supplies `POST /snooze` (`post.snooze`) with a required JSON object containing integer `durationSeconds` from 1 to 28800. Its native route requires `readwrite`; it changes provider snooze state for every service, including emergency alerts. Review its global effect before approval. The isolated acceptance fixture disables external notifiers, audio/speech and connectivity services. It verifies reader denial, no state change before approval, input bounds, writer dispatch and exact forwarding of provider state. The native synthetic suite separately proves admin-only configuration persistence and stricter target-route permission denial. See [POST contracts](plugin-posts.md).
