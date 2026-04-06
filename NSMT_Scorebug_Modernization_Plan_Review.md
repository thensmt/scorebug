# NSMT Scorebug Modernization Plan Review

Date: April 6, 2026

This review is based on:

- the proposed modernization plan provided for review
- inspection of the active repo files `yolo-overlay.html` and `yolo-control.html`
- inspection of the launcher page `index.html`
- live checks performed on April 6, 2026 against:
  - `https://thensmt.github.io/scorebug/yolo-overlay.html`
  - `https://thensmt.github.io/scorebug/yolo-control.html`
  - `https://thensmt.github.io/scorebug/live/yolo-overlay.html`
  - `https://thensmt.github.io/scorebug/live/yolo-control.html`
  - `https://nsmt-scorebug.firebaseio.com/state.json`
  - `https://nsmt-scorebug.firebaseio.com/pin.json`

Verified live observations on April 6, 2026:

- the root GitHub Pages overlay and control URLs returned `200`
- the `/live/...` GitHub Pages URLs returned `404`
- `state.json` was publicly readable
- `pin.json` was publicly readable and returned `null`
- the live RTDB state payload was about `401,835` bytes
- live team logo data in RTDB was still stored as `data:image/...` URLs, with one observed logo string around `351,890` characters

## Executive Summary

The proposed plan is directionally correct, but it is not yet sufficiently specified in the areas that matter most: trust boundaries, session authority, and operational control during a live game.

The strongest parts of the plan are:

- recognizing that the overlay can be public while write/admin paths cannot
- moving to event-scoped data instead of a flat shared global state
- making `eventId` mandatory now instead of postponing it
- moving image assets out of Realtime Database and into Cloud Storage
- cleaning up the overlay layout with a preserved 16:9 scaled stage

The weakest parts of the plan are:

- Phase 1 owner/admin auth is still PIN-only
- owner/admin is embedded inside the public control surface
- the session model is underspecified
- the plan does not clearly solve single-writer authority during live operation
- Firebase Hosting is treated as a major improvement, but the real problem is not hosting, it is authorization and data access rules

Bottom line: the direction is mostly right, but the plan should not be approved as-is. It needs stronger security and operational definitions before implementation starts.

## Current-State Risk Summary

The current system's most dangerous failure is not the fixed-size overlay. It is the trust model.

Current repo findings:

- `yolo-control.html` reads `/pin` directly from Firebase
- PIN validation is performed in the browser
- a hard-coded master reset key exists in shipped client code
- if no PIN exists, the client enters PIN creation flow
- the control page writes directly to shared RTDB state paths from the browser
- the overlay reads the shared `state` tree directly
- logos and sponsor graphics are stored as base64/data URLs in RTDB
- the launcher page still points to legacy pages, not the active production pair

What must change first:

1. eliminate browser-side PIN validation
2. eliminate any public PIN path
3. remove the master reset key
4. move write authority behind backend-issued sessions and strict Firebase rules
5. stop using a single shared flat state tree for all future games

What is truly risky:

- public bootstrap of control authority when PIN is unset
- browser-side trust for operator and owner authentication
- publicly readable RTDB structure combined with direct browser writes
- no event isolation
- no explicit active-operator ownership model

What is merely inconvenient:

- fixed 1920x1080 overlay layout
- long GitHub Pages URLs
- legacy launcher links

## Plan Critique By Area

### 1. Overlay elasticity / resize behavior

Keeping the internal scene at `1920x1080` and scaling a single stage with preserved `16:9` contain behavior is the correct choice. That part should not be reconsidered.

However, the implementation details matter:

- the current overlay uses a fixed viewport and fixed `html, body` dimensions
- scene-relative animation effects currently attach to `document.body`
- score pop placement uses `getBoundingClientRect()`, which will be affected by scaling

The plan is good, but incomplete. It should explicitly require:

- removing fixed page dimensions as the rendering model
- introducing a true stage wrapper with transform origin and computed scale
- moving any scene-positioned effects into the stage coordinate system
- testing the final behavior on YoloBox, not just desktop Chrome

Assessment: approve the direction, but only if the stage/refactor details are made explicit.

### 2. Public overlay security model

The public overlay model is correct in principle. A YoloBox-consumable public URL is not itself a security flaw.

The actual rule should be:

- overlay data may be public only if it is intentionally public
- everything else must remain unreadable to public clients

The plan is right to keep the overlay public and read-only. But it must assume attackers can:

