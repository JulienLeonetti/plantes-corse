-- À exécuter dans le SQL Editor d'un projet Supabase neuf.
-- Le bucket reste privé. Les chemins de fichiers commencent par l'UUID du propriétaire.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.plants (
  id uuid primary key default gen_random_uuid(),
  scientific_name text not null unique,
  common_name text not null,
  summary text not null,
  corsica_status text not null,
  facts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.discoveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plant_id uuid not null references public.plants(id),
  discovered_at timestamptz not null default now(),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  confidence double precision not null check (confidence between 0 and 1),
  photo_path text not null,
  constraint owner_photo_path check (split_part(photo_path, '/', 1) = user_id::text),
  constraint paired_coordinates check ((latitude is null) = (longitude is null))
);
create index if not exists discoveries_user_date_idx on public.discoveries(user_id, discovered_at desc);

-- Création automatique du profil quand un compte est créé.
create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_maquis on auth.users;
create trigger on_auth_user_created_maquis after insert on auth.users
for each row execute function public.create_profile_for_new_user();

-- Quatre espèces présentes en Corse pour le catalogue initial.
-- Les champs sans source suffisante sont laissés sans affirmation de recette/légende.
insert into public.plants(scientific_name, common_name, summary, corsica_status, facts) values
('Helichrysum italicum','Immortelle','Plante aromatique aux fleurs jaunes et au feuillage gris argenté.','présente en Corse',
 '{"caracteristiques":"L’immortelle a un feuillage étroit gris argenté et de petits bouquets de fleurs jaunes.","floraison":"La floraison se remarque généralement de la fin du printemps à l’été, selon le lieu.","lieux":"Elle est présente dans plusieurs milieux ouverts du maquis corse.","toxicite":"Une reconnaissance par photo ne suffit pas pour conclure à l’innocuité. Ne consommez pas une plante sans identification confirmée."}'),
('Clinopodium nepeta','Nepita','Petite plante aromatique de la famille des menthes.','présente en Corse',
 '{"caracteristiques":"La nepita est une petite plante aromatique aux feuilles odorantes et aux fleurs discrètes.","floraison":"Ses petites fleurs apparaissent surtout pendant la belle saison, selon le lieu.","lieux":"Elle est signalée en Corse ; la localisation précise de cette photo n’est pas vérifiée.","toxicite":"Une reconnaissance par photo ne suffit pas pour conclure à l’innocuité. Ne consommez pas une plante sans identification confirmée."}'),
('Myrtus communis','Myrte','Arbuste persistant aux feuilles aromatiques, fleurs blanches et baies sombres.','présente en Corse',
 '{"caracteristiques":"Le myrte garde des feuilles luisantes et aromatiques ; ses fleurs sont blanches et ses baies deviennent foncées.","floraison":"Le myrte fleurit généralement en été.","lieux":"Le myrte est présent dans le maquis corse.","toxicite":"Ne consommez aucune baie ou feuille à partir d’une identification par photo seule."}'),
('Arbutus unedo','Arbousier','Arbuste méditerranéen aux fleurs en clochettes et aux fruits rouge orangé.','présente en Corse',
 '{"caracteristiques":"L’arbousier porte des feuilles persistantes, des fleurs claires en clochettes et des fruits ronds qui rougissent.","floraison":"Sa floraison apparaît souvent en automne.","lieux":"L’arbousier est présent dans le maquis corse.","toxicite":"Une reconnaissance par photo ne garantit pas qu’un fruit sauvage puisse être consommé."}')
on conflict (scientific_name) do nothing;

alter table public.profiles enable row level security;
alter table public.plants enable row level security;
alter table public.discoveries enable row level security;

drop policy if exists "profiles own select" on public.profiles;
create policy "profiles own select" on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists "profiles own update" on public.profiles;
create policy "profiles own update" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
drop policy if exists "plants authenticated read" on public.plants;
create policy "plants authenticated read" on public.plants for select to authenticated using (true);
drop policy if exists "discoveries own select" on public.discoveries;
create policy "discoveries own select" on public.discoveries for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "discoveries own insert" on public.discoveries;
create policy "discoveries own insert" on public.discoveries for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "discoveries own delete" on public.discoveries;
create policy "discoveries own delete" on public.discoveries for delete to authenticated using (user_id = (select auth.uid()));

grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.plants to authenticated;
grant select, insert, delete on public.discoveries to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('plant-photos', 'plant-photos', false, 10485760, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['image/jpeg'];

drop policy if exists "plant photos own read" on storage.objects;
create policy "plant photos own read" on storage.objects for select to authenticated
using (bucket_id = 'plant-photos' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists "plant photos own upload" on storage.objects;
create policy "plant photos own upload" on storage.objects for insert to authenticated
with check (bucket_id = 'plant-photos' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists "plant photos own delete" on storage.objects;
create policy "plant photos own delete" on storage.objects for delete to authenticated
using (bucket_id = 'plant-photos' and (storage.foldername(name))[1] = (select auth.uid()::text));
