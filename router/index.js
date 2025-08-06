const express = require('express');
const router = express.Router();

const authRouter = require('./auth');
const mercadoLivreRouter = require('./mercadolivre');
const salesRouter = require('./sales');
const usersRouter = require('./users');
const settingsRouter = require('./settings');
const servicesRouter = require('./services');
const storageRouter = require('./storage'); 

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

module.exports = router;