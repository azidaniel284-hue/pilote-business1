// Fonction Netlify — réception des avis et messages des utilisateurs.
//
// POURQUOI CETTE FONCTION EXISTE : l'envoi passait par Netlify Forms (un POST
// vers « / » avec un champ form-name). Ce mécanisme dépend d'une détection au
// moment du déploiement ET d'une option à activer dans l'interface Netlify —
// invisible depuis le code, impossible à diagnostiquer, et silencieusement
// inopérante si l'option est désactivée. On reprend donc la main : l'avis est
// enregistré dans Supabase, avec une notification e-mail si Brevo est branché.
//
// Cette fonction n'exige AUCUN abonnement : un utilisateur qui n'a pas payé
// doit pouvoir signaler un problème. C'est même lui qu'on veut entendre.

const TYPES_OK = ['avis', 'bug', 'idee', 'aide', 'autre'];

function reply(status, obj, cors) {
  return { statusCode: status, headers: cors, body: JSON.stringify(obj) };
}
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
// Échappement : le message part dans un e-mail HTML. Sans ça, un utilisateur
// pourrait injecter du balisage dans la boîte de réception du propriétaire.
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Notification e-mail via l'API Brevo (gratuite, 300 messages/jour).
// Optionnelle : si la clé n'est pas posée, l'avis est quand même enregistré.
async function notifier(a) {
  const KEY  = process.env.BREVO_API_KEY;
  const FROM = process.env.AVIS_FROM  || 'noreply@pilote-business.com';
  const TO   = process.env.AVIS_TO    || 'azidaniel284@gmail.com';
  if (!KEY) return { envoye: false, raison: 'pas_de_cle' };
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        sender: { email: FROM, name: 'Pilote Business' },
        to: [{ email: TO }],
        // Répondre à l'e-mail répond directement à l'utilisateur.
        replyTo: a.email ? { email: a.email, name: a.nom || a.email } : undefined,
        subject: `[Pilote Business] ${a.type}${a.note ? ' · ' + a.note + '/5' : ''}`,
        htmlContent:
          `<p><b>Type :</b> ${esc(a.type)}<br>` +
          `<b>Note :</b> ${a.note ? esc(a.note) + '/5' : '—'}<br>` +
          `<b>Nom :</b> ${esc(a.nom) || '—'}<br>` +
          `<b>E-mail :</b> ${esc(a.email) || '—'}<br>` +
          `<b>Langue :</b> ${esc(a.langue)}</p>` +
          `<hr><p style="white-space:pre-wrap">${esc(a.message)}</p>`
      })
    });
    if (r.ok) return { envoye: true, http: r.status };
    // Diagnostic lisible : sans lui, un envoi refuse (IP non autorisee,
    // expediteur inconnu, quota) echouait en silence et l'avis restait
    // invisible pour le proprietaire.
    let detail = '';
    try {
      const d = await r.json();
      detail = String((d && (d.message || d.code)) || '').slice(0, 200);
    } catch (_) {}
    const raison = r.status === 401 ? 'cle_refusee_ou_ip_non_autorisee'
                 : r.status === 400 ? 'expediteur_ou_donnees_refuses'
                 : r.status === 402 ? 'quota_epuise'
                 : 'brevo_' + r.status;
    return { envoye: false, http: r.status, raison, detail };
  } catch (e) { return { envoye: false, raison: 'reseau', detail: String(e && e.message || '') }; }
}

/* Auto-diagnostic : dit ce qui est configure et si Brevo accepte la cle depuis
   CETTE machine, SANS envoyer le moindre message et sans exposer de secret.
   Appel : GET /.netlify/functions/avis?diag=1 */
