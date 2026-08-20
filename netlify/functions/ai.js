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
// L'AGENT tourne sur un modele plus capable que l'assistant : il choisit des
// outils qui ECRIVENT dans la comptabilite de l'utilisateur, une erreur y coute
// bien plus cher qu'une phrase maladroite. Surchargeable si le proprietaire
// veut arbitrer autrement entre qualite et cout.
const AGENT_MODEL  = process.env.AGENT_MODEL || 'claude-opus-5';
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
    const role = (m.role === 'assistant') ? 'assistant' : 'user';
    // MODE AGENT : le contenu peut être une LISTE de blocs (tool_use côté
    // assistant, tool_result côté utilisateur). On la transmet telle quelle —
    // l'aplatir en texte casserait la boucle d'outils.
    if (Array.isArray(m.content)) {
      if (!m.content.length) continue;
      if (!msgs.length && role !== 'user') continue;
      msgs.push({ role, content: m.content });
      continue;
    }
    const text = String(m.content || '').trim();
    if (!text) continue;
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

async function callClaude({ system, msgs, web, maxTokens, signal, tools, agent }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('no_claude_key');

  const body = {
    model: agent ? AGENT_MODEL : CLAUDE_MODEL,
    max_tokens: maxTokens,
    // Le contexte entreprise est identique d'un tour à l'autre → mis en cache (-90 %).
    system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
    messages: msgs,
    // Assistant du quotidien : rapide et économique. Agent business (web) : plus fouillé.
    // L'agent doit RAISONNER avant d'agir : on lui laisse plus de moyens que
    // l'assistant conversationnel, qui doit surtout être rapide.
    output_config: { effort: (agent || web) ? 'medium' : 'low' },
    thinking: (agent || web) ? { type: 'adaptive' } : { type: 'disabled' }
  };
  // Outils : ceux de l'agent (exécutés sur l'APPAREIL de l'utilisateur, jamais
  // ici) et/ou la recherche web native, qui tourne chez Anthropic.
  const outils = [];
  if (Array.isArray(tools) && tools.length) {
    // `strict: true` GARANTIT que les parametres recus respectent le schema.
    // Sans lui, l'agent peut inventer un champ ou omettre un montant, et on
    // ecrirait une ligne comptable incoherente. Le mode strict exige
    // `additionalProperties: false` et une liste `required`.
    for (const o of tools) {
      const schema = Object.assign({ additionalProperties: false, required: [] }, o.input_schema || {});
      if (!Array.isArray(schema.required)) schema.required = [];
      schema.additionalProperties = false;
      outils.push({ name: o.name, description: o.description, input_schema: schema, strict: true });
    }
  }
  if (web) outils.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
  if (outils.length) {
    // Les outils sont IDENTIQUES a chaque tour de boucle et sont rendus AVANT
    // le systeme et les messages : les mettre en cache economise leur cout et
    // reduit la latence de chaque tour suivant — ce qui compte beaucoup ici,
    // une fonction Netlify etant coupee a 10 s.
    const dernier = outils[outils.length - 1];
    if (!dernier.type) dernier.cache_control = { type: 'ephemeral' };
    body.tools = outils;
  }
  // NB : Claude Sonnet 5 REFUSE temperature/top_p/top_k (erreur 400). On ne les envoie pas.

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01'
  };
  // Un classifieur de securite peut decliner une demande pourtant legitime
  // (HTTP 200, stop_reason « refusal »). Sur le modele de l'agent, on demande a
  // Anthropic de rebasculer tout seul sur un autre modele plutot que de laisser
  // l'utilisateur devant un echec inexplique.
  if (agent) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

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

    // Mode agent : dès que Claude demande un outil, on rend la main au client.
    // C'est LUI qui exécute, parce que les données ne quittent pas l'appareil.
    if (agent && d.stop_reason === 'tool_use') {
      return { text: acc.text.trim(), sources: acc.sources, refused: false,
               blocs: d.content || [], stop: 'tool_use' };
    }
    if (d.stop_reason !== 'pause_turn') {
      if (agent) return { text: acc.text.trim(), sources: acc.sources, refused: false,
                          blocs: d.content || [], stop: d.stop_reason || 'end_turn' };
      break;
    }
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
    // Mode agent : la boucle d'outils tourne côté client. Groq ne sait pas la
    // mener de façon fiable, donc en cas de panne on le dit au lieu de basculer
    // sur un moteur qui répondrait n'importe quoi à un appel d'outil.
    const agent = body.agent === true && Array.isArray(body.tools) && body.tools.length > 0;
    // Avec la réflexion adaptative, max_tokens plafonne réflexion + réponse : si le
    // client demande 800, la réponse serait tronquée. On garantit une marge.
    const asked = Number(body.max_tokens) || 700;
    const maxTokens = (web || agent) ? Math.max(asked, 4000) : Math.max(asked, 700);

    // 2) Claude, avec garde-fou de temps.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLAUDE_DEADLINE_MS);
    try {
      const { system, msgs } = toAnthropic(body.messages);
      if (!msgs.length) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'no_messages' }) };

      const out = await callClaude({ system, msgs, web, maxTokens, signal: ctrl.signal,
                                     tools: agent ? body.tools : null, agent });
      clearTimeout(timer);

      if (out.refused) {
        return { statusCode: 200, headers: cors, body: JSON.stringify({ content: '', refused: true, engine: 'claude' }) };
      }
      if (agent) {
        return { statusCode: 200, headers: cors, body: JSON.stringify({
          content: out.text, blocs: out.blocs, stop: out.stop, sources: out.sources, engine: 'claude' }) };
      }
      if (out.text) {
        return { statusCode: 200, headers: cors, body: JSON.stringify({ content: out.text, sources: out.sources, engine: 'claude' }) };
      }
      throw new Error('claude_empty');   // réponse vide → on tente Groq
    } catch (err) {
      clearTimeout(timer);
      // En mode agent, pas de repli : mieux vaut un échec clair qu'une action
      // inventée sur les données de l'utilisateur.
      if (agent) {
        return { statusCode: 200, headers: cors,
                 body: JSON.stringify({ error: 'agent_indisponible', detail: String(err && err.message || '') }) };
      }
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
