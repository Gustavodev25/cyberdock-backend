// /router/mercadolivre.js

const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const db = require('../utils/postgres');
const router = express.Router();

const CLIENT_ID = process.env.ML_CLIENT_ID || '8423050287338772';
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'WWYgt9KH0HtZFH4YzD2yhrOLYHCUST9D';

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

/**
 * Determina a URI de redirecionamento correta, incluindo o prefixo /api.
 */
const fs = require('fs');
function getRedirectUri() {
    // Permite sobrescrever via variável de ambiente, se necessário
    if (process.env.ML_REDIRECT_URI) {
        return process.env.ML_REDIRECT_URI;
    }
    // Produção: callback cadastrado no Mercado Livre
    if (process.env.NODE_ENV === 'production') {
        return 'https://cyberdock-backend.onrender.com/api/ml/callback';
    }
    // Desenvolvimento: usa ngrok se disponível
    try {
        const ngrokUrl = fs.readFileSync(require('path').resolve(__dirname, '../ngrok-url.txt'), 'utf8').trim();
        if (ngrokUrl && ngrokUrl.startsWith('http')) {
            return `${ngrokUrl}/api/ml/callback`;
        }
    } catch (err) {
        // Se não conseguir ler ngrok, cai para localhost
    }
    return 'http://localhost:8080/mercadolivre/callback';
}

// --- Rota de Autenticação ---
router.get('/auth', (req, res) => {
    const { uid, client_id, redirect_uri } = req.query;
    if (!uid) {
        return res.status(400).send('UID do usuário é obrigatório.');
    }

    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = base64urlEncode(Buffer.from(JSON.stringify({ uid })));
    codeVerifiers.set(state, codeVerifier);

    // Prioriza parâmetros recebidos, senão usa padrão do backend
    const finalClientId = client_id || CLIENT_ID;
    const finalRedirectUri = redirect_uri || getRedirectUri();
    console.log(`Iniciando autenticação para UID: ${uid}. Redirecionando para: ${finalRedirectUri}`);

    const authUrl = `https://auth.mercadolibre.com/authorization` +
        `?response_type=code` +
        `&client_id=${finalClientId}` +
        `&redirect_uri=${encodeURIComponent(finalRedirectUri)}` +
        `&state=${state}` +
        `&code_challenge=${codeChallenge}` +
        `&code_challenge_method=S256`;

    res.redirect(authUrl);
});


// --- Rota de Callback ---
router.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';

    if (!code || !state) {
        return res.redirect(`${frontendUrl}/contas?error=${encodeURIComponent('Autorização falhou. Código ou estado ausentes.')}`);
    }

    const codeVerifier = codeVerifiers.get(state);
    if (!codeVerifier) {
        return res.redirect(`${frontendUrl}/contas?error=${encodeURIComponent('Falha de segurança. Verificador de estado inválido.')}`);
    }
    codeVerifiers.delete(state);

    const redirectUri = getRedirectUri();
    console.log(`Callback recebido. Trocando código por token com redirect_uri: ${redirectUri}`);

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
            const errorBody = await tokenResponse.json();
            console.error('Erro ao obter token do Mercado Livre:', errorBody);
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

        console.log(`✅ Conta ${userData.nickname} (ID: ${userData.id}) conectada com sucesso para o UID: ${uid}`);
        res.redirect(`${frontendUrl}/contas?success=${encodeURIComponent(`Conta ${userData.nickname} conectada com sucesso!`)}`);

    } catch (error) {
        console.error('❌ Erro no processo de callback do Mercado Livre:', error);
        res.redirect(`${frontendUrl}/contas?error=${encodeURIComponent(error.message || 'Erro desconhecido durante a conexão.')}`);
    }
});

// ... (resto do arquivo permanece igual)

// --- Rota para Atualizar Token (Refresh Token) ---
router.post('/refresh-token', async (req, res) => {
    const { uid, user_id } = req.body;
    
    try {
        const { rows } = await db.query('SELECT refresh_token FROM public.ml_accounts WHERE uid = $1 AND user_id = $2', [uid, user_id]);
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
            const errorBody = await response.json();
            await db.query("UPDATE public.ml_accounts SET status = 'error' WHERE uid = $1 AND user_id = $2", [uid, user_id]);
            throw new Error(errorBody.message || 'Falha ao atualizar token.');
        }
        
        const data = await response.json();
        await db.query(
            "UPDATE public.ml_accounts SET access_token = $1, expires_in = $2, status = 'active', updated_at = NOW() WHERE uid = $3 AND user_id = $4",
            [data.access_token, data.expires_in, uid, user_id]
        );

        res.json({ message: 'Token atualizado com sucesso!' });

    } catch (error) {
        console.error('Erro ao atualizar token:', error.message);
        res.status(500).json({ error: error.message });
    }
});


// --- Rota para buscar contas conectadas de um usuário ---
router.get('/contas/:uid', async (req, res) => {
    const { uid } = req.params;
    try {
        const { rows } = await db.query(
            'SELECT user_id, nickname, status, connected_at, expires_in, access_token, refresh_token FROM public.ml_accounts WHERE uid = $1',
            [uid]
        );
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar contas:', error.message);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// --- Rota para excluir uma conta conectada ---
router.delete('/contas/:id', async (req, res) => {
    const { id } = req.params;
    const { uid } = req.query; // UID para segurança
    try {
        await db.query('DELETE FROM public.ml_accounts WHERE user_id = $1 AND uid = $2', [id, uid]);
        res.status(204).send();
    } catch (error) {
        console.error('Erro ao excluir conta:', error.message);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

module.exports = router;