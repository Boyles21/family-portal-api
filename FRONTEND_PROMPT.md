# Prompt for Google AI Studio: connect the redesigned frontend to the new API

Paste everything below the line into AI Studio with your current (redesigned) project open.

---

You are migrating this React + Vite + Tailwind app from Firebase to a new REST API. The visual design must NOT change. Only the data layer and the first-run flows change.

## The API
Base URL from `import.meta.env.VITE_API_URL` (for example `https://api.example.com`). Every request uses `fetch(..., { credentials: 'include' })` with `Content-Type: application/json`. Login is an HttpOnly cookie, so never store tokens in localStorage. Errors are `{ error: string }`. All routes are under `/api`.

Create ONE file, `src/lib/apiClient.ts`, with a typed `api` helper (`get`, `post`, `patch`, `del`) that throws `Error(error)` on non-2xx and fires a global "signed out" callback on 401. Then replace `src/lib/firebaseService.ts`, `src/lib/api.ts`, `src/lib/firebase.ts`, `src/lib/supabase.ts`, `src/data/familyAccounts.ts`, `src/data/initialData.ts` and `firebase-applet-config.json`. Remove the `firebase` and `@supabase/supabase-js` dependencies.

### Endpoints
- Auth: `POST /auth/register {email,password,displayName}`, `POST /auth/login {email,password}`, `POST /auth/logout`, `GET /auth/me` returns `{user, families:[{id,name,tagline,accentColor,role,personId}]}`.
- Families: `POST /families {name,tagline?,myName?}`, `GET|PATCH /families/:fid`, `GET /families/:fid/members` returns `{members:[{userId,role,personId,name,nickname,avatarUrl,email?}]}`.
- Invites: `GET /invites/:code/preview` (public), `POST /invites/accept {code}`, and for admins `POST|GET /families/:fid/invites`, `DELETE /families/:fid/invites/:id`.
- Tree: `GET /families/:fid/tree` returns `{persons, unions, parentLinks}`. Persons have `id, fullName, nickname, titles[], gender, birthYear, birthDate, deathYear, isDeceased, birthOrder, location, bio, notes, avatarUrl, userId|null`. Parent link is `{childId,parentId,kind}`. Union is `{id,partnerA,partnerB,kind,startYear,endYear,notes}`. Writes: `POST /persons`, `PATCH|DELETE /persons/:id`, `POST /unions`, `DELETE /unions/:id`, `POST|DELETE /parent-links`.
- Feed: `GET /posts?limit=20&before=<nextBefore>` returns `{posts, nextBefore}`. `POST /posts {content,objectKey?,location?,feeling?,taggedPersonIds?}`, `DELETE /posts/:id`, `POST /posts/:id/reactions {type:'heart'|'celebrate'|'laugh'|'hug'}` (toggles), `GET|POST /posts/:id/comments`, `DELETE /comments/:id`. A post is `{id,content,photoUrl,authorId,authorName,authorAvatarUrl,commentCount,reactions:{heart:[userIds],...},createdAt}`. Comments are loaded only when the user taps "View N comments".
- Gallery: `GET /photos?eventName&year`, `POST /photos {title,caption,objectKey,eventName,year,taggedPersonIds}`, `POST /photos/:id/like` (toggles), `DELETE /photos/:id`.
- Messages: `GET /conversations` returns `{conversations:[{userId,name,avatarUrl,lastMessage,unreadCount}],totalUnread}`. `GET /messages/:otherUserId`, `POST /messages {recipientUserId,content}`, `POST /messages/:otherUserId/read`.
- Uploads: `POST /uploads/sign {kind:'image',contentType,size}` returns `{objectKey,uploadUrl}`. Compress the image first with the existing `imageUtils`, `PUT` the file blob to `uploadUrl` with the same Content-Type header, then send `objectKey` in the post or photo request. Never put base64 images in any request.
- Realtime: `new EventSource(`${API}/api/families/${fid}/events`, {withCredentials:true})` with events `post.created`, `post.updated`, `post.deleted`, `comment.created`, `photo.created`, `message.created`, `message.read`. Use these to update state, toasts and the notification bell. Remove the old Firestore listeners.
- Push: `GET /push/public-key`, then `POST /push/subscribe` with the PushSubscription JSON. Add a `push` listener to `public/sw.js` that calls `showNotification(data.title, {body:data.body, icon:'/icons/icon-192.png', data:{url:data.url}})`. Ask for permission from the existing notification banner, not on page load.

## Changes to the app
1. **Session and families.** On load call `/auth/me`. No user shows the new Login/Register screen. A user with no family sees "Create your family" or "Join with an invite code". One family opens straight into it. Several families show a switcher in the avatar menu. Keep `familyId` in app state and pass it to every call.
2. **Remove everything family-specific from code.** Brand name, tagline and accent colour now come from the family object (`name`, `tagline`, `accentColor`). Delete the 8 hard-coded members, "TOTAL_FAMILY_MEMBERS", preset passwords and email allow-lists, and every "Ajisebutu" string. The old `FamilyMember` type is replaced by `Person` (tree) and `Member` (login).
3. **Join flow.** Support `/join/<CODE>` links: show the family name from `/invites/:code/preview`, then register or sign in, then call `/invites/accept`.
4. **Admin screen** (visible only to admin and owner): member list with role dropdown and remove, "Invite someone" (role, optional person to link, copy link and a "Share on WhatsApp" button using `https://wa.me/?text=`), and the list of active invites with revoke.
5. **Tree** renders from `/tree` only: use `parentLinks` and `unions` for layout, never a fixed `generation`. It must handle people with no login, deceased people (subtle marker), titles, several spouses, 6+ generations, collapsible branches and "focus on this person". Editors and above get "Add person", "Add spouse", "Add child" and "Edit". Plain members can edit only their own profile.
6. **Roles in the UI.** Hide actions the user's role cannot do: delete only on own content (admins on all), Add person only for editors and above. The server enforces it either way, so show friendly messages for 403.
7. **Messages** list people from `/members`. Do not download other people's conversations.
8. Show clear loading, empty and error states, and sign the user out gracefully on 401.

## Rules
- Do not change the visual design, tokens, layout or components other than where data shapes force it.
- Run `npm run lint` and `vite build` at the end and list every file you changed.
- Add `VITE_API_URL` to `.env.example`.
