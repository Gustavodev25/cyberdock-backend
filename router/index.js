const express = require('express');
const router = express.Router();

const authRouter = require('./auth');
const mercadoLivreRouter = require('./mercadolivre');
const salesRouter = require('./sales');
const usersRouter = require('./users');
const settingsRouter = require('./settings');
const servicesRouter = require('./services');
const storageRouter = require('./storage');
const billingRouter = require('./billing');
const historyRoutes = require('./history');

router.get('/', (req, res) => {
  res.send('API Cyberdock backend rodando.');
});

router.use('/auth', authRouter);
router.use('/ml', mercadoLivreRouter);
router.use('/sales', salesRouter);
router.use('/users', usersRouter);
router.use('/settings', settingsRouter);
router.use('/services', servicesRouter);
router.use('/storage', storageRouter);
router.use('/billing', billingRouter);
router.use('/history', historyRoutes);

module.exports = router;
