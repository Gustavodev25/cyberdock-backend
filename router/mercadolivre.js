const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const db = require('../utils/postgres');
const { authenticateToken } = require('../utils/authMiddleware');
const router = express.Router();

const REDIRECT_URI = 'https://cyberdock-backend.onrender.com/api/ml/callback';
const FRONTEND_URL = 'http://localhost:8080';
const CLIENT_ID = '8423050287338772';
const CLIENT_SECRET = 'WWYgt9KH0HtZFH4YzD2yhrOLYHCUST9D';

const codeVerifiers = new Map();

function base64urlEncode(str) {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePKCE() {
  const verifier = base64urlEncode(crypto.randomBytes(32));
  const challenge = base64urlEncode(
    crypto.createHash('sha256').update(verifier).digest()
  );
  return { codeVerifier: verifier, codeChallenge: challenge };
}

function getRedirectUri() {
  return REDIRECT_URI;
}

router.get('/auth', (req, res) => {
  const { uid, client_id, redirect_uri } = req.query;
  if (!uid) {
    return res.status(400).send('UID do usuário é obrigatório.');
  }

  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = base64urlEncode(Buffer.from(JSON.stringify({ uid })));
  codeVerifiers.set(state, codeVerifier);

  const finalClientId = client_id || CLIENT_ID;
  const finalRedirectUri = redirect_uri || getRedirectUri();

  const authUrl = `https://auth.mercadolibre.com/authorization` +
    `?response_type=code` +
    `&client_id=${finalClientId}` +
    `&redirect_uri=${encodeURIComponent(finalRedirectUri)}` +
    `&state=${state}` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256`;

  res.redirect(authUrl);
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/contas?error=${encodeURIComponent('Autorização falhou. Código ou estado ausentes.')}`);
  }

  const codeVerifier = codeVerifiers.get(state);
  if (!codeVerifier) {
    return res.redirect(`${FRONTEND_URL}/contas?error=${encodeURIComponent('Falha de segurança. Verificador de estado inválido.')}`);
  }
  codeVerifiers.delete(state);

  const redirectUri = getRedirectUri();

  try {
    const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      })
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.json().catch(() => ({}));
      throw new Error(errorBody.message || 'Falha ao obter token de acesso.');
    }

    const tokenData = await tokenResponse.json();

    const userResponse = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const userData = await userResponse.json();

    const { uid } = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    const upsertQuery = `
      INSERT INTO public.ml_accounts (
        uid, user_id, nickname, access_token, refresh_token,
        expires_in, status, connected_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW())
      ON CONFLICT (uid, user_id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_in = EXCLUDED.expires_in,
        status = 'active',
        updated_at = NOW();
    `;

    await db.query(upsertQuery, [
      uid, userData.id, userData.nickname, tokenData.access_token,
      tokenData.refresh_token, tokenData.expires_in
    ]);

    res.redirect(`${FRONTEND_URL}/contas?success=${encodeURIComponent(`Conta ${userData.nickname} conectada com sucesso!`)}`);

  } catch (error) {
    res.redirect(`${FRONTEND_URL}/contas?error=${encodeURIComponent(error.message || 'Erro desconhecido durante a conexão.')}`);
  }
});

