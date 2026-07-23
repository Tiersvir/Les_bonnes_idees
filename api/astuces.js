// Fonction serverless Vercel : passerelle sécurisée entre le site et Airtable.
// La clé API Airtable reste ici, côté serveur, jamais visible dans le navigateur.

const BASE_ID = 'appgjg6HgW9nDLAon';
const TABLE_ID = 'tblFUqnOPcXPYarws';
const AIRTABLE_URL = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`;

// Correspondance entre les catégories Airtable (avec accents/majuscules)
// et les identifiants utilisés côté site (boutons de filtre, etc.)
const CATEGORY_MAP = {
  'Plomberie': { key: 'plomberie', label: 'Plomberie 🔧' },
  'Électronique': { key: 'electronique', label: 'Électronique ⚡' },
  'Informatique': { key: 'informatique', label: 'Informatique 💻' },
  'Impression 3D': { key: 'impression 3d', label: 'Impression 3D 🖨️' },
  'Cuisine': { key: 'cuisine', label: 'Cuisine 🍳' },
  'Bonnes Pensées': { key: 'philosophie', label: 'Bonnes Pensées 🧠' }
};

// Catégories Airtable valides (utilisées pour vérifier ce qu'envoie le robot IA)
const VALID_CATEGORIES = Object.keys(CATEGORY_MAP);

function mapCategory(rawLabel) {
  if (rawLabel && CATEGORY_MAP[rawLabel]) return CATEGORY_MAP[rawLabel];
  // Nouvelle catégorie proposée par le robot IA, pas encore dans la liste connue
  return { key: (rawLabel || '').toLowerCase(), label: rawLabel || 'Autre' };
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
    // --- LISTER TOUTES LES ASTUCES ---
    if (req.method === 'GET') {
      let records = [];
      let offset;
      do {
        const url = offset ? `${AIRTABLE_URL}?pageSize=100&offset=${offset}` : `${AIRTABLE_URL}?pageSize=100`;
        const r = await fetch(url, { headers });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error?.message || 'Erreur Airtable (lecture)');
        records = records.concat(data.records);
        offset = data.offset;
      } while (offset);

      const astuces = records.map(rec => {
        const cat = mapCategory(rec.fields['Catégorie']);
        return {
          id: rec.id,
          title: rec.fields['Titre'] || '',
          category: cat.key,
          categoryLabel: cat.label,
          summary: rec.fields['Résumé'] || '',
          fullDetail: rec.fields['Détail complet'] || '',
          sourceUrl: rec.fields['Source URL'] || '',
          image: (rec.fields['Images'] && rec.fields['Images'][0]) ? rec.fields['Images'][0].url : '',
          status: rec.fields['Statut'] === 'Validé' ? 'valide' : 'brouillon'
        };
      });

      return res.status(200).json(astuces);
    }

    // --- CRÉER UN NOUVEAU BROUILLON (utilisé par le webhook WhatsApp) ---
    if (req.method === 'POST') {
      const body = req.body || {};

      if (!body.title || !body.sourceUrl) {
        return res.status(400).json({ error: 'title et sourceUrl sont obligatoires' });
      }

      // Si la catégorie envoyée par l'IA ne correspond à aucune catégorie Airtable connue,
      // on retombe sur "Bonnes Pensées" pour éviter une erreur Airtable (champ select strict).
      const category = VALID_CATEGORIES.includes(body.category) ? body.category : 'Bonnes Pensées';

      const fields = {
        'Titre': body.title,
        'Catégorie': category,
        'Résumé': body.summary || '',
        'Détail complet': body.fullDetail || '',
        'Source URL': body.sourceUrl,
        'Statut': 'Brouillon'
      };

      if (body.imageUrl) {
        fields['Images'] = [{ url: body.imageUrl }];
      }

      const r = await fetch(AIRTABLE_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fields })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'Erreur Airtable (création)');

      return res.status(200).json({ success: true, id: data.id });
    }

    // --- MODIFIER / VALIDER UNE ASTUCE ---
    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id manquant' });

      const body = req.body || {};
      const fields = {};
      if (body.title !== undefined) fields['Titre'] = body.title;
      if (body.summary !== undefined) fields['Résumé'] = body.summary;
      if (body.fullDetail !== undefined) fields['Détail complet'] = body.fullDetail;
      if (body.status !== undefined) fields['Statut'] = body.status === 'valide' ? 'Validé' : 'Brouillon';

      const r = await fetch(`${AIRTABLE_URL}/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'Erreur Airtable (écriture)');

      return res.status(200).json({ success: true });
    }

    // --- SUPPRIMER UN BROUILLON REFUSÉ ---
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id manquant' });

      const r = await fetch(`${AIRTABLE_URL}/${id}`, { method: 'DELETE', headers });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'Erreur Airtable (suppression)');

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
