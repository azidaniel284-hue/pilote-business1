// Fonction Netlify — attribue UN parrainage à UN abonnement réellement payé.
//
// Règle de sécurité centrale : on ne fait JAMAIS confiance au navigateur.
// Un parrainage n'est enregistré que si :
//   1. la clé de licence est confirmée ACTIVE par Chariow (= argent encaissé) ;
//   2. cette clé n'a jamais été comptée (contrainte UNIQUE sur l'empreinte) ;
//   3. le code parrain a le bon format.
// La clé de licence n'est jamais stockée en clair : seulement son SHA-256.

const crypto = require('crypto');

const REF_RE = /^PB-[A-Z0-9]{5}$/;
const REWARD_FCFA = 1000;

function reply(status, obj, cors) {
  return { statusCode: status, headers: cors, body: JSON.stringify(obj) };
}

// Vérifie la licence auprès de Chariow (même logique que verify-license).
async function licenseActive(key) {
  const apiKey = process.env.CHARIOW_API_KEY;
  if (!apiKey || !key) return false;
  try {
    const r = await fetch('https://api.chariow.com/v1/licenses/' + encodeURIComponent(key), {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
    });
    if (!r.ok) return false;
    const d = await r.json();
    const lic = d.data || d.license || d || {};
    const st = String(lic.status || '').toLowerCase();
    return (lic.is_active === true || st === 'active' || st === 'pending_activation')
      && lic.is_expired !== true && st !== 'revoked' && st !== 'expired';
  } catch (e) { return false; }
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, reason: 'method' }, cors);

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE;   // clé de service — jamais côté client
  if (!SB_URL || !SB_KEY) return reply(200, { ok: false, reason: 'not_configured' }, cors);

  try {
    const body = JSON.parse(event.body || '{}');
    const key = String(body.key || '').trim();
    const ref = String(body.ref || '').trim().toUpperCase();

    if (!key || !REF_RE.test(ref)) return reply(200, { ok: false, reason: 'invalid' }, cors);

    // 1) Preuve de paiement : la licence doit être active chez Chariow.
    const paid = await licenseActive(key);
    if (!paid) return reply(200, { ok: false, reason: 'not_paid' }, cors);

    // 2) Empreinte de la clé (jamais la clé elle-même).
    const hash = crypto.createHash('sha256').update(key).digest('hex');

    // 3) Enregistrement. La contrainte UNIQUE bloque tout double comptage.
    const r = await fetch(SB_URL + '/rest/v1/referrals', {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ license_hash: hash, ref_code: ref, amount: REWARD_FCFA })
    });

    if (r.status === 409) return reply(200, { ok: false, reason: 'already_counted' }, cors);
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 220); } catch (_) {}
      const reason = (r.status === 401 || r.status === 403) ? 'bad_key'
                   : (r.status === 404) ? 'no_table' : 'store_error';
      return reply(200, { ok: false, reason, http: r.status, detail }, cors);
    }

    return reply(200, { ok: true, amount: REWARD_FCFA }, cors);
  } catch (e) {
    return reply(200, { ok: false, reason: 'server' }, cors);
  }
};
