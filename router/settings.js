const express = require('express');
const db = require('../utils/postgres');
// Importando o middleware de um arquivo separado para melhor organização
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');

const router = express.Router();

/**
 * @route   GET /api/settings/statuses
 * @desc    Busca a lista de status de venda globais do sistema.
 * @access  Private (Qualquer usuário autenticado)
 */
router.get('/statuses', authenticateToken, async (req, res) => {
    try {
        const { rows } = await db.query("SELECT value FROM public.system_settings WHERE key = 'sales_statuses'");
        
        if (rows.length === 0 || !rows[0].value) {
            // Se não houver configuração, retorna uma lista vazia.
            return res.json({ statuses: [] });
        }
        
        // O valor no banco é um JSON, que já é retornado corretamente pelo driver.
        res.json({ statuses: rows[0].value });

    } catch (error) {
        console.error('❌ Erro ao buscar status de venda:', error);
        res.status(500).json({ error: 'Erro interno do servidor ao buscar configurações.' });
    }
});

/**
 * @route   PUT /api/settings/statuses
 * @desc    Atualiza (ou cria) a lista de status de venda globais.
 * @access  Private (Apenas usuários 'master')
 */
router.put('/statuses', authenticateToken, requireMaster, async (req, res) => {
    const { statuses } = req.body;

    if (!statuses || !Array.isArray(statuses)) {
        return res.status(400).json({ error: 'Formato de status inválido. É esperado um array.' });
    }

    try {
        // Usa INSERT ... ON CONFLICT (UPSERT) para criar ou atualizar a configuração.
        const query = `
            INSERT INTO public.system_settings (key, value, updated_at) 
            VALUES ('sales_statuses', $1, NOW()) 
            ON CONFLICT (key) 
            DO UPDATE SET value = $1, updated_at = NOW();
        `;
        
        await db.query(query, [JSON.stringify(statuses)]);
        
        res.json({ message: 'Status atualizados com sucesso.' });

    } catch (error) {
        console.error('❌ Erro ao atualizar status de venda:', error);
        res.status(500).json({ error: 'Erro interno do servidor ao salvar configurações.' });
    }
});

module.exports = router;
