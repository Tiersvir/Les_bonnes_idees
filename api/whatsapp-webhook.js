// Fonction serverless Vercel : reçoit les messages WhatsApp (via Twilio),
// résume le lien envoyé avec Gemini, et crée un brouillon dans Airtable
// (via /api/astuces) prêt à être validé côté admin.
//
// Fonctionnement en 2 temps :
// 1. On répond IMMÉDIATEMENT à Twilio (obligatoire sous ~15s, sinon Twilio abandonne).
// 2. Le traitement réel (récupération du lien + IA + Airtable) continue en arrière-plan
//    grâce à waitUntil, puis un second message est envoyé via l'API Twilio avec le résultat.

const { waitUntil } = require('@vercel/functions');

const CATEGORIES = ['Plomberie', 'Électronique', 'Informatique', 'Impression 3D', 'Cuisine', 'Bonnes Pensées'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Méthode non autorisée');
  }

  // Twilio envoie les données en application/x-www-form-urlencoded
  const messageBody = (req.body && req.body.Body) || '';
  const from = (req.body && req.body.From) || ''; // ex: "whatsapp:+33612345678"

  const urlMatch = messageBody.match(/(https?:\/\/[^\s]+)/);
  if (!urlMatch) {
    sendTwiml(res, "Envoie-moi un lien (YouTube, Instagram, un site...) et je m'occupe de créer la fiche 👍");
    return;
  }
  const sourceUrl = urlMatch[1];

  // 1. Réponse immédiate pour rester sous le délai limite de Twilio
  sendTwiml(res, "🔎 C'est bien reçu ! Je regarde ce lien, je reviens vers toi dans quelques instants avec le résultat...");

  // 2. Traitement en arrière-plan (peut prendre plus de temps que la limite Twilio)
  waitUntil(processLink(sourceUrl, from));
};

async function processLink(sourceUrl, from) {
  try {
    const sourceInfo = await extractSourceInfo(sourceUrl);
    const summary = await generateSummary(sourceInfo, sourceUrl);
    await createDraft(summary, sourceUrl, sourceInfo.thumbnail);

    await sendWhatsappMessage(from, `✅ C'est ajouté ! Brouillon "${summary.title}" (catégorie : ${summary.category}) prêt à valider sur le site.`);
  } catch (err) {
    console.error('Erreur traitement lien WhatsApp:', err);
    await sendWhatsappMessage(from, `😕 Je n'ai pas réussi à traiter ce lien (${err.message})`);
  }
}

// --- Répond immédiatement à Twilio au format TwiML attendu ---
function sendTwiml(res, message) {
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`);
}

// --- Envoie un second message WhatsApp via l'API Twilio (message "sortant", indépendant du webhook) ---
async function sendWhatsappMessage(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER; // ex: "whatsapp:+14155238886"

  if (!accountSid || !authToken || !fromNumber || !to) {
    console.error('Configuration Twilio incomplète : impossible d\'envoyer le message de suivi.');
    return;
  }

  const params = new URLSearchParams();
  params.append('From', fromNumber);
  params.append('To', to);
  params.append('Body', body);

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    console.error('Erreur envoi message Twilio de suivi:', errText);
  }
}

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Récupère les infos disponibles selon la plateforme source ---
async function extractSourceInfo(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const r = await fetch(oembedUrl);
    if (!r.ok) throw new Error('Impossible de récupérer les infos YouTube (lien invalide ou vidéo privée)');
    const data = await r.json();

    const videoIdMatch = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    const thumbnail = videoIdMatch ? `https://img.youtube.com/vi/${videoIdMatch[1]}/hqdefault.jpg` : null;

    return {
      platform: 'youtube',
      title: data.title,
      author: data.author_name,
      thumbnail
    };
  }

  // Cas général (MakerWorld, blogs, articles, la plupart des sites...) :
  // on lit les balises Open Graph que les sites utilisent pour les aperçus de partage.
  // Note : certains réseaux comme Instagram ou TikTok bloquent ce type de lecture
  // automatique, le brouillon sera alors créé avec moins de détails (à compléter à la main).
  try {
    const r = await fetch(url, {
      headers: {
        // Beaucoup de sites bloquent les bots qui s'identifient comme tels ; on se présente
        // donc comme un navigateur standard pour maximiser les chances d'obtenir la page.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
      }
    });
    if (!r.ok) throw new Error(`page inaccessible (code ${r.status})`);
    const html = await r.text();

    const title = extractMeta(html, 'og:title') || extractTitleTag(html);
    const description = extractMeta(html, 'og:description') || extractMeta(html, 'description');
    const image = extractMeta(html, 'og:image') || extractMeta(html, 'twitter:image') || extractFirstImage(html, url);
    const author = extractMeta(html, 'og:site_name') || hostnameOf(url);
    const urlHint = guessFromUrl(url);

    return { platform: 'générique', title: title || urlHint, author, thumbnail: image, description };
  } catch (e) {
    console.error('Lecture générique de la page échouée:', e.message);
    // Dernier recours : même si la page est totalement inaccessible (blocage anti-bot),
    // le nom de domaine et les mots du chemin de l'URL donnent souvent un indice exploitable
    // (ex: makerworld.com/models/support-rangement-cables -> "support rangement cables").
    return { platform: 'inconnu', title: guessFromUrl(url), author: hostnameOf(url), thumbnail: null, description: null };
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return null;
  }
}

