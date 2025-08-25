const express = require('express');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');

const router = express.Router();

/**
 * @route   GET /api/history/contracts
 * @desc    Busca o histórico de serviços recorrentes (contratos).
 * @access  Private (Master)
 */
router.get('/contracts', authenticateToken, requireMaster, async (req, res) => {
  const { clientId, serviceId } = req.query;

  let query = `
    SELECT
      uc.id AS contract_id,
      uc.uid AS user_id,
      u.email AS user_email,
      COALESCE(ml.nickname, u.email) AS user_nickname,
      s.id AS service_id,
      s.name AS service_name,
      uc.volume,
      uc.start_date,
      uc.start_date AS contracted_at
    FROM public.user_contracts uc
    JOIN public.users u ON uc.uid = u.uid
    JOIN public.services s ON uc.service_id = s.id
    LEFT JOIN (
      SELECT uid, nickname
      FROM (
        SELECT uid, nickname,
               ROW_NUMBER() OVER (PARTITION BY uid ORDER BY connected_at ASC NULLS LAST) AS rn
        FROM public.ml_accounts
      ) ranked_accounts
      WHERE rn = 1
    ) ml ON u.uid = ml.uid
    WHERE 1=1
  `;

  const params = [];
  if (clientId) {
    params.push(clientId);
    query += ` AND uc.uid = $${params.length}`;
  }
  if (serviceId) {
    params.push(serviceId);
    query += ` AND uc.service_id = $${params.length}`;
  }

  query += ' ORDER BY uc.start_date DESC, uc.id DESC';

  try {
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar histórico de contratos:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @route   GET /api/history/manual
 * @desc    Busca o histórico de serviços avulsos (lançados manualmente).
 * @access  Private (Master)
 */
router.get('/manual', authenticateToken, requireMaster, async (req, res) => {
  const { clientId } = req.query;

  let query = `
    SELECT
      ii.id,
      ii.invoice_id,
      i.uid AS user_id,
      u.email AS user_email,
      COALESCE(ml.nickname, u.email) AS user_nickname,
      ii.description,
      ii.quantity,
      ii.unit_price,
      ii.service_date AS entry_date,
      ii.total_price,
      i.period
    FROM public.invoice_items ii
    JOIN public.invoices i ON ii.invoice_id = i.id
    JOIN public.users u ON i.uid = u.uid
    LEFT JOIN (
      SELECT uid, nickname
      FROM (
        SELECT uid, nickname,
               ROW_NUMBER() OVER (PARTITION BY uid ORDER BY connected_at ASC NULLS LAST) AS rn
        FROM public.ml_accounts
      ) ranked_accounts
      WHERE rn = 1
    ) ml ON u.uid = ml.uid
    WHERE ii.type = 'manual'
  `;

  const params = [];
  if (clientId) {
    params.push(clientId);
    query += ` AND i.uid = $${params.length}`;
  }

  query += ' ORDER BY ii.service_date DESC NULLS LAST, ii.id DESC';

  try {
    const { rows } = await db.query(query, params);
    const formattedRows = rows.map(row => ({
      ...row,
      quantity: row.quantity != null ? parseFloat(row.quantity) : null,
      unit_price: row.unit_price != null ? parseFloat(row.unit_price) : null,
      total_price: row.total_price != null ? parseFloat(row.total_price) : null,
    }));
    res.json(formattedRows);
  } catch (error) {
    console.error('Erro ao buscar histórico de serviços avulsos:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @route   PUT /api/history/manual/:id
 * @desc    Atualiza um serviço avulso.
 * @access  Private (Master)
 */
router.put('/manual/:id', authenticateToken, requireMaster, async (req, res) => {
  const { id } = req.params;
  const { description, quantity, unit_price, entry_date } = req.body;

  if (!description || quantity == null || unit_price == null || !entry_date) {
    return res.status(400).json({
      error: 'Todos os campos são obrigatórios: description, quantity, unit_price, entry_date.',
    });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    
    // Update invoice item
    const updateQuery = `
      UPDATE public.invoice_items
      SET
        description = $1,
        quantity = $2,
        unit_price = $3,
        service_date = $4,
        total_price = $2 * $3
      WHERE id = $5 AND type = 'manual'
      RETURNING *;
    `;
    const { rows } = await client.query(updateQuery, [description, quantity, unit_price, entry_date, id]);

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Serviço avulso não encontrado ou não é do tipo manual.' });
    }

    // Recalculate invoice total
    const invoiceId = rows[0].invoice_id;
    const sumRes = await client.query(`
      SELECT COALESCE(SUM(total_price), 0) AS sum
      FROM public.invoice_items WHERE invoice_id = $1;
    `, [invoiceId]);
    const newTotal = parseFloat(sumRes.rows[0].sum || 0);
    await client.query(`UPDATE public.invoices SET total_amount = $1 WHERE id = $2`, [newTotal, invoiceId]);

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar serviço avulso:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  } finally {
    client.release();
  }
});

/**
 * @route   DELETE /api/history/manual/:id
 * @desc    Deleta um serviço avulso.
 * @access  Private (Master)
 */
router.delete('/manual/:id', authenticateToken, requireMaster, async (req, res) => {
  const { id } = req.params;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    
    // Get invoice_id before deleting
    const getInvoiceQuery = 'SELECT invoice_id FROM public.invoice_items WHERE id = $1 AND type = \'manual\'';
    const invoiceResult = await client.query(getInvoiceQuery, [id]);
    
    if (invoiceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Serviço avulso não encontrado ou não é do tipo manual.' });
    }
    
    const invoiceId = invoiceResult.rows[0].invoice_id;
    
    // Delete the item
    const { rowCount } = await client.query(
      "DELETE FROM public.invoice_items WHERE id = $1 AND type = 'manual'",
      [id]
    );

    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Serviço avulso não encontrado ou não é do tipo manual.' });
    }
    
    // Recalculate invoice total
    const sumRes = await client.query(`
      SELECT COALESCE(SUM(total_price), 0) AS sum
      FROM public.invoice_items WHERE invoice_id = $1;
    `, [invoiceId]);
    const newTotal = parseFloat(sumRes.rows[0].sum || 0);
    await client.query(`UPDATE public.invoices SET total_amount = $1 WHERE id = $2`, [newTotal, invoiceId]);

    await client.query('COMMIT');
    res.status(200).json({ message: 'Serviço avulso excluído com sucesso.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao excluir serviço avulso:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  } finally {
    client.release();
  }
});

module.exports = router;
