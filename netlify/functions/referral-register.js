// Fonction Netlify — le parrain enregistre le numéro Mobile Money sur lequel
// il veut être payé, et consulte ses gains.
//
// PROTECTION ANTI-VOL DE CODE : un code de parrainage circule en clair dans les
// messages WhatsApp. N'importe qui pourrait donc tenter d'y associer SON numéro.
// Règle appliquée : le PREMIER enregistrement gagne, et il est immuable.
// Toute tentative ultérieure de changer le numéro est refusée (le propriétaire
// peut le modifier manuellement dans Supabase si un utilisateur le demande).

const REF_RE   = /^PB-[A-Z0-9]{5}$/;
const PHONE_RE = /^\+?[0-9]{8,15}$/;

function reply(status, obj, cors) {
  return { statusCode: status, headers: cors, body: JSON.stringify(obj) };
}
function sb(path, opts, SB_URL, SB_KEY) {
  return fetch(SB_URL + '/rest/v1/' + path, Object.assign({}, opts, {
    headers: Object.assign({
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json'
    }, (opts && opts.headers) || {})
  }));
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
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE;
  if (!SB_URL || !SB_KEY) return reply(200, { ok: false, reason: 'not_configured' }, cors);

  try {
    const body   = JSON.parse(event.body || '{}');
    const action = String(body.action || 'register');
    const code   = String(body.code || '').trim().toUpperCase();
    if (!REF_RE.test(code)) return reply(200, { ok: false, reason: 'invalid_code' }, cors);

    // --- Consultation des gains (aucune donnée sensible renvoyée) ---
    if (action === 'status') {
      const q = await sb('referrals?ref_code=eq.' + encodeURIComponent(code) +
                         '&select=amount,status', { method: 'GET' }, SB_URL, SB_KEY);
      const rows = q.ok ? await q.json() : [];
      const pend = rows.filter(r => r.status === 'a_payer');
      const paid = rows.filter(r => r.status === 'paye');
      const reg  = await sb('referrers?ref_code=eq.' + encodeURIComponent(code) +
                            '&select=phone', { method: 'GET' }, SB_URL, SB_KEY);
      const regRows = reg.ok ? await reg.json() : [];
      const phone = regRows[0] && regRows[0].phone ? String(regRows[0].phone) : null;
      return reply(200, {
        ok: true,
        registered: !!phone,
        // on ne renvoie que les derniers chiffres, jamais le numéro complet
        phone_hint: phone ? ('••••' + phone.slice(-3)) : null,
        pending_count: pend.length,
        pending_amount: pend.reduce((s, r) => s + (r.amount || 0), 0),
        paid_count: paid.length,
        paid_amount: paid.reduce((s, r) => s + (r.amount || 0), 0)
      }, cors);
    }

    // --- Enregistrement du numéro (immuable) ---
    const phone = String(body.phone || '').replace(/[\s.-]/g, '');
    const name  = String(body.name || '').trim().slice(0, 60);
    if (!PHONE_RE.test(phone)) return reply(200, { ok: false, reason: 'invalid_phone' }, cors);

    const ins = await sb('referrers', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ ref_code: code, phone: phone, name: name || null })
    }, SB_URL, SB_KEY);

    if (ins.status === 409) return reply(200, { ok: false, reason: 'already_registered' }, cors);
    if (!ins.ok) return reply(200, { ok: false, reason: 'store_error' }, cors);

    return reply(200, { ok: true }, cors);
  } catch (e) {
    return reply(200, { ok: false, reason: 'server' }, cors);
  }
};
