// Fonction Netlify PLANIFIÉE — envoie le rappel quotidien aux utilisateurs qui
// l'ont accepté. Déclenchée toutes les heures (voir netlify.toml) : chaque
// abonné reçoit son message quand il est l'heure CHEZ LUI, pas à Lomé.
//
// AUCUNE DÉPENDANCE : le Web Push (RFC 8030 / 8291 / 8292) est implémenté ici
// avec le seul module `crypto` de Node. Pas de `web-push` à installer, donc rien
// ne peut casser au déploiement, et le service reste entièrement gratuit.
//
// Un abonné ne reçoit AU PLUS un message par jour (colonne `dernier_envoi`).
// Un abonnement périmé (410/404 renvoyé par le navigateur) est supprimé
// automatiquement : la table ne se remplit pas de fantômes.

const crypto = require('crypto');

const TTL_SECONDS = 6 * 3600;     // le message expire s'il n'est pas remis dans la journée
const MAX_PAR_TOUR = 400;         // borne le travail d'un tour de planification
const CONCURRENCE  = 10;

/* ---------------------------------------------------------------------------
   Supabase
   --------------------------------------------------------------------------- */
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

/* ---------------------------------------------------------------------------
   VAPID — prouve au navigateur que le message vient bien de notre serveur.
   La signature ES256 doit être au format brut R||S (64 octets) : le format DER
   par défaut de Node est refusé par les serveurs de push, d'où `ieee-p1363`.
   --------------------------------------------------------------------------- */
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function clePriveeVapid(d64, pub64) {
  const pub = Buffer.from(pub64, 'base64url');          // 0x04 || X(32) || Y(32)
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      d: d64,
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65))
    }
  });
}

function jwtVapid(audience, sujet, cle) {
  const entete  = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const charge  = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: sujet
  }));
  const corps = entete + '.' + charge;
  const sig = crypto.createSign('SHA256').update(corps).sign({ key: cle, dsaEncoding: 'ieee-p1363' });
  return corps + '.' + b64url(sig);
}

/* ---------------------------------------------------------------------------
   Chiffrement du contenu (RFC 8291, encodage aes128gcm).
   Le serveur de push ne peut PAS lire le message : seul l'appareil abonné le
   déchiffre. C'est ce qui rend le Web Push acceptable pour une app de gestion.
   --------------------------------------------------------------------------- */
function hmac(cle, donnee) { return crypto.createHmac('sha256', cle).update(donnee).digest(); }
function hkdf(sel, ikm, info, longueur) {
  return hmac(hmac(sel, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, longueur);
}

function chiffrer(texte, p256dh64, auth64) {
  const uaPublic = Buffer.from(p256dh64, 'base64url');
  const authSec  = Buffer.from(auth64,   'base64url');

  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();                 // clé éphémère : nouvelle à chaque envoi
  const partage  = ecdh.computeSecret(uaPublic);

  const infoCle = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm     = hkdf(authSec, partage, infoCle, 32);

  const sel   = crypto.randomBytes(16);
  const cek   = hkdf(sel, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(sel, ikm, Buffer.from('Content-Encoding: nonce\0'),     12);

  // 0x02 = délimiteur de fin d'enregistrement (padding vide).
  const clair = Buffer.concat([Buffer.from(texte, 'utf8'), Buffer.from([2])]);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const chiffre = Buffer.concat([c.update(clair), c.final(), c.getAuthTag()]);

  const entete = Buffer.alloc(21);                      // sel(16) + rs(4) + longueur clé(1)
  sel.copy(entete, 0);
  entete.writeUInt32BE(4096, 16);
  entete.writeUInt8(asPublic.length, 20);

  return Buffer.concat([entete, asPublic, chiffre]);
}

async function envoyer(sub, texte, cleVapid, pub64, sujet) {
  const audience = new URL(sub.endpoint).origin;
  const corps = chiffrer(texte, sub.p256dh, sub.auth);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': String(TTL_SECONDS),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(corps.length),
      'Urgency': 'normal',
      'Authorization': 'vapid t=' + jwtVapid(audience, sujet, cleVapid) + ', k=' + pub64
    },
    body: corps
  });
}

/* ---------------------------------------------------------------------------
   Messages — génériques par construction : aucune donnée d'activité n'est
   stockée sur le serveur, donc aucune ne peut fuiter dans un rappel.
   La rotation évite le même texte chaque matin, qu'on finit par ignorer.
   --------------------------------------------------------------------------- */
