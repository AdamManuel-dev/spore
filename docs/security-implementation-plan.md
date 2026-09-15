# Spore: durable security implementation plan

## Scope and status

**Plan only. No implementation changes have been made.** This plan covers the eleven findings from the preceding source-based security review and additional identity hardening. It does not claim that browser exploits were reproduced or that all possible vulnerabilities were found.

**Durable features** are permanent fixes to root causes: isolation, explicit authorization, bounded resource use, correct attribution, and honest consent/key-lifetime controls. The separate [additional security backlog](security-additional-backlog.md) covers temporary containment, defense-in-depth, testing and operations. Those additional controls can be permanent too; they are not substitutes for the architectural fixes.

The recommended approach is **contain now, ship independent fixes next, then introduce proven isolation**. Initial containment and independent controls do not wait for a multi-origin architecture decision. Active untrusted scripts remain disabled throughout this plan.

## Security contract

1. Untrusted content cannot access gate controls, other torrents, publishing keys, or a generic privileged broker.
2. Content-triggered resource requests resolve only within the assigned torrent/root, never through a general host-network fallback. Trusted gate/bootstrap and WebRTC traffic are distinct roles.
3. Unknown, expired or mismatched request identity is denied, not treated as the gate.
4. Script execution remains disabled; an unsupported security mode does not fall back to an unsandboxed viewer.
5. Attribution describes the bytes and root actually verified for the current view. Signatures do not establish a person's identity or confer script permission.
6. Untrusted file/message processing has finite byte, count, time and concurrency budgets.
7. Reading creates no persistent browsing metadata without consent. Erasure failures are visible. Local key deletion is never described as revocation of retained capabilities or historical signatures.
8. The gate stays static and mirrorable, with no mandatory central application backend. A secure multi-origin deployment may need additional static-host/DNS/TLS capabilities; that is an approval gate, not an assumption.

Swarm peers still see IP addresses. Availability still requires an active compatible peer. An untrusted mirror can distribute malicious gate code; this plan does not make arbitrary mirrors safe places to enter secrets.

## Durable feature catalog