- inspect the overlay source
- inspect the Firebase config
- enumerate event URLs
- call Firebase endpoints directly

If the design depends on attackers not knowing the routes, the Firebase config, or the client code, it is not secure.

Assessment: conceptually correct.

### 3. PIN-based operator auth

Operator PIN auth is acceptable only as an operational compromise, not as a strong security design.

It can work for Phase 1 if all of the following are true:

- PIN validation is server-side only
- PINs are hashed, never stored or returned in readable form
- operator sessions are short-lived but renew safely during live use
- attempts are rate-limited per IP and per event
- lockout/backoff exists
- sessions are event-scoped
- there is exactly one active operator lease per event

Without those controls, operator PIN auth is not acceptable on an internet-facing control surface.

Assessment: acceptable as a compromise only if heavily hardened.

### 4. PIN-based owner/admin auth

This is the weakest part of the plan.

Owner/admin actions include resetting events, rotating PINs, revoking sessions, locking control, and taking over a live event. That is a materially higher privilege level than routine score operation. PIN-only owner auth is therefore second-best at best.

If retained in Phase 1, mandatory controls should include:

- minimum 10-digit owner PIN
- separate owner PIN from operator PIN
- separate owner session from operator session
- server-side hash storage only
- strong rate limits and temporary lockout
- audit log for every owner unlock and owner action
- fast session revocation
- owner-mode idle timeout

Assessment: acceptable only as temporary debt. Not best practice.

### 5. Embedding admin inside control

Embedding owner/admin inside `yolo-control.html` is understandable for Phase 1, but it is not a clean security or separation model.

The key point is this: hidden UI is not authorization.

If owner/admin remains embedded:

- owner controls must not render until owner unlock succeeds
- every owner action must be revalidated server-side
- owner capabilities must not share the same session as operator capabilities
- the page should clearly show role state to avoid confusion during live operation

The main downside is blast radius. A single complex page becomes responsible for operator workflow, owner workflow, state editing, session handling, and emergency takeover. That is manageable for Phase 1, but it will age badly.

Assessment: acceptable as a Phase 1 UX compromise, but structurally inferior to a separate admin page.

### 6. Firebase Hosting migration

Moving production hosting from GitHub Pages to Firebase Hosting is reasonable, but it should not be framed as a core security fix.

What Firebase Hosting actually improves:

- short clean rewrites like `/o/{eventId}` and `/c/{eventId}`
- preview channels and safer cutover testing
- easier integration with Firebase project configuration
- better control over cache headers and routing behavior

What it does not solve:

- browser-side auth flaws
- weak RTDB rules
- poor session design
- direct-write trust boundary problems

Assessment: good move, but not the main hardening step.

### 7. Custom domain usage

Using a short custom subdomain is good operationally. It makes YoloBox entry easier and reduces crew friction.

But it has side effects:

- short memorable URLs are easier to share
- short memorable URLs are also easier to probe and brute-force

That means custom domain convenience increases the importance of strong backend auth.

Assessment: operationally strong, security-neutral by itself.

### 8. Database structure and rules

The move away from flat/shared Firebase state is absolutely correct.

The proposed split:

- `/publicEvents/{eventId}/{bug,corners,ticker,stats,meta}`
- `/adminEvents/{eventId}`
- `/controlSessions/{uid}`
- `/auditLogs/{eventId}/{logId}`

is directionally sound, but it needs revision.

Problems:

- `controlSessions/{uid}` is not a strong session key model
- it does not clearly encode one active operator per event
- it does not clearly define revocation semantics
- it risks mixing identity and session state

Better approach:

- use event-scoped sessions keyed by `sessionId`
- store role, event, expiration, revocation state, and device metadata on the session
- track `activeOperatorSessionId` per event or equivalent lease ownership
- keep hot overlay state separate from colder admin/config/audit data

Also, the plan should state explicitly that public clients must not be able to list or infer other event admin paths.

Assessment: good direction, but under-specified and slightly mis-modeled.

### 9. Cloud Storage asset strategy

This is an unambiguous improvement.

The current design stores logos and sponsor images as data URLs in RTDB. That is inefficient, expensive, and operationally fragile. The live database payload observed on April 6, 2026 confirms that this is not theoretical.

The revised asset model should include:

- upload validation for size and MIME type
- optional server-side resize/normalization
- stable public asset references for overlay-safe retrieval
- retention/cleanup policy for obsolete assets

