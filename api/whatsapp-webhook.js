// Fonction serverless Vercel : reçoit les messages WhatsApp (via Twilio),
// résume le lien envoyé avec Claude, et crée un brouillon dans Airtable
// (via /api/astuces) prêt à être validé côté admin.

const CATEGORIES = ['Plomberie', 'Électronique', 'Informatique', 'Impression 3D', 'Cuisine', 'Bonnes Pensées'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Méthode non autorisée');
  }

  // Twilio envoie les données en application/x-www-form-urlencoded
  const messageBody = (req.body && req.body.Body) || '';

  const urlMatch = messageBody.match(/(https?:\/\/[^\s]+)/);
  if (!urlMatch) {
    return sendTwiml(res, "Envoie-moi un lien (YouTube, Instagram...) et je m'occupe de créer la fiche 👍");
  }
  const sourceUrl = urlMatch[1];

  try {
    const sourceInfo = await extractSourceInfo(sourceUrl);
    const summary = await generateSummary(sourceInfo, sourceUrl);
    await createDraft(summary, sourceUrl, sourceInfo.thumbnail);

    return sendTwiml(res, `C'est noté ! 📝 J'ai créé le brouillon "${summary.title}" (catégorie : ${summary.category}). Va le valider sur le site.`);
  } catch (err) {
    console.error('Erreur webhook WhatsApp:', err);
    return sendTwiml(res, `Oups, je n'ai pas réussi à traiter ce lien 😕 (${err.message})`);
  }
};

// --- Répond à Twilio au format TwiML attendu ---
function sendTwiml(res, message) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`);
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

  // Instagram / TikTok / autres : pas d'accès public simple sans scraping dédié.
  // On transmet juste le lien à Claude, qui devra travailler avec peu de contexte.
  return {
    platform: 'autre',
    title: null,
    author: null,
    thumbnail: null
  };
}

// --- Appelle l'API Claude pour générer le résumé structuré ---
async function generateSummary(sourceInfo, sourceUrl) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) throw new Error('Clé ANTHROPIC_API_KEY manquante sur Vercel');

  const contextLines = [
    `Lien source : ${sourceUrl}`,
    sourceInfo.title ? `Titre original : ${sourceInfo.title}` : null,
    sourceInfo.author ? `Auteur / chaîne : ${sourceInfo.author}` : null
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

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'Erreur API Claude');

  const textBlock = (data.content || []).find(b => b.type === 'text');
  const raw = textBlock ? textBlock.text : '{}';
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
