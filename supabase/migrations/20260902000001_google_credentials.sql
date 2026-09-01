-- Supabase becomes the identity store, and the custodian of one Google secret.
--
-- Two tables, with deliberately different exposure:
--
--   profiles            readable by the person it describes. Nothing sensitive.
--   google_credentials  readable by nobody. Row Level Security with no policy
--                       denies every client key; only the service role, held by
--                       the server alone, can reach it.
--
-- See docs/decisions/2026-09-02-supabase-holds-google-credentials.md for why the
-- application now keeps a credential at all, and what that costs.

-- ---------------------------------------------------------------------------
-- profiles: the login information, mirrored out of auth.users
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz
);

comment on table public.profiles is
  'Login information for each signed-in person. Mirrored from auth.users so the application can query it under Row Level Security.';

alter table public.profiles enable row level security;

-- A person may read and update their own row, and nobody else''s.
drop policy if exists "profiles are self-readable" on public.profiles;
create policy "profiles are self-readable"
  on public.profiles for select
  using ((select auth.uid()) = id);

drop policy if exists "profiles are self-writable" on public.profiles;
create policy "profiles are self-writable"
  on public.profiles for update
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ---------------------------------------------------------------------------
-- google_credentials: the refresh token, encrypted, reachable only by the server
-- ---------------------------------------------------------------------------

create table if not exists public.google_credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- An AES-256-GCM envelope produced by src/lib/supabase/token-crypto.ts:
  -- `v1.<iv>.<tag>.<ciphertext>`. Never a plaintext token.
  refresh_token text not null,
  scopes text[] not null default '{}',
  updated_at timestamptz not null default now()
);

comment on table public.google_credentials is
  'Encrypted Google refresh tokens. RLS is enabled with no policy, so no client key can read this table; the server reaches it with the service role key. The encryption key lives in the application, not the database, so reading this table is not enough on its own.';

alter table public.google_credentials enable row level security;

-- No policies, on purpose. RLS with zero policies denies anon and authenticated
-- outright, which is what keeps a refresh token out of any browser.
-- Revoking the default grants as well means a policy added by accident later
-- still cannot expose the column.
revoke all on public.google_credentials from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Keep profiles in step with auth.users
-- ---------------------------------------------------------------------------

create or replace function public.sync_profile_from_auth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url, last_sign_in_at)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url',
    new.last_sign_in_at
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.profiles.full_name),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    last_sign_in_at = excluded.last_sign_in_at;

  return new;
end;
$$;

drop trigger if exists sync_profile_on_auth_user_change on auth.users;
create trigger sync_profile_on_auth_user_change
  after insert or update on auth.users
  for each row execute function public.sync_profile_from_auth();
