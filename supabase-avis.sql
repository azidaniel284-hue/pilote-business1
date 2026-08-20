-- ===========================================================================
--  Pilote Business — table des avis et messages des utilisateurs
--  À exécuter UNE FOIS dans Supabase → SQL Editor → New query → Run.
-- ===========================================================================
--
--  Remplace la dépendance à Netlify Forms, qui exigeait une option activée
--  dans l'interface Netlify et échouait sans message exploitable.

create table if not exists public.avis (
  id        bigint generated always as identity primary key,
  type      text        not null default 'autre',   -- avis | bug | idee | aide | autre
  note      smallint,                               -- 1 à 5, ou nul
  message   text        not null,
  nom       text,
  email     text,                                   -- facultatif : pour la réponse
  langue    text        not null default 'fr',
  version   text,                                   -- build de l'app, utile pour un bug
  lu        boolean     not null default false,
  cree_le   timestamptz not null default now()
);

create index if not exists avis_cree_le_idx on public.avis (cree_le desc);

-- SÉCURITÉ : RLS activé SANS aucune policy publique.
-- La clé « anon » présente dans l'app ne peut donc ni lire ni écrire cette
-- table : seule la fonction Netlify, qui utilise la clé de service côté
-- serveur, y accède. Sans cela, n'importe qui pourrait lire les avis des
-- autres utilisateurs — y compris leurs adresses e-mail.
alter table public.avis enable row level security;

-- Pour lire les avis reçus :
--   select cree_le, type, note, nom, email, message from public.avis order by cree_le desc;
