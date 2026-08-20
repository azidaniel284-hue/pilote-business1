// Fonction Netlify — liens de paiement pour les factures et commandes.
//
// PRINCIPE DE SÉCURITÉ CENTRAL : l'argent ne transite JAMAIS par un compte
// Pilote Business. Chaque entrepreneur connecte SON PROPRE compte agrégateur ;
// les fonds vont directement chez lui. Pilote Business ne fait que fabriquer le
// lien et lire le statut. Sans cela, l'éditeur deviendrait un transmetteur de
// fonds — activité réglementée exigeant un agrément BCEAO.
//
// Les identifiants marchands (clé API, identifiant de site) sont envoyés par
// l'appareil du marchand à chaque appel et ne sont JAMAIS stockés côté serveur,
// ni journalisés. Même schéma que le connecteur Chariow déjà en place.
//
// Architecture multi-prestataires : chaque agrégateur est un adaptateur exposant
// deux fonctions — creer() et statut(). Ajouter PayDunya, FedaPay ou CashPay ne
// demande que d'ajouter une entrée dans PROVIDERS, rien d'autre ne bouge.

// Devises acceptées. Doit couvrir toutes celles proposées dans l'app (CURRENCIES
// côté client) : une devise absente d'ici fait échouer la création du lien alors
// que l'utilisateur l'a choisie dans ses réglages.
const CURRENCIES_OK = ['XOF', 'XAF', 'GNF', 'CDF', 'NGN', 'GHS', 'KES', 'UGX', 'TZS',
                       'RWF', 'ZAR', 'ZMW', 'EGP', 'MAD', 'TND', 'DZD',
                       'AED', 'SAR', 'QAR', 'USD', 'EUR', 'GBP', 'CAD', 'CHF'];

function reply(status, obj, cors) {
  return { statusCode: status, headers: cors, body: JSON.stringify(obj) };
}

// Réservé aux abonnés : on vérifie la licence avant de consommer quoi que ce soit.
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
    return (lic.is_active === true || st === 'active' || st === 'pending_activation')
           && lic.is_expired !== true && st !== 'revoked' && st !== 'expired';
  } catch (e) { return false; }
}

/* ---------------------------------------------------------------------------
   ADAPTATEUR CinetPay
   Base d'API surchargeable par variable d'environnement : si CinetPay fait
   évoluer son domaine, on corrige sans redéployer le code de l'app.
   --------------------------------------------------------------------------- */
const CINETPAY_BASE = process.env.CINETPAY_BASE || 'https://api-checkout.cinetpay.com/v2';

const cinetpay = {
  champs: ['apikey', 'site_id'],
  async creer(creds, p) {
    const r = await fetch(CINETPAY_BASE + '/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: creds.apikey,
        site_id: creds.site_id,
        transaction_id: p.ref,
        amount: p.montant,
        currency: p.devise,
        description: p.description,
        return_url: p.retour || undefined,
        notify_url: p.notify || undefined,
        customer_name: p.client || undefined,
        customer_phone_number: p.tel || undefined,
        channels: 'ALL'
      })
    });
    const d = await r.json().catch(() => null);
    const url = d && d.data && (d.data.payment_url || d.data.payment_link);
    if (!r.ok || !url) {
      return { ok: false, reason: 'provider_error', http: r.status,
               detail: d && (d.description || d.message) ? String(d.description || d.message).slice(0, 200) : '' };
    }
    return { ok: true, url, jeton: (d.data.payment_token || '') };
  },
  async statut(creds, p) {
    const r = await fetch(CINETPAY_BASE + '/payment/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: creds.apikey, site_id: creds.site_id, transaction_id: p.ref })
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) return { ok: false, reason: 'provider_error', http: r.status };
    const data = d.data || {};
    // On NORMALISE : l'app ne doit jamais connaître le vocabulaire d'un prestataire.
    const brut = String(data.status || d.code || '').toUpperCase();
    let etat = 'attente';
    if (brut === 'ACCEPTED' || brut === '00' || brut === 'SUCCES' || brut === 'SUCCESS') etat = 'paye';
    else if (brut === 'REFUSED' || brut === 'CANCELED' || brut === 'CANCELLED' || brut === 'FAILED') etat = 'echoue';
    else if (brut === 'EXPIRED') etat = 'expire';
    return { ok: true, etat, montant: Number(data.amount) || 0, brut, le: data.payment_date || null };
  }
};

const PROVIDERS = { cinetpay };

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

  try {
    const body = JSON.parse(event.body || '{}');

    const ok = await licenseActive(body.license);
    if (!ok) return reply(402, { ok: false, reason: 'subscription_required' }, cors);

    const nom = String(body.provider || '').toLowerCase();
    const prov = PROVIDERS[nom];
    if (!prov) return reply(200, { ok: false, reason: 'provider_inconnu', dispo: Object.keys(PROVIDERS) }, cors);

    // Identifiants du marchand — présents à chaque appel, jamais conservés.
    const creds = body.creds || {};
    const manquant = prov.champs.filter(c => !String(creds[c] || '').trim());
    if (manquant.length) return reply(200, { ok: false, reason: 'creds_manquants', champs: manquant }, cors);

    if (body.action === 'status') {
      const ref = String(body.ref || '').trim();
      if (!ref) return reply(200, { ok: false, reason: 'ref_manquante' }, cors);
      return reply(200, await prov.statut(creds, { ref }), cors);
    }

    // --- Vérification des identifiants -------------------------------------
    // On interroge le statut d'une référence volontairement inexistante :
    //   - identifiants refusés  -> le prestataire répond 401/403  => creds fausses
    //   - identifiants acceptés -> il répond « transaction inconnue » => creds bonnes
    // Cela valide l'authentification SANS créer la moindre transaction réelle.
    if (body.action === 'test') {
      const r = await prov.statut(creds, { ref: 'PB-TEST-' + Date.now().toString(36) });
      if (r.ok) return reply(200, { ok: true, valide: true }, cors);
      const auth = r.http === 401 || r.http === 403;
      return reply(200, { ok: true, valide: !auth, http: r.http || 0 }, cors);
    }

    // --- Création du lien : on valide AVANT d'appeler le prestataire ----------
    const montant = Math.round(Number(body.montant));
    if (!isFinite(montant) || montant <= 0) return reply(200, { ok: false, reason: 'montant_invalide' }, cors);
    const devise = String(body.devise || 'XOF').toUpperCase();
    if (CURRENCIES_OK.indexOf(devise) === -1) return reply(200, { ok: false, reason: 'devise_non_supportee' }, cors);
    const ref = String(body.ref || '').trim();
    if (!/^[A-Za-z0-9_-]{6,60}$/.test(ref)) return reply(200, { ok: false, reason: 'ref_invalide' }, cors);

    const out = await prov.creer(creds, {
      ref, montant, devise,
      description: String(body.description || 'Paiement').slice(0, 120),
      client: String(body.client || '').slice(0, 60),
      tel: String(body.tel || '').slice(0, 20),
      retour: String(body.retour || '').slice(0, 300),
      notify: String(body.notify || '').slice(0, 300)
    });
    return reply(200, out, cors);
  } catch (e) {
    return reply(200, { ok: false, reason: 'server' }, cors);
  }
};