// Déduit un titre approximatif à partir des mots présents dans le chemin de l'URL.
function guessFromUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const words = decodeURIComponent(pathname)
      .replace(/^www\./, '')
      .split(/[\/\-_?=.]+/)
      .filter(w => w && isNaN(w) && w.length > 2 && !/^(html?|php|aspx?|www)$/i.test(w));
    if (words.length === 0) return null;
    return `${words.join(' ')} (${hostname.replace(/^www\./, '')})`;
  } catch (e) {
    return null;
  }
}

// --- Petits utilitaires d'extraction de balises <meta> dans du HTML brut ---
function extractMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return null;
}

function extractTitleTag(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? decodeHtmlEntities(m[1]) : null;
}

// Dernier recours : la première balise <img> avec une source exploitable trouvée dans la page.
function extractFirstImage(html, pageUrl) {
  const matches = html.match(/<img[^>]+src=["']([^"']+)["']/gi);
  if (!matches) return null;
  for (const tag of matches) {
    const m = tag.match(/src=["']([^"']+)["']/i);
    if (!m) continue;
    let src = m[1];
    if (src.startsWith('data:')) continue; // images encodées inline, inutilisables telles quelles
    try {
      // Gère les URLs relatives (ex: "/images/photo.jpg") en les complétant avec le domaine
      src = new URL(src, pageUrl).href;
    } catch (e) {
      continue;
    }
    return src;
  }
  return null;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// --- Appelle l'API Gemini (gratuite) pour générer le résumé structuré ---
async function generateSummary(sourceInfo, sourceUrl) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) throw new Error('Clé GEMINI_API_KEY manquante sur Vercel');

  const contextLines = [
    `Lien source : ${sourceUrl}`,
    sourceInfo.title ? `Titre original : ${sourceInfo.title}` : null,
    sourceInfo.author ? `Auteur / chaîne / site : ${sourceInfo.author}` : null,
    sourceInfo.description ? `Description : ${sourceInfo.description}` : null
  ].filter(Boolean).join('\n');

  const prompt = `Voici le contenu d'où vient une astuce à résumer :
${contextLines}

Réponds UNIQUEMENT avec un objet JSON strict (pas de texte autour, pas de \`\`\`), au format :
{
  "title": "titre concret et précis de l'astuce (max 60 caractères)",
  "category": "une valeur EXACTE parmi : ${CATEGORIES.join(', ')}",
  "summary": "résumé en une phrase, max 20 mots",
  "fullDetail": "explication détaillée de l'astuce en 3 à 5 phrases"
}

Consignes importantes pour que la fiche soit facilement trouvable dans un moteur de recherche interne :
- Le titre doit nommer l'action et l'objet précis concernés (ex: "Déboucher un siphon avec du bicarbonate et du vinaigre"), jamais une formule vague comme "Astuce plomberie" ou "Vu sur la cuisine".
- Le résumé et le détail doivent citer les mots-clés concrets présents dans le titre/la description d'origine : noms d'outils, de produits, de techniques, de matériaux, de logiciels, de marques, de mesures (ex: "colle époxy", "clé à molette", "réglage de température à 60°C").
- N'utilise JAMAIS le nom de la catégorie comme substitut au titre ou au résumé.
- Exploite TOUS les indices disponibles avant d'abandonner, y compris les plus faibles : le nom de domaine du site (ex: "makerworld.com" = impression 3D, "marmiton.org" = cuisine), les mots présents dans l'URL elle-même, le nom de l'auteur/du site. Un titre ou une description même partiels valent mieux qu'un titre générique.
- N'utilise la phrase "Contenu à vérifier manuellement" QUE si tu ne disposes vraiment d'aucun mot-clé exploitable (ni titre, ni description, ni mot dans l'URL, ni nom de domaine évocateur) — c'est censé rester rare, pas la réponse par défaut.
- N'invente aucun fait technique précis qui ne soit pas suggéré par les informations fournies, mais tu peux formuler une hypothèse raisonnable sur le sujet général à partir du domaine/des mots de l'URL (en le présentant comme tel si besoin, ex: "Astuce d'impression 3D repérée sur MakerWorld : titre exact à vérifier sur la page").`;

  const model = 'gemini-3-flash-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'Erreur API Gemini');

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const clean = raw.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error("Réponse IA non exploitable (JSON invalide)");
  }

  if (!parsed.title || !parsed.summary) {
    throw new Error("Résumé incomplet généré par l'IA");
  }

  return parsed;
}

// --- Crée le brouillon dans Airtable via /api/astuces ---
async function createDraft(summary, sourceUrl, thumbnail) {
  const baseUrl = process.env.SITE_URL || 'https://les-bonnes-idees.vercel.app';

  const r = await fetch(`${baseUrl}/api/astuces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: summary.title,
      category: summary.category,
      summary: summary.summary,
      fullDetail: summary.fullDetail,
      sourceUrl,
      imageUrl: thumbnail || undefined
    })
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Erreur lors de la création du brouillon');
  return data;
}