Do not use expiring signed URLs for assets that the overlay must load reliably without operator intervention.

Assessment: strongly recommended.

### 10. Multi-game `eventId` scaling plan

Making `eventId` mandatory now is correct. It avoids building another generation of shared-state technical debt.

The plan is still missing important operational constraints:

- how are event IDs generated and retired
- how are crews prevented from operating the wrong event
- how is one active operator enforced
- how does owner takeover work per event
- how are old events cleaned up
- how are event URLs and PINs distributed safely on busy nights

Assessment: right architectural direction, but not yet a finished scale model.

## Strongest Reasons This Plan Could Be Wrong

1. It may be solving the visible architecture problems while leaving the live-control authority problem vague.

2. It may be accepting too much compromise around owner/admin auth. PIN-only owner auth on a public control route is weak for the privileges involved.

3. It may be overvaluing the hosting migration. GitHub Pages is not the main defect today.

4. It may still be putting too much into RTDB hot paths if public event state remains bulky or monolithic.

5. It may be investing in embedded owner/admin mode even though a separate oversight/admin surface is the cleaner medium-term design.

## Alternatives Claude Code Should Compare Against

### Separate admin page instead of embedded admin mode

Pros:

- cleaner separation of privilege
- lower accidental exposure of owner capabilities
- easier to reason about role-based UI and routing

Cons:

- one more URL to manage
- slightly more setup friction

### Owner Google auth or passkeys instead of owner PIN

Pros:

- materially stronger than PIN-only auth
- better fit for high-privilege owner actions

Cons:

- more setup overhead
- less frictionless than simple PIN unlock

### Staying on GitHub Pages longer

Pros:

- avoids hosting migration while auth/security work is underway
- simpler short-term rollout

Cons:

- less convenient routing
- weaker deployment ergonomics than Firebase Hosting

### Custom domain on GitHub Pages vs Firebase Hosting

This should be compared explicitly. If the only requirement is short URLs, either can work. If the requirement also includes clean rewrites, preview channels, tighter Firebase integration, and controlled headers, Firebase Hosting is better.

### Different routing/event models

Compare:

- `/c/{eventId}`
- `/c/{eventId}?token=...`
- `/control/{eventId}/{inviteToken}`

The simplest route is not always the safest route.

### Different backend split models

Compare:

- top-level `publicEvents`, `adminEvents`, `auditLogs`
- nested `/events/{eventId}/{public,admin,sessions,audit}`

Either can work. The important point is clean access control and hot/cold data separation.

## Security Review Questions

### If the overlay is public, what can an attacker realistically do?

They can:

- load the overlay
- inspect the HTML and JS
- discover the Firebase project config
- infer public event structure
- read whatever data rules allow them to read
- probe Firebase and Storage directly

That is normal. The system must remain secure even when all of that is known.

### Can they discover enough from the overlay/client code to attack Firebase directly?

Yes. Assume yes.

Firebase client config is not secret. Hiding routes or assuming obscurity is not an acceptable control.

### What does “secure enough” actually mean here?

For NSMT, “secure enough” should mean:

- public overlay works with no auth
- only intentional public event data is readable
- no admin/session/audit data is publicly readable
- no write is allowed without a valid scoped backend-issued session
- brute-force attempts are slowed enough to be impractical
- compromise of one event does not compromise another
- owner takeover and session revocation work quickly and reliably

### Is PIN-only owner auth good enough?

Only as a temporary operational compromise, not as a preferred long-term design.

### What protections are mandatory if we keep PIN-only owner auth?

- 10-digit minimum owner PIN
- strong server-side hashing
- no browser-side comparison
- strict rate limiting
- temporary lockout/backoff
- separate owner session
- owner session timeout
- audit logging
- rapid revocation

### What would still be concerning after implementation?

- wrong-event operation under stress
- shared-device owner unlock
- brute-force pressure on short public control routes
- stale cached HTML after emergency fixes
- control-page complexity if operator and owner flows remain combined
- clock authority if multiple devices act at once

## Day-Of-Game Failure Modes

- wrong overlay URL loaded into YoloBox
- wrong control URL opened by crew
- correct URL but wrong `eventId`
- operator handoff between devices
- operator session expires in the middle of game action
- owner must take over from another device immediately
- asset upload fails or partially succeeds
- mobile browser pauses timers or throttles background tabs
- YoloBox browser behavior does not match desktop browser behavior
- production cutover mixes old GitHub Pages URLs with new Firebase Hosting URLs

