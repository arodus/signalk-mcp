# Registry and listing readiness

The package listing includes a read-only description, Signal K and MCP discovery keywords, public repository/homepage/issue links, a settings screenshot and the changelog. The README describes supported telemetry, notification, History and approved plugin reads, and labels the screenshot's synthetic examples. No live compatibility or publication claim is inferred from these metadata fields.

## Local scoring preflight (2026-10-19)

Inspected official [Signal K registry source](https://github.com/SignalK/signalk-plugin-registry/tree/8917282). The exact code revision is recorded in the local validation checkout. Installed the packed candidate with scripts disabled on Linux/Node 24, audited that install, and ran portable source tests and the official detection/scoring functions with Docker networking disabled.

| Criterion                        |     Points | Local result                                               |
| -------------------------------- | ---------: | ---------------------------------------------------------- |
| Installation                     |         20 | Pass with scripts disabled                                 |
| Constructor/load                 |         15 | Pass                                                       |
| Activation                       |         15 | Pass; no detection errors                                  |
| JSON schema                      |          5 | Present                                                    |
| Own tests                        |         25 | Portable suite passes                                      |
| Dependency security              |         20 | No moderate, high or critical installed advisories         |
| Changelog and screenshot         | No penalty | Both present in package                                    |
| Core ranges and legacy libraries | No penalty | No held-back core dependencies or legacy runtime libraries |

The official scoring function returns **100/100 locally**. This is not a public registry result. The fixture's activation check does not establish real token authorization; native server integration tests cover that separately. No authentication check is weakened to obtain a score.

The registry's published summary can additionally deduct 10 points when the official plugin CI is not associated with the published npm `gitHead`. The release pipeline therefore stamps and verifies that field and runs both CI workflows on the release tag. A 100/100 public score still requires an authorized npm publication, registry indexing and inspection of the registry's actual result. Recheck current advisory data and scoring rules for each release; do not publish an unverified score badge.

The local harness uses the upstream detection, legacy-dependency and scoring functions against a locally packed candidate, with tests run from the matching source. It does not invoke the registry's npm-name installer, source-clone fallback or Firejail wrapper. Those public-run differences remain explicit acceptance checks after publication.
