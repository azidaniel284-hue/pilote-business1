// Fonction Netlify — connecteur Chariow pour les abonnés.
// Avec la clé API du MARCHAND (envoyée par le client), récupère ses ventes (→ recettes)
// et ses clients (→ contacts). Vérifie d'abord la licence Pilote Business via la clé
// CHARIOW_API_KEY du PROPRIÉTAIRE (gate Premium) avant d'autoriser l'import.

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
    return lic.is_active === true || lic.status === 'active';
  } catch (e) { return false; }
}

async function pull(path, userKey) {
  try {
    const r = await fetch('https://api.chariow.com/v1/' + path, {
      headers: { 'Authorization': 'Bearer ' + userKey, 'Accept': 'application/json' }
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, status: r.status, detail: d };
    const list = (d && (d.data || d.results || d.items)) || (Array.isArray(d) ? d : []);
    return { ok: true, list: Array.isArray(list) ? list : [] };
  } catch (e) { return { ok: false, error: 'fetch' }; }
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'method' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const userKey = (body.key || '').toString().trim();
    if (!userKey) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'no_key' }) };

    // Réservé aux abonnés Premium.
    const ok = await licenseActive(body.license);
    if (!ok) return { statusCode: 402, headers: cors, body: JSON.stringify({ error: 'subscription_required' }) };

    const [sales, customers] = await Promise.all([
      pull('sales?limit=100', userKey),
      pull('customers?limit=100', userKey)
    ]);

    if (!sales.ok && !customers.ok) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'chariow_error', sales, customers }) };
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({
      sales: sales.ok ? sales.list : [],
      customers: customers.ok ? customers.list : []
    }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'server' }) };
  }
};
