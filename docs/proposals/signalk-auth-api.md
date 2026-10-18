# Draft: public Signal K bearer and read-authorization contract

Status: local proposal only, prepared for issue #2. Not submitted upstream. Names and signatures must be agreed with Signal K maintainers; nothing in this document describes an available API.

## Problem

Native plugins can classify HTTP routes with `router.access(...)`, but a multiplexed endpoint such as MCP must also authorize each operation. Model getters expose data without a caller context. The current gateway therefore calls internal `securityStrategy.authorizeWS` and `checkACL` methods, coupling it to release-specific details.

A public read-authorization contract would let plugins retain Signal K's identity and ACL semantics without reading signing keys, implementing JWT verification, creating a second authentication system or acquiring a different principal for internal requests.

## Required behavior

A minimal public interface needs two responsibilities:

1. Resolve an explicitly supplied bearer credential to a verified Signal K identity, or return a typed denial/unavailable result. Credential precedence must be explicit: unrelated cookies and query values must not override the supplied bearer. Disabled security, guest fallback, unknown permissions and removed identities must not count as authenticated users.
2. Evaluate a read for an authenticated context plus Signal K context/path/source. The server must own the permission decision and reevaluate current identity/ACL state, including revocation, rather than trusting a caller-supplied identifier/permission object or a cached grant.

A request-bound opaque context is preferable to a forgeable principal object. The final API should specify context lifetime and refresh semantics so a plugin can recheck access after an asynchronous provider operation. Server-private credentials and signing material must never be exposed through it.

Errors should distinguish an invalid/expired credential, unavailable security and denied access without including sensitive token or configuration details. Public type declarations and tests should pin these semantics across supported releases. Synchronous versus asynchronous behavior must be explicit so callers cannot mistake an unresolved result for authorization.

## Acceptance examples

- A bearer for user A with user B's cookie resolves as A or fails; it never resolves as B.
- A guest-enabled installation still denies an explicit-authentication request without a verified identity.
- A removed user/device or changed role stops authorizing subsequent invocations, including a recheck before an asynchronous result is returned.
- A denied path/source remains denied even when the native plugin can access the complete model.
- Unknown or unavailable authorization never becomes an implicit allow.
- A plugin can perform the checks without inspecting signing keys, user databases or private security strategy methods.

## Boundaries

This proposal is for caller-preserving read access. It does not add token minting, account management, OAuth, privileged internal requests, arbitrary HTTP proxying, control operations or data calculations. Generic plugin responses still require the provider to enforce its own endpoint-specific visibility rules.

If a future public contract meets these requirements, migrate only `src/auth.ts`, keep equivalent regression coverage and remove the private hooks after verifying the supported runtime set. Do not claim the dependency removed until that migration is implemented and tested.