| ID | Feature and lasting outcome | Work | Audit coverage |
| --- | --- | --- | --- |
| [D1](#d1-policy-enforcement) | Central fail-closed effective policy and security-version interlock; stored grants cannot override unsupported isolation. | T02 | 001, 002 |
| [D2](#d2-rendering-topology-and-origin-names) | Gate/content and cross-torrent origin isolation with a narrowly scoped byte bridge. | T03–T05 | 001, 004, 005 |
| [D3](#d3-worker-and-bridge-authorization) | Authenticated view-scoped worker authority; no unknown-provenance privilege or non-torrent content egress. | T04–T05 | 003, 004, 005 |
| [D4](#d4-signature-scope-and-attribution) | Signed-root confinement and attribution bound to the current view. | T06 | 006 |
| [D5](#d5-file-and-peer-work-budgets) | Pre-read file limits and bounded aggregate peer/verification work. | T07, T08, T16 | 008, 009 |
| [D6](#d6-metadata-consent-and-erasure) | Explicit metadata consent and complete, scoped, failure-aware erasure. | T09 | 010 |
| [D7](#d7-signer-location-and-key-lifetime) | Constrained signing authority, cross-tab lock/sign-out and accurate key-lifetime semantics. | T10a, T10b | 001, 007 |
| [D8](#d8-status-and-monitoring-access) | Local-only native status defaults with separate minimal health and detailed inventory. | T11 | 011 |
| [D9](#d9-identity-enrollment) | High-entropy identity enrollment and explicit backup confirmation without changing existing identities. | T14 | Additional durable hardening |
| [D10](#d10-rotation-and-compromise-recovery) | Versioned routine rotation and independently authorized compromise recovery. | T15 | 007; later gated protocol work |

Audit IDs are `SPORE-001` through `SPORE-011`. Finding 004 is a confirmed fail-open source decision, **not a confirmed browser cross-torrent bypass**. Findings 005 and 007 partly amplify the same origin-isolation problem; they are not counted as unrelated remote exploits.

## Architecture choices and approval gates

### G1 — Measured rendering/hosting topology

**Recommendation:** separate untrusted views from the gate and isolate mutually hostile torrents by origin. Do not place all active content onto one shared second origin and call that cross-torrent isolation.

T03 must compare practical static-host arrangements before T04 selects one. The exact design is unresolved:

- A service-worker registration is origin-scoped. The existing `client.createServer({ controller })` cannot simply receive a foreign renderer's registration. Prove the real cross-origin message/byte adapter; keep WebTorrent in a trusted page and ordinary resource serving behind a worker chokepoint.
- A shell sharing an origin with hostile active content is **not** a trusted gate/signer authority. Even if the shell is compromised, its bridge capability must be restricted to its assigned torrent/root and bounded operations.
- Removing `allow-same-origin` from the existing iframe is not a shortcut: opaque-origin worker serving is a known feasibility issue.
- Test same-site cross-origin details: cookies, `document.domain`, storage partitioning, initial navigations, nested frames and worker restarts.
- Deterministic infohash subdomains disclose the hash through DNS/Host/TLS metadata. Compare opaque labels with explicit allocation and lifecycle rules. Opaque labels do not hide IP/timing or protect against a malicious bootstrap host.
- Do not reuse an origin pool until hostile worker/storage survival and cleanup have been demonstrated safe. Failed cleanup means quarantine/no reuse, not reassignment.

**Required approval:** host capabilities, supported browser/topology matrix, origin naming/privacy trade-offs and lifecycle. If no candidate meets the contract, affected rendering stays unavailable; do not invent a mandatory backend or weaken isolation to mark the task complete.

### G2 — Signature scope and signer trust

**Recommended signature model:** one fixed signed root per verified view. Its resources cannot escape that root. Leaving it opens a separately authorized view with cleared attribution. This preserves existing signature bytes; it may reject sites whose nested entry references unsigned siblings. The alternative—whole-torrent coverage—needs explicit compatibility approval.

**Recommended signer:** a trusted top-level signing surface on a separate origin from content, preferably also separate from arbitrary gate mirrors. A gate-co-located signer is acceptable only if the user explicitly accepts that gate/mirror compromise also compromises signing. Neither option may expose a generic arbitrary-message signing service. If the chosen trusted signer cannot be deployed, disable browser signing rather than move keys into an untrusted renderer.

### G3 — Later rotation/recovery protocol

Routine old-key-authorized rotation and recovery after theft are different. A thief holding the old key can sign competing rotations. Compromise recovery requires an independently pinned authority, preferably offline, established before compromise and adopted by readers.

No retroactive guaranteed recovery exists for unenrolled identities. Historical signatures remain mathematically valid; offline and legacy readers may never learn or enforce retirement. T15 requires a versioned protocol decision before implementation and does not block R0–R2.

## Dependency-ordered implementation work

Paths below are existing touch points unless marked proposed. New modules and deployment directories are proposals, not code already present.

### T01 — Invariants, compatibility vectors and safe fixtures

**Depends on:** none. **Owner:** security lead + browser maintainer.

Inventory storage namespaces, worker scopes, persisted grants, keys, signed-format vectors and current e2e assumptions. Build local fixtures for each finding: prior grants, two tabs, non-torrent endpoints, signed subtree/sibling, unresolved author, blocked deletion and native status.

**Files:** `SECURITY.md`, `spec/mutable-sites.md`, `tools/e2e.mjs`; proposed `docs/security-model.md` and security fixtures.

**Done:** every finding maps to an invariant and a test; existing identity/signature vectors are recorded; tests use no real secrets or live-peer floods. Updated script-off expectations are explicit requirement changes, not deleted security tests.

### T02 — Effective scripts-off policy and safe lifecycle containment

**Depends on:** T01. **Owner:** browser maintainer.

Force scripts off independently in worker headers and viewer policy, regardless of stored grants. Remove unsandboxed fallback. Add compatible gate/worker policy-version checks before new rendering/signing, clear old views on controlled upgrades, and coordinate cooperative tabs. Invalidate legacy grants, but do not rely on deletion as enforcement.

**Files:** `js/policy.js`, `js/viewer.js`, `js/app.js`, `js/swarm.js`, `js/config.js`, `sw.js`, `index.html`.

**Done:** prior grants cannot enable scripts on open, restore, reload, repeated show or failed probe. Incompatible versions block privileged operations in the new release. Unsupported engines receive an explicit unavailable state. Existing hostile/offline tabs cannot be retroactively secured; migration requires closing legacy contexts and states that limitation.

### T03 — Isolation feasibility spike

**Depends on:** T01. **Owner:** browser/security engineer.

Build a disposable prototype of the actual cross-origin byte/message path and origin lifecycle, not just a diagram. Evaluate G1 alternatives on Chromium, Firefox and WebKit with static HTTPS hosting and a second mirror/subpath.

**Files:** `js/swarm.js`, `sw.js`, `js/viewer.js`, `js/site.js`; proposed `tools/security-browser-matrix.mjs` and `docs/security-isolation-spike.md`.

**Done:** publish PASS/BLOCKED evidence per topology/browser for relative assets, navigation, redirects, cancellation, no-referrer requests, worker restart, direct renderer launch, shell compromise, other-torrent access and storage/origin reuse. Record network counters and request provenance, not just CSP console messages. Establish which deployment capabilities are actually required.

### T04 — Approve the authority and deployment design

**Depends on:** T02, T03. **Owner:** security lead + deployment owner; human gate G1/G2.

Specify authenticated bootstrap and a per-view authority tuple: gate session, protocol version, renderer identity, view epoch, hash, root and permitted operations. Define initial-navigation authorization, request-ID replay handling, revocation/disposal and restart behavior from the spike's measured APIs. Do not assume URL bearer tokens or a gate-looking URL establish browser identity.

**Files:** proposed `docs/security-model.md`; `js/config.js`, `deploy/README.md`, `spec/mutable-sites.md`.

**Done:** G1/G2 decisions are explicitly recorded. A renderer cannot self-designate as gate, ask for another torrent, read storage or request signing. No unexplained browser behavior is required for an authorization decision.

### T05 — Implement isolated rendering and scoped worker authority

**Depends on:** T04. **Owner:** browser maintainer + security reviewer.

Implement the approved topology/adapter. Replace first-responder broadcasts with registered authenticated owner channels. Validate roles before the current non-torrent pass-through. Bind requests to hash/root/view epoch; deny unknown or stale identities. Preserve ordinary HTML/resource requests through the worker, not tag-specific rewriting.

**Files:** `sw.js`, `js/swarm.js`, `js/policy.js`, `js/viewer.js`, `js/site.js`, `js/app.js`, `js/config.js`; proposed `js/view-bridge.js`, topology-dependent `renderer/`; deployment configuration.

**Done:** wrong-source/origin/port, second responder, replay and cross-torrent requests are denied. Methods, ranges, paths and response shapes are validated; arbitrary redirects/cookies/security headers cannot enter via the bridge. Ports/timers are bounded and closed. Non-torrent content requests never reach local counting endpoints, while authorized bootstrap and tracker operations still work. Restart requires fresh authorization. Unsupported cases remain closed.

### T06 — Bind verified attribution to the served root/view

**Depends on:** T05, T07. **Owner:** browser + protocol maintainers.

Apply the G2 signed-root model to every resource and navigation, including while verification is pending. Clear/reverify attribution when the authorized view changes. Prevent stale asynchronous results from labeling a new view. Preserve existing manifest serialization, digest and signature formats.

**Files:** `js/site.js`, `js/manifest.js`, `js/app.js`, `js/viewer.js`, `sw.js`; compatibility checks in `js/publish.js` and `tools/seed.mjs`.

**Done:** an existing signed sibling reference cannot expose unsigned sibling content under a verified badge. Encoded traversal, separator/prefix ambiguity and nested frames cannot escape scope. Pending, unverified, cancelled, broken and verified remain distinct. Existing signed bytes/hashes are not silently rewritten; changed compatibility is documented.

### T16 — Set finite resource defaults from bounded measurements

**Depends on:** T01. **Owner:** performance/browser engineer + security reviewer.

Produce the resource configuration and measurement report before T07/T08 activation. Use representative constrained devices and bounded fixtures, not intentional OOM.

**Provisional starting values, subject to measured approval:**

| Control | Starting configuration |
| --- | --- |
| Declaration / manifest bytes | Existing 4 KiB / 512 KiB limits, enforced before and during reading |
| Automatic content verification | 16 MiB/file, 64 MiB/job, 2,048 files/job, 30 seconds/job |
| Verification buffers/concurrency | 64 MiB total managed verification buffers per gate; one file-hashing job at a time |
| Update record bytes | Preserve existing 2,048-byte cap |
| Pending update candidates | 1/wire, 8/torrent, 32/gate; expire unresolved candidates after 60 seconds |
| Update verification | 2 concurrent operations/gate; per-wire burst 4 then 1/second; gate-wide burst/rate cap 20/second |

These are budgets for the named operations, not a claim that all WebTorrent/browser memory is capped. Specify admission limits for retained jobs/torrents and logging/dedup caches during measurement. Manual retries must retain finite hard ceilings. If native WebCrypto cannot hash incrementally, enforce a buffered cap or approve a reviewed streaming implementation; do not pretend `digest()` streams.

**Done:** approved constants with units, scopes, hard ceilings, overload behavior and test assertions exist. Values may change with evidence, but “unlimited” is not the fallback.

### T07 — Enforce file and automatic-verification budgets

**Depends on:** T16. **Owner:** browser maintainer.

Check file lengths before reads, limit actual bytes consumed, and enforce count/aggregate/time/cancellation budgets. Coordinate concurrent views so per-file limits cannot be multiplied without bound.

**Files:** `js/site.js`, `js/manifest.js`, `js/app.js`, `js/publish.js`, `js/swarm.js`, `js/config.js`; proposed `tools/security-unit.mjs`.

**Done:** oversized metadata is rejected before `arrayBuffer`; deceptive lengths are caught while reading. Navigation cancels work and releases buffers/streams. Budget exhaustion produces honest unverified/budget-exceeded state, not a false signature failure or success. Compatible digest vectors still pass.

### T08 — Bound peer update processing

**Depends on:** T16. **Owner:** protocol maintainer.

Apply per-wire/torrent/gate admission, deduplication, rate and concurrency controls before author waits/crypto. Bound dedup/rejection logging too. Settle or cancel pending readiness on failure/disposal; stop existing callbacks, not only future wire attachment.

**Files:** `js/updates.js`, `js/app.js`, `js/record.js`, `tools/seed.mjs`, proposed unit tests.

**Done:** deferred-author and repeated-record fixtures cannot exceed approved bounds across many wires. Legitimate normal/late-handshake successors still work. Timeouts and disposal create no stale UI changes or unhandled rejections.

### T09 — Consent, minimization and scoped erasure

**Depends on:** T02. **Owner:** browser/storage maintainer.

Default author recognition to memory, with explicit consent for persistent recognition/history distinct from Keep. Preserve a distinction between declarations and verified authors. Inventory and minimize all owned metadata. Add a legacy keep/delete choice and explicit per-site Forget, full privacy reset and key-removal operations.

**Files:** `js/authors.js`, `js/app.js`, `js/me.js`, `js/idb.js`, `js/keep.js`, `js/diagnostics.js`, `js/policy.js`, `index.html`.

**Done:** reading without consent leaves no persistent browsing metadata. Cooperative tabs quiesce writes and close stores before erasure. Blocked/failed deletion is shown as incomplete, not success. Cleanup touches only owned namespaces/scopes, never unrelated applications. Other origins need their own acknowledged cleanup. Full erase cannot immediately recreate data from loaded torrents. Removing local version memory explicitly loses local replay/freshness history; the UI states this trade-off.

### T10a — Repair local key deletion/lock semantics early

**Depends on:** T02. **Owner:** browser/storage maintainer.

Expose deletion failures, invalidate pending signing actions and coordinate cooperative tab lock/sign-out. Correct retained-handle and historical-signature claims. Do not introduce new enrollment or new ambient signing authority on the legacy origin.

**Files:** `js/me.js`, `js/idb.js`, `js/app.js`, `SECURITY.md`.

**Done:** failed deletion cannot appear successful; normal tabs stop using a locked identity. A disposable retained-handle test documents that deletion does not revoke it. Potential compromise instructions recommend retirement, not a promise of repair by deletion.

### T10b — Introduce the approved constrained signer boundary

**Depends on:** T05, T09, T10a. **Owner:** security/browser maintainer; G2 approval required.

Keep keys in the approved trusted signing context. Require trusted user presence and a one-shot, expiring approval bound to exact canonical bytes, purpose, identity and series. The content bridge exposes no signing operation. Invalidate approvals when content or session state changes. Migrate keys only through explicit trusted import/re-derivation; never blindly auto-transfer legacy shared-origin keys.

**Files:** `js/me.js`, `js/identity.js`, `js/idb.js`, `js/app.js`, `js/manifest.js`, `js/record.js`; proposed `js/signer.js` and approved static signer surface.

**Done:** hostile renderer messages/clicks/replays cannot sign or approve signing. Changed bytes require new approval. Enrollment/signing are unavailable until the trusted surface is established and legacy-context migration requirements are satisfied. Retaining a potentially compromised identity is never presented as making it safe again.

### T11 — Secure native status without breaking Docker

**Depends on:** T01. **Owner:** seeder/deployment maintainer.

Default native binding to loopback; provide explicit validated host configuration. Separate minimal health from detailed inventory and remove unnecessary CORS. Configure the container listener explicitly for bridge networking while keeping Compose's host publication on `127.0.0.1`.

**Files:** `tools/seed.mjs`, `deploy/seeder/docker-compose.yml`, `deploy/seeder/Dockerfile`, `deploy/seeder/.env.example`, `.github/workflows/seeder.yml`, deployment docs.

**Done:** native status is not unexpectedly reachable on external interfaces. Health contains no magnets/keys/inventory; unknown routes do not disclose inventory. Docker health and loopback host access both pass tests. Remote inventory requires explicit deployment/authentication guidance. Health does not falsely claim end-to-end peer reachability.

### T14 — Activate secure identity enrollment

**Depends on:** T10b. **Owner:** signer/protocol maintainer.

Recommend a generated 256-bit CSPRNG recovery secret fed through unchanged identity derivation. This strengthens new enrollment without silently changing old public keys. Algorithm/vector preparation can happen after T01, but activation waits for the trusted signer. Random-key enrollment with encrypted import/export is a separate format decision, not a prerequisite for this compatible approach.

**Files:** `js/identity.js`, trusted enrollment UI, `js/me.js`, `tools/seed.mjs`, documentation/tests.

**Done:** secrets are generated only with secure randomness, shown only in trusted UI, never automatically copied/logged/stored in plaintext, and require backup confirmation. Legacy derivation vectors and browser/seeder interoperability pass. A publishing-secret backup is clearly distinguished from an independent compromise-recovery authority.

### T12 — Qualify the isolated release

**Depends on:** T06, T08, T10b, T11, T14. **Owner:** security QA + independent reviewer.

Run the production topology through the full local cross-engine matrix. Include ordinary reading, relative resources, second-browser publishing, opted-in Keep, signatures and second-mirror behavior as well as attack fixtures.

**Files:** `tools/e2e.mjs`, proposed browser/unit security runners, `package.json`, `package-lock.json`, proposed `docs/security-test-results.md`.

**Done:** each invariant has observed evidence on every supported cell. Record real provenance for finding 004 without pretending the original bypass was reproduced. A failing engine/feature is blocked. No release passes merely because CSP warnings appeared or a happy-path page rendered.

### T13 — Prepare staged release and rollback controls

**Depends on:** T01. **Owner:** release maintainer.

Prepare compatible-version manifests/checks, migration notices, per-release test checklists and safe rollback procedures early. This task does not defer all shipping until T12. R0/R1/R2 below have separate approvals. Compare [release strategy alternatives](#release-strategy-alternatives) before changing that sequence.

**Files:** `js/config.js`, worker lifecycle/version touch points, deployment configuration, `.github/workflows/seeder.yml`, README/SECURITY/protocol docs; proposed `docs/security-rollout.md`.

**Done:** releases are promoted only after their scoped tests. Rollback never restores old grants, unsandboxed fallback, ambiguous responder authority or silently restored keys. A compatible safe scripts-off build is retained; otherwise disable affected rendering/signing rather than reinstall vulnerable behavior. Destructive erasure is not automatically reversed by rollback.

### T15 — Design, implement and adopt rotation/recovery separately

**Depends on:** T06, T10b, T14; **G3 approval before protocol code**. **Owner:** protocol/security maintainers.

1. Specify versioned routine-rotation and independent recovery-authority enrollment/records, scopes, sequence/conflict rules and reader adoption.
2. Approve the threat model and compatibility decision. Old-key authorization alone is not compromise recovery.
3. Implement reader verification/state transitions, constrained signer operations, peer transport and seeder support without rewriting old signed bytes.
4. Test competing rotations, replay/downgrade, recovery-authority mismatch, compromised old keys, unenrolled identities and offline/legacy readers with disposable keys.
5. Roll out opt-in enrollment/adoption separately, documenting who can enforce retirement and when.

**Files:** `spec/mutable-sites.md`, `js/identity.js`, `js/record.js`, `js/updates.js`, `js/authors.js`, `js/me.js`, `js/app.js`, `tools/seed.mjs`, tests.

**Done:** approved versioned behavior is implemented and tested, and adoption requirements are visible. No retrospective/global revocation guarantee is made. Until then D10 remains **gated, not completed**, even if R2 ships.

## Releases, dependencies and parallel work

| Release | Required work | Qualification and rollback |
| --- | --- | --- |
| R0 — containment | T01, T02, T13 | Prior-grant/fallback, core static flow and mixed-version tests; close/reload guidance. Roll back only to a verified scripts-off containment build or disable affected features. No G1/G2 dependency. |
| R1 — independent durable controls | R0, T07, T08, T09, T10a, T11 | Each control's regression/measurement evidence; blocked-erasure and old-profile migration tests. Independent components may ship incrementally with this same scoped gate. No topology dependency. |
| R2 — isolated gate/renderer/signer | R1, G1/G2, T12 | Full production-topology browser matrix and independent boundary review. Preserve identity/signature compatibility. Disable affected features on rollback rather than revive the legacy architecture. |
| R3 — rotation/recovery adoption | R2, G3, T15 | Versioned protocol/adoption tests and explicit legacy/offline limits. Reverting UI cannot undo published records; rollback stops new enrollment/issuance while preserving required verification/history. |

After T01, containment, the isolation spike, resource measurement, native-status work and release preparation can run in parallel. After T02, privacy and local key-lifetime work can run independently of G1/G2. T07 and T08 follow approved budget measurements. New secret enrollment does **not** run ahead of signer isolation.

## Definition of completion and unresolved decisions

- **R0/R1 can be implemented without resolving the final topology.** They reduce exposure but do not mean origin isolation is finished.
- **R2 is blocked** until measured bridge feasibility, supported browser/host matrix, origin naming/privacy, signed-root policy and signer trust location are approved.
- **R3 is separately blocked** on rotation/recovery protocol approval and reader-adoption semantics.
- Active scripted content is not a deliverable of this plan. Re-enabling it requires another explicit security contract and review; separate origins or CSP alone cannot justify a zero-egress claim.
- No task introduces discovery, human-readable aliases, identity-only resolution, anonymity, a central backend, gate TOFU pinning or a new always-on backbone.

The plan is ready for **containment and independent-control approval**; architectural and protocol blockers remain explicit. See the [additional backlog](security-additional-backlog.md) for verification, defense-in-depth and operational work supporting each release.

## Solution trade-offs and alternatives

These comparisons explain the recommendations; they do **not** approve replacements or change the task dependencies. **Recommended** means the proposed direction, still subject to its stated gate. **Gated** requires feasibility/security or product approval. **Partial** does not complete the corresponding durable feature. Every viable option must retain finite budgets, truthful attribution and explicit trust boundaries.

The catalog links to each comparison. T01/T03/T12 testing choices are also covered by [A02](security-additional-backlog.md#a02-browser-verification); independent design approval by [A03](security-additional-backlog.md#a03-independent-review); T13 rollout alternatives appear at the end of this section. No new benchmark or browser-compatibility claim is implied by the tables.

### D1 Policy enforcement

**Recommendation:** enforce scripts-off independently in worker and viewer, with compatible-version checks and explicit failure states (T02).

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended: effective policy plus version interlock** | Overrides legacy grants; covers multiple entry paths; supports incremental secure releases. | More lifecycle and mixed-version testing; rejects script-dependent sites and unsupported browsers; cannot neutralize already-running hostile tabs. | R0 containment and a lasting fail-closed policy mechanism. |
| Permanently script-free distribution with the grant machinery removed | Fewer policy branches and accidental re-enable paths; simpler long-term maintenance. | Permanently gives up script support; still needs worker-version checks and fixes for scripts-off egress/provenance. | Viable if the product commits to static-only content; not a replacement for D2/D3. |
| Suspend all rendering until the isolation release qualifies | Avoids relying on the vulnerable viewer while redesigning; simple incident containment. | Largest availability loss; leaves users unable to read even benign static sites for longer. | Emergency alternative when a safe partial release cannot be demonstrated. |

Hiding the toggle or deleting grants without worker enforcement is **rejected**: it cannot establish the intended policy.

### D2 Rendering topology and origin names

**Recommendation:** prove a per-torrent/per-view origin boundary and narrowly authorized byte adapter before choosing deployment (T03–T05, G1).

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended candidate: distinct origins with opaque labels and a scoped bridge** | Separates gate and torrent authorities; avoids putting the literal hash in routine hostname metadata; preserves a static deployment in principle. | Additional DNS/TLS/provisioning and worker lifecycle; origin proliferation and cleanup; cross-origin serving adapter must actually work. Opaque names do not defeat host compromise or traffic correlation. | G1-gated default candidate, not an already-proven implementation. |
| Finite origin pool, exclusive assignment, quarantine on uncertain cleanup | Bounded host configuration; potentially avoids unlimited origin allocation. | Hard capacity ceiling; old workers, storage or live contexts can contaminate reassignment. Unprovable cleanup means the slot cannot be reused. | Gated alternative only if lifecycle tests prove isolation; never silently share occupied slots. |
| Permanently provisioned separate origins for a limited set of torrents | Stable ownership and no cross-torrent origin reuse; easier to audit a small deployment. | Manual provisioning, certificates and maintenance; poor fit for opening arbitrary new torrents immediately. | Gated small/private deployment alternative, not equivalent general-purpose usability. |
| Hardened single-origin, permanently scripts-off viewer | Lowest hosting complexity; retains simple mirrors and much current resource serving. | No browser origin boundary; relies on explicit worker controls and continuous prohibition of active content. | **Partial:** possible containment/product alternative, not completion of D2 as planned. |

**Origin naming is a separate choice:**

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended candidate: opaque allocated labels** | Does not directly encode the content hash in DNS, Host or TLS metadata. | Requires a trusted mapping and lifecycle; may add origin churn; does not hide IP, timing or mappings from a compromised trusted application. | G1 privacy-first candidate. |
| Deterministic hash-derived hostname | Simple stable mapping; easier routing and troubleshooting. | Reveals a directly identifying hash, or an enumerable deterministic derivative, outside the URL fragment. | Gated only with explicit privacy-contract approval; never claim fragment-only content-reference privacy. |
| Fixed opaque hostname permanently assigned to each supported torrent | Stable without directly publishing the hash in the hostname; little churn. | Linkability over time and eventual mapping discovery; finite/manual assignment or additional allocation infrastructure. | Gated limited-scale alternative. |

One shared second origin with active scripts is **not** cross-torrent isolation. Removing `allow-same-origin` without proving worker compatibility is also not an accepted shortcut.

### D3 Worker and bridge authorization

**Recommendation:** authenticate owner channels and bind every request to a view/hash/root/epoch, rejecting unknown provenance (T04–T05).

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended: scoped MessagePort capabilities** | Explicit delegation; content receives only assigned operations; easy to invalidate a view's channel. | Bootstrap authentication, replay handling, port cleanup and restart recovery are security-critical; a transferred port alone does not prove trusted identity. | Preferred design candidate under G1, with origin/source checks and narrow authority. |
| Worker-owned authorization registry with validated client/request identifiers | Central policy lookup; explicit allow/deny audit trail; fewer privileges conveyed as transferable handles. | Navigation identifiers and restart state vary by browser; registry expiration/races need careful treatment. Referrers cannot substitute for identity. | Viable if T03 proves the required browser-backed identifiers on every supported path. |
| Separate registered serving owner for each view rather than one multiplexed owner | Reduces accidental cross-view routing; smaller authority per owner and simpler disposal. | More contexts/channels and potentially more networking overhead; still requires authenticated bootstrap and finite owner counts. | Gated alternative where simplicity of individual owners outweighs runtime cost. |

These patterns can be combined. URL matching alone, first-responder broadcasts and treating missing provenance as the gate are **rejected**, not cheaper equivalent authorizers. All options must block content's non-torrent network fall-through.

### D4 Signature scope and attribution

**Recommendation:** confine a verified view to one signed root and bind its badge to that root and view generation (T06, G2).

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended: signed-root confinement** | Preserves existing manifest bytes; clear relationship between badge and serveable files; rejects unsigned sibling mixing. | Breaks links/resources that escape the signed root; requires explicit new-view handling and navigation tracking. | G2 default recommendation for existing root-scoped signatures. |
| Require signature coverage of the entire torrent | Simple whole-torrent attribution rule; every serveable file must be covered. | Existing partial/subtree signatures may become insufficient; publishing/verification compatibility must be specified without rewriting old hashes. | G2 alternative if stricter packaging is acceptable. |
| Per-document/resource provenance with explicit mixed-content attribution | Supports multi-root packages and separately signed components; more flexible linking. | Much more verification/UI state; mixed authors must never receive a blanket verified badge; higher testing and maintenance cost. | Gated larger redesign, not a shortcut to the current scope fix. |

For display timing, the plan's **scripts-off progressive rendering with a checking badge** gives faster reading but shows content before authorship is established. **Verify-before-display** gives a stronger admission rule but delays or blocks large/offline-incomplete sites and must obey D5 budgets. It is a viable stricter policy, not a substitute for root confinement or protection from a malicious legitimate author.

### D5 File and peer-work budgets

**Recommendation:** enforce pre-read and actual-byte caps, finite aggregate budgets, cancellation and bounded update processing (T07/T08/T16). T16's numbers remain provisional, not measured guarantees.

**File verification:**

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended initial implementation: capped buffered hashing** | Uses existing WebCrypto and known vectors; small dependency footprint; predictable managed-buffer ceilings. | Large files cannot be automatically verified; whole-file buffers remain within the cap; may require a second read or an explicit retry. | R1 starting point when streaming cannot yet be justified. |
| Reviewed incremental hashing with bounded streams | Smaller working buffers; can verify larger honest files. | New implementation/dependency and compatibility review; browser `subtle.digest()` is not a streaming API. Total byte/time limits remain essential. | Viable upgrade after measurements show the benefit outweighs maintenance cost. |
| User-initiated verification with finite hard limits | Avoids unsolicited full-site hashing/download work; makes resource expenditure explicit. | More friction and more content remains unverified; user consent cannot override hard safety ceilings. | Product-policy alternative that still needs metadata prechecks and honest attribution. |

**Peer updates:**

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended: bounded queues, deduplication and layered rate limits** | Handles short bursts while limiting aggregate CPU/memory; preserves ordinary update delivery. | More configuration/fairness logic; dedup/logging structures themselves need limits. | R1 default across wire, torrent and gate scopes. |
| Small bounded serial FIFO with overflow rejection | Simple concurrency model and easy-to-test ceilings. | Duplicate work and head-of-line blocking can delay a legitimate update; fairness across peers still needs enforcement. | Viable conservative implementation with gate-global limits. |
| Drop updates until author readiness, then negotiate re-offers | Avoids retaining unauthenticated early candidates. | Needs a proven retry/re-offer path and compatibility behavior; current one-time offers could otherwise be lost. | Gated protocol/transport alternative, not a drop-in replacement. |

Do not treat an unverified claimed sequence as authority when prioritizing queued records. Per-message limits alone and unbounded consent overrides are **rejected**.

### D6 Metadata consent and erasure

**Recommendation:** memory-only recognition by default, explicit persistent consent and scoped, acknowledged deletion (T09).

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended: session default plus granular persistent opt-in** | Matches no-history expectations until consent; retains optional recognition and version history; separates Keep from tracking metadata. | Consent and migration UX; deleting version memory weakens cross-session replay/freshness knowledge; cross-tab cleanup is complex. | R1 default. |
| Never persist reading/author history at all | Smallest durable reading trace and simpler deletion policy. | Loses cross-session author recognition and remembered update floors; publishing/kept-content storage still requires separate rules. | Viable privacy-first product alternative. |
| Opt-in encrypted local history unlocked explicitly | Can reduce disclosure from copied storage when the unlock secret is absent. | Key/KDF and recovery complexity; active unlocked code can read it; does not protect against compromised gate code or guarantee forensic deletion. | Optional gated extension, not a reason to persist by default. |

For all options, application deletion is logical cleanup—not a promise that browser backups, disk remnants, other origins or hostile retained copies vanished. A timeout must remain an incomplete operation.

### D7 Signer location and key lifetime

**Recommendation:** a trusted top-level signer, preferably independent of arbitrary gate mirrors, with exact-operation approval and cooperative lock/sign-out (T10a/T10b, G2).

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended: separate trusted signer origin** | Content and gate mirrors do not directly own keys; approval can show the exact identity, purpose and bytes in a trusted surface. | Another trusted deployment and cross-origin protocol; context-switch friction; must prevent clickjacking and arbitrary signing requests. | G2 default candidate, without a mandatory shared central signer. |
| Signer co-located with a trusted gate, but isolated from content | Simpler static deployment and UI; fewer cross-origin handoffs. | A compromised/malicious gate or mirror still controls signing; stronger gate-trust assumption must be accepted explicitly. | G2-gated alternative, never co-located with untrusted content. |
| Local CLI/offline signing with explicit artifact transfer | Keeps browser origins away from signing secrets; can reuse compatible signing formats. | Loses one-click browser signing; local host and transfer/approval workflow become trust boundaries. | Viable alternative for high-assurance publishers or when a trusted browser signer is unavailable. |

Hardware-backed signing is a possible later variant, but arbitrary Ed25519 record signing is **not** automatically supplied by WebAuthn; device/API compatibility and trusted approval need separate evaluation. Browser user-presence guarantees also do not apply to an intentionally unattended seeder. Regardless of signer location, deleting a record cannot revoke previously retained handles or issued signatures; compromise recovery belongs to D10.

### D8 Status and monitoring access

**Recommendation:** native loopback defaults, minimal health and separate inventory, with explicit container binding (T11).

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended: local HTTP health and explicitly exposed inventory** | Familiar monitoring tools; least-surprising native default; small changes to current Docker checks. | Loopback is not authentication against local processes; bridge/listener configuration and endpoint separation need testing. | R1 default. |
| Process-local or permissioned Unix-socket health/inventory | Removes a default network listener; operating-system permissions constrain access. | More platform-specific tooling; current HTTP health checks/integrations must change; socket permissions remain sensitive. | Viable local-only operations alternative. |
| Explicit TLS/authenticated remote monitoring endpoint | Supports centralized operations across hosts. | More credentials/certificates and service configuration; exposes metadata to authorized monitors; CORS is not an authorization mechanism. | Optional deployment alternative, not the default or a required gate backend. |

For Docker, a container may intentionally listen on `0.0.0.0` while the host publishes only on loopback. A native loopback-only listener cannot simply be imposed inside bridge networking without testing reachability.

### D9 Identity enrollment

**Recommendation:** generate a 256-bit recovery secret in the trusted signer and retain existing derivation for compatibility (T14).

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended: generated secret through existing derivation** | High entropy without changing existing identity/signature formats; browser/seeder interoperability; minimal new cryptographic machinery. | Awkward to transcribe; backup discipline is essential; existing derivation still has its computation cost. A stolen backup controls the identity. | Default after T10b, never new enrollment on the unsafe legacy surface. |
| Random key/seed with reviewed encrypted export/import | Avoids deriving new identities from human phrases; portable, explicitly protected backup format. | New encryption/import format, secret management and compatibility tests; weak backup passwords can reintroduce offline guessing. Non-extractable keys need a deliberate backup lifecycle. | Gated alternative requiring a separate format decision. |
| Import a securely generated external high-entropy secret | Allows independent/offline generation and compatibility with current derivation. | Browser cannot infer generation entropy from appearance; transfer and backup errors; more setup and source trust for users. | Viable advanced-user alternative with explicit provenance guidance. |

Human-chosen phrases remain a legacy compatibility path, not the preferred new-enrollment solution. Character count alone is not an entropy guarantee. None of these backups is an independent compromise-recovery authority.

### D10 Rotation and compromise recovery

**Recommendation:** versioned routine rotation plus a separately pinned, preferably offline recovery authority (T15, G3).

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended candidate: independent recovery key** | Can distinguish authorized recovery from statements by a stolen publishing key when enrolled beforehand; smaller model than multi-party recovery. | Another critical secret and enrollment process; loss/theft of recovery key; conflict, downgrade and reader-adoption semantics need design. | G3-gated compromise-recovery candidate; no retroactive/global guarantee. |
| Threshold recovery across multiple independent custodians/keys | Can tolerate some key loss or individual compromise; no single recovery key necessarily controls the identity. | Substantially more protocol, custody, availability and coordination complexity; no existing implementation to assume. | Gated higher-assurance alternative, not required for R0–R2. |
| Retire the identity and distribute a new fingerprint out of band | Minimal new protocol; works without pretending the stolen key can restore trust. | Loses automatic continuity; readers must independently adopt the new identity and may keep trusting the old one. | Valid incident response and deferral option, but **partial** rather than completion of in-protocol recovery. |
| Routine old-key-authorized rotation only | Simple continuity for planned key changes while the old key remains trustworthy. | A thief with the old key can authorize a competing replacement; cannot settle compromise. | **Partial:** useful routine feature, not compromise recovery. |

Any recovery design must state what legacy/offline readers cannot enforce. UI rollback cannot retract already published signed records.

### Release strategy alternatives

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| **Recommended: R0 containment, R1 independent controls, then gated R2/R3** | Reduces exposure sooner; smaller changes to review; architecture/protocol uncertainty does not block basic fixes. | More intermediate version/migration states and repeated release qualification; partial security status must stay visible. | Current plan; T13 prepares safe rollback from the start. |
| Freeze affected features and deliver one coordinated security release | Fewer intermediate migrations; one coherent architecture to qualify. | Longer interruption and larger review/change set; no early benefit from independent features while frozen. | Viable when safe incremental versions cannot be maintained. |
| Parallel isolated beta on a fresh origin, with the old deployment kept at R0/R1 | Exercises clean-state boundaries before broad migration; limits initial blast radius. | Duplicate deployments, user confusion and origin-specific state/key migration; cannot silently copy compromised legacy keys. | Gated rollout variant alongside staged releases, not permission to leave old script grants enabled. |

All release alternatives require scoped regression evidence and rollback to a safe state. Restoring the vulnerable legacy behavior to recover availability is **rejected**.
