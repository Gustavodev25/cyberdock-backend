// backend/routes/mercadolivre.js
const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const crypto = require('crypto');
const { getDatabase } = require('../utils/firebase');
const router = express.Router();

const CLIENT_ID = process.env.ML_CLIENT_ID || '8423050287338772';
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'WWYgt9KH0HtZFH4YzD2yhrOLYHCUST9D';

// Coleção para armazenar code_verifiers para PKCE
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
    // Certifique-se de que esta URI está configurada no Mercado Livre
    return process.env.ML_REDIRECT_URI || 'https://cyberdock-backend.onrender.com/ml/callback';
  }
  return process.env.ML_REDIRECT_URI || 'http://localhost:3001/ml/callback';
}

function getFrontendUrl(success = true, message = '') {
  const baseUrl = process.env.NODE_ENV === 'production'
    ? 'https://cyberdock.com.br/contas' // Substitua pelo seu domínio de frontend em produção
    : 'http://localhost:5173/contas';
  const query = success
    ? `success=${encodeURIComponent(message || 'Conta conectada com sucesso')}`
    : `error=${encodeURIComponent(message || 'Erro na conexão com Mercado Livre')}`;
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


// Rota para iniciar o fluxo OAuth (autenticação de contas)
router.get('/auth', async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    return res.status(400).json({ error: 'UID obrigatório para autenticação.' });
  }
  const redirectUri = getRedirectUri(req);
  try {
    const { codeVerifier, codeChallenge } = generatePKCE();
    // Armazena o codeVerifier com um identificador único (state) para verificar no callback
    const state = Buffer.from(JSON.stringify({ uid, timestamp: Date.now() })).toString('base64');
    codeVerifiers.set(state, codeVerifier);

    const authUrl = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=read write offline_access`;
    res.redirect(authUrl);
  } catch (error) {
    console.error('Erro ao iniciar autenticação:', error.message);
    res.status(500).json({ error: 'Erro interno ao iniciar autenticação.' });
  }
});

// Rota de callback após a autenticação do Mercado Livre
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Erro retornado pelo Mercado Livre no callback:', error);
    return res.redirect(getFrontendUrl(false, `Erro do Mercado Livre: ${error}`));
  }
  if (!code || !state) {
    console.error('Parâmetros "code" ou "state" ausentes no callback.');
    return res.redirect(getFrontendUrl(false, 'Parâmetros de retorno ausentes.'));
  }

  const codeVerifier = codeVerifiers.get(state);
  if (!codeVerifier) {
    console.error('Code Verifier não encontrado para o state:', state);
    return res.redirect(getFrontendUrl(false, 'Sessão expirada ou inválida. Tente novamente.'));
  }

  try {
    const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
    const uid = decodedState.uid;
    const redirectUri = getRedirectUri(req);

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
      console.error('Erro ao obter token de acesso do Mercado Livre:', tokenData);
      return res.redirect(getFrontendUrl(false, tokenData.message || 'Falha ao obter token de acesso.'));
    }

    const { access_token, refresh_token, user_id, expires_in } = tokenData;
    let nickname = '';

    // Tenta buscar o nickname do usuário
    try {
      const userRes = await fetch(`https://api.mercadolibre.com/users/${user_id}`, {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      const userData = await userRes.json();
      if (userRes.ok) {
        nickname = userData.nickname || `Usuário ${user_id}`;
      } else {
        console.warn(`Não foi possível obter nickname para user_id ${user_id}. Status: ${userRes.status}`);
      }
    } catch (e) {
      console.error(`Erro ao buscar nickname para user_id ${user_id}:`, e.message);
      nickname = `Usuário ${user_id}`; // Fallback para o nickname
    }

    const db = getDatabase();
    await db.ref(`ml_accounts/${uid}/${user_id}`).set({
      access_token,
      refresh_token: refresh_token || null,
      user_id: String(user_id), // Garante que user_id seja string
      nickname,
      status: 'active',
      connected_at: Date.now(),
      expires_in
    });

    codeVerifiers.delete(state); // Limpa o code_verifier após o uso
    res.redirect(getFrontendUrl(true, `Conta "${nickname}" conectada com sucesso!`));

  } catch (err) {
    console.error('Erro crítico no callback de autenticação:', err.message, err.stack);
    res.redirect(getFrontendUrl(false, `Erro interno durante a conexão: ${err.message}`));
  }
});