async function diagnostic() {
  const out = {
    supabase_url:  !!process.env.SUPABASE_URL,
    supabase_cle:  !!process.env.SUPABASE_SERVICE_ROLE,
    brevo_cle:     !!process.env.BREVO_API_KEY,
    expediteur:    process.env.AVIS_FROM || 'noreply@pilote-business.com',
    destinataire:  process.env.AVIS_TO   || 'azidaniel284@gmail.com'
  };
  // La table existe-t-elle et la cle de service passe-t-elle ?
  if (out.supabase_url && out.supabase_cle) {
    try {
      const r = await sb('avis?select=id&limit=1', {}, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
      out.table_avis = r.ok ? 'ok' : (r.status === 404 ? 'ABSENTE — exécute supabase-avis.sql'
                                    : (r.status === 401 || r.status === 403) ? 'CLE REFUSEE' : 'erreur_' + r.status);
    } catch (e) { out.table_avis = 'injoignable'; }
  } else out.table_avis = 'non_configure';
  // La cle Brevo est-elle acceptee DEPUIS CETTE IP ? (lecture seule, aucun envoi)
  if (out.brevo_cle) {
    try {
      const r = await fetch('https://api.brevo.com/v3/account', {
        headers: { 'api-key': process.env.BREVO_API_KEY, 'Accept': 'application/json' } });
      out.brevo = r.ok ? 'ok'
                : r.status === 401 ? 'REFUSEE — clé invalide, ou IP non autorisée dans Brevo'
                : 'erreur_' + r.status;
      if (r.ok) { try { const d = await r.json(); out.brevo_compte = d.email || ''; } catch (_) {} }
    } catch (e) { out.brevo = 'injoignable'; }
  } else out.brevo = 'non_configure';
  return out;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  // Auto-diagnostic : aucun secret n'est renvoye, aucun message n'est envoye.
  if (event.httpMethod === 'GET' && event.queryStringParameters
      && event.queryStringParameters.diag) {
    return reply(200, await diagnostic(), cors);
  }
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, reason: 'method' }, cors);

  try {
    const b = JSON.parse(event.body || '{}');

    // Piège à robots : un humain ne remplit jamais ce champ, il est caché.
    if (String(b.website || '').trim()) return reply(200, { ok: true, ignore: true }, cors);

    const message = String(b.message || '').trim();
    if (message.length < 3)    return reply(200, { ok: false, reason: 'message_vide' }, cors);
    if (message.length > 4000) return reply(200, { ok: false, reason: 'message_trop_long' }, cors);

    const type   = TYPES_OK.includes(String(b.type)) ? String(b.type) : 'autre';
    let note     = Math.round(Number(b.note));
    if (!isFinite(note) || note < 1 || note > 5) note = null;
    const nom    = String(b.nom || '').trim().slice(0, 80);
    const email  = String(b.email || '').trim().slice(0, 120);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
      return reply(200, { ok: false, reason: 'email_invalide' }, cors);
    }
    const langue = ['fr', 'en', 'ar'].includes(String(b.langue)) ? String(b.langue) : 'fr';
    const avis   = { type, note, message, nom, email, langue };

    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_ROLE;

    // Sans base configurée, l'e-mail seul suffit à ne pas perdre l'avis.
    if (!SB_URL || !SB_KEY) {
      const mail = await notifier(avis);
      return mail.envoye
        ? reply(200, { ok: true, stocke: false, notifie: true }, cors)
        : reply(200, { ok: false, reason: 'not_configured' }, cors);
    }

    const r = await sb('avis', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify(Object.assign({}, avis, {
        version: String(b.version || '').slice(0, 24)
      }))
    }, SB_URL, SB_KEY);

    // L'e-mail part DANS TOUS LES CAS : c'est le canal par lequel le
    // proprietaire apprend qu'un avis existe. Si la base est en panne ou la
    // table absente, l'avis ne doit pas disparaitre pour autant.
    const mail = await notifier(avis);
    const stocke = r.ok;
    if (!stocke && !mail.envoye) {
      const d = await diag(r);
      return reply(200, Object.assign({ ok: false }, d, { mail: mail.raison || '' }), cors);
    }
    return reply(200, { ok: true, stocke, notifie: !!mail.envoye,
                        mail: mail.envoye ? '' : (mail.raison || '') }, cors);
  } catch (e) {
    return reply(200, { ok: false, reason: 'server' }, cors);
  }
};
