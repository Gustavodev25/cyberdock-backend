// routes/ml.js
/* eslint-disable camelcase */
const express = require('express');
const fetch = require('node-fetch'); // v2.x (web streams no v3 mudam o pipe)
const crypto = require('crypto');
const db = require('../utils/postgres');
const { authenticateToken } = require('../utils/authMiddleware');

const router = express.Router();

/**
 * >>> CONFIGURAÇÕES DO MERCADO LIVRE <<<
 * IMPORTANTE: As URLs de redirect devem estar cadastradas no painel de desenvolvedores:
 * https://developers.mercadolivre.com.br/devcenter
 *
 * URLs permitidas (cadastrar TODAS no painel do ML):
 * - http://localhost:3001/api/ml/callback (desenvolvimento)
 * - https://cyberdock-backend.onrender.com/api/ml/callback (produção)
 * - https://SEU-NGROK-URL/api/ml/callback (ngrok - atualizar quando mudar)
 */
const REDIRECT_URI = process.env.ML_REDIRECT_URI || 'https://cyberdock-backend.onrender.com/api/ml/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://cyberdock.com.br'; // Sempre usar produção para callbacks do ML
const CLIENT_ID = process.env.ML_CLIENT_ID || '8423050287338772';
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'WWYgt9KH0HtZFH4YzD2yhrOLYHCUST9D';

// Lista de URLs de callback permitidas (para validação)
const ALLOWED_REDIRECT_URIS = [
  'http://localhost:3001/api/ml/callback',
  'https://cyberdock-backend.onrender.com/api/ml/callback',
];

const codeVerifiers = new Map(); // state -> { codeVerifier, createdAt }

/* ------------------------- Utils PKCE/STATE ------------------------- */
function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePKCE() {
  const verifier = base64urlEncode(crypto.randomBytes(32));
  const challenge = base64urlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { codeVerifier: verifier, codeChallenge: challenge };
}

function makeState(payload) {
  const nonce = base64urlEncode(crypto.randomBytes(16));
  return base64urlEncode(JSON.stringify({ ...payload, nonce }));
}

function parseState(stateB64) {
  try {
    const json = Buffer.from(stateB64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function getRedirectUri() {
  return REDIRECT_URI;
}

/* Limpa verifiers antigos a cada 5 minutos (TTL 15 min) */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codeVerifiers.entries()) {
    if (now - v.createdAt > 15 * 60 * 1000) codeVerifiers.delete(k);
  }
}, 5 * 60 * 1000);

