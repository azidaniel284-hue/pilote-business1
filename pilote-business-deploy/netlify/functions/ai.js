// Fonction Netlify — proxy IA pour les abonnés Premium.
//
// Moteur principal : CLAUDE (Anthropic). Il apporte trois choses que Groq n'avait pas :
//   1. une bien meilleure qualité en français ;
//   2. la RECHERCHE WEB NATIVE (outil `web_search`) — Tavily n'est plus nécessaire ;
//   3. le cache de prompt (-90 % sur le contexte entreprise répété d'un tour à l'autre).
//
// Repli automatique : si ANTHROPIC_API_KEY manque, si Claude renvoie une erreur, ou si
// l'appel dépasse le délai d'une fonction Netlify (10 s), on bascule sur Groq pour que
// l'IA de l'app ne tombe JAMAIS. Le repli Groq ne sait pas chercher sur le web.
//
// Clés (Netlify → Site configuration → Environment variables — jamais dans index.html) :
//   ANTHROPIC_API_KEY  (principal)   CLAUDE_MODEL (optionnel, défaut claude-sonnet-5)
//   GROQ_API_KEY       (repli)       GROQ_MODEL   (optionnel)
//   CHARIOW_API_KEY    (vérification de licence — sans elle, personne n'accède à l'IA)

const CLAUDE_URL   = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
// Une fonction Netlify synchrone est coupée à 10 s. On s'arrête avant pour avoir le
// temps de basculer sur Groq (très rapide) et de répondre quand même à l'utilisateur.
const CLAUDE_DEADLINE_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 8000);

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
    return (lic.is_active === true || st === 'active' || st === 'pending_activation') && lic.is_expired !== true && st !== 'revoked' && st !== 'expired';
  } catch (e) { return false; }
}

/* Le client envoie des messages au format OpenAI (avec un rôle "system" dans la liste).
   Claude veut le système à part et une liste user/assistant qui COMMENCE par "user". */
function toAnthropic(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const system = list.filter(m => m && m.role === 'system')
                     .map(m => String(m.content || '')).join('\n\n').trim();
  const msgs = [];
  for (const m of list) {
    if (!m || m.role === 'system') continue;
    const text = String(m.content || '').trim();
    if (!text) continue;
    const role = (m.role === 'assistant') ? 'assistant' : 'user';
    if (!msgs.length && role !== 'user') continue;   // doit démarrer par un tour utilisateur
    msgs.push({ role, content: text });
  }
  return { system, msgs };
}

/* Lit la réponse de Claude : texte + sources web (pour l'affichage « Sources : »). */
function readClaude(data, acc) {
  for (const b of (data.content || [])) {
    if (b.type === 'text' && b.text) acc.text += b.text;
    if (b.type === 'web_search_tool_result') {
      const c = b.content;
      if (Array.isArray(c)) {                       // succès : liste de résultats
        for (const r of c) {
          if (r && r.url && !acc.seen.has(r.url)) {
            acc.seen.add(r.url);
            acc.sources.push({ title: r.title || r.url, url: r.url, content: '' });
          }
        }
      }
      // si `c` est un objet, c'est une erreur d'outil (quota, etc.) — on l'ignore
      // silencieusement : Claude répond alors avec ses connaissances propres.
    }
  }
  return acc;
}

