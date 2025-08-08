const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.PGUSER || 'postgres_cyber_dock_user',
  host: process.env.PGHOST || 'dpg-d29mquer433s739ir01g-a.oregon-postgres.render.com',
  database: process.env.PGDATABASE || 'postgres_cyber_dock',
  password: process.env.PGPASSWORD || 'KVT8w15r7n2EDQQ7w4TNxI8HvR09JZ0u',
  port: process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432,
  ssl: { rejectUnauthorized: false }, // Necessário para conexão externa segura
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
