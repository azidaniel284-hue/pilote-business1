// Fonction Netlify PLANIFIÉE — empêche la mise en pause du projet Supabase.
//
// Pourquoi : sur l'offre gratuite, Supabase met un projet en pause après
// 7 jours SANS la moindre requête. Au démarrage d'un SaaS, il est normal de
// n'avoir aucun trafic pendant plusieurs jours : le projet s'endort, et
// l'inscription au compte cloud échoue ("Load failed").
//
// Cette fonction exécute une requête minuscule 2 fois par semaine, ce qui
// suffit à garder le projet actif. Coût : zéro.
// La planification est définie dans netlify.toml.

exports.handler = async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  try {
    // Requête la plus légère possible : on ne demande aucune ligne (limit=0),
    // mais la base est bien sollicitée — c'est ce qui compte pour Supabase.
    const r = await fetch(url + '/rest/v1/states?select=id&limit=1', {
      headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' }
    });
    console.log('keep-alive Supabase →', r.status);
    return { statusCode: 200, body: JSON.stringify({ ok: r.ok, status: r.status, at: new Date().toISOString() }) };
  } catch (e) {
    console.log('keep-alive échec →', e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'unreachable' }) };
  }
};
