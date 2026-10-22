# Native OpenAPI fixtures

These JSON documents are serialized `apiDoc` exports from the published `signalk-server@2.33.0` package, under `dist/api/<name>/openApi.js`. They are stored unchanged apart from JSON serialization and formatting. Upstream source: https://github.com/SignalK/signalk-server/tree/v2.33.0/src/api .

The portable suite uses these documents to detect schema-coverage changes. The native integration suite separately fetches the documents from the actual server selected by `MCP_TEST_SERVER_DIR`, so fixtures are not evidence of runtime compatibility on their own. See `docs/native-apis.md` for coverage and exclusions.
