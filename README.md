# VidyaSetu

A new MERN learning platform: React 19 + React Router, Vite 6, Express 5, Node.js 22+, MongoDB 7+ replica set (or Atlas), native MongoDB driver 6, and Argon2id. npm versions are locked in `package-lock.json`. Appwrite was replaced with MERN at the user's request.

## Start quickly

```powershell
npm ci
npm run dev:demo
```

Open **http://localhost:5173**. Create an account, create a course, copy its ID, then use another account in a private browser window to join with that ID and the password you chose. No accounts or passwords are seeded.

**Demo mode is temporary**: its isolated MongoDB replica set is deleted on shutdown. It uses an installed `mongod` executable when available (PATH or standard Windows MongoDB location), otherwise downloads MongoDB 7.0.24 using `mongodb-memory-server`. You can also set `MONGOMS_SYSTEM_BINARY` to an installed MongoDB 7+ executable. Never use this mode for real student data. This uses the same application and security rules as the persistent mode.

## Persistent local development

Install Node.js 22+ and Docker Desktop, then:

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d --wait
npm run dev
```

Docker is optional if you supply an existing replica set or MongoDB Atlas URI. Standalone MongoDB is intentionally rejected because course creation needs transactions. The Compose service is a **local development database**, without authentication and bound to loopback. Its volume persists across restarts. Do not expose it to the network. `docker compose down` preserves the volume; do not add `-v` unless you intend to delete all local data.

Use `http://localhost:5173` exactly, matching APP_ORIGIN. Vite proxies `/api` to Express at port 4000. Origin checking rejects writes from `127.0.0.1:5173` if APP_ORIGIN remains localhost.

## Audit and design decision

The supplied directory was empty: no source, schema, installed SDK, existing users, passwords, memberships, routes, Storage, or migration could be audited. This is a new implementation, not a patch to an existing VidyaSetu project. The main threats addressed are client identity spoofing, plaintext or exposed enrollment passwords, arbitrary role assignment, unauthenticated content access, concurrent duplicate enrollment, CSRF, and guessing attacks. Existing functionality and legacy membership compatibility cannot be verified without the original application/data.

## Enrollment flow

1. React sends only `{ courseId, password }` to `POST /api/courses/enroll` over the same origin.
2. Express resolves the random session token in an HttpOnly, SameSite=Strict cookie against an unexpired server-side session. Identity never comes from request JSON.
3. Persistent MongoDB counters limit requests per IP, authenticated user, and target course. Unavailable counters fail closed.
4. Zod rejects malformed UUIDs and unexpected fields, including `userId`, `role`, or `admin`.
5. The server retrieves course metadata and its separate private secret record, verifies Argon2id, then checks existing membership. Missing courses, missing hashes, and wrong passwords share one safe error. A dummy hash verification avoids skipping hashing for nonexistent courses.
6. MongoDB inserts a server-assigned `member` with the session user's ID. A unique `{ courseId, userId }` index arbitrates simultaneous requests. Duplicate key errors return 409. Other write failures return 503, never success.
7. React navigates only on success, fetches authorized course content, and refreshes courses when returning to the dashboard. It never stores a local pretend membership or enrollment password in browser storage.

Course creation transactionally inserts the metadata, secret, and creator's `admin` membership. There is no public API for arbitrary membership creation, role edits, or MongoDB access. Both lesson publication and enrollment password reset require a server-side admin membership check. Lesson bodies are rendered as text by React, never raw HTML.

## Authentication and password handling

- Both account and enrollment passwords use independent Argon2id hashes: 64 MiB, 3 iterations, parallelism 1. The maintained `argon2` library generates a fresh cryptographic salt and encodes salt/parameters in each hash. Account hashes are never reused for course enrollment.
- New account and course passwords: 10–128 characters. Existing-password verification accepts 1–128 characters. No plaintext is written to MongoDB, returned, or logged.
- Course hashes live only in `courseSecrets`, outside course metadata. All API responses explicitly serialize approved fields. Account responses also explicitly exclude hashes.
- Session tokens are 256 random bits. Only a SHA-256 digest of the **random token** is stored; SHA-256 is not used for password hashing. Sessions expire after seven days, checked on every request even if MongoDB TTL cleanup has not run. Logout deletes the session; login rotates the browser session.
- Production cookies use `__Host-vidyasetu`, Secure, HttpOnly, SameSite=Strict, and path `/`. Development cookies omit Secure for localhost HTTP.
- Every modifying request requires exactly APP_ORIGIN and JSON content type. No permissive CORS is enabled. Serve frontend and API from one HTTPS origin.
- Errors never return database internals or stack traces. Server failure logs contain event/method/status only, without bodies, URLs containing IDs, tokens, passwords, or hashes.

