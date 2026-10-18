# ADR 002: Keep native bearer authentication; defer OAuth pending a Signal K contract

Date: 2026-10-18. Status: accepted for the current gateway; OAuth implementation is blocked by the native integration contract.

## Decision

Continue to accept existing Signal K user/device bearer tokens and enforce current native permissions on every call. Document which products can supply that header. Do not advertise OAuth endpoints or OAuth compatibility, add a second account/key database, read signing secrets, or replace callers with a shared service identity.

An OAuth-only client cannot connect through a configuration-only change today. Adding discovery metadata alone would not resolve the identity, audience or lifecycle requirements.

## Evidence and boundary

The pinned Signal K 2.32.0/2.33.0 `tokensecurity` implementation signs native user/device JWTs and resolves current principals; the inspected `generateJWT`/`authorizeWS`/`http_authorize` paths do not provide an MCP resource audience contract. Native browser cookie renewal is not OAuth refresh-token support. These are the same version-sensitive internals covered by [ADR 001](../architecture.md) and [authentication tests](../authentication.md).

The [MCP 2025-11-25 authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) requires resource/authorization-server discovery, audience validation and resource indicators for OAuth. It forbids forwarding the client's OAuth access token to an upstream API as a substitute for a separately authorized upstream credential. PKCE, redirect validation and secure token lifecycle are also required. The existing native-bearer mode is not a claim to implement that OAuth profile.

Today, the gateway forwards the original native token only to the same Signal K instance's approved local routes. That preserves the native caller but does not establish that a future OAuth token is valid for those routes. A design must explicitly resolve this distinction.

## Conditions for a future integration

1. **Identity and permission authority:** Signal K must remain the source of users/devices, revocation and path/source permissions. A supported native interface must resolve a delegated caller and perform authorized reads without constructing a privileged token or trusting arbitrary principal headers.
2. **Resource and discovery:** Configure a canonical HTTPS MCP resource identifier. Never derive the issuer, audience, callback or token endpoints from untrusted Host/Forwarded headers. Publish protected-resource metadata and a correct challenge only when a working authorization server exists. Select supported client registration mechanisms from actual product tests.
3. **Delegation:** Prefer authorization owned by Signal K or a Signal K-supported authorization integration. An MCP access token must target this resource. Downstream plugin/history access needs a native same-user delegation contract, or an explicitly supported scoped token exchange. Do not forward an OAuth token with the wrong audience; do not silently fall back to native admin credentials.
4. **Lifecycle:** Define consent, short-lived access credentials, refresh rotation/revocation, account/device removal, permission changes during pending reads and behavior on server restart. OAuth scopes may restrict native permissions; they must never enlarge them. Lifecycle storage belongs to the authorization integration, not a parallel gateway account/key system.
5. **Proof:** Test the complete browser/code flow with the intended products, wrong resource/issuer/client cases, expired/revoked credentials, refresh replay, denied paths/sources, original identity at providers and reconnect. Fetching and forwarding remains the entire data scope.

## Blockers and follow-up

The supported native delegation/audience contract has not been established. The public authentication proposal in this repository is a draft and is insufficient by itself to implement OAuth token exchange. Selecting a standalone OAuth library would not solve that gap.

Keep OAuth implementation out of the current PR. Revisit this decision after a concrete Signal K authorization/delegation contract is verified, then open a narrowly scoped implementation issue with that evidence and the required product tests. No upstream proposal has been sent and no alternative authentication service is installed.