const MESSAGES = {
  fr: [
    { t: '📊 Ton tableau t\'attend', b: '2 minutes suffisent pour noter les ventes d\'hier.' },
    { t: '💡 Où en es-tu aujourd\'hui ?', b: 'Note tes recettes et dépenses : tu sauras exactement ce que tu as gagné.' },
    { t: '🧾 Des factures à relancer ?', b: 'Ouvre Pilote Business : tes impayés du jour t\'attendent.' },
    { t: '🎯 Ton objectif avance-t-il ?', b: 'Un coup d\'œil sur ta progression, et tu sais quoi faire aujourd\'hui.' },
    { t: '🚀 Un petit geste, un grand écart', b: 'Ceux qui notent chaque jour savent toujours où va leur argent.' },
    { t: '📦 Commandes en cours', b: 'Vérifie l\'état de tes commandes avant que le client ne te relance.' },
    { t: '💰 Fais le point de la semaine', b: 'Recettes, dépenses, bénéfice : trois chiffres, deux minutes.' }
  ],
  en: [
    { t: '📊 Your dashboard is waiting', b: '2 minutes are enough to log yesterday\'s sales.' },
    { t: '💡 Where do you stand today?', b: 'Log your income and expenses and you\'ll know exactly what you earned.' },
    { t: '🧾 Invoices to chase?', b: 'Open Pilote Business — today\'s unpaid invoices are waiting.' },
    { t: '🎯 Is your goal moving?', b: 'One look at your progress tells you what to do today.' },
    { t: '🚀 Small habit, big gap', b: 'People who log daily always know where their money goes.' },
    { t: '📦 Orders in progress', b: 'Check your orders before the customer chases you.' },
    { t: '💰 Take stock of the week', b: 'Income, expenses, profit: three numbers, two minutes.' }
  ],
  ar: [
    { t: '📊 لوحتك في انتظارك', b: 'دقيقتان تكفيان لتسجيل مبيعات الأمس.' },
    { t: '💡 أين أنت اليوم؟', b: 'سجّل مداخيلك ومصاريفك لتعرف بالضبط ما ربحته.' },
    { t: '🧾 فواتير تحتاج متابعة؟', b: 'افتح Pilote Business — فواتيرك غير المدفوعة بانتظارك.' },
    { t: '🎯 هل يتقدّم هدفك؟', b: 'نظرة واحدة على تقدّمك تكفي لتعرف ما تفعله اليوم.' },
    { t: '🚀 عادة صغيرة، فرق كبير', b: 'من يسجّل يوميًا يعرف دائمًا أين تذهب أمواله.' },
    { t: '📦 طلبات جارية', b: 'تحقّق من طلباتك قبل أن يتصل بك الزبون.' },
    { t: '💰 قيّم أسبوعك', b: 'مداخيل، مصاريف، ربح: ثلاثة أرقام في دقيقتين.' }
  ]
};

function messageDuJour(langue, jourISO) {
  const liste = MESSAGES[langue] || MESSAGES.fr;
  const jours = Math.floor(Date.parse(jourISO + 'T00:00:00Z') / 864e5);
  return liste[((jours % liste.length) + liste.length) % liste.length];
}

/* ---------------------------------------------------------------------------
   Tour de planification
   --------------------------------------------------------------------------- */
exports.handler = async () => {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE;
  const PUB    = process.env.VAPID_PUBLIC;
  const PRIV   = process.env.VAPID_PRIVATE;
  const SUJET  = process.env.VAPID_SUBJECT || 'mailto:azidaniel284@gmail.com';

  if (!SB_URL || !SB_KEY) return { statusCode: 200, body: 'not_configured:supabase' };
  if (!PUB || !PRIV)      return { statusCode: 200, body: 'not_configured:vapid' };

  let cleVapid;
  try { cleVapid = clePriveeVapid(PRIV, PUB); }
  catch (e) { return { statusCode: 200, body: 'vapid_key_invalid' }; }

  const r = await sb('push_abonnes?actif=eq.true&select=endpoint,p256dh,auth,heure,tz,langue,dernier_envoi&limit=' + MAX_PAR_TOUR,
                     {}, SB_URL, SB_KEY);
  if (!r.ok) return { statusCode: 200, body: 'read_error:' + r.status };
  const abonnes = await r.json();

  const maintenant = Date.now();
  // Ne garde que ceux dont l'heure locale correspond et qui n'ont rien reçu aujourd'hui.
  const aEnvoyer = [];
  for (const s of abonnes) {
    const local = new Date(maintenant - (Number(s.tz) || 0) * 60000);
    const heureLocale = local.getUTCHours();
    const jourLocal   = local.toISOString().slice(0, 10);
    if (heureLocale !== Number(s.heure)) continue;
    if (s.dernier_envoi === jourLocal) continue;
    aEnvoyer.push({ sub: s, jour: jourLocal });
  }

  let envoyes = 0, perimes = 0, echecs = 0;
  const file = aEnvoyer.slice();
  const worker = async () => {
    while (file.length) {
      const { sub, jour } = file.shift();
      const m = messageDuJour(sub.langue || 'fr', jour);
      try {
        const res = await envoyer(sub, JSON.stringify({ titre: m.t, corps: m.b, tag: 'pb-daily' }),
                                  cleVapid, PUB, SUJET);
        if (res.status === 404 || res.status === 410) {
          // L'utilisateur a désinstallé l'app ou révoqué l'autorisation : on nettoie.
          await sb('push_abonnes?endpoint=eq.' + encodeURIComponent(sub.endpoint), { method: 'DELETE' }, SB_URL, SB_KEY);
          perimes++;
        } else if (res.ok || res.status === 201 || res.status === 202) {
          await sb('push_abonnes?endpoint=eq.' + encodeURIComponent(sub.endpoint), {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ dernier_envoi: jour })
          }, SB_URL, SB_KEY);
          envoyes++;
        } else { echecs++; }
      } catch (e) { echecs++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCE, file.length || 1) }, worker));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, candidats: aEnvoyer.length, envoyes, perimes, echecs })
  };
};
