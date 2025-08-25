const express = require('express');
const router = express.Router();
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');
const db = require('../utils/postgres');

// Criar tabela kit_parents se não existir
async function createKitParentsTable() {
    const client = await db.pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS public.kit_parents (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                nome VARCHAR(255) NOT NULL,
                descricao TEXT,
                ativo BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Criar índice para otimizar buscas por user_id
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_kit_parents_user_id 
            ON public.kit_parents(user_id);
        `);

        console.log('Tabela kit_parents criada/verificada com sucesso');
    } catch (error) {
        console.error('Erro ao criar tabela kit_parents:', error);
    } finally {
        client.release();
    }
}

// Executar criação da tabela na inicialização
createKitParentsTable();

// GET - Listar todos os kits pai de um usuário
router.get('/user/:userId', authenticateToken, async (req, res) => {
    const { userId } = req.params;
    
    // Allow masters and the user themselves to access their own data
    if (req.user.role !== 'master' && req.user.uid !== userId) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }

    try {
        const client = await db.pool.connect();
        
        const query = `
            SELECT id, nome, descricao, ativo, created_at, updated_at
            FROM public.kit_parents 
            WHERE user_id = $1 
            ORDER BY created_at DESC
        `;
        
        const result = await client.query(query, [userId]);
        client.release();

        res.json(result.rows);
    } catch (error) {
        console.error('Erro ao buscar kits pai:', error);
        res.status(500).json({ error: 'Erro interno ao buscar kits pai.' });
    }
});

// GET - Listar kits pai ativos para seleção (usado no formulário de SKU)
router.get('/user/:userId/active', authenticateToken, async (req, res) => {
    const { userId } = req.params;
    
    // Allow masters and the user themselves to access their own data
    if (req.user.role !== 'master' && req.user.uid !== userId) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }

    try {
        const client = await db.pool.connect();
        
        const query = `
            SELECT id, nome, descricao
            FROM public.kit_parents 
            WHERE user_id = $1 AND ativo = true 
            ORDER BY nome ASC
        `;
        
        const result = await client.query(query, [userId]);
        client.release();

        res.json(result.rows);
    } catch (error) {
        console.error('Erro ao buscar kits pai ativos:', error);
        res.status(500).json({ error: 'Erro interno ao buscar kits pai ativos.' });
    }
});

// POST - Criar novo kit pai
router.post('/user/:userId', authenticateToken, async (req, res) => {
    const { userId } = req.params;
    const { nome, descricao, ativo = true } = req.body;
    
    // Allow masters and the user themselves to manage their own data
    if (req.user.role !== 'master' && req.user.uid !== userId) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }

    if (!nome || !descricao) {
        return res.status(400).json({ error: 'Nome e descrição são obrigatórios.' });
    }

    try {
        const client = await db.pool.connect();
        
        // Verificar se já existe um kit pai com o mesmo nome para este usuário
        const existingKit = await client.query(
            'SELECT id FROM public.kit_parents WHERE user_id = $1 AND nome = $2',
            [userId, nome]
        );

        if (existingKit.rows.length > 0) {
            client.release();
            return res.status(400).json({ error: 'Já existe um kit pai com este nome.' });
        }

        const insertQuery = `
            INSERT INTO public.kit_parents (user_id, nome, descricao, ativo)
            VALUES ($1, $2, $3, $4)
            RETURNING id, nome, descricao, ativo, created_at, updated_at
        `;
        
        const result = await client.query(insertQuery, [userId, nome, descricao, ativo]);
        client.release();

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Erro ao criar kit pai:', error);
        res.status(500).json({ error: 'Erro interno ao criar kit pai.' });
    }
});

// PUT - Atualizar kit pai
router.put('/user/:userId/:kitId', authenticateToken, async (req, res) => {
    const { userId, kitId } = req.params;
    const { nome, descricao, ativo } = req.body;
    
    // Allow masters and the user themselves to manage their own data
    if (req.user.role !== 'master' && req.user.uid !== userId) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }

    if (!nome || !descricao) {
        return res.status(400).json({ error: 'Nome e descrição são obrigatórios.' });
    }

    try {
        const client = await db.pool.connect();
        
        // Verificar se o kit pai existe e pertence ao usuário
        const existingKit = await client.query(
            'SELECT id FROM public.kit_parents WHERE id = $1 AND user_id = $2',
            [kitId, userId]
        );

        if (existingKit.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: 'Kit pai não encontrado.' });
        }

        // Verificar se já existe outro kit pai com o mesmo nome para este usuário
        const nameCheck = await client.query(
            'SELECT id FROM public.kit_parents WHERE user_id = $1 AND nome = $2 AND id != $3',
            [userId, nome, kitId]
        );

        if (nameCheck.rows.length > 0) {
            client.release();
            return res.status(400).json({ error: 'Já existe um kit pai com este nome.' });
        }

        const updateQuery = `
            UPDATE public.kit_parents 
            SET nome = $1, descricao = $2, ativo = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $4 AND user_id = $5
            RETURNING id, nome, descricao, ativo, created_at, updated_at
        `;
        
        const result = await client.query(updateQuery, [nome, descricao, ativo, kitId, userId]);
        client.release();

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Erro ao atualizar kit pai:', error);
        res.status(500).json({ error: 'Erro interno ao atualizar kit pai.' });
    }
});

// PATCH - Alternar status ativo/inativo
router.patch('/user/:userId/:kitId/toggle-status', authenticateToken, async (req, res) => {
    const { userId, kitId } = req.params;
    
    // Allow masters and the user themselves to manage their own data
    if (req.user.role !== 'master' && req.user.uid !== userId) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }

    try {
        const client = await db.pool.connect();
        
        // Verificar se o kit pai existe e pertence ao usuário
        const existingKit = await client.query(
            'SELECT id, ativo FROM public.kit_parents WHERE id = $1 AND user_id = $2',
            [kitId, userId]
        );

        if (existingKit.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: 'Kit pai não encontrado.' });
        }

        const currentStatus = existingKit.rows[0].ativo;
        const newStatus = !currentStatus;

        const updateQuery = `
            UPDATE public.kit_parents 
            SET ativo = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND user_id = $3
            RETURNING id, nome, descricao, ativo, created_at, updated_at
        `;
        
        const result = await client.query(updateQuery, [newStatus, kitId, userId]);
        client.release();

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Erro ao alterar status do kit pai:', error);
        res.status(500).json({ error: 'Erro interno ao alterar status do kit pai.' });
    }
});

// DELETE - Excluir kit pai
router.delete('/user/:userId/:kitId', authenticateToken, async (req, res) => {
    const { userId, kitId } = req.params;
    
    // Allow masters and the user themselves to manage their own data
    if (req.user.role !== 'master' && req.user.uid !== userId) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }

    try {
        const client = await db.pool.connect();
        
        // Verificar se o kit pai existe e pertence ao usuário
        const existingKit = await client.query(
            'SELECT id FROM public.kit_parents WHERE id = $1 AND user_id = $2',
            [kitId, userId]
        );

        if (existingKit.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: 'Kit pai não encontrado.' });
        }

        // TODO: Verificar se existem SKUs usando este kit pai antes de excluir
        // const skusUsingKit = await client.query(
        //     'SELECT id FROM public.skus WHERE kit_parent_id = $1',
        //     [kitId]
        // );
        //
        // if (skusUsingKit.rows.length > 0) {
        //     client.release();
        //     return res.status(400).json({ 
        //         error: 'Não é possível excluir este kit pai pois existem SKUs utilizando-o.' 
        //     });
        // }

        const deleteQuery = `
            DELETE FROM public.kit_parents 
            WHERE id = $1 AND user_id = $2
        `;
        
        await client.query(deleteQuery, [kitId, userId]);
        client.release();

        res.json({ message: 'Kit pai excluído com sucesso.' });
    } catch (error) {
        console.error('Erro ao excluir kit pai:', error);
        res.status(500).json({ error: 'Erro interno ao excluir kit pai.' });
    }
});

module.exports = router;