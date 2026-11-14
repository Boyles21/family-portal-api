// Quick end-to-end check of your running API. Run:  node scripts/smoke.mjs
const API = process.env.API ?? 'http://localhost:8080/api';
let cookie = '';

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const data = await res.json().catch(() => ({}));
  console.log(`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} -> ${res.status}`);
  if (!res.ok) {
    console.log('FAILED:', data);
    process.exit(1);
  }
  return data;
}

const email = `test${Date.now()}@example.com`;
await call('POST', '/auth/register', { email, password: 'password123', displayName: 'Test User' });
const { family } = await call('POST', '/families', { name: 'My Test Family' });
await call('POST', `/families/${family.id}/posts`, { content: 'Hello from the smoke test' });
const feed = await call('GET', `/families/${family.id}/posts`);
console.log(`Feed has ${feed.posts.length} post(s): "${feed.posts[0].content}"`);
const tree = await call('GET', `/families/${family.id}/tree`);
console.log(`Tree has ${tree.persons.length} person(s): ${tree.persons[0].fullName}`);
const inv = await call('POST', `/families/${family.id}/invites`, {});
console.log(`Invite code created: ${inv.invite.code}`);
console.log('\nALL GOOD. Your API is working.');
