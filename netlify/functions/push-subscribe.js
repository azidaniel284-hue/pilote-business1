// Fonction Netlify — abonnement / désabonnement aux rappels quotidiens (Web Push).
//
// POURQUOI CE CHOIX : le Web Push est un standard du navigateur (RFC 8030/8291).
// Il ne coûte RIEN et ne dépend d'aucun service tiers payant — ni Firebase, ni
// OneSignal, ni Pusher. Ce sont les serveurs de Google, Apple et Mozilla qui
// relaient le message, gratuitement, parce que c'est leur navigateur.
//
// RÈGLE DE CONSENTEMENT : rien n'est enregistré ici tant que l'utilisateur n'a
// pas explicitement accepté les notifications dans son navigateur. Le navigateur
// ne délivre l'abonnement (`endpoint` + clés) qu'après ce consentement : il est
// donc techniquement impossible d'inscrire quelqu'un à son insu.
//
// VIE PRIVÉE : on ne stocke QUE ce qu'il faut pour poster un message à l'heure
// voulue — l'adresse d'envoi, les deux clés de chiffrement, l'heure locale, le
// décalage horaire et la langue. AUCUNE donnée d'activité (chiffre d'affaires,
// factures, clients) ne quitte l'appareil. Le rappel est donc générique : c'est
// l'app, une fois ouverte, qui affiche les chiffres réels.

function reply(status, obj, cors) {
  return { statusCode: status, headers: cors, body: JSON.stringify(obj) };
}
// Même normalisation d'URL que les autres fonctions : un slash final produisait
// « ...//rest/v1/... », rejeté par Supabase (PGRST125).
function sbBase(u) {
  return String(u || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
}
function sb(path, opts, SB_URL, SB_KEY) {
  return fetch(sbBase(SB_URL) + '/rest/v1/' + path, Object.assign({}, opts, {
    headers: Object.assign({
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json'
    }, (opts && opts.headers) || {})
  }));
}
async function diag(res) {
  let detail = '';
  try { detail = (await res.text()).slice(0, 220); } catch (_) {}
  const reason = (res.status === 401 || res.status === 403) ? 'bad_key'
               : (res.status === 404) ? 'no_table'
               : 'store_error';
  return { reason, http: res.status, detail };
}

// N'accepte que les serveurs de push officiels des navigateurs. Sans ce filtre,
// on pourrait nous faire poster des requêtes vers une adresse arbitraire.
const HOTES_OK = /(^|\.)(googleapis\.com|mozilla\.com|mozaws\.net|windows\.com|push\.apple\.com|microsoft\.com)$/i;
function endpointValide(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOTES_OK.test(u.hostname);
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
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE;
  if (!SB_URL || !SB_KEY) return reply(200, { ok: false, reason: 'not_configured' }, cors);

  try {
    const body = JSON.parse(event.body || '{}');
    const endpoint = String(body.endpoint || '').trim();
    if (!endpoint || endpoint.length > 900) return reply(200, { ok: false, reason: 'endpoint_invalide' }, cors);
    if (!endpointValide(endpoint))          return reply(200, { ok: false, reason: 'endpoint_refuse' }, cors);

    // --- Désabonnement : l'utilisateur retire son consentement ---------------
    if (body.action === 'off') {
      const r = await sb('push_abonnes?endpoint=eq.' + encodeURIComponent(endpoint),
                         { method: 'DELETE' }, SB_URL, SB_KEY);
      if (!r.ok) return reply(200, Object.assign({ ok: false }, await diag(r)), cors);
      return reply(200, { ok: true, actif: false }, cors);
    }

    // --- Abonnement / mise à jour de l'heure --------------------------------
    const p256dh = String(body.p256dh || '').trim();
    const auth   = String(body.auth   || '').trim();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{10,64}$/.test(auth)) {
      return reply(200, { ok: false, reason: 'cles_invalides' }, cors);
    }
    let heure = Math.round(Number(body.heure));
    if (!isFinite(heure) || heure < 0 || heure > 23) heure = 8;
    let tz = Math.round(Number(body.tz));                    // minutes, comme getTimezoneOffset()
    if (!isFinite(tz) || tz < -900 || tz > 900) tz = 0;
    const langue = ['fr', 'en', 'ar'].includes(String(body.langue)) ? String(body.langue) : 'fr';

    // `resolution=merge-duplicates` sur la clé unique `endpoint` : réactiver ou
    // changer d'heure met à jour la ligne au lieu d'en créer une deuxième.
    const r = await sb('push_abonnes', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ endpoint, p256dh, auth, heure, tz, langue, actif: true, dernier_envoi: null })
    }, SB_URL, SB_KEY);
    if (!r.ok) return reply(200, Object.assign({ ok: false }, await diag(r)), cors);

    return reply(200, { ok: true, actif: true, heure }, cors);
  } catch (e) {
    return reply(200, { ok: false, reason: 'server' }, cors);
  }
};