/* --------------------------- OAuth: Auth ---------------------------- */
router.get('/auth', (req, res) => {
  const { uid, client_id, redirect_uri } = req.query;
  if (!uid) return res.status(400).send('UID do usuário é obrigatório.');

  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = makeState({ uid });
  codeVerifiers.set(state, { codeVerifier, createdAt: Date.now() });

  const finalClientId = client_id || CLIENT_ID;
  const finalRedirectUri = redirect_uri || getRedirectUri();

  // Validar se a URL de redirect está na lista permitida
  if (!ALLOWED_REDIRECT_URIS.includes(finalRedirectUri)) {
    console.warn(`[ML Auth] URL de redirect não está na lista permitida: ${finalRedirectUri}`);
    console.warn('[ML Auth] Certifique-se de que esta URL está cadastrada no painel do Mercado Livre');
  }

  console.log(`[ML Auth] Iniciando autenticação para UID: ${uid}`);
  console.log(`[ML Auth] Redirect URI: ${finalRedirectUri}`);

  const authUrl =
    'https://auth.mercadolibre.com/authorization' +
    `?response_type=code` +
    `&client_id=${finalClientId}` +
    `&redirect_uri=${encodeURIComponent(finalRedirectUri)}` +
    `&state=${state}` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256`;

  res.redirect(authUrl);
});

/* --------------------------- OAuth: Callback ------------------------ */
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.redirect(
      `${FRONTEND_URL}/contas?error=${encodeURIComponent('Autorização falhou. Código ou estado ausentes.')}`
    );
  }

  const verifierObj = codeVerifiers.get(state);
  if (!verifierObj) {
    return res.redirect(
      `${FRONTEND_URL}/contas?error=${encodeURIComponent('Falha de segurança. Verificador de estado inválido.')}`
    );
  }
  codeVerifiers.delete(state);

  const redirectUri = getRedirectUri();
  console.log(`[ML Callback] Processando callback com redirect_uri: ${redirectUri}`);

  try {
    const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifierObj.codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.json().catch(() => ({}));
      console.error('[ML Callback] Erro ao obter token:', {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
        errorBody,
        redirectUri,
      });

      // Mensagem de erro mais detalhada
      let errorMessage = errorBody.message || 'Falha ao obter token de acesso.';
      if (tokenResponse.status === 400 && errorBody.error === 'invalid_grant') {
        errorMessage = 'Erro de autenticação. Verifique se a URL de callback está cadastrada no painel do Mercado Livre.';
      }

      throw new Error(errorMessage);
    }

    const tokenData = await tokenResponse.json();

    const userResponse = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userResponse.ok) {
      throw new Error(`Não foi possível identificar o usuário ML (${userResponse.status}).`);
    }
    const userData = await userResponse.json();

    const decoded = parseState(state);
    if (!decoded?.uid) throw new Error('State inválido.');

    const upsertQuery = `
      INSERT INTO public.ml_accounts (
        uid, user_id, nickname, access_token, refresh_token,
        expires_in, status, connected_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW())
      ON CONFLICT (uid, user_id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_in   = EXCLUDED.expires_in,
        status       = 'active',
        updated_at   = NOW();
    `;

    await db.query(upsertQuery, [
      decoded.uid,
      userData.id,
      userData.nickname,
      tokenData.access_token,
      tokenData.refresh_token,
      tokenData.expires_in,
    ]);

    res.redirect(
      `${FRONTEND_URL}/contas?success=${encodeURIComponent(`Conta ${userData.nickname} conectada com sucesso!`)}`
    );
  } catch (error) {
    res.redirect(
      `${FRONTEND_URL}/contas?error=${encodeURIComponent(error.message || 'Erro desconhecido durante a conexão.')}`
    );
  }
});

/* ---------------------- Refresh Token (manual) ---------------------- */
router.post('/refresh-token', async (req, res) => {
  const { uid, user_id } = req.body;
  try {
    const { rows } = await db.query(
      'SELECT refresh_token FROM public.ml_accounts WHERE uid = $1 AND user_id = $2',
      [uid, user_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Conta não encontrada.' });
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
        "UPDATE public.ml_accounts SET status = 'error', updated_at = NOW() WHERE uid = $1 AND user_id = $2",
        [uid, user_id]
      );
      throw new Error(errorBody.message || 'Falha ao atualizar token.');
    }

    const data = await response.json();
    await db.query(
      "UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = 'active', updated_at = NOW() WHERE uid = $4 AND user_id = $5",
      [data.access_token, data.refresh_token, data.expires_in, uid, user_id]
    );

    res.json({ message: 'Token atualizado com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ----------------------- Obter contas por UID ----------------------- */
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

/* -------------------- Obter access_token (seguro) ------------------- */
router.get('/access-token/:mlUserId', authenticateToken, async (req, res) => {
  const { mlUserId } = req.params;
  const { uid, role } = req.user;
  if (!mlUserId) return res.status(400).json({ error: 'ID do usuário ML é obrigatório.' });

  try {
    const params = [];
    let query = 'SELECT access_token FROM public.ml_accounts WHERE user_id = $1 AND status = $2';
    params.push(mlUserId, 'active');

    if (role !== 'master') {
      query += ' AND uid = $3';
      params.push(uid);
    }

    const { rows } = await db.query(query, params);
    if (rows.length === 0) return res.status(404).json({ error: 'Token de acesso não encontrado ou conta inativa.' });

    res.json({ access_token: rows[0].access_token });
  } catch (error) {
    console.error('Erro ao obter token de acesso:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/* --------------------------- Helpers ML API ------------------------- */
async function getAccountTokens({ seller_id, uid, role }) {
  // Seleciona conta conforme permissão
  const params = [];
  let q = 'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1';
  params.push(seller_id);

  if (role !== 'master') {
    q += ' AND uid = $2';
    params.push(uid);
  }

  const { rows } = await db.query(q, params);
  if (rows.length === 0) {
    const msg = 'Conta do Mercado Livre não encontrada ou você não tem permissão para acessá-la.';
    const err = new Error(msg);
    err.status = 404;
    throw err;
  }

  return { accessToken: rows[0].access_token, refreshToken: rows[0].refresh_token };
}

async function refreshIfNeeded({ seller_id, uid, role, reason }) {
  // Efeito colateral: atualiza banco ao renovar
  const params = [];
  let q = 'SELECT refresh_token FROM public.ml_accounts WHERE user_id = $1';
  params.push(seller_id);
  if (role !== 'master') {
    q += ' AND uid = $2';
    params.push(uid);
  }

  const { rows } = await db.query(q, params);
  if (rows.length === 0) return null;

  const refresh_token = rows[0].refresh_token;
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token,
    }),
  });

  if (!resp.ok) {
    await db.query(
      "UPDATE public.ml_accounts SET status = 'error', updated_at = NOW() WHERE user_id = $1" + (role !== 'master' ? ' AND uid = $2' : ''),
      role !== 'master' ? [seller_id, uid] : [seller_id]
    );
    return null;
  }

  const data = await resp.json();
  await db.query(
    "UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = 'active', updated_at = NOW() WHERE user_id = $4" +
      (role !== 'master' ? ' AND uid = $5' : ''),
    role !== 'master'
      ? [data.access_token, data.refresh_token, data.expires_in, seller_id, uid]
      : [data.access_token, data.refresh_token, data.expires_in, seller_id]
  );

  console.log(`[OAUTH] Token renovado (${reason || 'auto'}) para seller_id=${seller_id}`);
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

/** Faz fetch ao ML com bearer e tenta renovar token 1x se 401/invalid_token */
async function fetchMLWithAutoRefresh(url, { method = 'GET', headers = {}, body, seller_id, uid, role, accept }, tokenPair) {
  let { accessToken } = tokenPair;
  const buildHeaders = (tkn) => ({
    Authorization: `Bearer ${tkn}`,
    ...(accept ? { Accept: accept } : {}),
    ...headers,
  });

  let resp = await fetch(url, { method, headers: buildHeaders(accessToken), body });
  if (resp.status === 401 || resp.status === 400) {
    // tenta ler mensagem
    let errMsg = '';
    try {
      const j = await resp.json();
      errMsg = j.message || '';
      if (!errMsg && j.error) errMsg = j.error;
    } catch {}

    // somente renova se parecer token inválido
    if (resp.status === 401 || /invalid_token|expired|invalid_grant/i.test(errMsg)) {
      const refreshed = await refreshIfNeeded({ seller_id, uid, role, reason: 'auto-fetch' });
      if (refreshed?.accessToken) {
        accessToken = refreshed.accessToken;
        resp = await fetch(url, { method, headers: buildHeaders(accessToken), body });
      }
    }
  }
  return resp;
}

/* -------------------- Verificar status de 1 shipment ----------------- */
router.get('/check-shipment-status', authenticateToken, async (req, res) => {
  const { shipment_id, seller_id } = req.query;
  const { uid, role } = req.user;

  if (!shipment_id || !seller_id) {
    return res.status(400).json({ error: 'Parâmetros shipment_id e seller_id são obrigatórios.' });
  }

  try {
    const tokens = await getAccountTokens({ seller_id, uid, role });

    const url = `https://api.mercadolibre.com/shipments/${shipment_id}`;
    const resp = await fetchMLWithAutoRefresh(url, { seller_id, uid, role }, tokens);

    if (!resp.ok) {
      return res.status(resp.status).json({
        status: null,
        id: shipment_id,
        available: false,
        error: `Erro ${resp.status}`,
      });
    }

    const shipmentData = await resp.json();
    return res.json({
      status: shipmentData.status,
      id: shipmentData.id,
      available: true,
    });
  } catch (error) {
    console.error('Erro ao verificar status do shipment:', error);
    res.status(error.status || 500).json({
      error: 'Erro interno do servidor',
      message: 'Erro interno do servidor ao verificar status do shipment.',
      details: { shipmentId: shipment_id, error: error.message },
    });
  }
});