## Database layout and integrity

| Collection | Purpose | Important indexes |
| --- | --- | --- |
| users | UUID, email, name, account passwordHash | unique email |
| sessions | hashed token `_id`, userId, expiresAt | unique `_id`, TTL expiresAt |
| courses | UUID, title, description, ownerId, createdAt | unique `_id` |
| courseSecrets | courseId, encoded passwordHash | unique courseId |
| memberships | courseId, userId, role, createdAt | unique (courseId, userId), userId |
| lessons | UUID, courseId, title, body, createdAt | (courseId, createdAt) |
| limits | hashed bucket `_id`, count, expiresAt | unique `_id`, TTL expiresAt |

Startup installs strict required-field/type/role validators and indexes before serving requests. A failed unique-index build aborts startup. Never drop these indexes to get the application to start. MongoDB does not enforce foreign keys; only this server's routes may create these documents. Do not grant database credentials to learners or browsers.

Limits shared by all API processes: 300 API requests/IP/minute, 20 login/signup attempts/IP/15 minutes, 10 enrollment attempts/user/15 minutes, 100 enrollment attempts/course/15 minutes, and 20 course creations/user/hour. Counters include successful requests. Fixed windows can allow twice a limit across a boundary; deploy edge limits as well for hostile traffic. Course-wide limits trade availability for brute-force protection. Configure your trusted proxy count accurately to keep IP limits meaningful; never enable blanket trust proxy.

## PDF and notes uploads

The admin form is now **Upload PDF or notes**. Choose a title, a category (Notes, PYQs, Assignment, Lab Experiments, or Important Announcements), and a `.pdf`, `.txt`, or `.md` file up to 10 MiB. The classroom displays five separate sections with item counts and empty states. Existing uncategorized files and text lessons appear under Notes. Members and admins see a Download button; existing text lessons remain readable.

`POST /api/courses/:courseId/materials` accepts raw PDF or UTF-8 text bytes with a validated `X-Material-Category` value and URI-encoded `X-File-Name` and `X-Material-Title` headers, set automatically by CourseService. Origin, session, membership/admin checks and a shared 30-uploads/user/hour limit run before parsing. Other modifying endpoints still require JSON. `GET /api/courses/:courseId/materials/:materialId` checks membership and scopes the file to that course.

Files are MongoDB binary documents in a new `materials` collection indexed on `(courseId, createdAt)`. Listings return metadata without bytes. Downloads use attachment disposition and `nosniff`. Filenames cannot contain paths or control characters. PDFs receive basic header/end-marker checks; TXT/MD must be valid UTF-8 without NULs. This is **not malware scanning or full PDF structural validation**. For larger deployments add scanning, storage quotas, dedicated private object storage, and proxy concurrency limits; uploads are buffered in memory. The 10 MiB limit is below MongoDB's 16 MiB document limit.

Startup adds the collection/index without changing existing content or memberships. No additional dependencies or setup are needed. Demo mode optionally accepts `DEMO_RESTORE_PATH` for one-time private EJSON recovery into its empty temporary database; the ignored snapshot is deleted after successful restoration. This preserved the active preview during the backend update.

## API

Members can use **Leave course → Confirm leave** on the course page. `DELETE /api/courses/:courseId/membership` accepts only an empty JSON object and deletes only the authenticated caller's `member` membership. Admins cannot leave, and clients cannot specify another user's identity. The dashboard no longer lists the course after leaving; subsequent content/download requests are denied. Members can rejoin using the current enrollment password. Existing courses and uploaded materials are retained.

