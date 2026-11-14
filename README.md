# Family Portal API

Secure, multi-family backend for the Family Heritage & Memory Portal. Node + Express + Neon (Postgres).

## What it fixes

| Problem in the Firebase version | Now |
|---|---|
| Anyone could read all messages, members and posts (`allow read: if true`) | Every route needs a login **and** membership of that family. Outsiders get 404. |
| Family emails and passwords shipped in the JS bundle | No accounts in code. Users register; passwords are bcrypt-hashed server side. |
| Hard-coded to 8 people | Any number of families; each person in the tree is separate from a login. |
| Any signed-in user could edit or delete anything | Roles: owner, admin, editor, member (rules below). |
| Photos stored inside database documents | Files go to a bucket via short-lived signed URLs; only the key is stored. |
| Notifications only worked with the app open | Web Push (VAPID) plus live updates over Server-Sent Events. |
| Everyone's browser downloaded every private message | Messages are only returned to the sender and recipient. No admin override. |

## Permissions

| Action | member | editor | admin | owner |
|---|---|---|---|---|
| Read feed, gallery, tree, members | yes | yes | yes | yes |
| Post, comment, react, upload photos | yes | yes | yes | yes |
| Delete own post / comment / photo | yes | yes | yes | yes |
| Delete anyone's post / comment / photo | | | yes | yes |
| Edit own profile (bio, photo, location, birthday) | yes | yes | yes | yes |
| Add people, spouses, parent links; edit any person | | yes | yes | yes |
| Delete a person | | | yes | yes |
| Create / revoke invites, see member emails, remove members | | | yes | yes |
| Rename family, promote/demote editors | | | yes | yes |
| Promote/demote admins | | | | yes |

## Isolation, layered

1. Every `/api/families/:familyId/*` route runs `requireMember`, which looks up the caller's membership.
2. Every query includes `family_id`.
3. The schema uses composite foreign keys `(family_id, id)`, so even buggy code cannot link rows across families.
4. `test/api.test.ts` proves it (29 tests on in-memory Postgres). Run `npm test` after every change.

## Setup

```bash
cp .env.example .env        # fill in DATABASE_URL and JWT_SECRET at minimum
npm install
npm run migrate             # applies db/schema.sql to your Neon database (empty DB only)
npm run dev                 # http://localhost:8080  (GET /health)
npm test
```

### Neon
Create a project, copy the **pooled** connection string (host contains `-pooler`), keep `?sslmode=require`.

### Deploy (Render or Railway)
- Build: `npm install && npm run build`   Start: `npm start`
- Add every variable from `.env.example`.
- **Cookies:** the login cookie is HttpOnly. Best setup is a custom domain with the frontend on `app.yourdomain.com` and the API on `api.yourdomain.com` (`COOKIE_DOMAIN=.yourdomain.com`, `COOKIE_SAMESITE=lax`). If they must sit on different domains, set `COOKIE_SAMESITE=none`.
- Frontend `fetch` must use `credentials: 'include'`.

### File storage (Cloudflare R2 or any S3 bucket)
Create a **private** bucket and add a CORS rule allowing `PUT` and `GET` from your frontend origin with header `Content-Type`. Set the `S3_*` variables.

### Push notifications
`npx web-push generate-vapid-keys`, set the `VAPID_*` variables, and add the push handler to the frontend's `sw.js` (see FRONTEND_PROMPT.md).

## API reference (all JSON, prefix `/api`)

**Auth:** `POST /auth/register {email,password,displayName}` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` (user + families)

**Families:** `POST /families {name,tagline?,myName?}` · `GET|PATCH /families/:fid` · `GET /families/:fid/members` · `PATCH|DELETE /families/:fid/members/:userId`

**Invites:** `POST|GET /families/:fid/invites` · `DELETE /families/:fid/invites/:id` · `GET /invites/:code/preview` (public: name only) · `POST /invites/accept {code}`

**Tree:** `GET /families/:fid/tree` (persons, unions, parentLinks) · `POST /persons` · `PATCH|DELETE /persons/:id` · `POST /unions` · `DELETE /unions/:id` · `POST|DELETE /parent-links`

**Feed:** `GET /posts?limit&before` · `POST /posts` · `DELETE /posts/:id` · `POST /posts/:id/reactions {type}` (toggle) · `GET|POST /posts/:id/comments` · `DELETE /comments/:id`

**Gallery:** `GET /photos?eventName&year&limit&before` · `POST /photos` · `POST /photos/:id/like` (toggle) · `DELETE /photos/:id`

**Messages:** `GET /conversations` · `GET /messages/:otherUserId` · `POST /messages {recipientUserId,content}` · `POST /messages/:otherUserId/read`

**Uploads:** `POST /uploads/sign {kind:'image'|'audio'|'document',contentType,size}` returns `{objectKey, uploadUrl}`. `PUT` the file to `uploadUrl`, then send `objectKey` when creating a post or photo.

**Realtime:** `GET /families/:fid/events` (Server-Sent Events: `post.created`, `post.updated`, `post.deleted`, `comment.created`, `photo.created`, `message.created`, `message.read`)

**Push:** `GET /push/public-key` · `POST /push/subscribe` · `POST /push/unsubscribe`

## Known limits (next steps)
- **Password reset** needs an email provider (Resend, Brevo). Not built yet; until then an admin must help locked-out members.
- **Realtime hub is in-process**, so run one instance. For several instances use Redis or Ably.
- **Billing**: `families.plan` and `member_limit` exist and the member limit is enforced; Paystack hooks are not built yet.
- Rotate any password that was ever in the old `familyAccounts.ts`.
