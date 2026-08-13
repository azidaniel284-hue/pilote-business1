// Fonction Netlify — DROIT À L'EFFACEMENT.
// Supprime définitivement le compte cloud d'un utilisateur : sa sauvegarde
// (table `states`) ET son compte d'authentification Supabase.
//
// SÉCURITÉ : on n'accepte JAMAIS un simple identifiant fourni par le navigateur —
// n'importe qui pourrait alors effacer le compte d'un autre. L'appelant doit
// présenter son propre jeton de session Supabase ; on demande à Supabase à qui
// il appartient, et on ne supprime QUE ce compte-là.

const SB_KEY = () => process.env.SUPABASE_SERVICE_ROLE;
// Un slash final dans SUPABASE_URL casserait le chemin (erreur PGRST125).
const sbBase = () => String(process.env.SUPABASE_URL || '').trim()
  .replace(/\/+$/, '').replace(/\/rest\/v1$/, '');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };
  const reply = (s, o) => ({ statusCode: s, headers: cors, body: JSON.stringify(o) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, reason: 'method' });

  const base = sbBase(), key = SB_KEY();
  if (!base || !key) return reply(200, { ok: false, reason: 'not_configured' });

  try {
    const body = JSON.parse(event.body || '{}');
    const token = String(body.access_token || '').trim();
    if (!token) return reply(200, { ok: false, reason: 'no_token' });

    // 1) À qui appartient ce jeton ? Supabase seul peut le dire.
    const who = await fetch(base + '/auth/v1/user', {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + token }
    });
    if (!who.ok) return reply(200, { ok: false, reason: 'bad_token', http: who.status });
    const user = await who.json();
    const uid = user && user.id;
    if (!uid) return reply(200, { ok: false, reason: 'bad_token' });

    // 2) Effacer la sauvegarde cloud de CET utilisateur uniquement.
    const delData = await fetch(base + '/rest/v1/states?user_id=eq.' + encodeURIComponent(uid), {
      method: 'DELETE',
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Prefer': 'return=minimal' }
    });
    if (!delData.ok) {
      let detail = ''; try { detail = (await delData.text()).slice(0, 200); } catch (_) {}
      return reply(200, { ok: false, reason: 'data_error', http: delData.status, detail });
    }

    // 3) Effacer le compte lui-même (email + identifiants).
    const delUser = await fetch(base + '/auth/v1/admin/users/' + encodeURIComponent(uid), {
      method: 'DELETE',
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    });
    if (!delUser.ok) {
      let detail = ''; try { detail = (await delUser.text()).slice(0, 200); } catch (_) {}
      // La sauvegarde est déjà effacée : on le signale pour ne pas laisser croire
      // que rien n'a été fait.
      return reply(200, { ok: false, reason: 'auth_error', data_deleted: true, http: delUser.status, detail });
    }

    return reply(200, { ok: true });
  } catch (e) {
    return reply(200, { ok: false, reason: 'server' });
  }
};
