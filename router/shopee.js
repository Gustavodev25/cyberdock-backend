const express = require('express');
const router = express.Router();
const { getDatabase } = require('../utils/firebase');

// Rota para buscar contas da Shopee
router.get('/contas', async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    console.error('Tentativa de acesso sem UID');
    return res.status(400).json({ error: 'UID ausente.' });
  }

  try {
    const db = getDatabase();
    const snapshot = await db.ref(`shopee_accounts/${uid}`).once('value');
    const data = snapshot.val() || {};
    const contas = Object.values(data).map(acc => ({
      shop_id: acc.shop_id,
      shop_name: acc.shop_name || '',
      status: acc.status,
      access_token: acc.access_token,
      refresh_token: acc.refresh_token,
      connected_at: acc.connected_at,
      expires_in: acc.expires_in
    }));
    console.log(`Contas Shopee encontradas para UID ${uid}: ${contas.length}`);
    res.json(contas);
  } catch (err) {
    console.error('Erro ao buscar contas Shopee:', err);
    res.status(500).json({ error: 'Erro ao buscar contas: ' + err.message });
  }
});

module.exports = router;
