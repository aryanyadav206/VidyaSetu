# Verification — 29 October 2026

- `npm test`: **38 passed, 0 failed, 0 skipped**, final run approximately 15.9 seconds. Real, isolated single-node replica set launched using the computer's installed MongoDB 8.2 executable; no existing database was used. Includes actual concurrent HTTP requests, database unique-index enforcement, transaction rollback fault injection, and fail-closed rate-limit storage failure.
- `npm run build`: **passed**, Vite 6.4.5, 44 modules transformed; production assets generated in `dist/`.
- `npm audit --omit=dev`: **0 vulnerabilities reported** at execution time. This dependency report is not a full security audit.
- `node --check server/app.js`, `server/db.js`, `server/index.js`: **passed**.
- Local preview HTTP checks: frontend `/` **200**; proxied `/api/auth/me` with no session **401**.
- Browser visual/interaction QA: **not completed**. The in-app browser automation timed out waiting for the webview to attach. Opening the preview through the Codex panel was queued. Responsive CSS and frontend compilation were checked, but viewport layouts and real browser form flows have not been independently verified.
- Docker Compose, Atlas provisioning, external database network isolation, production HTTPS/Secure cookies, backups, and deployment infrastructure: **not executed**. Configure and verify these before public use.
- No existing project or data was supplied. Compatibility with an original dataset or legacy schema-specific import is **not tested**. Tests verify fail-closed missing-secret/reset behavior and refusal of known legacy plaintext fields.

The initial sandboxed MongoDB test launch failed because local connections were denied (`EACCES`); rerunning with approved local process/network access passed. An initial automatic MongoDB download stalled; the final setup detects installed MongoDB first and disables installation-time downloads. It downloads only at test/demo runtime if no executable is available. All successful test results above are from the final code, not the failed setup attempt.

Expected fault-injection logs contain only `event`, `method`, and `status`, with no credentials or database internals.

PDF/notes update: all four new integration tests passed, covering admin uploads, member downloads, outsider/unauthenticated denial, member upload denial, byte-for-byte PDF downloads, metadata serialization, invalid file signatures/UTF-8, unsafe filenames, empty/oversized uploads, and cross-course file ID tampering. The existing 25 security tests also passed. Build passed after the UI change. Active preview data was recovered into a fresh isolated demo database; the private recovery snapshot was deleted automatically.

Categories update: three added integration tests passed for all five persisted categories and response metadata, rejection of unsupported/empty categories (including the database validator), and default Notes behavior for old clients and existing uploads. All prior 29 tests passed. Production build passed with five separate course content sections and an upload category dropdown.

Removal update: four new integration tests passed for admin removal across all five categories, download denial after deletion, denial for ordinary members/outsiders/unauthenticated requests, cross-course ID tampering, invalid IDs, Origin checks, repeat deletion, and removal of older text notes while retaining unrelated content. All 32 prior tests passed. The UI requires an explicit confirmation and updates section counts after successful deletion. No real user notes were deleted by these isolated tests.

Leave course update: both added integration tests passed for member departure, content access revocation, dashboard removal, rejoining, admin protection, outsider/unauthenticated rejection, and user ID spoofing rejection. All 36 previous tests and the production build passed. Preview restored from its private recovery snapshot.
