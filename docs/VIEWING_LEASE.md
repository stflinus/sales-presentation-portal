# One-time viewing & lease model (v0.1)

## When the viewing is permanently consumed

The one-time viewing is **permanently consumed only after successful completion**
(heartbeat reaches the completion threshold, or `completeVideo` on ended).

At that point:

- session status → `completed` (then treated as closed/consumed)
- invite status → `completed`
- viewing lease → `consumed`
- client Auth user disabled
- signed URL renewal denied forever
- reopen shows: *This presentation has already been viewed…*
- **reset is refused** — create a **new invitation** instead

## What does NOT consume the viewing

| Action | Consumes? |
| --- | --- |
| Open invitation / token exchange | No |
| Accept NDA / Terms / Privacy | No |
| Load video page / prepare signed URL | No |
| Meaningful playback begins (lease acquired) | No (lease active only) |
| Rewind within same active lease | No |
| Refresh same browser during active lease | No (same `deviceId` renews) |
| Browser crash / lease TTL expiry | No (lease may be reclaimed) |
| Successful completion | **Yes — permanent** |

## Lease lifecycle

- **Begins:** `acquireViewingLease` when playback reaches `MEANINGFUL_PLAYBACK_SECONDS` (1s).
- **TTL:** `VIEWING_LEASE_TTL_MS` = 90 seconds; heartbeats renew while playing.
- **Expires:** If heartbeats stop, lease becomes inactive. Expiry ≠ consumption.
- **Reconnection:** After expiry (or rep/admin reset), the same invitation may resume until completion.
- **Second device:** Blocked while another device holds an **active** lease.
- **Signed URLs:** TTL `SIGNED_URL_TTL_MS` = 5 minutes. Renewal requires authenticated client, matching `sessionId`, legal acceptance, session not consumed/revoked/expired, and lease rules (no foreign active lease; heartbeat/complete require active lease). After session closure, renewal is denied. A copied URL stops working when it expires and cannot be renewed after closure.

## Who may reset an interrupted session

- Owning **representative** (`sessions:reset_own`)
- **Administrator**

Reset clears the lease and returns the session to `legal_accepted` (or `opened` if legal not done).  
Completed sessions **cannot** be reset.
