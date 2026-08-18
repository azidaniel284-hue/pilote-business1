-- ===========================================================================
--  Pilote Business — table des abonnés aux rappels quotidiens (Web Push)
--  À exécuter UNE FOIS dans Supabase → SQL Editor → New query → Run.
-- ===========================================================================
--
--  Ce qui est stocké : strictement ce qu'il faut pour poster un message à la
--  bonne heure. AUCUNE donnée d'activité (chiffre d'affaires, factures,
--  clients) — celles-ci ne quittent jamais l'appareil de l'utilisateur.
--
--  Une ligne n'existe QUE si l'utilisateur a accepté les notifications dans son
--  navigateur : sans ce consentement, le navigateur ne fournit pas d'endpoint.

create table if not exists public.push_abonnes (
  endpoint       text primary key,            -- adresse d'envoi fournie par le navigateur
  p256dh         text not null,               -- clé publique de l'appareil (chiffrement)
  auth           text not null,               -- secret d'authentification de l'appareil
  heure          smallint not null default 8, -- heure LOCALE souhaitée (0-23)
  tz             smallint not null default 0, -- décalage en minutes (getTimezoneOffset)
  langue         text     not null default 'fr',
  actif          boolean  not null default true,
  dernier_envoi  date,                        -- garantit un seul rappel par jour
  cree_le        timestamptz not null default now()
);

-- Le tour de planification lit « les abonnés actifs » toutes les heures.
create index if not exists push_abonnes_actif_idx on public.push_abonnes (actif, heure);

-- SÉCURITÉ : RLS activé SANS aucune policy publique.
-- Résultat : la clé « anon » (celle qui est dans l'app, donc publique) ne peut
-- NI lire NI écrire cette table. Seule la clé de service, utilisée uniquement
-- par les fonctions Netlify côté serveur, y accède. Sans cela, n'importe qui
-- pourrait aspirer la liste des abonnés ou envoyer du bruit.
alter table public.push_abonnes enable row level security;

-- Vérification rapide après exécution :
--   select count(*) from public.push_abonnes;