/* ---------------- Verificar status de múltiplos shipments ------------ */
router.post('/check-multiple-shipments', authenticateToken, async (req, res) => {
  const { shipments, seller_id } = req.body;
  const { uid, role } = req.user;

  if (!shipments || !Array.isArray(shipments) || !seller_id) {
    return res.status(400).json({ error: 'Parâmetros shipments (array) e seller_id são obrigatórios.' });
  }

  try {
    const tokens = await getAccountTokens({ seller_id, uid, role });

    const results = {};
    const batchSize = 8;
    for (let i = 0; i < shipments.length; i += batchSize) {
      const batch = shipments.slice(i, i + batchSize);
      const promises = batch.map(async (shipmentId) => {
        const url = `https://api.mercadolibre.com/shipments/${shipmentId}`;
        try {
          const resp = await fetchMLWithAutoRefresh(url, { seller_id, uid, role }, tokens);
          if (!resp.ok) {
            results[shipmentId] = { status: null, id: shipmentId, available: false, error: `Erro ${resp.status}` };
          } else {
            const data = await resp.json();
            results[shipmentId] = { status: data.status, id: data.id, available: true };
          }
        } catch (e) {
          results[shipmentId] = { status: null, id: shipmentId, available: false, error: e.message };
        }
      });
      await Promise.all(promises);
      if (i + batchSize < shipments.length) await new Promise((r) => setTimeout(r, 120));
    }

    res.json(results);
  } catch (error) {
    console.error('Erro ao verificar múltiplos shipments:', error);
    res.status(error.status || 500).json({
      error: 'Erro interno do servidor',
      message: 'Erro interno do servidor ao verificar status dos shipments.',
      details: { shipments, error: error.message },
    });
  }
});

