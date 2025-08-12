// backend/routes/history.js
const express = require('express');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');

const router = express.Router();

/**
 * @route   GET /api/history/services
 * @desc    Busca o histórico de todos os serviços contratados por todos os clientes.
 * @access  Private (Master)
 * @query   ?clientId=<uid> - Filtra por um cliente específico
 * @query   ?serviceId=<id> - Filtra por um serviço específico
 */
router.get('/services', authenticateToken, requireMaster, async (req, res) => {
    const { clientId, serviceId } = req.query;

    try {
        // CORREÇÃO:
        // 1. Tabela padronizada para 'user_contracts' com alias 'uc'.
        // 2. Removida a coluna 'created_at' que não existe.
        // 3. Ordenação feita pela coluna 'start_date'.
        let query = `
            SELECT
                uc.id AS contract_id,
                uc.uid AS user_id,
                u.email AS user_email,
                (SELECT nickname FROM public.ml_accounts WHERE uid = u.uid ORDER BY created_at ASC LIMIT 1) as user_nickname,
                uc.service_id,
                s.name AS service_name,
                uc.start_date,
                uc.volume
            FROM
                public.user_contracts uc
            JOIN
                public.users u ON uc.uid = u.uid
            JOIN
                public.services s ON uc.service_id = s.id
        `;

        const params = [];
        const conditions = [];

        if (clientId) {
            params.push(clientId);
            conditions.push(`uc.uid = $${params.length}`);
        }
        if (serviceId) {
            params.push(serviceId);
            conditions.push(`uc.service_id = $${params.length}`);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY uc.start_date DESC;';

        const { rows } = await db.query(query, params);
        res.json(rows);

    } catch (error) {
        console.error("Erro ao buscar histórico de serviços:", error);
        res.status(500).json({ error: 'Erro interno ao buscar histórico de serviços.' });
    }
});

module.exports = router;
