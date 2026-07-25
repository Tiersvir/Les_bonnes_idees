// Fonction serverless Vercel : gère les réglages d'apparence du site
// (couleur ou image du bandeau du haut, couleur ou image du fond de page),
// stockés dans Airtable (table "Themes", ligne "Accueil").
//
// NB : le système de blocs texte/image positionnables a été retiré (trop complexe
// à utiliser). Seule l'apparence globale du site (en-tête + fond de page) reste ici.

const THEMES_TABLE = 'tbl6K25lKdjMYq8Mf';
const BASE_ID = 'appgjg6HgW9nDLAon';
const THEMES_URL = `https://api.airtable.com/v0/${BASE_ID}/${THEMES_TABLE}`;

// Correspondance Nom Airtable <-> clé catégorie utilisée sur le site
const NAME_TO_KEY = {
  'Accueil': 'tous',
  'Plomberie': 'plomberie',
  'Électronique': 'electronique',
  'Informatique': 'informatique',
  'Impression 3D': 'impression 3d',
  'Cuisine': 'cuisine',
  'Bonnes Pensées': 'philosophie'
};

function checkAdminPassword(req) {
  const expected = process.env.ADMIN_PASSWORD;
  const provided = req.headers['x-admin-password'];
  return Boolean(expected) && provided === expected;
}

async function fetchAllRecords(url, headers) {
  let records = [];
  let offset;
  do {
    const pageUrl = offset ? `${url}?pageSize=100&offset=${offset}` : `${url}?pageSize=100`;
    const r = await fetch(pageUrl, { headers });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Erreur Airtable');
    records = records.concat(data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

module.exports = async function handler(req, res) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  if (!AIRTABLE_API_KEY) {
    return res.status(500).json({ error: 'Clé Airtable manquante (variable AIRTABLE_API_KEY non configurée sur Vercel).' });
  }

  const headers = {
    'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    // --- LISTER LES THÈMES (réglages d'apparence) ---
    if (req.method === 'GET') {
      const themeRecords = await fetchAllRecords(THEMES_URL, headers);
      const result = {};

      themeRecords.forEach(rec => {
        const key = NAME_TO_KEY[rec.fields['Nom']] || (rec.fields['Nom'] || '').toLowerCase();
        result[key] = {
          id: rec.id,
          name: rec.fields['Nom'] || '',
          couleur: rec.fields['Couleur'] || null,
          imageEntete: rec.fields['Image en-tête'] || null,
          couleurFondPage: rec.fields['Couleur fond page'] || null,
          imageFondPage: rec.fields['Image fond page'] || null
        };
      });

      return res.status(200).json(result);
    }

    // --- MODIFIER L'APPARENCE DU SITE (couleur/image de l'en-tête ou du fond de page) ---
    if (req.method === 'PATCH') {
      if (!checkAdminPassword(req)) {
        return res.status(401).json({ error: 'Mot de passe admin incorrect ou manquant' });
      }

      const { themeId } = req.query;
      if (!themeId) return res.status(400).json({ error: 'themeId manquant' });

      const body = req.body || {};
      const fields = {};
      if (body.couleur !== undefined) fields['Couleur'] = body.couleur;
      if (body.imageEntete !== undefined) fields['Image en-tête'] = body.imageEntete;
      if (body.couleurFondPage !== undefined) fields['Couleur fond page'] = body.couleurFondPage;
      if (body.imageFondPage !== undefined) fields['Image fond page'] = body.imageFondPage;

      const r = await fetch(`${THEMES_URL}/${themeId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'Erreur Airtable (modification thème)');
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