/* ------------------------- Download de etiqueta ---------------------- */
router.get('/download-label', authenticateToken, async (req, res) => {
  const { shipment_ids, response_type = 'pdf', seller_id } = req.query;
  const { uid, role } = req.user;

  if (!shipment_ids || !seller_id) {
    return res.status(400).json({ error: 'Parâmetros shipment_ids e seller_id são obrigatórios.' });
  }
  const type = String(response_type).toLowerCase(); // 'pdf' | 'zpl' | 'zpl2'
  const isPDF = type === 'pdf';
  const acceptHeader = isPDF ? 'application/pdf' : 'application/zpl';

  // Normaliza lista (aceita "123" ou "123,456")
  const ids = String(shipment_ids)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split('.')[0]); // remove possíveis .0

  try {
    const tokens = await getAccountTokens({ seller_id, uid, role });

    // 1) Verifica status de cada shipment e bloqueia apenas os claramente impossíveis
    const nonPrintableStatuses = new Set(['shipped', 'delivered', 'cancelled', 'canceled']);
    const statusChecks = await Promise.all(
      ids.map(async (id) => {
        const url = `https://api.mercadolibre.com/shipments/${id}`;
        const r = await fetchMLWithAutoRefresh(url, { seller_id, uid, role }, tokens);
        if (!r.ok) return { id, status: null, printable: true }; // se não der pra checar, seguimos tentando baixar
        const d = await r.json();
        return { id, status: d.status, printable: !nonPrintableStatuses.has((d.status || '').toLowerCase()) };
      })
    );

    const notPrintable = statusChecks.filter((s) => !s.printable);
    if (notPrintable.length > 0) {
      return res.status(400).json({
        error: 'Etiqueta não disponível',
        message: `Um ou mais envios não possuem etiqueta disponível: ${notPrintable
          .map((x) => `${x.id} (status: ${x.status || 'desconhecido'})`)
          .join(', ')}`,
        details: { shipmentIdsTried: ids, blockedByStatus: notPrintable },
      });
    }

    // 2) Tenta métodos (single vs batch)
    const tryEndpoints = async () => {
      // Se for 1 id, prioriza endpoint individual
      if (ids.length === 1) {
        const id = ids[0];
        const url1 = `https://api.mercadolibre.com/shipments/${id}/labels?response_type=${type}`;
        const resp1 = await fetchMLWithAutoRefresh(url1, { seller_id, uid, role, accept: acceptHeader }, tokens);
        if (resp1.ok && resp1.headers.get('content-type')?.includes(isPDF ? 'pdf' : 'zpl')) return resp1;

        // fallback: endpoint geral com 1 id
        const url2 = `https://api.mercadolibre.com/shipment_labels?shipment_ids=${id}&response_type=${type}`;
        const resp2 = await fetchMLWithAutoRefresh(url2, { seller_id, uid, role, accept: acceptHeader }, tokens);
        if (resp2.ok && resp2.headers.get('content-type')?.includes(isPDF ? 'pdf' : 'zpl')) return resp2;

        // fallback com access_token na query (alguns ambientes legados)
        const url3 = `https://api.mercadolibre.com/shipment_labels?shipment_ids=${id}&response_type=${type}&access_token=${
          (await getAccountTokens({ seller_id, uid, role })).accessToken
        }`;
        const resp3 = await fetch(url3, { headers: { Accept: acceptHeader } }); // sem bearer
        if (resp3.ok && resp3.headers.get('content-type')?.includes(isPDF ? 'pdf' : 'zpl')) return resp3;

        return null;
      }

      // Com vários ids, prioriza endpoint em lote
      const joined = ids.join(',');
      const urlBatch = `https://api.mercadolibre.com/shipment_labels?shipment_ids=${joined}&response_type=${type}`;
      const respBatch = await fetchMLWithAutoRefresh(
        urlBatch,
        { seller_id, uid, role, accept: acceptHeader },
        tokens
      );
      if (respBatch.ok && respBatch.headers.get('content-type')?.includes(isPDF ? 'pdf' : 'zpl')) return respBatch;

      // fallback: tenta baixar um a um e juntar? (não suportaremos mesclar PDF aqui; retornaremos erro detalhado)
      return null;
    };

    const mlResponse = await tryEndpoints();
    if (!mlResponse) {
      // Tenta ler JSON de erro do ML para repassar
      let mlErr = null;
      try {
        mlErr = await mlResponse.json();
      } catch {}
      return res.status(400).json({
        error: 'Etiqueta não disponível',
        message:
          'Não foi possível obter a etiqueta no momento. Verifique se os envios estão aptos ou tente novamente em instantes.',
        details: {
          shipmentIdsTried: ids,
          mlError: mlErr || 'Sem detalhes',
        },
      });
    }

    // 3) Stream seguro do conteúdo (sem depender de .body.pipe em envs com web streams)
    const ct = mlResponse.headers.get('content-type') || (isPDF ? 'application/pdf' : 'application/zpl');
    const cd = `attachment; filename="etiqueta-${ids.length === 1 ? ids[0] : 'lote'}.${isPDF ? 'pdf' : 'zpl'}"`;

    // Detecta se veio JSON (erro do ML) e repassa como 400
    if (ct.includes('application/json')) {
      const payload = await mlResponse.json().catch(() => ({}));
      return res.status(400).json({
        error: 'Etiqueta não disponível',
        message: payload.message || 'Resposta da API do Mercado Livre não retornou arquivo de etiqueta.',
        details: { shipmentIdsTried: ids, mlPayload: payload },
      });
    }

    const ab = await mlResponse.arrayBuffer();
    const buf = Buffer.from(ab);
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', cd);
    res.setHeader('Content-Length', String(buf.length));
    return res.status(200).end(buf);
  } catch (error) {
    console.error('Erro no servidor ao baixar etiqueta:', error);
    res.status(error.status || 500).json({
      error: 'Erro interno do servidor',
      message: 'Erro interno do servidor ao processar a solicitação da etiqueta.',
      details: { shipmentIds: shipment_ids, error: error.message },
    });
  }
});

