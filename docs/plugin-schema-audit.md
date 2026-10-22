# Plugin schema audit

This audit covers the seven available plugin OpenAPI documents in the 2026-10-22
MCP inventory. The documents are pinned in
[`test/fixtures/plugin-openapi`](../test/fixtures/plugin-openapi/README.md), with
source notes and hashes. The other seven discovered plugins either had no
available OpenAPI document or were disabled. No new host inspection was used.

An admitted operation has a supported route, input contract and JSON response
transport. Admission does not mean execution has been tested against that plugin,
and does not grant approval or bypass the plugin's native authentication.

## Results for the pinned documents

The previous implementation accepted 48 of 100 operation inputs. The updated
implementation admits 87 of 100 operations. The earlier count also included an
SSE read, a binary read and a Freeboard route that the JSON/plugin-route executor
could not actually serve; those are now reported as unavailable at discovery.

| Plugin                | Previous input admission | Updated admission | Remaining limitation                                                                     |
| --------------------- | ------------------------ | ----------------- | ---------------------------------------------------------------------------------------- |
| Alert Center          | 20/28                    | 27/28             | `/events` returns SSE                                                                    |
| Stowage               | 15/36                    | 35/36             | Attachment POST uses multipart upload                                                    |
| Logbook               | 1/6                      | 6/6               | No remaining input/parser blocker in the pinned document                                 |
| KIP                   | 5/11                     | 11/11             | Some request values are ambiguous under its published `oneOf`; see below                 |
| Hoeken's Anchor Alarm | 5/11                     | 7/11              | Two UI configuration writes, binary icon GET, non-JSON icon PUT                          |
| Resources Provider    | 1/3                      | 1/3               | POST/DELETE modify collection configuration                                              |
| Freeboard-SK          | 1/5                      | 0/5               | All five routes use `/signalk/v2/api/alarms`, outside the generic plugin route namespace |

The remaining 13 operations are four configuration writes, five routes outside
the plugin namespace, two uploads, one binary response and one event stream.
The route and transport limits are independent of JSON schema parsing.

KIP's `ConcreteSeriesDefinition` and `TemplateSeriesDefinition` alternatives can
overlap: the concrete variant's `expansionMode` has no type or constant constraint.
A value matching both is invalid under `oneOf`. The gateway checks exactly one
match and rejects that value. The plugin author should make the alternatives
exclusive if those values are intended to be accepted; the gateway does not
silently reinterpret `oneOf` as `anyOf`.

## What was the gateway's fault?

The previous parser accepted only scalar parameters and flat JSON request
objects. It rejected ordinary OpenAPI declarations including `format: date-time`,
nullable fields, arrays and nested objects. It also excluded every plugin PUT,
PATCH and DELETE before inspecting their schemas. KIP documented its own
`/plugins/kip` prefix, which the gateway incorrectly added a second time.

These are shared parser, method and routing issues. They do not require a separate
adapter for every plugin. The pinned documents exercise the common implementation
rather than plugin-specific exceptions.

## What must an Alert Center user do?

The two previously blocked JSON reads, `/alert-history` and `/occurrences`, already
have useful schemas: their optional `from` and `to` parameters are date-time
strings. The plugin author does not need to remove those formats. The gateway
parser now validates them. The policy PATCH also needs the shared method and
nested-schema support; changing the plugin's public contract to a flat object
would be unnecessary.

The `/events` route returns `text/event-stream`. It needs event-stream transport
support, rather than a schema change, and remains unavailable through the JSON
executor. The other JSON operations can use the common gateway, subject to the
normal saved operation review and native route permissions.

## What must other users and plugin authors do?

For an enabled plugin that already publishes a supported OpenAPI document through
Signal K's `getOpenApi()` interface, users do not need to install a plugin-specific
adapter. They inspect its discovered operations and request the ones they need.
The gateway reports the exact schema location and unsupported keyword when input
validation cannot be compiled.

For a plugin with no discoverable OpenAPI document, an ordinary README can help a
developer establish its contract, but it does not automatically make that API
executable through MCP. The plugin author should expose `getOpenApi()` with the
actual method, route, parameters, request media type and body schema, documented
meaning, responses and native authentication requirements. Local component
references are supported; remote references are not fetched. Plugin-relative
paths and the plugin's own `/plugins/<id>/...` prefix are supported. A declared
server URL cannot redirect the gateway to another service.

Use schemas that describe what the plugin actually accepts. Do not remove real
constraints merely to get a green discovery result. Unknown validation keywords
remain explicit failures until the common parser can enforce them. File uploads,
binary responses and streams need their corresponding transport support. An
arbitrary server-configuration endpoint remains outside the gateway's mutation
scope even when its JSON schema is valid.

The other discovered plugin groups were:

| Plugins                                                   | MCP discovery result                    | What is missing                                                                           |
| --------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Course Provider, App Dock, Autostate, Maintenance Tracker | `CAPABILITY_UNAVAILABLE`, no operations | An available machine-readable operation contract; a capability name alone is insufficient |
| Set System Time, SK to NMEA 0183, UDP NMEA Sender         | `PLUGIN_DISABLED`, no operations        | An enabled provider before its contract can be assessed                                   |

Native `api.course`, `api.weather`, `api.autopilot`, `api.radar`, `api.ble`,
`api.tracks` and `api.sensors` advertise feature names rather than plugin OpenAPI
operations. Their `ADAPTER_REQUIRED` status is a separate native-interface gap.
The generic OpenAPI improvements do not invent contracts for those features.
