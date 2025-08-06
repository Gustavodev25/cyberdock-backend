// backend/router/users.js

const express = require('express');
const db = require('../utils/postgres');
// Importa os middlewares centralizados
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');

const router = express.Router();

// --- Rota para listar todos os usuários (apenas masters) ---
router.get('/all', authenticateToken, requireMaster, async (req, res) => {
    try {
        const usersQuery = `
            SELECT uid, email, role, created_at
            FROM public.users 
            ORDER BY created_at DESC
        `;
        const { rows } = await db.query(usersQuery);
        const formattedUsers = rows.map(user => ({
            ...user,
            createdAt: user.created_at
        }));
        res.json(formattedUsers);
    } catch (error) {
        console.error('Erro ao buscar usuários:', error);
        res.status(500).json({ error: 'Erro interno ao buscar usuários.' });
    }
});

// --- [CORRIGIDO] Rota para buscar status personalizados de um usuário ---
router.get('/statuses/:uid', authenticateToken, requireMaster, async (req, res) => {
    const { uid } = req.params;
    const client = await db.pool.connect();
    try {
        // Tenta buscar os status específicos do usuário
        let userStatusesResult = await client.query('SELECT statuses FROM public.user_settings WHERE uid = $1', [uid]);

        if (userStatusesResult.rows.length > 0 && userStatusesResult.rows[0].statuses) {
            // Se o usuário já tem status salvos, retorna eles
            return res.json({ statuses: userStatusesResult.rows[0].statuses });
        }

        // Se o usuário não tem status, busca os padrões do sistema
        console.log(`Nenhum status encontrado para o usuário ${uid}. Buscando padrões do sistema.`);
        const defaultStatusesResult = await client.query("SELECT value FROM public.system_settings WHERE key = 'sales_statuses'");

        if (defaultStatusesResult.rows.length === 0) {
            // Se nem os padrões existem, retorna um array vazio
            console.warn('Configuração de status padrão ("sales_statuses") não encontrada em system_settings.');
            return res.json({ statuses: [] });
        }

        const defaultStatuses = defaultStatusesResult.rows[0].value;

        // [LAZY-SEEDING] Salva os status padrão para o usuário para futuras edições
        console.log(`Salvando status padrão para o usuário ${uid}.`);
        const upsertQuery = `
            INSERT INTO public.user_settings (uid, statuses, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (uid)
            DO UPDATE SET statuses = EXCLUDED.statuses, updated_at = NOW();
        `;
        await client.query(upsertQuery, [uid, JSON.stringify(defaultStatuses)]);

        // Retorna os status padrão que acabaram de ser salvos
        res.json({ statuses: defaultStatuses });

    } catch (error) {
        console.error('Erro ao buscar status do usuário:', error);
        res.status(500).json({ error: 'Erro interno ao buscar status.' });
    } finally {
        client.release();
    }
});


// --- Rota para salvar status personalizados de um usuário ---
router.put('/statuses/:uid', authenticateToken, requireMaster, async (req, res) => {
    const { uid } = req.params;
    const { statuses } = req.body;

    if (!Array.isArray(statuses)) {
        return res.status(400).json({ error: 'Lista de status é obrigatória e deve ser um array.' });
    }

    try {
        const upsertQuery = `
            INSERT INTO public.user_settings (uid, statuses, updated_at) 
            VALUES ($1, $2, NOW())
            ON CONFLICT (uid) 
            DO UPDATE SET statuses = EXCLUDED.statuses, updated_at = NOW()
            RETURNING uid;
        `;
        const { rows } = await db.query(upsertQuery, [uid, JSON.stringify(statuses)]);
        res.json({ message: 'Status salvos com sucesso!', uid: rows[0].uid });
    } catch (error) {
        console.error('Erro ao salvar status do usuário:', error);
        res.status(500).json({ error: 'Erro interno ao salvar status.' });
    }
});


// --- ROTAS PARA GERENCIAR SERVIÇOS CONTRATADOS (CONTRATOS) ---

/**
 * @route   GET /api/users/contracts/:uid
 * @desc    Busca todos os serviços contratados por um usuário.
 * @access  Private (Master)
 */
router.get('/contracts/:uid', authenticateToken, requireMaster, async (req, res) => {
    const { uid } = req.params;
    try {
        const query = `
            SELECT id, uid, service_id, name, price, volume, start_date
            FROM public.user_contracts
            WHERE uid = $1
            ORDER BY start_date DESC;
        `;
        const { rows } = await db.query(query, [uid]);
        const formattedRows = rows.map(c => ({ ...c, price: parseFloat(c.price) }));
        res.json({ contracts: formattedRows });
    } catch (error) {
        console.error(`Erro ao buscar contratos para o usuário ${uid}:`, error);
        res.status(500).json({ error: 'Erro interno ao buscar contratos.' });
    }
});

/**
 * @route   POST /api/users/contracts/:uid
 * @desc    Adiciona um novo serviço (contrato) para um usuário.
 * @access  Private (Master)
 */
router.post('/contracts/:uid', authenticateToken, requireMaster, async (req, res) => {
    const { uid } = req.params;
    const { serviceId, name, price, volume, startDate } = req.body;

    if (!serviceId || !name || price == null || !startDate) {
        return res.status(400).json({ error: 'Dados incompletos. serviceId, name, price e startDate são obrigatórios.' });
    }

    try {
        const query = `
            INSERT INTO public.user_contracts (uid, service_id, name, price, volume, start_date)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *;
        `;
        const { rows } = await db.query(query, [uid, serviceId, name, price, volume, startDate]);
        res.status(201).json({ message: 'Contrato adicionado com sucesso.', contract: rows[0] });
    } catch (error) {
        console.error(`Erro ao adicionar contrato para o usuário ${uid}:`, error);
        if (error.code === '23505') { // unique_violation
            return res.status(409).json({ error: 'Este serviço já foi contratado por este usuário.' });
        }
        if (error.code === '23503') { // foreign_key_violation
            return res.status(404).json({ error: 'Usuário ou serviço do catálogo não encontrado.' });
        }
        res.status(500).json({ error: 'Erro interno ao adicionar contrato.' });
    }
});

/**
 * @route   DELETE /api/users/contracts/:uid/:contractId
 * @desc    Remove um serviço contratado de um usuário.
 * @access  Private (Master)
 */
router.delete('/contracts/:uid/:contractId', authenticateToken, requireMaster, async (req, res) => {
    const { uid, contractId } = req.params;
    try {
        const query = `
            DELETE FROM public.user_contracts
            WHERE id = $1 AND uid = $2
            RETURNING id;
        `;
        const { rowCount } = await db.query(query, [contractId, uid]);

        if (rowCount === 0) {
            return res.status(404).json({ error: 'Contrato não encontrado ou não pertence a este usuário.' });
        }

        res.status(200).json({ message: 'Contrato removido com sucesso.' });
    } catch (error) {
        console.error(`Erro ao remover o contrato ${contractId} do usuário ${uid}:`, error);
        res.status(500).json({ error: 'Erro interno ao remover contrato.' });
    }
});

module.exports = router;