// Rota para buscar contas conectadas de um usuário
router.get('/contas', async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    return res.status(400).json({ error: 'UID ausente na requisição.' });
  }
  try {
    const db = getDatabase();
    const snapshot = await db.ref(`ml_accounts/${uid}`).once('value');
    const data = snapshot.val() || {};

    const contas = Object.values(data).map(acc => ({
      user_id: acc.user_id,
      nickname: acc.nickname || 'N/A',
      status: acc.status || 'inactive',
      access_token: acc.access_token,
      refresh_token: acc.refresh_token,
      connected_at: acc.connected_at,
      expires_in: acc.expires_in
    }));
    res.json(contas);
  } catch (err) {
    console.error('Erro ao buscar contas do Firebase:', err);
    res.status(500).json({ error: 'Erro interno ao buscar contas.' });
  }
});

// Rota para atualizar token de uma conta Mercado Livre (refresh token)
router.post('/refresh-token', async (req, res) => {
  const { uid, user_id } = req.body;
  const db = getDatabase(); // Move a inicialização para fora do try/catch para ser acessível no catch

  if (!uid || !user_id) {
    return res.status(400).json({ error: 'uid e user_id são obrigatórios.' });
  }

  try {
    const accRef = db.ref(`ml_accounts/${uid}/${user_id}`);
    const accSnap = await accRef.once('value');
    const acc = accSnap.val();

    if (!acc || !acc.refresh_token) {
      // Se não encontrar a conta ou refresh_token, talvez a conta tenha sido desconectada ou nunca foi conectada corretamente.
      console.warn(`Tentativa de refresh para conta não encontrada ou sem refresh_token: UID=${uid}, user_id=${user_id}`);
      // Opcional: remover a entrada se estiver corrompida, ou retornar um erro claro
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
      console.error('Erro na resposta do refresh token do Mercado Livre:', tokenData);
      // Se o refresh falhar, marca a conta como erro e notifica o frontend
      await accRef.update({ status: 'error', updated_at: Date.now() });
      return res.status(tokenRes.status).json({ error: tokenData.message || 'Erro ao atualizar token de acesso.' });
    }

    // Atualiza todos os campos necessários, incluindo o connected_at para reiniciar o "cronômetro".
    await accRef.update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || acc.refresh_token, // Usa o novo refresh_token se fornecido, senão mantém o antigo
      expires_in: tokenData.expires_in,
      connected_at: Date.now(), // <-- ESTA É A LINHA ADICIONADA/CORRIGIDA PARA REINICIAR O TEMPO DE EXPIRAÇÃO
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
    console.error('Erro ao processar refresh token:', err);
    // Em caso de erro inesperado, também marca a conta como erro
    // (Precisa garantir que `user_id` esteja disponível aqui, ou buscar novamente se `acc` for nulo)
    if (uid && user_id) {
        try {
            await db.ref(`ml_accounts/${uid}/${user_id}`).update({ status: 'error', updated_at: Date.now() });
        } catch (dbErr) {
            console.error('Falha ao atualizar status para erro no Firebase:', dbErr);
        }
    }
    res.status(500).json({ error: 'Erro interno ao atualizar token.' });
  }
});

// Rota para excluir uma conta conectada
router.delete('/contas/:id', async (req, res) => {
  const { uid } = req.query;
  const user_id = req.params.id;
  if (!uid || !user_id) {
    return res.status(400).json({ error: 'UID e User ID da conta são obrigatórios.' });
  }
  try {
    const db = getDatabase();
    await db.ref(`ml_accounts/${uid}/${user_id}`).remove();
    // Opcional: remover também as vendas associadas a essa conta se desejar
    // await db.ref(`user_sales/${uid}`).orderByChild('user_id').equalTo(user_id).remove();
    res.json({ message: `Conta ${user_id} excluída com sucesso.` });
  } catch (err) {
    console.error('Erro ao excluir conta do Firebase:', err);
    res.status(500).json({ error: 'Erro interno ao excluir conta.' });
  }
});


