const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.send('API Cyberdock backend rodando.');
});

module.exports = router;
