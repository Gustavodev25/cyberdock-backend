const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const db = require('../utils/postgres');
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

  console.log(`[ML] Iniciando autenticação para UID: ${uid}. Redirecionando para: ${finalRedirectUri}`);

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
  console.log(`[ML] Callback recebido. Trocando código por token com redirect_uri: ${redirectUri}`);

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
      console.error('[ML] Erro ao obter token:', errorBody);
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

    console.log(`✅ [ML] Conta ${userData.nickname} (ID: ${userData.id}) conectada para UID: ${uid}`);
    res.redirect(`${FRONTEND_URL}/contas?success=${encodeURIComponent(`Conta ${userData.nickname} conectada com sucesso!`)}`);

  } catch (error) {
    console.error('❌ [ML] Erro no callback:', error);
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
    console.error('[ML] Erro ao atualizar token:', error.message);
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
    console.error('[ML] Erro ao buscar contas:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

router.delete('/contas/:id', async (req, res) => {
  const { id } = req.params;
  const { uid } = req.query;
  try {
    await db.query(
      'DELETE FROM public.ml_accounts WHERE user_id = $1 AND uid = $2',
      [id, uid]
    );
    res.status(204).send();
  } catch (error) {
    console.error('[ML] Erro ao excluir conta:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
