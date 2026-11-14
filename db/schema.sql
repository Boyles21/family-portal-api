-- Family Heritage Portal: multi-family schema for Neon (Postgres 15+)
-- Tenant safety: every family-owned row carries family_id, and rows that point at
-- other family-owned rows use COMPOSITE foreign keys (family_id, id), so the database
-- itself refuses links that cross from one family into another.

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  password_hash text not null,
  display_name  text not null,
  created_at    timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create table families (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  tagline      text not null default '',
  accent_color text not null default '#A3591E',
  plan         text not null default 'free' check (plan in ('free','family','extended')),
  member_limit int  not null default 25,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- A "person" is a node in the family tree. Most people are NOT users
-- (deceased elders, children, relatives without phones).
create table persons (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references families(id) on delete cascade,
  full_name   text not null,
  nickname    text not null default '',
  titles      text[] not null default '{}',      -- e.g. {'Oba','Otunba'}
  gender      text not null default 'unknown' check (gender in ('male','female','other','unknown')),
  birth_year  int,
  birth_date  date,
  death_year  int,
  is_deceased boolean not null default false,
  birth_order int,
  location    text not null default '',
  bio         text not null default '',
  notes       text not null default '',          -- e.g. "1st Iwaro", source remarks
  avatar_key  text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (family_id, id)
);
create index persons_family_idx on persons (family_id);

create table memberships (
  family_id uuid not null references families(id) on delete cascade,
  user_id   uuid not null references users(id) on delete cascade,
  role      text not null check (role in ('owner','admin','editor','member')),
  person_id uuid,
  joined_at timestamptz not null default now(),
  primary key (family_id, user_id),
  foreign key (family_id, person_id) references persons (family_id, id)
);
create unique index memberships_person_key on memberships (person_id) where person_id is not null;
create index memberships_user_idx on memberships (user_id);

create table invites (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references families(id) on delete cascade,
  code       text not null unique,
  role       text not null default 'member' check (role in ('editor','member')),
  person_id  uuid,                                 -- optional: invite is for a specific person
  max_uses   int  not null default 1,
  uses       int  not null default 0,
  expires_at timestamptz not null,
  revoked    boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (family_id, person_id) references persons (family_id, id) on delete cascade
);

-- Lineage: a parent link says "parent_id is a parent of child_id".
create table parent_links (
  family_id uuid not null,
  child_id  uuid not null,
  parent_id uuid not null,
  kind      text not null default 'biological' check (kind in ('biological','adoptive','step')),
  primary key (child_id, parent_id),
  check (child_id <> parent_id),
  foreign key (family_id, child_id)  references persons (family_id, id) on delete cascade,
  foreign key (family_id, parent_id) references persons (family_id, id) on delete cascade
);
create index parent_links_family_idx on parent_links (family_id);
create index parent_links_parent_idx on parent_links (parent_id);

-- Unions (marriages/partnerships). A person may have several.
create table unions (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null,
  partner_a  uuid not null,
  partner_b  uuid not null,
  kind       text not null default 'marriage' check (kind in ('marriage','partnership','other')),
  start_year int,
  end_year   int,
  notes      text not null default '',
  check (partner_a <> partner_b),
  foreign key (family_id, partner_a) references persons (family_id, id) on delete cascade,
  foreign key (family_id, partner_b) references persons (family_id, id) on delete cascade
);
create index unions_family_idx on unions (family_id);

create table posts (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references families(id) on delete cascade,
  author_user_id    uuid references users(id) on delete set null,
  content           text not null,
  object_key        text,
  location          text not null default '',
  feeling           text not null default '',
  tagged_person_ids uuid[] not null default '{}',
  created_at        timestamptz not null default now(),
  unique (family_id, id)
);
create index posts_family_created_idx on posts (family_id, created_at desc);

create table comments (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null,
  post_id        uuid not null,
  author_user_id uuid references users(id) on delete set null,
  content        text not null,
  created_at     timestamptz not null default now(),
  foreign key (family_id, post_id) references posts (family_id, id) on delete cascade
);
create index comments_post_idx on comments (post_id, created_at);

create table reactions (
  post_id   uuid not null,
  family_id uuid not null,
  user_id   uuid not null references users(id) on delete cascade,
  type      text not null check (type in ('heart','celebrate','laugh','hug')),
  primary key (post_id, user_id, type),
  foreign key (family_id, post_id) references posts (family_id, id) on delete cascade
);

create table photos (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references families(id) on delete cascade,
  uploader_user_id  uuid references users(id) on delete set null,
  title             text not null,
  caption           text not null default '',
  object_key        text not null,
  event_name        text not null default 'General',
  year              int,
  tagged_person_ids uuid[] not null default '{}',
  created_at        timestamptz not null default now(),
  unique (family_id, id)
);
create index photos_family_idx on photos (family_id, created_at desc);

create table photo_likes (
  photo_id  uuid not null,
  family_id uuid not null,
  user_id   uuid not null references users(id) on delete cascade,
  primary key (photo_id, user_id),
  foreign key (family_id, photo_id) references photos (family_id, id) on delete cascade
);

create table messages (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references families(id) on delete cascade,
  sender_user_id    uuid not null references users(id) on delete cascade,
  recipient_user_id uuid not null references users(id) on delete cascade,
  content           text not null,
  created_at        timestamptz not null default now(),
  read_at           timestamptz,
  check (sender_user_id <> recipient_user_id)
);
create index messages_pair_idx on messages (family_id, sender_user_id, recipient_user_id, created_at);
create index messages_recipient_idx on messages (family_id, recipient_user_id, read_at);

create table push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
