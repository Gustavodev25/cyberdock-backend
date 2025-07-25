const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const crypto = require('crypto');
const { getDatabase } = require('../utils/firebase');
const router = express.Router();

const CLIENT_ID = process.env.ML_CLIENT_ID || '8423050287338772';
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'WWYgt9KH0HtZFH4YzD2yhrOLYHCUST9D';
const codeVerifiers = new Map();

function base64urlEncode(str) {
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE() { 
  const codeVerifier = crypto.randomBytes(32).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const codeChallenge = base64urlEncode(
    crypto.createHash('sha256').update(codeVerifier).digest('base64')
  );
  return { codeVerifier, codeChallenge };
}

function getRedirectUri(req) {
  if (process.env.NODE_ENV === 'production') {
    return process.env.ML_REDIRECT_URI || 'https://cyberdock-backend.onrender.com/ml/callback';
  }
  return process.env.ML_REDIRECT_URI || 'http://localhost:3001/ml/callback';
}

function getFrontendUrl(success = true) {
  const baseUrl = process.env.NODE_ENV === 'production'
    ? 'https://cyberdock.com.br/contas'
    : 'http://localhost:8080/contas';
  const query = success
    ? 'success=Conta%20conectada%20com%20sucesso'
    : 'error=Erro%20na%20conex%C3%A3o%20com%20Mercado%20Livre';
  return `${baseUrl}?${query}`;
}

function getShippingModeName(shipmentData) {
    if (!shipmentData) return 'Não especificado';
    const logisticTypeMap = {
        'fulfillment': 'Mercado Envios Full',
        'cross_docking': 'Mercado Envios Coleta',
        'drop_off': 'Mercado Envios (Agência)',
        'self_service': 'Mercado Envios Flex',
        'xd_drop_off': 'Mercado Envios (Agência)'
    };
    const logistic_type = shipmentData.logistic_type;
    if (logistic_type && logisticTypeMap[logistic_type]) {
        return logisticTypeMap[logistic_type];
    }
    if (shipmentData.mode === 'me1' || shipmentData.mode === 'custom') {
        return 'Envio Próprio / A Combinar';
    }
    if(shipmentData.mode === 'me2'){
        return 'Mercado Envios';
    }
    return 'A combinar';
}

router.get('/auth', async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    return res.status(400).json({ error: 'UID obrigatório' });
  }
  const redirectUri = getRedirectUri(req);
  try {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = Buffer.from(JSON.stringify({ uid })).toString('base64');
    codeVerifiers.set(state, codeVerifier);
    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=read write offline_access`;
    res.redirect(url);
  } catch (error) {
    console.error('Erro ao iniciar autenticação:', error.message);
    res.status(500).json({ error: 'Erro ao iniciar autenticação' });
  }
});

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.error('Erro retornado pelo Mercado Livre:', error);
    return res.redirect(getFrontendUrl(false));
  }
  if (!code || !state) {
    console.error('Parâmetros code ou state ausentes:', { code, state });
    return res.redirect(getFrontendUrl(false));
  }
  try {
    const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
    const uid = decodedState.uid;
    const redirectUri = getRedirectUri(req);
    const codeVerifier = codeVerifiers.get(state);
    if (!codeVerifier) {
      console.error('code_verifier não encontrado para o state:', state);
      throw new Error('code_verifier não encontrado');
    }
    const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Erro na requisição de token:', {
        status: tokenRes.status,
        data: tokenData
      });
      throw new Error(tokenData.message || 'Erro ao obter token');
    }
    const { access_token, refresh_token, user_id, expires_in } = tokenData;
    let nickname = '';
    try {
      const userRes = await fetch(`https://api.mercadolibre.com/users/${user_id}`, {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      const userData = await userRes.json();
      if (userRes.ok) {
        nickname = userData.nickname || '';
      }
    } catch (e) { /* ignora erro de nickname */ }
    const db = getDatabase();
    await db.ref(`ml_accounts/${uid}/${user_id}`).set({
      access_token,
      refresh_token: refresh_token || null,
      user_id,
      nickname,
      status: 'active',
      connected_at: Date.now(),
      expires_in
    });
    codeVerifiers.delete(state);
    res.redirect(getFrontendUrl(true));
  } catch (err) {
    console.error('Erro no callback:', err.message, err.stack);
    res.redirect(getFrontendUrl(false));
  }
});

router.get('/contas', async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    console.error('Tentativa de acesso sem UID');
    return res.status(400).json({ error: 'UID ausente.' });
  }
  try {
    const db = getDatabase();
    const snapshot = await db.ref(`ml_accounts/${uid}`).once('value');
    const data = snapshot.val() || {};
    const contas = Object.values(data).map(acc => ({
      user_id: acc.user_id,
      nickname: acc.nickname || '',
      status: acc.status,
      access_token: acc.access_token,
      refresh_token: acc.refresh_token,
      connected_at: acc.connected_at,
      expires_in: acc.expires_in
    }));
    console.log(`Contas encontradas para UID ${uid}: ${contas.length}`);
    res.json(contas);
  } catch (err) {
    console.error('Erro ao buscar contas:', err);
    res.status(500).json({ error: 'Erro ao buscar contas: ' + err.message });
  }
});

