// Fonction Netlify — recherche web (Tavily) pour l'agent Business Plan, RÉSERVÉE aux abonnés.
// Garde TAVILY_API_KEY côté serveur et vérifie la licence Chariow (CHARIOW_API_KEY) avant chaque
// recherche, pour protéger ton quota Tavily. Réponse : { answer, results:[{title,url,content}] }

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
    const query = (body.query || '').toString().trim().slice(0, 400);
    if (!query) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'no_query' }) };

    // 1) Réservé aux abonnés : on vérifie la licence avant de consommer le quota Tavily.
    const ok = await licenseActive(body.license);
    if (!ok) return { statusCode: 402, headers: cors, body: JSON.stringify({ error: 'subscription_required' }) };

    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'search_not_configured' }) };

    // 2) Recherche web Tavily (palier gratuit). La clé est passée en header ET en body (compat).
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tavilyKey },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: query,
        max_results: 5,
        search_depth: 'basic',
        include_answer: true
      })
    });
    const d = await r.json();
    if (!r.ok) return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'search_error', detail: d }) };

    const results = Array.isArray(d.results) ? d.results.slice(0, 5).map(x => ({
      title: x.title || '',
      url: x.url || '',
      content: x.content || ''
    })) : [];
    return { statusCode: 200, headers: cors, body: JSON.stringify({ answer: d.answer || '', results }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'server' }) };
  }
};