async function callClaude({ system, msgs, web, maxTokens, signal }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('no_claude_key');

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    // Le contexte entreprise est identique d'un tour à l'autre → mis en cache (-90 %).
    system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
    messages: msgs,
    // Assistant du quotidien : rapide et économique. Agent business (web) : plus fouillé.
    output_config: { effort: web ? 'medium' : 'low' },
    thinking: web ? { type: 'adaptive' } : { type: 'disabled' }
  };
  // Recherche web native — remplace Tavily. `max_uses` borne la latence ET le coût.
  if (web) body.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }];
  // NB : Claude Sonnet 5 REFUSE temperature/top_p/top_k (erreur 400). On ne les envoie pas.

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01'
  };

  const acc = { text: '', sources: [], seen: new Set() };
  let payload = body;

  // La recherche web tourne côté Anthropic et peut rendre la main avec `pause_turn`
  // quand elle a besoin d'un tour de plus. On relance une fois, pas davantage
  // (le budget de temps d'une fonction Netlify est court).
  for (let turn = 0; turn < 2; turn++) {
    const r = await fetch(CLAUDE_URL, {
      method: 'POST', headers, body: JSON.stringify(payload), signal
    });
    const d = await r.json();
    if (!r.ok) {
      const e = new Error('claude_http_' + r.status);
      e.detail = d && d.error ? d.error : d;
      throw e;
    }

    // Un classifieur de sécurité peut refuser la demande (HTTP 200, pas une erreur).
    if (d.stop_reason === 'refusal') {
      return { text: '', sources: [], refused: true };
    }

    readClaude(d, acc);

    if (d.stop_reason !== 'pause_turn') break;
    // On renvoie l'échange tel quel : le serveur reprend là où il s'était arrêté.
    payload = Object.assign({}, body, {
      messages: msgs.concat([{ role: 'assistant', content: d.content }])
    });
  }

  return { text: acc.text.trim(), sources: acc.sources, refused: false };
}

async function callGroq({ messages, temperature, maxTokens }) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error('no_groq_key');
  // NB : llama-3.3-70b-versatile a été déprécié par Groq le 17/06/2026 → gpt-oss-120b.
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      messages: Array.isArray(messages) ? messages : [],
      temperature: (typeof temperature === 'number') ? temperature : 0.4,
      max_tokens: maxTokens
    })
  });
  const d = await r.json();
  if (!r.ok) { const e = new Error('groq_http_' + r.status); e.detail = d; throw e; }
  return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
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

    // 1) Réservé aux abonnés : on vérifie la licence AVANT de dépenser le moindre token.
    const ok = await licenseActive(body.license);
    if (!ok) return { statusCode: 402, headers: cors, body: JSON.stringify({ error: 'subscription_required' }) };

    const web = body.web === true;
    // Avec la réflexion adaptative, max_tokens plafonne réflexion + réponse : si le
    // client demande 800, la réponse serait tronquée. On garantit une marge.
    const asked = Number(body.max_tokens) || 700;
    const maxTokens = web ? Math.max(asked, 4000) : Math.max(asked, 700);

    // 2) Claude, avec garde-fou de temps.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLAUDE_DEADLINE_MS);
    try {
      const { system, msgs } = toAnthropic(body.messages);
      if (!msgs.length) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'no_messages' }) };

      const out = await callClaude({ system, msgs, web, maxTokens, signal: ctrl.signal });
      clearTimeout(timer);

      if (out.refused) {
        return { statusCode: 200, headers: cors, body: JSON.stringify({ content: '', refused: true, engine: 'claude' }) };
      }
      if (out.text) {
        return { statusCode: 200, headers: cors, body: JSON.stringify({ content: out.text, sources: out.sources, engine: 'claude' }) };
      }
      throw new Error('claude_empty');   // réponse vide → on tente Groq
    } catch (err) {
      clearTimeout(timer);
      // 3) Repli Groq — panne, quota, délai dépassé ou clé absente.
      try {
        const content = await callGroq({ messages: body.messages, temperature: body.temperature, maxTokens: Math.min(asked, 900) });
        if (!content) throw new Error('groq_empty');
        return { statusCode: 200, headers: cors, body: JSON.stringify({ content, sources: [], engine: 'groq' }) };
      } catch (err2) {
        return {
          statusCode: 502, headers: cors,
          body: JSON.stringify({ error: 'ai_error', claude: String(err && err.message || err), groq: String(err2 && err2.message || err2) })
        };
      }
    }
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'server' }) };
  }
};
