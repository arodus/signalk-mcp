# Release readiness

Version `0.1.0` is prepared as the first stable release, consolidating the alpha features, mixed-case plugin discovery, native PUT diagnostics and declared input choices. This preparation does not authorize or establish publication, deployment or completion of vessel acceptance. The release workflow must run on the final annotated tag after the release commit is merged to `main`.

On 2026-10-20, GitHub confirms all three alpha releases, and both CI workflows pass on the current pre-preparation `main` commit `872b389`. npm reports `latest` as `0.1.0-alpha.1` and `next` as `0.1.0-alpha.3`. Stable publication must move `latest` to `0.1.0`; verify the registry again after publishing. Historical acceptance issues [#7](https://github.com/arodus/signalk-mcp/issues/7) and [#8](https://github.com/arodus/signalk-mcp/issues/8) are closed, but their old checklists are not proof that every acceptance step ran.

## Package verification

Use a clean checkout of the reviewed commit. Install development dependencies and an isolated Python MCP client as described in the README. Run under Node 24, then repeat with Node 22 and the alternate supported Signal K runtime. The output directory must not already exist:

```sh
npm run check
MCP_TEST_PYTHON=/tmp/signalk-mcp-python-client/bin/python \
MCP_TEST_SERVER_VERSION=2.33.0 \
npm run verify:package -- /tmp/signalk-mcp-package-24
```

`verify:package` builds and packs once, verifies required documentation and the compiled entry point, installs that exact tarball with `--omit=dev --ignore-scripts`, and runs the real-server integration tests with the installed plugin and both MCP SDKs. It audits the installed production tree, then removes the temporary install. The tarball, integration log and JSON receipt remain in the requested directory. The receipt records SHA-256, npm integrity, source commit/dirty state, Node/server version, optional real History backend and audit results. It does not claim the optional installed product clients ran. Set `MCP_TEST_INFLUX_URL` to an isolated disposable backend to include the published History provider; never point it at vessel data.

Require a clean-source receipt for the final candidate. An earlier receipt does not validate a changed tarball, even when the version string is unchanged. Keep the artifact with its receipt and repeat after any code, dependency or packaging change.

## Registry and publishing status

The alpha release workflows successfully published through npm trusted publishing. The same tag-driven workflow selects `latest` for stable versions and `next` for prereleases. Verify npm metadata and the downloaded artifact after the stable workflow succeeds; earlier alpha evidence does not validate the stable artifact.

The package has the `signalk-node-server-plugin` discovery keyword, compiled CommonJS entry, Node >=22 requirement, MIT license, repository link and disabled-by-default declaration. The tarball includes README, brief, working instructions, changelog and compatibility documentation. It has no install-time build hook; AppStore installation must work with scripts disabled.

The official plugin CI is separate from the registry harness and our native integration CI. The registry runs its own installation/load/activation checks and the plugin's tests, applies its audit and metadata rules, then associates the published npm `gitHead` with the official CI workflow. A passing PR run alone is not evidence for an eventual release commit. Run the workflow again on the exact commit that will be published.

The 2026-10-19 local Linux preflight uses official registry detection/scoring code at `8917282` and returns 100/100 with no detection errors, passing portable tests, a clean installed audit, screenshots and changelog present, and no core-range or legacy-library penalties. This is a network-disabled Docker preflight, not the registry's Firejail run or a published score. See [registry readiness](registry-readiness.md). The public result also depends on official CI for the published npm `gitHead`.

Before publication, verify the registry's current source and requirements rather than assuming its score from local tests:

- Run the portable suite in the registry's isolated Linux environment and inspect load/activation results.
- Verify screenshots and changelog are included in the exact tarball and correctly referenced.
- Verify production dependency audit and declared core dependency ranges.
- Verify official CI evidence for the npm `gitHead` after the publication commit is chosen.
- Obtain explicit authorization for npm publication and a GitHub release. Afterward, verify the downloaded npm artifact and AppStore/registry indexing independently.

Official references: [registry scoring and sandbox](https://github.com/SignalK/signalk-plugin-registry), [plugin CI](https://github.com/SignalK/signalk-server/blob/340d5bb62c17ec58d2a3497dbbf081cd87af2a96/.github/workflows/plugin-ci.yml).

## Upgrade, rollback and removal

The native Signal K 2.33.0 Plugin Config UI was exercised with a disposable synthetic admin account: the staleness setting changed from 300 to 600, survived reload, and was restored to 300; disabling showed `Stopped`, and re-enabling restored the ready status. The [captured configuration](images/native-plugin-config.jpg) shows only the complete settings card, including Save Configuration. The current screenshot shows five synthetic example approval rows in the embedded table. The refreshed labels and help text were checked at 1280-pixel desktop and 390-pixel mobile widths; saving 600 seconds, reloading and restoring 300 seconds succeeded. The separate UI fixture installed the optional published admin UI package and linked its hoisted directory into the location expected by the server. This verifies the form workflow, not a live-vessel configuration or the full installation layout of every host.

Before changing an existing installation, save the current package version and the plugin's configuration through the host's normal backup process. Keep provider approvals for review; a provider upgrade can change a route's behavior or permissions.

Disable the gateway in Plugin Config, install the reviewed tarball from the Signal K configuration directory as its service account, and restart the server process through its service manager. Confirm the loaded version, Signal K’s browser-origin policy, security-enabled state and each individually reviewed plugin GET/POST/native PUT approval before enabling. There is no blanket approval; native permissions remain mandatory. Repeat one allowed read, one denied-path read and an unapproved-action refusal check using an isolated synthetic target. Live PUT acceptance requires separate authorization. The plugin stores no historical values or private account database to migrate.

For rollback, disable the plugin, reinstall the previously retained tarball/version with scripts disabled, restore its compatible configuration and restart. Recheck permissions before enabling. Do not assume a changed schema or provider approval remains compatible.

For removal, disable the plugin, run `npm uninstall signalk-mcp` in the Signal K configuration directory and restart. Confirm the MCP endpoint is no longer available. Signal K may retain its plugin settings; remove those only if intentionally discarding the saved configuration. Remove the client connection and revoke its native token only if that token was dedicated to this client and is no longer needed.

## Vessel acceptance procedure

The complete procedure remains a separate acceptance check; automated integration tests and partial installation/discovery checks do not establish completion. Do not connect to a vessel or install the package without explicit access/deployment authorization.

1. Record the approved vessel/server, exact package hash, Signal K/Node versions, client and permitted read-only time window. Confirm existing native security and a dedicated least-privilege token without exposing it in logs or screenshots.
2. Configure Signal K’s browser-origin policy and trusted TLS. Start with no generic plugin GET approvals.
3. Initialize MCP, list tools/capabilities and read a small allowlisted set of current values. Compare value, unit, timestamp and source with the authorized native Signal K view. Preserve zero, null/missing and inaccessible distinctions without inferring equipment health.
4. Verify a denied path remains unavailable and malformed/missing credentials are rejected. Verify unapproved operations return a refusal; do not call a live control or notification mutation endpoint to test this.
5. If separately approved, read a short historical interval using exact permitted paths/sources. Compare the provider response unchanged. Add a generic GET approval only after reviewing that exact provider version for authorization and side effects.
6. Check server responsiveness, client disconnect/reconnect and gateway disable/re-enable. Stop on new errors or telemetry disruption and roll back the package/configuration if required.
7. Record actual observations, omissions and errors. Successful reads do not prove sensor health, notification delivery or physical equipment operation.

## Stable release checklist

- [ ] Review and merge the `0.1.0` preparation PR, with one dated changelog entry and current README/install instructions.
- [ ] Verify the final clean-commit tarball on supported runtimes; retain the exact artifact, checksum and receipt.
- [ ] Pass both CI workflows on the final release commit and reassess production dependency advisories.
- [ ] Recheck current registry requirements and run the registry preflight on the candidate; keep local scoring distinct from the public result.
- [ ] Obtain explicit publication authorization, then create the annotated `v0.1.0` tag on the reviewed `main` commit.
- [ ] After publication, verify npm `latest`, downloaded package integrity and `gitHead`, the GitHub release assets, and AppStore/registry indexing.

## Separate acceptance and known limits

- Product-client checks need refreshing for the full current tool catalog; earlier Codex/Hermes evidence covered a smaller read catalog. Desktop/web and intended tunnel connections remain unverified. See the [client matrix](clients.md#verification-status).
- Complete the vessel procedure above only with access/deployment authorization, including an audit of the actual production host. Package audit results do not certify that host.
- Raspberry Pi testing is outside release acceptance per the owner's 2026-10-19 decision; local ARM64 evidence does not establish Pi compatibility.
- Upstream in-process shutdown remains unsupported as a verified cleanup path. Full server process replacement and synthetic large-value recovery are tested; see the [resource report](resource-validation.md) for workload-specific limits.

These limitations remain explicit for `0.1.0`; preparing the stable version does not mark them resolved.

## Release workflow

The tag-driven workflow follows [arodus/signalk-alert-center](https://github.com/arodus/signalk-alert-center/blob/main/.github/workflows/release.yml). It calls both existing CI workflows before publication, then requires an annotated `v<package version>` tag on a commit contained in `main`, a clean checkout, and matching nonempty `## [<version>] - <date>` changelog notes. No version bump or tag is created automatically.

`scripts/create-release-package.mjs` stamps the actual `git rev-parse HEAD` into the tarball's `package.json.gitHead`, checks the packed value, writes a SHA-256 checksum and restores the tracked manifest. Do not hard-code a commit SHA in the tracked manifest. The workflow installs and tests that exact tarball with native Signal K and both SDK clients, audits it, retains it as a workflow artifact, then publishes it. Prereleases use npm's `next` tag; stable releases use `latest`.

After publishing, the workflow verifies npm's `gitHead` matches the release commit before creating the GitHub release with the tarball, checksum and version-specific changelog notes. A failed verification stops the GitHub release step; it cannot undo an npm publication already completed.

The owner has configured npm trusted publishing. The publish job uses OIDC from this repository's `release.yml` workflow and `release` environment; no bootstrap token is used. If npm rejects the identity, inspect that configuration instead of introducing a stored publication token.
