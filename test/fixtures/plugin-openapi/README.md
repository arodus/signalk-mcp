# Pinned plugin OpenAPI fixtures

These documents were collected on 2026-10-22 for the shared parser audit. They contain public API contracts, not live configuration, vessel records, credentials or responses. Tests use these files offline. No fixture calls a plugin or notification service.

The Anchor, KIP, Freeboard, Stowage and Logbook fixtures are the unmodified document values from previously collected plugin source files; the Alert Center fixture is the JSON result of its `getAlertCenterOpenApi()` export. JSON whitespace is normalized by the repository formatter. The Logbook fixture comes from the published `@meri-imperiumi/signalk-logbook` 0.14.3 package. The Resources Provider fixture is from this checkout’s `@signalk/resources-provider` 1.5.2 development dependency (`dist/openApi.json`); its operation methods and paths match the cached MCP discovery. The other source copies came from the earlier test-container inspection; this audit did not inspect the host again.

The versions below are `info.version` from each document. They are API document versions and must not be interpreted as installed package versions. This audit does not claim future package compatibility. Retain upstream license declarations embedded in each document.

| Fixture / plugin ID                               | Document version | Collected source                                         | SHA-256 of fixture                                                 |
| ------------------------------------------------- | ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| [freeboard-sk](freeboard-sk.json)                 | 2.20.0           | `plugin/openApi.json`                                    | `4e726cddd4122142c2ae844e4eba45e7a2a9f6871f8e82403859d3c377939267` |
| [hoekens-anchor-alarm](hoekens-anchor-alarm.json) | 2.0.0            | `src/openApi.json`                                       | `b3581be9c5eb4c3a265246d5052a099d0af6cfb85b85f411f17c7e800cab7882` |
| [kip](kip.json)                                   | 1.1.0            | `plugin/openApi.json`                                    | `02f8667f111b62fb214a6f322b093e4753d09eac83c93c964f3089e26e4ceaef` |
| [signalk-alert-center](signalk-alert-center.json) | 1.0.0            | `api/openapi.js`, `getAlertCenterOpenApi()`              | `5633359590a6dfd9d516911e0767fbe4a231ae7b57f24f8c2512d079b5c6ef36` |
| [signalk-logbook](signalk-logbook.json)           | 0.2.0            | `schema/openapi.json` (published scoped package 0.14.3)  | `f4b8cc434d4db80591028fdf6781d2a6d01cfac45625476670cfcb12f42b4475` |
| [signalk-stowage-mgmt](signalk-stowage-mgmt.json) | 0.5.3            | `openApi.json`                                           | `711d2c743c90de0ba316bc07dd9ec93d3512910b609ce0f017dd02136d787216` |
| [resources-provider](resources-provider.json)     | 2.0.0            | `dist/openApi.json` (local development dependency 1.5.2) | `7327a5d0992ddb88bfd94c0b8fed42d8011bc755183948d51433267e4691b68f` |
