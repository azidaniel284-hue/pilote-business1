-- ============================================================================
--  PILOTE BUSINESS — Parrainage rémunéré (1 000 FCFA par filleul abonné)
--  À exécuter UNE FOIS dans Supabase → SQL Editor → New query → Run.
--
--  Principe de sécurité : ces tables sont TOTALEMENT fermées au public.
--  Aucune "policy" n'est créée => la clé publique (anon) de l'app ne peut
--  ni lire ni écrire. Seules les fonctions Netlify, qui utilisent la clé
--  de service (SUPABASE_SERVICE_ROLE), y accèdent. Cette clé ne doit JAMAIS
--  se trouver dans index.html.
-- ============================================================================

-- 1) Les parrains : un code -> un numéro Mobile Money pour être payé
create table if not exists public.referrers (
  ref_code    text primary key check (ref_code ~ '^PB-[A-Z0-9]{5}$'),
  phone       text not null,
  name        text,
  created_at  timestamptz not null default now()
);

-- 2) Les parrainages confirmés : 1 ligne = 1 abonnement PAYÉ et attribué
--    license_hash est UNIQUE : un même achat ne peut jamais être payé deux fois.
--    On ne stocke QUE l'empreinte (SHA-256) de la clé, jamais la clé en clair.
create table if not exists public.referrals (
  id            bigserial primary key,
  license_hash  text not null unique,
  ref_code      text not null,
  amount        integer not null default 1000,
  status        text not null default 'a_payer'
                check (status in ('a_payer','paye','rejete')),
  created_at    timestamptz not null default now(),
  paid_at       timestamptz,
  note          text
);
create index if not exists referrals_ref_code_idx on public.referrals(ref_code);
create index if not exists referrals_status_idx   on public.referrals(status);

-- 3) VERROU : RLS activé et AUCUNE policy => inaccessible avec la clé publique.
alter table public.referrers enable row level security;
alter table public.referrals enable row level security;

-- 4) Ton tableau de paiement (à consulter dans SQL Editor / Table Editor).
--    security_invoker = les droits de l'appelant s'appliquent (donc fermé au public).
create or replace view public.referral_payouts
with (security_invoker = true) as
select
  r.ref_code,
  rf.phone                                                as numero_mobile_money,
  rf.name                                                 as parrain,
  count(*) filter (where r.status = 'a_payer')            as filleuls_a_payer,
  sum(r.amount) filter (where r.status = 'a_payer')       as montant_fcfa,
  min(r.created_at) filter (where r.status = 'a_payer')   as plus_ancien
from public.referrals r
left join public.referrers rf on rf.ref_code = r.ref_code
group by r.ref_code, rf.phone, rf.name
having count(*) filter (where r.status = 'a_payer') > 0
order by montant_fcfa desc;

-- ============================================================================
--  UTILISATION AU QUOTIDIEN
-- ============================================================================
-- a) Voir qui payer :
--      select * from public.referral_payouts;
--
-- b) IMPORTANT — attendre 7 jours avant de payer (fenêtre de remboursement),
--    puis ne payer que les parrainages confirmés :
--      select * from public.referral_payouts;  -- colonne plus_ancien
--
-- c) Après avoir envoyé l'argent à un parrain, marquer comme payé :
--      update public.referrals
--         set status = 'paye', paid_at = now()
--       where ref_code = 'PB-XXXXX' and status = 'a_payer';
--
-- d) Rejeter un parrainage douteux (remboursement, abus) :
--      update public.referrals
--         set status = 'rejete', note = 'abonnement remboursé'
--       where id = 123;
-- ============================================================================