/* -------------------------- Excluir conta --------------------------- */
router.delete('/contas/:mlUserId', authenticateToken, async (req, res) => {
  const { mlUserId } = req.params;
  const { uid } = req.user;

  if (!mlUserId || !uid) {
    return res.status(400).json({ error: 'Parâmetros inválidos para exclusão.' });
  }

  try {
    const result = await db.query('DELETE FROM public.ml_accounts WHERE user_id = $1 AND uid = $2', [mlUserId, uid]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Conta não encontrada ou não pertence a este usuário.' });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao excluir a conta.' });
  }
});

/* ----------------------- Verificar configuração --------------------- */
router.get('/config-check', (req, res) => {
  const config = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    redirectUri: REDIRECT_URI,
    frontendUrl: FRONTEND_URL,
    clientId: CLIENT_ID,  // Mostrar para debug (remover em produção se necessário)
    clientIdConfigured: !!CLIENT_ID,
    clientSecretConfigured: !!CLIENT_SECRET,
    allowedRedirectUris: ALLOWED_REDIRECT_URIS,
    warnings: [],
    instructions: [],
  };

  // Verificações
  if (!CLIENT_ID || !CLIENT_SECRET) {
    config.status = 'error';
    config.warnings.push('Client ID ou Client Secret não configurados');
  }

  if (!ALLOWED_REDIRECT_URIS.includes(REDIRECT_URI)) {
    config.warnings.push(`REDIRECT_URI (${REDIRECT_URI}) não está na lista de URLs permitidas.`);
    config.instructions.push('Adicione esta URL no painel do Mercado Livre em: https://developers.mercadolivre.com.br/devcenter');
  }

  // Verificar se está usando localhost em produção
  if (process.env.NODE_ENV === 'production' && REDIRECT_URI.includes('localhost')) {
    config.status = 'error';
    config.warnings.push('URL de callback aponta para localhost em ambiente de produção!');
  }

  // Instruções para resolver erro 403
  config.instructions.push('1. Acesse: https://developers.mercadolivre.com.br/devcenter');
  config.instructions.push('2. Selecione sua aplicação (Client ID: ' + CLIENT_ID + ')');
  config.instructions.push('3. Vá em "Editar" > "Configurações"');
  config.instructions.push('4. Em "Redirect URIs", adicione: ' + REDIRECT_URI);
  config.instructions.push('5. Em "Allowed Domains", adicione: localhost, cyberdock.com.br, cyberdock-backend.onrender.com');
  config.instructions.push('6. Salve e aguarde alguns minutos');

  res.json(config);
});

/* ----------------------- Teste de conexão --------------------------- */
router.get('/test', (req, res) => {
  res.json({
    message: 'Mercado Livre router está funcionando!',
    timestamp: new Date().toISOString(),
    redirectUri: REDIRECT_URI,
    environment: process.env.NODE_ENV || 'development',
  });
});

module.exports = router;