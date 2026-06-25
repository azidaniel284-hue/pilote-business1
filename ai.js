// Fonction Netlify — proxy IA pour les abonnés Premium.
// Garde la clé Groq du PROPRIÉTAIRE (GROQ_API_KEY) cachée côté serveur, et ne répond
// qu'aux licences Chariow actives (vérifiées avec CHARIOW_API_KEY). Ainsi l'IA est
// "clé en main" pour tes abonnés, et personne d'autre ne peut consommer ta clé Groq.

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

    // 1) Réservé aux abonnés : on vérifie la licence avant de consommer la clé Groq.
    const ok = await licenseActive(body.license);
    if (!ok) return { statusCode: 402, headers: cors, body: JSON.stringify({ error: 'subscription_required' }) };

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'ai_not_configured' }) };

    // 2) Appel à Groq (modèle open-source Llama par défaut).
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: Array.isArray(body.messages) ? body.messages : [],
        temperature: (typeof body.temperature === 'number') ? body.temperature : 0.4,
        max_tokens: body.max_tokens || 700
      })
    });
    const d = await r.json();
    if (!r.ok) return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'ai_error', detail: d }) };

    const content = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    return { statusCode: 200, headers: cors, body: JSON.stringify({ content }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'server' }) };
  }
};
