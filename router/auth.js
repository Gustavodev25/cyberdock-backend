// /router/auth.js

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../utils/postgres');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto-para-jwt';

// --- Rota de Registro de Usuário ---
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Nome, email e senha são obrigatórios.' });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const uid = uuidv4();

    // Insere apenas o novo usuário. A lógica de status agora é global.
    const newUserQuery = `
      INSERT INTO public.users (uid, email, role, created_at, password_hash) 
      VALUES ($1, $2, 'usuario', NOW(), $3)
      RETURNING uid, email, role;
    `;
    const { rows } = await db.query(newUserQuery, [uid, email, hashedPassword]);
    
    res.status(201).json({ message: 'Usuário criado com sucesso!', user: rows[0] });

  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Este email já está em uso.' });
    }
    console.error('Erro no registro:', error);
    res.status(500).json({ error: 'Erro interno ao registrar usuário.' });
  }
});

// --- Rota de Login ---
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
    }

    try {
        const userQuery = 'SELECT uid, email, role, password_hash FROM public.users WHERE email = $1';
        
        const { rows } = await db.query(userQuery, [email]);
        const user = rows[0];

        if (!user || !user.password_hash) {
            return res.status(401).json({ error: 'Email ou senha inválidos.' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ error: 'Email ou senha inválidos.' });
        }

        const token = jwt.sign(
            { uid: user.uid, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '1h' }
        );

        res.json({
            message: 'Login bem-sucedido!',
            token,
            user: {
                uid: user.uid,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ error: 'Erro interno ao tentar fazer login.' });
    }
});

// --- Rota para verificar a existência do usuário pelo UID e retornar role atualizado ---
router.get('/user', async (req, res) => {
    const { uid } = req.query;

    if (!uid) {
        return res.status(400).json({ error: 'UID do usuário é obrigatório.' });
    }

    try {
        const userQuery = 'SELECT uid, email, role FROM public.users WHERE uid = $1';
        const { rows } = await db.query(userQuery, [uid]);
        const user = rows[0];

        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado.', user: null });
        }
        
        res.json({ user });

    } catch (error) {
        console.error('Erro ao buscar usuário por UID:', error);
        res.status(500).json({ error: 'Erro interno ao verificar usuário.' });
    }
});

// --- Rota para atualizar role do usuário (apenas para masters) ---
router.put('/user/role', async (req, res) => {
    const { uid, newRole } = req.body;
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token de autorização necessário.' });
    }
    
    const token = authHeader.substring(7);
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        if (decoded.role !== 'master') {
            return res.status(403).json({ error: 'Apenas usuários master podem alterar roles.' });
        }
        
        if (!['usuario', 'master'].includes(newRole)) {
            return res.status(400).json({ error: 'Role inválido. Use "usuario" ou "master".' });
        }
        
        const updateQuery = 'UPDATE public.users SET role = $1 WHERE uid = $2 RETURNING uid, email, role';
        const { rows } = await db.query(updateQuery, [newRole, uid]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }
        
        res.json({ 
            message: 'Role atualizado com sucesso!', 
            user: rows[0] 
        });
        
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Token inválido.' });
        }
        console.error('Erro ao atualizar role:', error);
        res.status(500).json({ error: 'Erro interno ao atualizar role.' });
    }
});

// --- Rota para registrar consumo de armazenamento ---
router.post('/storage/consume', async (req, res) => {
    const { uid, sku, quantity } = req.body;

    if (!uid || !sku || !quantity) {
        return res.status(400).json({ error: 'UID, SKU e quantidade são obrigatórios.' });
    }

    try {
        const skuQuery = 'SELECT quantidade FROM public.skus WHERE uid = $1 AND sku = $2';
        const { rows } = await db.query(skuQuery, [uid, sku]);
        const existingSku = rows[0];

        if (!existingSku) {
            return res.status(404).json({ error: 'SKU não encontrado.' });
        }

        if (existingSku.quantidade < quantity) {
            return res.status(400).json({ error: 'Estoque insuficiente para o SKU.' });
        }

        const newQuantity = existingSku.quantidade - quantity;
        const updateQuery = 'UPDATE public.skus SET quantidade = $1 WHERE uid = $2 AND sku = $3';
        await db.query(updateQuery, [newQuantity, uid, sku]);

        res.json({ message: 'Consumo registrado com sucesso.', newQuantity });
    } catch (error) {
        console.error('Erro ao registrar consumo:', error);
        res.status(500).json({ error: 'Erro interno ao registrar consumo.' });
    }
});

// --- Rota para retirada manual de SKUs ---
router.post('/storage/withdraw', async (req, res) => {
    const { uid, sku, quantity } = req.body;

    if (!uid || !sku || !quantity) {
        return res.status(400).json({ error: 'UID, SKU e quantidade são obrigatórios.' });
    }

    try {
        const skuQuery = 'SELECT quantidade FROM public.skus WHERE uid = $1 AND sku = $2';
        const { rows } = await db.query(skuQuery, [uid, sku]);
        const existingSku = rows[0];

        if (!existingSku) {
            return res.status(404).json({ error: 'SKU não encontrado.' });
        }

        if (existingSku.quantidade < quantity) {
            return res.status(400).json({ error: 'Estoque insuficiente para retirada.' });
        }

        const newQuantity = existingSku.quantidade - quantity;
        const updateQuery = 'UPDATE public.skus SET quantidade = $1 WHERE uid = $2 AND sku = $3';
        await db.query(updateQuery, [newQuantity, uid, sku]);

        res.json({ message: 'Retirada registrada com sucesso.', newQuantity });
    } catch (error) {
        console.error('Erro ao registrar retirada:', error);
        res.status(500).json({ error: 'Erro interno ao registrar retirada.' });
    }
});

// --- Rota para obter preços fixos de armazenamento ---
router.get('/storage/prices', (req, res) => {
    const prices = {
        base: 397.00, // Até 1m³
        additional: 197.00 // 1m³ adicional
    };
    res.json(prices);
});

module.exports = router;