Course admins can remove uploaded materials in every category using the **Remove → Confirm remove** controls, or cancel. Legacy text notes also have Remove controls when expanded. `DELETE /api/courses/:courseId/materials/:itemId` and `DELETE /api/courses/:courseId/lessons/:itemId` require a verified admin session, the configured Origin, and an empty JSON object. Deletions are scoped to the course, remove the stored document/file bytes permanently, and return 404 for missing or already removed items. Members can download but cannot remove content. After success, React refreshes the section counts and file list; failures remain visible without pretending the item was deleted. No schema change is required. Recovering a confirmed removal requires a database backup.

All modifying calls need `Content-Type: application/json` and an Origin equal to APP_ORIGIN. Responses are JSON; session cookies travel automatically in the browser.

| Method and path | Access / input |
| --- | --- |
| POST /api/auth/register | public; name, email, password |
| POST /api/auth/login | public; email, password |
| GET /api/auth/me | authenticated |
| POST /api/auth/logout | authenticated; `{}` |
| GET /api/courses | authenticated; own memberships only (up to 200) |
| POST /api/courses | authenticated; title, description, password |
| POST /api/courses/enroll | authenticated; courseId, password |
| GET /api/courses/:courseId | member/admin; course and lessons (up to 200) |
| POST /api/courses/:courseId/lessons | admin; title, body |
| PUT /api/courses/:courseId/password | admin; password |

Error statuses: 400 malformed input/extra fields, 401 expired or missing session, 403 incorrect course credentials/unauthorized role/origin, 409 duplicate enrollment/account, 413 oversized body, 415 non-JSON write, 429 rate limit with Retry-After, 503 database/service failure. Unknown paths or unsupported methods return 404.

## Tests

```powershell
npm test
npm run build
```

Tests use Node's test runner and Supertest against an isolated **real MongoDB replica set**, not production. They cover valid/invalid enrollment, missing identity/course, repeat and concurrent enrollment, spoofing, admin escalation, database insertion failure, response serialization, unavailable direct membership endpoints, protected content, creator/member preservation, resets, missing hashes, legacy plaintext rejection, salt uniqueness, Origin/JSON controls, malformed IDs, expired sessions, and shared rate limits. See `TEST_RESULTS.md` for actual execution results. The fault-injection test intentionally writes one safe failure event to stderr.

## Environment and deployment order

| Variable | Meaning |
| --- | --- |
| NODE_ENV | `development` or `production` |
| PORT | Express listen port; default 4000 |
| APP_ORIGIN | Exact browser origin, no trailing slash; production must start with `https://` |
| MONGODB_URI | Server-only Atlas/replica-set connection string; keep secret |
| MONGODB_DB | Database name; default vidyasetu |
| TRUST_PROXY_HOPS | Known reverse proxy hop count; default 0 |

1. Provision MongoDB Atlas or a secured replica set. Enable TLS, backups, authentication, and network allowlisting to the API host. Use a deployment identity to create collections/validators/indexes. Current startup requires these permissions, so a scoped `dbOwner` on **only the application's database** is the simplest initial setup; no cluster administration or other database access. For stricter deployment separation, pre-run `initializeDatabase` with a migration identity and move startup DDL to your release job before using a readWrite-only runtime identity. That separation is not automated here.
2. Keep MongoDB credentials only in the API host secret store or `.env`, never in a `VITE_` variable or frontend bundle. Do not expose the database port publicly. Browser users get no database credentials or permissions.
3. Set .env on the host (or inject matching environment variables); set NODE_ENV=production and APP_ORIGIN to your HTTPS URL. If using injected env variables without an .env file, launch `node server/index.js` directly.
4. Install, test, and build the frontend:

```powershell
npm ci
npm test
npm run build
npm start
```

5. Route a TLS reverse proxy to port 4000. Express serves `dist` and the API from the same origin in production. Redirect HTTP to HTTPS at the proxy, preserve Origin, and configure TRUST_PROXY_HOPS for the exact network topology. Add edge request/body/concurrency limits and monitoring before public use.
6. Smoke-test with two test accounts: create a course, publish content, verify outsider denial, join, verify content, verify a member cannot publish/reset, and sign out. Verify Secure/HttpOnly/SameSite cookies and actual database network denial from outside your server network.

