FROM docker.io/library/node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
COPY --chmod=0555 runner.cjs /usr/local/bin/signalk-mcp-worker
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/signalk-mcp-worker"]
