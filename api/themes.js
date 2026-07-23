// Fonction serverless Vercel : gère les pages de présentation personnalisables par thème
// (fond d'écran + blocs texte/image), stockées dans Airtable (tables "Themes" et "Blocs").

const THEMES_TABLE = 'tbl6K25lKdjMYq8Mf';
const BLOCS_TABLE = 'tblpQoTo0lFiXCRG4';
const BASE_ID = 'appgjg6HgW9nDLAon';
const THEMES_URL = `https://api.airtable.com/v0/${BASE_ID}/${THEMES_TABLE}`;
const BLOCS_URL = `https://api.airtable.com/v0/${BASE_ID}/${BLOCS_TABLE}`;

// Champs (IDs) utilisés pour l'upload d'images (l'API d'upload Airtable veut des IDs de champ)
const FIELD_THEME_BACKGROUND = 'fldqkcvKDUWq5pnMB';
const FIELD_BLOC_IMAGE = 'fldA9ZLmQJgyAdJkC';

// Correspondance Nom Airtable <-> clé catégorie utilisée sur le site
const NAME_TO_KEY = {
  'Plomberie': 'plomberie',
  'Électronique': 'electronique',
  'Informatique': 'informatique',
  'Impression 3D': 'impression 3d',
  'Cuisine': 'cuisine',
  'Bonnes Pensées': 'philosophie'
};

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
    // --- LISTER LES THÈMES + LEURS BLOCS ---
    if (req.method === 'GET') {
      const [themeRecords, blocRecords] = await Promise.all([
        fetchAllRecords(THEMES_URL, headers),
        fetchAllRecords(BLOCS_URL, headers)
      ]);

      const themesByRecordId = {};
      const result = {};

      themeRecords.forEach(rec => {
        const key = NAME_TO_KEY[rec.fields['Nom']] || (rec.fields['Nom'] || '').toLowerCase();
        const bg = rec.fields["Fond d'écran"] && rec.fields["Fond d'écran"][0] ? rec.fields["Fond d'écran"][0].url : null;
        const themeObj = { id: rec.id, name: rec.fields['Nom'] || '', background: bg, blocks: [] };
        themesByRecordId[rec.id] = themeObj;
        result[key] = themeObj;
      });

      blocRecords.forEach(rec => {
        const links = rec.fields['Thème'] || [];
        links.forEach(themeRecId => {
          const themeObj = themesByRecordId[themeRecId];
          if (!themeObj) return;
          themeObj.blocks.push({
            id: rec.id,
            type: rec.fields['Type'] || 'Texte',
            texte: rec.fields['Texte'] || '',
            image: (rec.fields['Image'] && rec.fields['Image'][0]) ? rec.fields['Image'][0].url : '',
            ordre: rec.fields['Ordre'] || 0
          });
        });
      });

      Object.values(result).forEach(themeObj => {
        themeObj.blocks.sort((a, b) => a.ordre - b.ordre);
      });

      return res.status(200).json(result);
    }

    // --- CRÉER UN BLOC / UPLOADER UNE IMAGE ---
    if (req.method === 'POST') {
      const body = req.body || {};

      if (body.action === 'addBlock') {
        const { themeId, type, texte } = body;
        if (!themeId || !type) return res.status(400).json({ error: 'themeId et type requis' });

        const ordre = Date.now();
        const r = await fetch(BLOCS_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fields: {
              'Titre du bloc': type === 'Image' ? 'Bloc image' : 'Bloc texte',
              'Thème': [themeId],
              'Type': type,
              'Texte': texte || '',
              'Ordre': ordre
            }
          })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error?.message || 'Erreur Airtable (création bloc)');
        return res.status(200).json({ success: true, id: data.id, ordre });
      }

      if (body.action === 'uploadBlockImage' || body.action === 'uploadBackground') {
        const { fileBase64, filename, contentType } = body;
        if (!fileBase64 || !filename || !contentType) {
          return res.status(400).json({ error: 'fileBase64, filename et contentType requis' });
        }

        let recordId, fieldId;
        if (body.action === 'uploadBlockImage') {
          recordId = body.blockId;
          fieldId = FIELD_BLOC_IMAGE;
        } else {
          recordId = body.themeId;
          fieldId = FIELD_THEME_BACKGROUND;
        }
        if (!recordId) return res.status(400).json({ error: 'id manquant' });

        const uploadUrl = `https://content.airtable.com/v0/${BASE_ID}/${recordId}/${fieldId}/uploadAttachment`;
        const r = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ contentType, file: fileBase64, filename })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error?.message || "Erreur Airtable (upload d'image)");
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'action inconnue' });
    }

    // --- MODIFIER UN BLOC (texte ou ordre) ---
    if (req.method === 'PATCH') {
      const { blockId } = req.query;
      if (!blockId) return res.status(400).json({ error: 'blockId manquant' });

      const body = req.body || {};
      const fields = {};
      if (body.texte !== undefined) fields['Texte'] = body.texte;
      if (body.ordre !== undefined) fields['Ordre'] = body.ordre;

      const r = await fetch(`${BLOCS_URL}/${blockId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'Erreur Airtable (modification bloc)');
      return res.status(200).json({ success: true });
    }

    // --- SUPPRIMER UN BLOC ---
    if (req.method === 'DELETE') {
      const { blockId } = req.query;
      if (!blockId) return res.status(400).json({ error: 'blockId manquant' });

      const r = await fetch(`${BLOCS_URL}/${blockId}`, { method: 'DELETE', headers });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'Erreur Airtable (suppression bloc)');
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
