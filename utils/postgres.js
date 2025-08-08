const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'cyberdock',
  password: process.env.PGPASSWORD || 'Gustavo2501',
  port: process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432,
  // ssl: { rejectUnauthorized: false }, // Descomente se for usar SSL
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Erro ao conectar com o PostgreSQL:', err);
  } else {
    console.log('Conexão com o PostgreSQL bem-sucedida:', res.rows[0].now);
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  getClient: () => pool.connect(), 
};