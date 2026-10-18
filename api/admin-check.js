// Fonction serverless Vercel : vérifie uniquement si le mot de passe admin fourni est correct.
// Utilisée avant d'afficher le panneau admin (pas seulement avant d'enregistrer une modification).

module.exports = async function handler(req, res) {
  const expected = process.env.ADMIN_PASSWORD;
  const provided = req.headers['x-admin-password'];

  if (expected && provided === expected) {
    return res.status(200).json({ success: true });
  }
  return res.status(401).json({ error: 'Mot de passe admin incorrect ou manquant' });
};