No Appwrite Console configuration is necessary: this version uses MERN. There is no hosted deployment in this repository; hosting accounts, production URI, domain, and TLS must be configured by you.

## Migration and recovery

This empty project has no pre-existing data to migrate. Do not point it at a legacy database expecting automatic conversion. Startup refuses known plaintext/hash fields on course metadata. It does not invent passwords or silently invalidate courses.

For future imports: back up and disable writes; review mappings and validate user/course UUIDs; deduplicate memberships under review (preserve verified creators/admins); migrate metadata and memberships into the documented schema; leave untrusted/missing secrets absent. Deploy the backend with indexes and private access controls, then have verified course admins sign in and use **Enrollment settings** to set a new password over HTTPS. Existing member content access does not depend on an enrollment hash, so approved memberships remain usable while new enrollment fails closed. Remove plaintext fields from the imported metadata and all active legacy writers before startup. Securely restrict/expire old backups according to your data policy. The reset/fail-closed behavior is tested; a schema-specific legacy import script cannot be supplied without the original schema and verified user mapping.

Rollback: back up the database before releases; retain prior source/build and index definitions. Roll back UI/API together to a version that maintains server-only membership writes and hashing. Never roll back to a client-write or plaintext model. Passwords cannot be recovered from hashes; reset them. Enrollment and password reset preserve existing memberships; course creation rolls back all three inserts if the transaction fails. Restoring snapshots requires an outage and may undo legitimate enrollments, so reconcile against your operational records before reopening writes.

## Scope and remaining limits

This is a focused foundation, not a claim of a completed production security audit. Dedicated object storage, malware scanning, email verification, account recovery, invitations, role delegation, course deletion, admin membership removal, account password changes, MFA, and pagination beyond the documented 200-record caps are not implemented. User-controlled courses mean any authenticated account can create a course; add verified-instructor policy if your institution requires it. Large/coordinated attacks need upstream bot/traffic defenses; rate limits are not a DDoS solution. Supply your own database/hosting configuration and verify network isolation in the deployed environment. No original valid-membership dataset was available for migration testing.

Reference APIs: [MongoDB unique indexes](https://www.mongodb.com/docs/manual/core/index-unique/) and [node-argon2](https://github.com/ranisalt/node-argon2).

## Files created

There were no existing source files to modify. The initial `npm init` package file was replaced with this project's package configuration.

| File | Purpose |
| --- | --- |
| package.json | Dependencies, package config, npm commands |
| package-lock.json | Exact dependency resolution |
| .gitignore | Excludes secrets, dependencies, build artifacts |
| .env.example | Safe environment template |
| index.html | React entry document |
| vite.config.js | React build and local API proxy |
| client/src/main.jsx | Auth, dashboard, create/join, classroom/admin screens |
| client/src/styles.css | Responsive visual design |
| client/src/materials.css | File upload, category sections, and download card styling |
| client/src/CourseContent.jsx | Five categorized sections, counts, and legacy notes |
| shared/categories.js | Allowed category values and display labels shared by frontend and backend |
| client/src/api.js | Central API client and CourseService |
| server/app.js | Authentication, authorization, validation, enrollment and content API |
| server/db.js | Connection, schema validation, indexes, legacy guard |
| server/index.js | Persistent API/production entry point |
| server/temp-db.js | Installed MongoDB discovery and isolated development/test replica set |
| server/demo.js | Temporary local demo entry point |
| server/test/security.test.js | 38 isolated API/database security tests |
| compose.yaml | Persistent local MongoDB replica set |
| README.md | Architecture, security, setup, migration, deployment, limitations |
| TEST_RESULTS.md | Actual verification results and unverified deployment checks |

`node_modules/` and `dist/` are generated local artifacts, excluded from source control. `.env` has not been populated with any credentials.

Category storage: materials have an optional enum `category`: `notes`, `pyqs`, `assignment`, `lab-experiments`, or `important-announcements`. New uploads persist it; absent values default to `notes` in the API for compatibility. Startup updates the MongoDB validator to reject unsupported category values without rewriting existing files. No destructive migration is required.
