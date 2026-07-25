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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LesBonnesIdeesBot/1.0; +https://les-bonnes-idees.vercel.app)' }
    });
    if (!r.ok) throw new Error(`page inaccessible (code ${r.status})`);
    const html = await r.text();

    const title = extractMeta(html, 'og:title') || extractTitleTag(html);
    const description = extractMeta(html, 'og:description') || extractMeta(html, 'description');
    const image = extractMeta(html, 'og:image');
    const author = extractMeta(html, 'og:site_name');

    return { platform: 'générique', title, author, thumbnail: image, description };
  } catch (e) {
    console.error('Lecture générique de la page échouée:', e.message);
    return { platform: 'inconnu', title: null, author: null, thumbnail: null, description: null };
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
  "title": "titre court et accrocheur de l'astuce (max 60 caractères)",
  "category": "une valeur EXACTE parmi : ${CATEGORIES.join(', ')}",
  "summary": "résumé en une phrase, max 20 mots",
  "fullDetail": "explication détaillée de l'astuce en 3 à 5 phrases"
}

Si le titre original ne donne pas assez d'informations pour déduire l'astuce avec certitude, fais de ton mieux à partir du titre et indique dans fullDetail qu'il faudra vérifier le contenu source.`;

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