router.post('/refresh-token', async (req, res) => {
  const { uid, user_id } = req.body;

  try {
    const { rows } = await db.query(
      'SELECT refresh_token FROM public.ml_accounts WHERE uid = $1 AND user_id = $2',
      [uid, user_id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Conta não encontrada.' });
    }
    const refreshToken = rows[0].refresh_token;

    const response = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      await db.query(
        "UPDATE public.ml_accounts SET status = 'error' WHERE uid = $1 AND user_id = $2",
        [uid, user_id]
      );
      throw new Error(errorBody.message || 'Falha ao atualizar token.');
    }

    const data = await response.json();
    await db.query(
      "UPDATE public.ml_accounts SET access_token = $1, expires_in = $2, status = 'active', updated_at = NOW() WHERE uid = $3 AND user_id = $4",
      [data.access_token, data.expires_in, uid, user_id]
    );

    res.json({ message: 'Token atualizado com sucesso!' });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/contas/:uid', async (req, res) => {
  const { uid } = req.params;
  try {
    const { rows } = await db.query(
      'SELECT user_id, nickname, status, connected_at, expires_in, access_token, refresh_token FROM public.ml_accounts WHERE uid = $1',
      [uid]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

router.get('/access-token/:mlUserId', authenticateToken, async (req, res) => {
  const { mlUserId } = req.params;
  const { uid, role } = req.user;

  if (!mlUserId) {
    return res.status(400).json({ error: 'ID do usuário ML é obrigatório.' });
  }

  try {
    let query, params;
    
    if (role === 'master') {
      query = 'SELECT access_token FROM public.ml_accounts WHERE user_id = $1 AND status = $2';
      params = [mlUserId, 'active'];
    } else {
      query = 'SELECT access_token FROM public.ml_accounts WHERE user_id = $1 AND uid = $2 AND status = $3';
      params = [mlUserId, uid, 'active'];
    }

    const { rows } = await db.query(query, params);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Token de acesso não encontrado ou conta inativa.' });
    }

    res.json({ access_token: rows[0].access_token });
  } catch (error) {
    console.error('Erro ao obter token de acesso:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

router.get('/download-label', authenticateToken, async (req, res) => {
    const { shipment_ids, response_type, seller_id } = req.query;
    const { uid, role } = req.user;

    if (!shipment_ids || !response_type || !seller_id) {
        return res.status(400).send('Parâmetros shipment_ids, response_type e seller_id são obrigatórios.');
    }

    try {
        let accountQuery, accountParams;
        if (role === 'master') {
            accountQuery = 'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1';
            accountParams = [seller_id];
        } else {
            accountQuery = 'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1 AND uid = $2';
            accountParams = [seller_id, uid];
        }
        
        const { rows } = await db.query(accountQuery, accountParams);

        if (rows.length === 0) {
            return res.status(404).send('Conta do Mercado Livre não encontrada ou você não tem permissão para acessá-la.');
        }

        let { access_token: accessToken, refresh_token: refreshToken } = rows[0];

        const fetchLabelWithShipmentId = async (token) => {
            const mlApiUrl = `https://api.mercadolibre.com/shipment_labels?shipment_ids=${shipment_ids}&response_type=${response_type}`;
            return await fetch(mlApiUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
        };

        let mlResponse = await fetchLabelWithShipmentId(accessToken);

        if (mlResponse.status === 401 && refreshToken) {
            console.log(`Token expirado para seller_id: ${seller_id}. Tentando renovar...`);
            const refreshResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    refresh_token: refreshToken,
                }),
            });

            if (refreshResponse.ok) {
                const newTokenData = await refreshResponse.json();
                accessToken = newTokenData.access_token;
                const newRefreshToken = newTokenData.refresh_token;

                await db.query(
                    "UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = 'active', updated_at = NOW() WHERE user_id = $4",
                    [accessToken, newRefreshToken, newTokenData.expires_in, seller_id]
                );
                console.log(`Token renovado com sucesso para seller_id: ${seller_id}`);
                mlResponse = await fetchLabelWithShipmentId(accessToken);
            } else {
                await db.query("UPDATE public.ml_accounts SET status = 'error' WHERE user_id = $1", [seller_id]);
                return res.status(401).send('Falha ao renovar o token de acesso do Mercado Livre.');
            }
        }

        // *** LÓGICA DE FALLBACK APRIMORADA PARA ITENS ENVIADOS ***
        if (!mlResponse.ok && mlResponse.status === 400) {
            const errorBodyText = await mlResponse.text();
            let originalErrorBody = `Erro ao buscar etiqueta do Mercado Livre: ${errorBodyText}`;

            try {
                const errorBody = JSON.parse(errorBodyText);
                const isNotPrintable = errorBody?.causes?.includes('NOT_PRINTABLE_STATUS') || 
                                     errorBody?.message?.includes('status is shipped') ||
                                     errorBody?.message?.includes('not printable');

                if (isNotPrintable) {
                    console.log(`[1] Envio ${shipment_ids} não imprimível. Tentando método alternativo mais direto.`);
                    
                    // CORREÇÃO: Usando um endpoint alternativo que usa "/labels" (plural) em vez de "/label" (singular)
                    const alternativeUrl = `https://api.mercadolibre.com/shipments/${shipment_ids}/labels?response_type=${response_type}`;
                    console.log(`[1] Tentando buscar etiqueta em: ${alternativeUrl}`);
                    
                    const alternativeResponse = await fetch(alternativeUrl, {
                         headers: { 'Authorization': `Bearer ${accessToken}` }
                    });

                    if (alternativeResponse.ok) {
                        console.log(`[1] Sucesso ao buscar etiqueta para o envio ${shipment_ids} pelo método alternativo.`);
                        const contentType = alternativeResponse.headers.get('content-type');
                        const contentDisposition = `attachment; filename="etiqueta-${shipment_ids}.${response_type === 'pdf' ? 'pdf' : 'zpl'}"`;
                        res.setHeader('Content-Type', contentType || 'application/octet-stream');
                        res.setHeader('Content-Disposition', contentDisposition);
                        return alternativeResponse.body.pipe(res);
                    } else {
                         console.log(`[1] Método alternativo também falhou com status: ${alternativeResponse.status}`);
                         const altError = await alternativeResponse.text();
                         
                         // Se o método alternativo também falhar, retorna uma mensagem mais clara
                         return res.status(400).json({
                             error: 'Etiqueta não disponível',
                             message: `O envio ${shipment_ids} não possui etiqueta disponível para download. Isso pode ocorrer quando o pedido já foi enviado ou cancelado.`,
                             details: {
                                 originalError: errorBodyText,
                                 alternativeError: altError,
                                 shipmentId: shipment_ids
                             }
                         });
                    }
                }
            } catch (e) {
                 console.error('Não foi possível analisar o corpo do erro ou lidar com a busca alternativa da etiqueta.', e);
            }
             // Se o fallback falhar ou não for aplicável, retorna o erro original.
            return res.status(mlResponse.status).send(originalErrorBody);
        }
        // *** FIM DA LÓGICA APRIMORADA ***


        if (!mlResponse.ok) {
            const errorBody = await mlResponse.text();
            console.error(`Erro ao buscar etiqueta do ML para shipment ${shipment_ids}: ${mlResponse.status} - ${errorBody}`);
            return res.status(mlResponse.status).send(`Erro ao buscar etiqueta do Mercado Livre: ${errorBody}`);
        }

        const contentType = mlResponse.headers.get('content-type');
        const contentDisposition = `attachment; filename="etiqueta-${shipment_ids}.${response_type === 'pdf' ? 'pdf' : 'zpl'}"`;

        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', contentDisposition);
        mlResponse.body.pipe(res);

    } catch (error) {
        console.error('Erro no servidor ao baixar etiqueta:', error);
        res.status(500).send('Erro interno do servidor ao processar a solicitação da etiqueta.');
    }
});


router.delete('/contas/:mlUserId', authenticateToken, async (req, res) => {
  const { mlUserId } = req.params;
  const { uid } = req.user;

  if (!mlUserId || !uid) {
    return res.status(400).json({ error: 'Parâmetros inválidos para exclusão.' });
  }

  try {
    const result = await db.query(
      'DELETE FROM public.ml_accounts WHERE user_id = $1 AND uid = $2',
      [mlUserId, uid]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Conta não encontrada ou não pertence a este usuário.' });
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao excluir a conta.' });
  }
});

module.exports = router;