// Atualizar token de uma conta Mercado Livre (refresh token)
router.post('/refresh-token', async (req, res) => {
  const { uid, user_id } = req.body;
  if (!uid || !user_id) {
    return res.status(400).json({ error: 'uid e user_id são obrigatórios.' });
  }
  try {
    const db = getDatabase();
    const accSnap = await db.ref(`ml_accounts/${uid}/${user_id}`).once('value');
    const acc = accSnap.val();
    if (!acc || !acc.refresh_token) {
      return res.status(404).json({ error: 'Conta ou refresh_token não encontrado.' });
    }

    const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: acc.refresh_token
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return res.status(400).json({ error: tokenData.message || 'Erro ao atualizar token.' });
    }

    // ***** AQUI ESTÁ A CORREÇÃO *****
    // Atualiza todos os campos necessários, incluindo o connected_at para reiniciar o "cronômetro".
    await db.ref(`ml_accounts/${uid}/${user_id}`).update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || acc.refresh_token,
      expires_in: tokenData.expires_in,
      connected_at: Date.now(), // <-- ESTA É A LINHA ADICIONADA/CORRIGIDA
      updated_at: Date.now(),
      status: 'active' // Garante que o status volte para 'active'
    });

    res.json({
      message: 'Token atualizado com sucesso.',
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || acc.refresh_token,
      expires_in: tokenData.expires_in
    });
  } catch (err) {
    // Se der erro no refresh, marca a conta com status de erro.
     await db.ref(`ml_accounts/${uid}/${user_id}`).update({ status: 'error' });
    res.status(500).json({ error: 'Erro ao atualizar token.' });
  }
});

router.delete('/contas/:id', async (req, res) => {
  const { uid } = req.query;
  const user_id = req.params.id;
  if (!uid || !user_id) {
    return res.status(400).json({ error: 'uid e user_id são obrigatórios.' });
  }
  try {
    const db = getDatabase();
    await db.ref(`ml_accounts/${uid}/${user_id}`).remove();
    res.json({ message: 'Conta excluída com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir conta.' });
  }
});

router.get('/vendas', async (req, res) => {
  const { uid, seller_id } = req.query;
  if (!uid || !seller_id) {
    return res.status(400).json({ error: 'UID e Seller ID são obrigatórios.' });
  }

  try {
    const db = getDatabase();
    const accountSnapshot = await db.ref(`ml_accounts/${uid}/${seller_id}`).once('value');
    const account = accountSnapshot.val();

    if (!account || !account.access_token) {
      return res.status(404).json({ error: 'Conta ou token de acesso não encontrado.' });
    }
    
    const accessToken = account.access_token;
    const mlApiUrl = `https://api.mercadolibre.com/orders/search?seller=${seller_id}&sort=date_desc`;
    const apiResponse = await fetch(mlApiUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!apiResponse.ok) {
       console.error('Erro da API do ML (orders):', await apiResponse.text());
       await db.ref(`ml_accounts/${uid}/${seller_id}`).update({ status: 'error' });
       throw new Error('Falha ao buscar vendas no Mercado Livre.');
    }

    const salesData = await apiResponse.json();
    
    if (!salesData.results || salesData.results.length === 0) {
        return res.json([]);
    }
    
    const processedSales = await Promise.all(
      salesData.results.map(async (order) => {
        const shipmentId = order.shipping?.id;
        let shipmentData = null;
        let slaData = null;
        
        if (shipmentId) {
            try {
                const [shipmentRes, slaRes] = await Promise.all([
                    fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, { headers: { 'Authorization': `Bearer ${accessToken}` } }),
                    fetch(`https://api.mercadolibre.com/shipments/${shipmentId}/sla`, { headers: { 'Authorization': `Bearer ${accessToken}` } })
                ]);

                if (shipmentRes.ok) {
                    shipmentData = await shipmentRes.json();
                }
                if (slaRes.ok) {
                    slaData = await slaRes.json();
                }
            } catch (fetchError) {
                console.error(`Erro ao buscar detalhes para shipment ${shipmentId}:`, fetchError.message);
            }
        }
        
        return {
          id: order.id,
          channel: 'ML',
          accountNickname: account.nickname,
          saleDate: order.date_created,
          productTitle: order.order_items[0]?.item?.title || 'Produto sem título',
          sku: order.order_items[0]?.item?.seller_sku || null,
          quantity: order.order_items[0]?.quantity || 0,
          shippingMode: getShippingModeName(shipmentData),
          shippingLimitDate: slaData?.shipping_limit_date || slaData?.expected_date || null,
          packages: order.pack_id ? 1 : (order.order_items?.length || 1),
          rawApiData: { 
            order: order, 
            shipment: shipmentData, 
            sla: slaData 
          },
        };
      })
    );
    
    res.json(processedSales);

  } catch (error) {
    console.error('Erro no backend ao buscar vendas:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;