// backend/utils/authMiddleware.js
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto-para-jwt';

/**
 * Middleware para verificar o token JWT presente no header Authorization.
 * Adiciona o payload do token (user) ao objeto da requisição (req).
 */
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        // 401 Unauthorized: O cliente não forneceu credenciais.
        return res.status(401).json({ error: 'Token de acesso requerido' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.error('JWT Verification Error:', err.message);
            // 403 Forbidden: O cliente forneceu credenciais, mas elas são inválidas ou expiraram.
            return res.status(403).json({ error: 'Token inválido ou expirado' });
        }
        req.user = user;
        next();
    });
};

/**
 * Middleware para garantir que o usuário autenticado tem a role 'master'.
 * Deve ser usado *após* o middleware authenticateToken.
 */
const requireMaster = (req, res, next) => {
    if (req.user.role !== 'master') {
        return res.status(403).json({ error: 'Acesso negado. Apenas masters podem acessar este recurso.' });
    }
    next();
};

module.exports = { authenticateToken, requireMaster };