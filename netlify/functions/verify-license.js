// Fonction Netlify — vérifie une licence Chariow CÔTÉ SERVEUR.
// La clé secrète Chariow (sk_live_...) reste cachée dans la variable d'environnement
// CHARIOW_API_KEY et n'est JAMAIS exposée au navigateur.
// Réponse renvoyée à l'app : { active: bool, status: string, expires: string|null }

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const reply = (obj) => ({ statusCode: 200, headers: cors, body: JSON.stringify(obj) });

  try {
    const key = ((event.queryStringParameters && event.queryStringParameters.key) || '').trim();
    if (!key) return reply({ active: false, status: 'empty' });

    const apiKey = process.env.CHARIOW_API_KEY;
    if (!apiKey) return reply({ active: false, status: 'not_configured' });

    const r = await fetch('https://api.chariow.com/v1/licenses/' + encodeURIComponent(key), {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
    });
    if (!r.ok) return reply({ active: false, status: 'invalid' });

    const d = await r.json();
    // L'API peut renvoyer la licence directement ou dans { data: {...} } / { license: {...} }
    let lic = d.data || d.license || d || {};
    let st = String(lic.status || '').toLowerCase();

    // Licence payée mais pas encore activée → on l'active pour DÉMARRER l'expiration.
    // (Chariow calcule expires_at à l'activation, selon la durée de validité du produit.)
    if (st === 'pending_activation' && lic.is_expired !== true) {
      try {
        const ar = await fetch('https://api.chariow.com/v1/licenses/' + encodeURIComponent(key) + '/activate', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_identifier: 'pilote-business' })
        });
        if (ar.ok) { const ad = await ar.json(); lic = ad.data || ad.license || ad || lic; st = String(lic.status || '').toLowerCase(); }
      } catch (e) { /* on garde l'état lu si l'activation échoue */ }
    }

    // Premium accordé si la licence est payée et ni expirée ni révoquée
    // (on accepte 'active' ET 'pending_activation').
    const active = (lic.is_active === true || st === 'active' || st === 'pending_activation')
                   && lic.is_expired !== true && st !== 'revoked' && st !== 'expired';
    const expires = lic.expires_at || lic.expiry || lic.renews_at || lic.expiration || null;

    return reply({ active, status: lic.status || (active ? 'active' : 'inactive'), expires });
  } catch (e) {
    return reply({ active: false, status: 'error' });
  }
};
