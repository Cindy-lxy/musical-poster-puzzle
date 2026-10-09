-- 在 Supabase SQL Editor 中执行一次
create extension if not exists pgcrypto;

create table if not exists public.community_posters (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 80),
  aliases text not null default '',
  image_url text not null,
  source_url text not null,
  source_note text not null default '',
  width integer not null check (width >= 600),
  height integer not null check (height >= 800),
  report_count integer not null default 0,
  status text not null default 'visible' check (status in ('visible', 'hidden')),
  created_at timestamptz not null default now()
);

create table if not exists public.poster_reports (
  id bigint generated always as identity primary key,
  poster_id uuid not null references public.community_posters(id) on delete cascade,
  reporter_id uuid not null,
  created_at timestamptz not null default now(),
  unique (poster_id, reporter_id)
);

alter table public.community_posters enable row level security;
alter table public.poster_reports enable row level security;

grant select, insert on public.community_posters to anon;
grant insert on public.poster_reports to anon;
grant usage, select on sequence public.poster_reports_id_seq to anon;

drop policy if exists "public can read visible posters" on public.community_posters;
create policy "public can read visible posters"
on public.community_posters for select
to anon
using (status = 'visible');

drop policy if exists "public can submit posters" on public.community_posters;
create policy "public can submit posters"
on public.community_posters for insert
to anon
with check (
  status = 'visible'
  and report_count = 0
  and source_url like 'https://%'
  and width >= 600
  and height >= 800
);

drop policy if exists "public can create reports" on public.poster_reports;
create policy "public can create reports"
on public.poster_reports for insert
to anon
with check (true);

create or replace function public.report_community_poster(
  target_poster uuid,
  visitor_id uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  insert into public.poster_reports(poster_id, reporter_id)
  values(target_poster, visitor_id)
  on conflict (poster_id, reporter_id) do nothing;

  select count(*)::integer into new_count
  from public.poster_reports
  where poster_id = target_poster;

  update public.community_posters
  set report_count = new_count,
      status = case when new_count >= 3 then 'hidden' else status end
  where id = target_poster;

  return json_build_object(
    'report_count', new_count,
    'hidden', new_count >= 3
  );
end;
$$;

grant execute on function public.report_community_poster(uuid, uuid) to anon;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'poster-submissions',
  'poster-submissions',
  true,
  8388608,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public can upload poster submissions" on storage.objects;
create policy "public can upload poster submissions"
on storage.objects for insert
to anon
with check (
  bucket_id = 'poster-submissions'
  and (storage.foldername(name))[1] = 'public'
);

drop policy if exists "public can view poster submissions" on storage.objects;
create policy "public can view poster submissions"
on storage.objects for select
to public
using (bucket_id = 'poster-submissions');

-- 管理员删除：直接在 Supabase Dashboard 的 community_posters 表中删除记录。
-- 外键会同步删除举报记录；图片可在 Storage 中一并删除。
