// backend/routes/services.js
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
// Suporta ?manualOnly=1 para retornar apenas serviços avulsos lançáveis no faturamento
router.get('/', authenticateToken, async (req, res) => {
  try {
    const manualOnly = String(req.query.manualOnly || '').toLowerCase();
    const onlyManual = manualOnly === '1' || manualOnly === 'true';

    const q = `
      SELECT id, name, type, price, config
      FROM public.services
      ${onlyManual ? "WHERE type IN ('avulso_simples','avulso_quantidade')" : ""}
      ORDER BY name ASC
    `;
    const { rows } = await db.query(q);

    const formatted = rows.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type || null,
      price: s.price !== null ? parseFloat(s.price) : null,
      config: s.config || null
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Erro ao buscar serviços:', error);
    res.status(500).json({ error: 'Erro interno ao buscar serviços.' });
  }
});

// --- Rota para criar um novo serviço (apenas master) ---
// Agora aceita opcionalmente "type" e "config" (json)
router.post('/', authenticateToken, requireMaster, async (req, res) => {
  const { name, price = null, type = null, config = null } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Nome é obrigatório.' });
  }

  try {
    const insertQuery = `
      INSERT INTO public.services (name, type, price, config)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, type, price, config
    `;
    const { rows } = await db.query(insertQuery, [name, type, price, config]);
    const r = rows[0];
    res.status(201).json({
      id: r.id,
      name: r.name,
      type: r.type,
      price: r.price !== null ? parseFloat(r.price) : null,
      config: r.config || null
    });
  } catch (error) {
    console.error('Erro ao criar serviço:', error);
    res.status(500).json({ error: 'Erro interno ao criar serviço.' });
  }
});

// --- Rota para atualizar um serviço existente (apenas master) ---
// Agora aceita opcionalmente "type" e "config"
router.put('/:id', authenticateToken, requireMaster, async (req, res) => {
  const { id } = req.params;
  const { name, price = null, type = undefined, config = undefined } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Nome é obrigatório.' });
  }

  try {
    const updateQuery = `
      UPDATE public.services
      SET
        name   = $1,
        price  = $2,
        type   = COALESCE($3, type),
        config = COALESCE($4, config)
      WHERE id = $5
      RETURNING id, name, type, price, config
    `;
    const { rows } = await db.query(updateQuery, [name, price, type ?? null, config ?? null, id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Serviço não encontrado.' });
    }

    const r = rows[0];
    res.json({
      id: r.id,
      name: r.name,
      type: r.type,
      price: r.price !== null ? parseFloat(r.price) : null,
      config: r.config || null
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
