# Security regression baseline

These tests assert the **secure outcome**, not today's vulnerable behavior. They are intentionally red on the current implementation. Fixing a finding should turn its tests green without weakening their assertions. Application security code has not been changed to satisfy them.

## Run

Requirements: **Node 22.15+** (or Node 24+) and an installed Chrome/Chromium for browser cases. The seeder test preload uses `module.registerHooks`. The browser suite reuses the project's Puppeteer and tracker dependencies; there is no new test framework.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:security

# Separate layers
npm run test:security:unit
npm run test:security:browser
npm run test:security:seeder

# When Chrome is not at a detected macOS/Linux location
CHROME=/path/to/chrome npm run test:security:browser

# Optional visible browser
SECURITY_HEADFUL=1 npm run test:security:browser

# Focus a finding; options precede the test-file argument
node --test --test-name-pattern='SPORE-006' tools/security/browser.test.mjs
```

No native WebRTC addon build is needed for these suites: the browser uses its own WebRTC, and the seeder test uses an explicitly offline adapter. `--ignore-scripts` here is sufficient for **these tests**, not a claim about the existing server-seeder tool or legacy e2e suite. For a constrained CI container only, `SECURITY_NO_SANDBOX=1` can disable Chromium's process sandbox; do not use that option for ordinary browsing.

`npm test` remains unchanged. Its older script-opt-in expectations are not a substitute for the new secure-contract suite. `test:security` returns a nonzero exit code while any assertion fails; it does not convert expected vulnerabilities into success, `todo`, or skipped tests.

## What is executed

| Layer | Production behavior exercised | Test boundary |
| --- | --- | --- |
| `unit.test.mjs` | Actual `sw.js` registered fetch handler; actual site readers, update extension, and signature verification | Worker client/events/ports are simulated; small fake files and fake peer messages; no network |
| `browser.test.mjs` | Actual gate, vendored WebTorrent, worker responses, sandbox/CSP, signatures, IndexedDB and localStorage | Disposable browser contexts; loopback static host/tracker; folder input is supplied through the real `publish()` API |
| `seeder.test.mjs` | Actual `tools/seed.mjs` entry point, temporary filesystem restore/publication and real HTTP responses | Offline torrent/WebRTC adapter; native listen **request** recorded, then actual socket forced to an ephemeral loopback port |

The worker script is evaluated intact, not extracted with a regex or replaced with a duplicate implementation. The browser server changes only the served tracker configuration; no production source file is edited. Single-file browser fixtures get a harmless second file to avoid an unrelated publisher naming behavior that would otherwise open a listing instead of HTML.

## Finding-to-test map

| Finding | Secure behavior asserted | Evidence/qualification |
| --- | --- | --- |
| SPORE-001 | Content cannot alter/read gate DOM/storage, use a remembered signing key, or borrow parent WebSocket authority | Real inline fixture scripts run only if the application's stored permission permits them. Browser-driver evaluation only inspects outcomes; it is not the attacking script. Turning scripts off is valid containment. |
| SPORE-002 | A failed sandbox capability probe overrides an existing script grant | Chromium probe observation is deliberately simulated as unsupported, followed by actual fallback consent/UI/policy. This is **not** a native WebKit test. Explicit refusal to render is acceptable. |
| SPORE-003 | Content cannot cause non-torrent host requests | Browser image/CSS requests are counted at the loopback host, including referrers. Worker unit cases also cover pass-through decisions; a simulated external request does not claim CSP would permit it in a browser. |
| SPORE-004 | Missing identity is denied; a referrerless nested frame cannot display another torrent | Both simulated FetchEvent cases and a real Chromium nested-navigation case. Loading a second document is distinct from attacker-JavaScript read access. |
| SPORE-005 | An unauthorized window cannot win content/policy response authority | Deterministic worker-client race, with trusted response delayed. This tests protocol authorization, not browser-specific client eligibility. |
| SPORE-006 | An unsigned sibling cannot appear beneath a retained verified badge | A real signed subtree contains a preexisting escaping link; unsigned sibling is outside its manifest. The test requires completed navigation or explicit scope rejection, not a short sleep with the original page still visible. |
| SPORE-007 | Content cannot use a gate key; deletion errors are visible; cooperative other-tab sessions lock | Real disposable keys/storage, injected failed deletion transaction, two actual gate tabs. A separate passing characterization explicitly shows that deleting a record cannot revoke a retained CryptoKey. |
| SPORE-008 | Size limits apply before metadata/file reads | Small fake metadata files count `arrayBuffer` calls. Browser application verification also receives a tiny signed file with an intentionally oversized advertised length/read adapter; it allocates no huge payload. |
| SPORE-009 | Pending messages and signature-verification work are bounded | A modest 64-record fake-wire batch, deferred author readiness and instrumented real crypto. Both admitted lookups and pending completions are observed; peak crypto work includes late completions. |
| SPORE-010 | Reading without consent leaves no author history; reset erases owned metadata, preserves unrelated data and reports blocked deletion | Real localStorage, Cache Storage and IndexedDB in disposable profiles; no actual user profile is touched. |
| SPORE-011 | Native status requests loopback, public health omits inventory/CORS, unknown routes reject | Production HTTP handler with current/retained disposable versions. Adapter hashes identify fixtures, not real torrents. Instrumented bind request is **not** an actual wide-interface reachability test. |

### Proposed budgets, not measured production constants

The resource cases use the security plan's provisional ceilings: one unresolved candidate per wire, two concurrent crypto verifications, and 16 MiB per automatically verified file. Metadata limits retain the existing 4 KiB/512 KiB values but require enforcement before reading.

These cases expose absent controls; they do not establish full cross-wire/tab fairness, every global resource cap, or an OOM threshold. If T16 measurements approve different finite limits, change the explicit test contract with that decision—not merely to accommodate failing production code.

## Initial observed baseline

Run with Node **24.6.0** and Chrome **152.0.7977.83**. All listed security failures were assertion failures, not missing-dependency, startup, timeout, cancellation, or skipped-test results.

| Suite | Cases | Passing controls | Failing secure assertions |
| --- | --- | --- | --- |
| Browser | 16 | 3 | 13 |
| Worker/module unit | 17 | 6 | 11 |
| Seeder | 6 | 1 | 5 |
| **Total** | **39** | **10** | **29** |

Positive controls prove ordinary resources render, default scripts are off, genuine manifests verify, changed content fails signature checks, gate/self reads work, identified cross-torrent reads fail, small metadata remains readable, authentic updates work, malformed signatures fail, and status-disabled seeding can start without a listener.

The retained-handle control deliberately passes when signing still works after key-record deletion. That is a browser capability lifetime fact, not an expected-to-fail regression or a claim the key-access flaw is fixed. Prevention must stop content obtaining the handle; compromise response cannot rely on deleting one record.

**New evidence relative to the source-only review:** this Chromium run displayed the second torrent in the referrerless nested-frame fixture and retained verified attribution after the signed-root escape. That does not establish the behavior on Firefox/WebKit, nor prove script-readable cross-torrent access. The baseline is not consulted by the runner and cannot make a failing test green.

## How to use the suite during fixes

1. Run the relevant finding and its positive controls before changing production code.
2. Implement enforcement, then rerun the focused cases and the complete security suite.
3. Check that a green result came from the intended boundary, not disabled verification, broken fixtures, missing dependencies or a hidden exception.
4. Keep secure assertions when architecture changes. Adapt the transport/bootstrap fixture if APIs or origins change; do not authorize the hostile fixture merely to make a test pass.
5. Extend the browser matrix and add global-budget/replay/cancellation cases before claiming completion of the broader [implementation plan](../../docs/security-implementation-plan.md).

The separate-origin bridge, new enrollment and recovery protocol are not yet implemented and are not certified by this baseline. Firefox/WebKit and alternate static-host topologies still need qualification. These tests cover the reviewed issues, not every possible security weakness or every proposed alternative.

## Safety and teardown

- Fixtures use loopback endpoints, random disposable keys, temporary seeder directories and fresh browser contexts. No real credentials or remote exploit collectors are used.
- The browser tracker is local; injected page WebRTC configuration removes STUN servers, page WebSockets are restricted to that tracker, and page request interception denies non-fixture destinations. Public trackers are never a fallback.
- **This is not OS-level network isolation.** Those page mechanisms do not automatically constrain dedicated/service workers or every browser background service. Current fixture payloads do not attempt those routes. Before adding worker-originated attack probes, use verified worker-target interception or a process/network sandbox; use network-level isolation if a hard no-egress guarantee is required.
- Browser startup, profile teardown and global shutdown have deadlines; cleanup attempts the remaining servers even if browser closure fails. Seeder children are stopped on failure and all temporary data removed. Unit ports/timers and crypto mocks are restored.
- Logs can contain disposable fixture hashes and local addresses. They contain no user secrets, but should not be confused with a production privacy-safe telemetry format.
