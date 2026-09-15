# Additional security work

Companion to [the durable security implementation plan](security-implementation-plan.md).

Here, **additional / non-durable-feature work** means containment, defense-in-depth, verification, or operations rather than a root-cause architectural feature. Many of these controls should remain permanently. “Additional” does not mean optional when an item is a release gate.

Priorities: **P0** containment release; **P1** required for the relevant durable release; **P2** ongoing hardening. These are proposed work items, not completed controls or newly discovered vulnerabilities.

| ID | Priority | Implementation | Completion evidence |
| --- | --- | --- | --- |
| [A01](#a01-containment) | P0 | Disable all effective script grants, including old persisted permissions; remove unsandboxed compatibility rendering. Publish close/reload and potentially exposed-key guidance. | Prior-grant/fallback and mixed-version tests pass. Unsupported rendering is unavailable, not silently weakened. Cross-reference T02: this is containment, not completion of origin isolation. |
| [A02](#a02-browser-verification) | P0/P1 | Build a local adversarial browser test suite, extending the existing Chrome tests with Firefox and WebKit. Use disposable keys and local endpoints only. | Actual network counters, worker provenance observations, parent/storage sentinels, signature-scope and migration tests pass for each supported browser/topology. A failing cell blocks release for that cell. |
| [A03](#a03-independent-review) | P1 | Independently review the renderer bridge, signer, authorization and migration boundaries before enabling them. Review future active-content mode separately. | Written findings are fixed or explicitly block release; no approval based solely on happy-path e2e tests. |
| [A04](#a04-response-headers) | P1 | Harden response headers: restrictive CSP, `nosniff`, `no-referrer` after provenance no longer relies on it, minimal browser capabilities, and unnecessary CORS removal. Protect gate/signer against embedding with host-delivered headers. | Tests inspect real response headers, including errors and navigation. Gate/signer anti-framing is not incorrectly implemented only in a CSP meta tag. Renderer headers still permit the approved embedding chain. |
| [A05](#a05-release-promotion) | P1 | Gate release promotion on tests. Pin release inputs, use the lockfile for container dependency installation, document vendored bundle provenance, and protect release credentials. | A failed smoke/security test cannot promote `latest` or a production release. Gate, worker and renderer versions are checked as a compatible set. Rollback selects a validated safe build. |
| [A06](#a06-dependency-maintenance) | P2 | Review dependency advisories and vendored WebTorrent updates regularly; inventory browser and Node dependency versions. | Maintainer-owned update procedure, recorded dependency review, and regression evidence for upgrades. No present CVE is asserted by this plan. |
| [A07](#a07-seeder-secrets) | P1 | Support appropriately permissioned secret files/mounts for the seeder; avoid secret arguments and redact diagnostics. Document that environment variables and files remain visible to sufficiently privileged host access. | A disposable signing secret never appears in command arguments, logs, status, URLs or error reports. Existing browser/seeder identity derivation remains compatible. |
| [A08](#a08-monitoring) | P1/P2 | Keep monitoring local by default; require an explicit authenticated remote inventory deployment. Separate local process/storage health from an optional end-to-end delivery check. | Health contains no content inventory; remote access is tested through the chosen firewall/proxy. Monitoring does not label `complete: true` as proof of browser reachability. |
| [A09](#a09-security-guarantees) | P1 | Reconcile README, SECURITY.md, protocol status and UI guarantees with the implementation. Cover history consent, verification scope, key lifetime, host trust, IP exposure and browser support. | Every security promise has an enforcement point and a test or a clearly stated limitation. Old “nothing implemented,” “no history,” and “forgetting revokes” claims are removed where inaccurate. |
| [A10](#a10-incident-response) | P1 | Write an incident/identity-retirement playbook and safe migration/rollback instructions. | A drill covers old tabs, blocked storage deletion, potentially retained key handles, malicious mirrors and communicating a replacement fingerprint through an independent trusted channel. It does not promise retroactive/global revocation. |
| [A11](#a11-bounded-fuzzing) | P2 | Add bounded fuzz/property tests for bencode, signature manifests, paths, update records, cancellation and protocol version mismatches. | Malformed input produces bounded work and explicit rejection, without live-peer floods or intentional browser OOM. Existing canonical-signature vectors remain unchanged. |
| [A12](#a12-reporting-and-releases) | P2 | Maintain a vulnerability-reporting and security-release checklist. | A documented reporting route, triage owner and release procedure exist; reports are not automatically published with sensitive reproduction details. |

## Approach trade-offs

The linked IDs above lead to comparisons below. **Recommended** retains the existing planned approach, not an already completed implementation; alternatives are choices for evaluation, not new scope commitments. Operational variants must meet the same completion evidence. Supplemental controls cannot replace release gates or durable boundaries. Permanent maintenance is compatible with “additional” work.

### A01 Containment

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: revoke effective grants, remove unsafe fallback, publish guidance | Closes known execution paths, including persisted permissions; gives affected users actionable steps. | Breaks active sites; cannot forcibly replace hostile mirrors or already running tabs. | R0 containment, not origin isolation. |
| Serve a maintenance-only gate until safe rendering ships | Simple deny-all boundary; reduces reachable code during emergency response. | Suspends normal browsing/publication; old tabs and mirrors still need guidance. | Stricter temporary containment alternative. |
| Deploy only the verified static-only renderer | Preserves useful browsing while eliminating active-content entry points. | Requires checking all fallback and migration paths; not merely hiding controls. | Conditional equivalent; retain exposure guidance. |

### A02 Browser verification

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: local adversarial Chrome, Firefox and WebKit suite | Repeatable negative tests; local counters expose actual egress without collecting user data. | Matrix maintenance and engine differences cost time; passes cannot guarantee all devices. | Required evidence for supported cells. |
| Containerized local CI browser matrix | Reproducible fixtures and parallel execution; retains disposable keys and local endpoints. | Containers may miss OS-specific behavior; engine packaging needs maintenance. | Automation variant, supplement with target-platform checks. |
| Scripted manual lab on target browsers/devices | Exercises real deployment and platform behavior with direct observations. | Slower, less repeatable; easy to miss regressions. | Supplemental or bounded cell evidence, not wholesale suite replacement. |

No remote collector, live exploit against users, or live-peer attack is needed by these options.

### A03 Independent review

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: independent boundary review before enablement | Challenges trust assumptions across bridge, signer, authorization and migration. | Reviewer availability and remediation delay releases; review cannot prove absence of flaws. | Required before relevant promotion. |
| Contract a specialist for a scoped assessment | Concentrated expertise; explicit deliverables and separation from implementers. | Costs money; snapshot assessment needs follow-up on changed boundaries. | Independent-review sourcing alternative. |
| Reciprocal review by independent project maintainers | Lower cash cost; practical implementation scrutiny and shared expertise. | Scheduling, confidentiality and relevant security competence need checking. | Valid with independence, scope and written findings; self-review alone rejected. |

### A04 Response headers

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: harden real responses and host-deliver anti-framing | Reduces injection, sniffing and capability exposure; covers document-level defenses. | Host configuration varies; errors/navigation need coverage and approved renderer embedding must work. | Defense-in-depth, never origin isolation. |
| Static-host header configuration files | Simple deployment artifact; little runtime machinery on supported hosts. | Syntax and error coverage differ by provider; mirrors must verify behavior. | Delivery alternative meeting identical header tests. |
| Operator-managed reverse proxy header policy | Central policy covers multiple upstream response paths. | Adds configuration responsibility; can conflict with upstream CSP or embedding. | Optional deployment variant, not a required backend. |

CSP meta cannot enforce `frame-ancestors`; neither meta nor response headers substitute for isolation. Remove referrers only after replacing provenance dependencies.

### A05 Release promotion

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: test-gated promotion with pinned inputs and provenance | Blocks known regressions before publication; records compatible gate/worker/renderer sets. | Requires credential protection and maintained checks; pinning does not remove update obligations. | Required promotion boundary. |
| Build candidate once, test it, then promote its immutable artifact | Avoids rebuilding different bytes after tests; simplifies validated rollback. | Needs artifact retention and precise identity checks during promotion. | Pipeline variant preserving all gates. |
| Protected manual promotion of a tested candidate | Human confirmation without elaborate automation; workable at low release frequency. | Approval can drift or be bypassed unless permissions enforce evidence checks. | Conditional variant; tests precede production/latest publication, never post-publication-only. |

### A06 Dependency maintenance

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: recurring advisory and vendored-version review | Covers browser bundles and Node dependencies; ties upgrades to regression evidence. | Ongoing maintainer effort; advisories miss undisclosed or unreported issues. | Ongoing hardening; no current CVE asserted. |
| Automated update proposals plus maintainer review | Faster discovery; small, traceable dependency changes. | Alert noise and lockfile churn; vendored bundles may need custom inventory. | Tooling variant, not unattended security approval. |
| Scheduled manual inventory and update windows | Minimal automation; supports carefully assessed vendored upgrades. | Slower response unless urgent advisories interrupt schedule; relies on ownership. | Operational variant with emergency updates; indefinite pinning rejected. |

### A07 Seeder secrets

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: permissioned secret files/mounts, redacted diagnostics | Avoids argument exposure; straightforward deployment and compatible identity derivation. | Privileged host access still reads secrets; filesystem permissions require care. | Baseline secret handling. |
| Local orchestrator secret mounts | Standardized injection and access permissions; avoids embedding secrets in images. | Adds operator/tooling dependence; node administrators retain access. | Deployment variant using existing infrastructure. |
| Read once from an inherited file descriptor | Avoids persistent application-managed secret files and command arguments. | Supervisor integration and restart handling are harder; memory remains accessible to privileged attackers. | Conditional input variant; same derivation and leak tests. |

### A08 Monitoring

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: local health, explicit authenticated remote inventory | Limits accidental disclosure; separates storage/process state from actual delivery. | Operators must configure remote protection and interpret distinct signals. | Safe default; delivery probes optional. |
| Local command checks through authenticated SSH | Reuses host access controls; no dedicated remote inventory listener. | Requires operator access and careful output handling; not browser-reachability evidence. | Operational alternative for remote administration. |
| Self-hosted proxy-protected monitoring with local synthetic browser probes | Central visibility; optional probe measures a real delivery path. | More infrastructure and probe upkeep; sampled success is not universal availability. | Explicit opt-in; no third-party telemetry requirement. |

### A09 Security guarantees

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: reconcile all published guarantees with evidence | Removes contradictory promises across docs/UI; makes limitations reviewable. | Cross-document drift returns without release ownership. | Required each release. |
| Maintain a claim-to-enforcement/test checklist | Traceable review coverage; lightweight Markdown workflow. | Manual upkeep; checklist completion alone does not establish truth. | Process variant covering every public surface. |
| Generate repeated support/limitation text from one reviewed source | Reduces duplication and version mismatch. | Adds generation tooling; prose and context still require human review. | Optional tooling alternative, not a substitute for reconciliation. |

### A10 Incident response

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: retirement, migration and safe rollback playbook with drill | Exercises old tabs, retained handles and hostile mirrors before crisis. | Cannot recall all content, erase remote copies or guarantee global revocation. | Required response preparation. |
| Checklist-led tabletop plus isolated disposable-profile rehearsal | Low operational risk; tests communication and failure decisions cheaply. | Less realistic than deployment rehearsal; must actually test storage/handle edge cases. | Drill variant when evidence covers required scenarios. |
| Isolated staging migration/rollback rehearsal | Validates release artifacts and operator steps end-to-end. | More setup; staging cannot reproduce every hostile mirror or user device. | Higher-fidelity drill alternative; independent fingerprint communication remains necessary. |

Backups aid recovery, not revocation; restoring a compromised identity is not retirement.

### A11 Bounded fuzzing

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: bounded property/fuzz tests across parsers and lifecycle | Explores malformed inputs and cancellation systematically; reproducible rejection evidence. | Budgets miss deep cases; incorrect properties can encode mistaken assumptions. | Ongoing local hardening. |
| Seeded property generators with shrinking in CI | Small reproducible counterexamples; predictable runtime. | Requires carefully designed generators and protocol invariants. | Practical tooling variant preserving canonical vectors. |
| Coverage-guided fuzzing in isolated scheduled jobs | Finds unexpected parser branches; reuses interesting corpus inputs. | Instrumentation and corpus maintenance cost; strict CPU/memory/time caps needed. | Complement or execution alternative; no live-peer floods or intentional browser OOM. |

### A12 Reporting and releases

| Option | Pros | Cons / limits | Fit |
| --- | --- | --- | --- |
| Recommended: private reporting route, triage owner, release checklist | Predictable intake and coordinated fixes without publishing sensitive reproductions. | Requires coverage, access control and ongoing responder attention. | Ongoing operational control. |
| Hosted repository private vulnerability reporting | Familiar workflow; restricted advisory collaboration and release coordination. | Provider dependency and account permissions require management. | Intake alternative where supported; no automatic public disclosure. |
| Dedicated security mailbox with restricted case tracking | Host-independent public contact; flexible confidential coordination. | Spam, key management and responder handoffs need procedures. | Intake alternative; retain triage ownership and security-release checklist. |

## Ownership and scheduling

Roles are assignments to make when implementation starts, not claims that people have already been allocated. R0–R3 are defined in the main plan.

| Item | Owner role | Milestone |
| --- | --- | --- |
| A01 | Browser maintainer + security lead | R0 |
| A02 | Browser security QA | Scoped tests at R0/R1; full matrix at R2; protocol additions at R3 |
| A03 | Independent security reviewer | Before R2 and R3 promotion |
| A04 | Browser + deployment maintainers | R1 where applicable; topology-specific headers at R2 |
| A05 | Release maintainer | R0 promotion safeguards; complete release-input checks by R1 |
| A06 | Dependency maintainer | Ongoing after R0; every dependency update |
| A07 | Seeder/deployment maintainer | R1 |
| A08 | Seeder/deployment maintainer | Safe local defaults at R1; optional delivery monitoring afterward |
| A09 | Feature owner + security reviewer | Every release, starting R0 |
| A10 | Security lead + release maintainer | R0 legacy guidance; full R1/R2 migration drill; R3 protocol response |
| A11 | Protocol/browser test maintainer | Ongoing after R1; known vulnerability regressions already required by A02 |
| A12 | Security lead | Ongoing after R0 |

## Where this work belongs

- **Browser tests and fixtures:** `tools/e2e.mjs`, proposed `tools/security-browser-matrix.mjs` and `tools/security-unit.mjs`, `package.json`.
- **Headers and deployment:** `sw.js`, `index.html`, `deploy/gate/nginx.conf`, topology-specific static-host configurations chosen at G1.
- **Release/dependencies:** `.github/workflows/seeder.yml`, `deploy/seeder/Dockerfile`, `package-lock.json`, `vendor/README.md`.
- **Secrets/monitoring:** `tools/seed.mjs`, `deploy/seeder/`, `deploy/README.md`.
- **Guarantees and response:** `SECURITY.md`, `README.md`, `spec/mutable-sites.md`, proposed security test/rollout documents.

## Controls that are not substitutes for the durable fixes

- Hiding the script toggle is not permission enforcement.
- CSP does not isolate same-origin active code from its parent.
- A non-extractable key is not a revocable signing capability.
- Removing an IndexedDB record is not proof that every live or hostile context lost access.
- A passing test suite is evidence, not the access-control mechanism itself.
- Checksums downloaded from a malicious mirror do not independently authenticate that mirror's code.
- No item here makes swarm participation anonymous or makes a browser seed while all its tabs are closed.