The plan should define how the system behaves in each case. Right now it does not.

Specific concerns:

- wrong-event protection must be highly visible in the UI
- session expiry must not surprise the operator during gameplay
- owner emergency takeover should revoke operator control within seconds
- overlay and control should clearly expose environment and event identity during rollout/cutover

## Questions About Scaling To 5+ Simultaneous Games

1. How are event IDs created, validated, retired, and prevented from colliding?

2. How is a session bound to one exact event and one exact role?

3. Is there exactly one active operator per event?

4. How does takeover work if two operators or two owners are active on different devices?

5. How are event credentials issued to crews without confusion on multi-game nights?

6. Is hot overlay state small enough that five simultaneous games remain efficient?

7. What oversight tooling exists to monitor event health, connectivity, active session, and last update time across all games?

8. What is the archive and cleanup policy for old events, sessions, assets, and logs?

The current plan points in the right direction, but it does not yet answer these well enough.

## Review Checklist

Claude Code should:

1. inspect the active files `yolo-overlay.html` and `yolo-control.html`
2. verify whether fixed-size overlay assumptions still exist
3. verify all direct RTDB read/write paths
4. search for browser-side PIN logic, master keys, and reset flows
5. confirm whether RTDB rules, Storage rules, Firebase Hosting config, and backend functions actually exist in the repo
6. verify the public production URLs and any dead or stale route assumptions
7. inspect the live Firebase payload shape and payload size
8. confirm whether assets are still stored as base64/data URLs
9. test missing `eventId`, invalid `eventId`, expired session, revoked session, and wrong-event behavior
10. test operator/owner takeover behavior
11. test on iPad, phone, laptop, and actual YoloBox hardware
12. verify launcher/index links do not point crews to legacy pages

## What Would Make Me Approve This Plan

- browser-side PIN logic removed entirely
- no readable PIN path in Firebase
- master reset key removed
- backend-issued event-scoped sessions implemented
- clear operator vs owner session separation
- exactly one active operator lease per event
- immediate owner takeover/revocation path
- public overlay restricted to intentionally public data only
- Cloud Storage asset migration completed
- hot state separated from bulky asset/config state
- invalid or missing `eventId` fails closed
- Firebase Hosting preview and production cutover tested on real production devices

## What Would Block This Plan

- any remaining client-side PIN validation
- any remaining hard-coded master reset path
- any design that treats a public control page plus a short PIN as the main security boundary
- owner/admin UI being hidden without server-side owner authorization behind it
- no active-operator authority model
- continuing to store large base64 assets in RTDB hot state
- hosting migration happening before auth/rules/session behavior is implemented and tested

## Recommended Revisions

1. Reorder the implementation plan. Security and session semantics should come before hosting cutover and before responsive cleanup.

2. Strengthen the operator auth spec. Do not simply say "backend-validated PIN flows." Specify:
   - server-side hash validation
   - rate limits
   - lockout/backoff
   - event scoping
   - session renewal behavior
   - one active operator lease

3. Reconsider owner auth if possible. If one preference should be challenged, challenge owner PIN before challenging anything else.

4. If owner PIN stays for Phase 1, write down the mandatory hardening controls explicitly. Do not leave them implied.

5. Replace `controlSessions/{uid}` with an event-scoped `sessionId` model and explicit operator lease ownership.

6. Split hot live state from cold/admin/config data so the overlay does not depend on bulky or broad RTDB listeners.

7. Move assets to Cloud Storage with validation, normalization, and stable public references suitable for unattended overlay loading.

8. Keep the 1920x1080 internal scene model, but explicitly require stage-relative refactoring of effects and layout logic.

9. Treat Firebase Hosting as a deployment improvement, not the main security fix.

## Final Assessment

The plan is mostly moving in the right direction. The public overlay model, event-scoped architecture, Hosting migration, mandatory `eventId`, and Cloud Storage asset move are all sensible.

But the plan is still too weak where it matters most. It is not enough to say “backend-validated PIN flows” and “short-lived sessions.” The design needs a clear, testable trust boundary and a clear, testable live-control authority model.

As written, this is a promising plan, not an approved one.

The core revision needed is simple:

The system must stop being “a public control page protected by better PIN handling” and become “a public overlay plus a server-enforced, event-scoped control plane with explicit operator ownership and tightly bounded owner authority.”
