// backend/routes/users.js
const express = require('express');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');

const router = express.Router();

/**
 * @route   GET /api/users/all
 * @desc    Busca todos os usuários. Adiciona o nickname da primeira conta ML associada.
 * @access  Private (Master)
 */
router.get('/all', authenticateToken, requireMaster, async (req, res) => {
    try {
        const query = `
            SELECT
                u.uid,
                u.email,
                u.role,
                u.created_at,
                (SELECT nickname FROM public.ml_accounts WHERE uid = u.uid ORDER BY created_at ASC LIMIT 1) as "mlNickname"
            FROM
                public.users u
            ORDER BY
                u.created_at DESC;
        `;
        const { rows } = await db.query(query);
        res.json(rows);
    } catch (error) {
        console.error("Erro ao buscar usuários:", error);
        res.status(500).json({ error: 'Erro interno ao buscar usuários.' });
    }
});

/**
 * @route   PUT /api/users/:uid/role
 * @desc    Atualiza a permissão (role) de um usuário.
 * @access  Private (Master)
 */
router.put('/:uid/role', authenticateToken, requireMaster, async (req, res) => {
    const { uid } = req.params;
    const { role } = req.body;

    if (!['cliente', 'master'].includes(role)) {
        return res.status(400).json({ error: 'Permissão inválida. Use "cliente" ou "master".' });
    }

    try {
        const { rows } = await db.query(
            'UPDATE public.users SET role = $1, updated_at = NOW() WHERE uid = $2 RETURNING uid, role',
            [role, uid]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        res.json({ message: 'Permissão atualizada com sucesso.', user: rows[0] });
    } catch (error) {
        console.error(`Erro ao atualizar permissão para o usuário ${uid}:`, error);
        res.status(500).json({ error: 'Erro interno ao atualizar permissão.' });
    }
});

/**
 * @route   DELETE /api/users/:uid
 * @desc    Exclui um usuário e seus dados relacionados.
 * @access  Private (Master)
 */
router.delete('/:uid', authenticateToken, requireMaster, async (req, res) => {
    const { uid } = req.params;
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        await client.query('DELETE FROM public.ml_accounts WHERE uid = $1', [uid]);
        await client.query('DELETE FROM public.sales WHERE uid = $1', [uid]);
        await client.query('DELETE FROM public.skus WHERE user_id = $1', [uid]);
        await client.query('DELETE FROM public.stock_movements WHERE user_id = $1', [uid]);
        await client.query('DELETE FROM public.user_contracts WHERE uid = $1', [uid]);
        await client.query('DELETE FROM public.user_statuses WHERE user_id = $1', [uid]);

        const deleteUserResult = await client.query('DELETE FROM public.users WHERE uid = $1 RETURNING uid', [uid]);

        if (deleteUserResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        await client.query('COMMIT');
        res.status(200).json({ message: `Usuário ${uid} excluído com sucesso.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Erro ao excluir usuário ${uid}:`, error);
        res.status(500).json({ error: 'Erro interno ao excluir o usuário.' });
    } finally {
        client.release();
    }
});


/**
 * @route   GET /api/users/statuses/:uid
 * @desc    Busca os status de venda personalizados de um usuário.
 * @access  Private (Master)
 */
router.get('/statuses/:uid', authenticateToken, requireMaster, async (req, res) => {
    const { uid } = req.params;
    try {
        const { rows } = await db.query("SELECT statuses FROM public.user_statuses WHERE user_id = $1", [uid]);
        if (rows.length === 0) {
            return res.json({ statuses: [] });
        }
        res.json({ statuses: rows[0].statuses || [] });
    } catch (error) {
        console.error('Erro ao buscar status do usuário:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

/**
 * @route   PUT /api/users/statuses/:uid
 * @desc    Atualiza (ou cria) a lista de status de um usuário.
 * @access  Private (Master)
 */
router.put('/statuses/:uid', authenticateToken, requireMaster, async (req, res) => {
    const { uid } = req.params;
    const { statuses } = req.body;

    if (!statuses || !Array.isArray(statuses)) {
        return res.status(400).json({ error: 'Formato de status inválido.' });
    }

    try {
        const query = `
            INSERT INTO public.user_statuses (user_id, statuses, updated_at) 
            VALUES ($1, $2, NOW()) 
            ON CONFLICT (user_id) 
            DO UPDATE SET statuses = $2, updated_at = NOW();
        `;
        await db.query(query, [uid, JSON.stringify(statuses)]);
        res.json({ message: 'Status do usuário atualizados com sucesso.' });
    } catch (error) {
        console.error('Erro ao salvar status do usuário:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// --- NOVAS ROTAS PARA GERENCIAR CONTRATOS ---

/**
 * @route   GET /api/users/contracts/:uid
 * @desc    Busca todos os serviços contratados por um usuário.
 * @access  Private (Master)
 */
router.get('/contracts/:uid', authenticateToken, requireMaster, async (req, res) => {
    const { uid } = req.params;
    try {
        const query = `
            SELECT
                uc.id,
                uc.uid,
                uc.service_id AS "serviceId",
                uc.name,
                uc.price,
                uc.volume,
                uc.start_date AS "startDate"
            FROM public.user_contracts uc
            WHERE uc.uid = $1
            ORDER BY uc.start_date DESC;
        `;
        const { rows } = await db.query(query, [uid]);
        res.json({ contracts: rows });
    } catch (error) {
        console.error(`Erro ao buscar contratos para o usuário ${uid}:`, error);
        res.status(500).json({ error: 'Erro interno ao buscar contratos.' });
    }
});

/**
 * @route   POST /api/users/contracts/:uid
 * @desc    Adiciona um novo serviço contratado para um usuário.
 * @access  Private (Master)
 */
router.post('/contracts/:uid', authenticateToken, requireMaster, async (req, res) => {
    const { uid } = req.params;
    const { serviceId, name, price, volume, startDate } = req.body;

    if (!serviceId || !name || price == null || !startDate) {
        return res.status(400).json({ error: 'Dados do contrato incompletos.' });
    }

    try {
        const query = `
            INSERT INTO public.user_contracts (uid, service_id, name, price, volume, start_date)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *;
        `;
        const { rows } = await db.query(query, [uid, serviceId, name, price, volume, startDate]);
        res.status(201).json({ message: 'Serviço contratado com sucesso!', contract: rows[0] });
    } catch (error) {
        if (error.code === '23505') { // unique_contract violation
            return res.status(409).json({ error: 'Este serviço já foi contratado por este usuário.' });
        }
        console.error(`Erro ao adicionar contrato para o usuário ${uid}:`, error);
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
        const { rowCount } = await db.query(
            'DELETE FROM public.user_contracts WHERE uid = $1 AND id = $2',
            [uid, contractId]
        );

        if (rowCount === 0) {
            return res.status(404).json({ error: 'Contrato não encontrado para este usuário.' });
        }

        res.status(200).json({ message: 'Serviço contratado removido com sucesso.' });
    } catch (error) {
        console.error(`Erro ao remover contrato ${contractId} do usuário ${uid}:`, error);
        res.status(500).json({ error: 'Erro interno ao remover contrato.' });
    }
});


module.exports = router;
