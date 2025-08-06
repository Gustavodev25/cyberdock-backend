// /router/services.js

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../utils/postgres');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto-para-jwt';

// Middleware para verificar token JWT
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token de acesso requerido' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido' });
        }
        req.user = user;
        next();
    });
};

// Middleware para verificar se é master
const requireMaster = (req, res, next) => {
    if (req.user.role !== 'master') {
        return res.status(403).json({ error: 'Acesso negado. Apenas masters podem acessar este recurso.' });
    }
    next();
};

// --- Rota para buscar todos os serviços (catálogo) ---
router.get('/', authenticateToken, async (req, res) => {
    try {
        const servicesQuery = `
            SELECT id, name, price
            FROM public.services
            ORDER BY name ASC
        `;
        const { rows } = await db.query(servicesQuery);
        // Garante que o preço é convertido para um número antes de enviar para o frontend
        const formattedRows = rows.map(service => ({
            ...service,
            price: parseFloat(service.price)
        }));
        res.json(formattedRows);
    } catch (error) {
        console.error('Erro ao buscar serviços:', error);
        res.status(500).json({ error: 'Erro interno ao buscar serviços.' });
    }
});

// --- Rota para criar um novo serviço (apenas master) ---
router.post('/', authenticateToken, requireMaster, async (req, res) => {
    const { name, price } = req.body;
    if (!name || price == null) {
        return res.status(400).json({ error: 'Nome e preço são obrigatórios.' });
    }

    try {
        const insertQuery = `
            INSERT INTO public.services (name, price)
            VALUES ($1, $2)
            RETURNING id, name, price
        `;
        const { rows } = await db.query(insertQuery, [name, price]);
        res.status(201).json({
            ...rows[0],
            price: parseFloat(rows[0].price)
        });
    } catch (error) {
        console.error('Erro ao criar serviço:', error);
        res.status(500).json({ error: 'Erro interno ao criar serviço.' });
    }
});

// --- Rota para atualizar um serviço existente (apenas master) ---
router.put('/:id', authenticateToken, requireMaster, async (req, res) => {
    const { id } = req.params;
    const { name, price } = req.body;
    if (!name || price == null) {
        return res.status(400).json({ error: 'Nome e preço são obrigatórios.' });
    }

    try {
        const updateQuery = `
            UPDATE public.services
            SET name = $1, price = $2
            WHERE id = $3
            RETURNING id, name, price
        `;
        const { rows } = await db.query(updateQuery, [name, price, id]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Serviço não encontrado.' });
        }

        res.json({
            ...rows[0],
            price: parseFloat(rows[0].price)
        });
    } catch (error) {
        console.error('Erro ao atualizar serviço:', error);
        res.status(500).json({ error: 'Erro interno ao atualizar serviço.' });
    }
});

// --- Rota para deletar um serviço (apenas master) ---
router.delete('/:id', authenticateToken, requireMaster, async (req, res) => {
    const { id } = req.params;

    try {
        const deleteQuery = `
            DELETE FROM public.services
            WHERE id = $1
            RETURNING id
        `;
        const { rows } = await db.query(deleteQuery, [id]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Serviço não encontrado.' });
        }

        res.json({ message: 'Serviço excluído com sucesso.' });
    } catch (error) {
        console.error('Erro ao deletar serviço:', error);
        res.status(500).json({ error: 'Erro interno ao deletar serviço.' });
    }
});

module.exports = router;