// Rota para buscar vendas de um vendedor Mercado Livre
router.get('/vendas', async (req, res) => {
  const { uid, seller_id } = req.query;
  if (!uid || !seller_id) {
    return res.status(400).json({ error: 'UID e Seller ID são obrigatórios.' });
  }

  const db = getDatabase();
  let account;
  try {
    const accountSnapshot = await db.ref(`ml_accounts/${uid}/${seller_id}`).once('value');
    account = accountSnapshot.val();

    if (!account || !account.access_token) {
      // Se a conta não for encontrada ou não tiver token, responde com 404
      console.warn(`Conta não encontrada ou sem token para UID: ${uid}, Seller ID: ${seller_id}`);
      return res.status(404).json({ error: 'Conta do Mercado Livre não encontrada ou não autenticada.' });
    }
    
    const accessToken = account.access_token;
    const mlApiUrl = `https://api.mercadolibre.com/orders/search?seller=${seller_id}&sort=date_desc`;
    
    const apiResponse = await fetch(mlApiUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!apiResponse.ok) {
       const errorText = await apiResponse.text();
       console.error(`Erro da API do ML (orders) para ${seller_id}: Status ${apiResponse.status}, Resposta: ${errorText}`);
       
       // Atualiza o status da conta para 'error' no Firebase se a API do ML falhar
       await db.ref(`ml_accounts/${uid}/${seller_id}`).update({ status: 'error', updated_at: Date.now() });
       
       // Retorna um erro JSON claro para o frontend
       return res.status(apiResponse.status).json({ 
           error: `Falha ao buscar vendas no Mercado Livre para ${account.nickname}.`,
           details: errorText // Inclui detalhes para depuração no frontend
       });
    }

    const salesData = await apiResponse.json();
    
    // Se não houver resultados, retorna um array vazio.
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
                // Requisições paralelas para detalhes de envio e SLA
                const [shipmentRes, slaRes] = await Promise.all([
                    fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, { headers: { 'Authorization': `Bearer ${accessToken}` } }),
                    fetch(`https://api.mercadolibre.com/shipments/${shipmentId}/sla`, { headers: { 'Authorization': `Bearer ${accessToken}` } })
                ]);

                if (shipmentRes.ok) {
                    shipmentData = await shipmentRes.json();
                } else {
                    console.warn(`Falha ao buscar shipment ${shipmentId}: ${shipmentRes.status} - ${await shipmentRes.text()}`);
                }
                if (slaRes.ok) {
                    slaData = await slaRes.json();
                } else {
                    console.warn(`Falha ao buscar SLA para shipment ${shipmentId}: ${slaRes.status} - ${await slaRes.text()}`);
                }
            } catch (fetchError) {
                console.error(`Erro ao buscar detalhes adicionais para shipment ${shipmentId}:`, fetchError.message);
            }
        }
        
        return {
          id: String(order.id), // Garante que o ID é string
          channel: 'ML',
          accountNickname: account.nickname,
          saleDate: order.date_created,
          productTitle: order.order_items[0]?.item?.title || 'Produto sem título',
          sku: order.order_items[0]?.item?.seller_sku || null,
          quantity: order.order_items[0]?.quantity || 0,
          shippingMode: getShippingModeName(shipmentData),
          shippingLimitDate: slaData?.shipping_limit_date || shipmentData?.shipping_option?.estimated_delivery_time?.date || null, // Fallback para data limite
          packages: order.pack_id ? 1 : (order.order_items?.length || 1), // Simplificado: 1 se tiver pack_id, senão qtd de itens
          shippingStatus: order.shipping?.status || 'pendente', // Status do envio da ordem
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
    console.error('Erro geral no backend ao buscar vendas:', error);
    // Se o erro ocorreu após a busca inicial da conta (ex: durante processamento das vendas),
    // é importante não sobrescrever um status de erro anterior se o token já falhou.
    // Mas se for um erro genérico de servidor, retorna 500.
    res.status(500).json({ error: 'Erro interno do servidor ao processar vendas.', details: error.message });
  }
});


module.exports = router;