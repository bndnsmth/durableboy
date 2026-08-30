# Security

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories for
`bndnsmth/durableboy`. Do not open a public issue for an exploitable flaw.

## Deployment guidance

The repository is a proof of concept, not an unauthenticated public emulation
service. Before exposing a deployment, protect console creation and ROM upload
with Cloudflare Access or an equivalent policy, and set account-level rate and
spend limits.

Console owner capabilities authorize destructive operations. Treat them as
secrets. Share links contain only console IDs and do not grant deletion or
cartridge replacement rights.

DurableBoy bounds ROM and JSON request bodies, stores user-supplied media in R2,
and never bundles commercial ROMs. Operators remain responsible for acceptable
use, retention, regional, and copyright policies.

## Supported versions

Security fixes are applied to the latest release and the `main` branch.
