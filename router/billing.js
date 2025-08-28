// backend/routes/billing.js
const express = require('express');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');

const router = express.Router();

/**
 * Gera/atualiza itens automáticos da fatura (armazenamento + expedições),
 * preservando itens manuais, e recalcula o total somando manual + automático.
 */
async function calculateAndSaveInvoice(client, uid, period) {
  const [year, month] = period.split('-').map(Number);
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, -1));

  // === 1) Preços "master" dos serviços de armazenamento ===
  const masterPricesRes = await client.query(`
    SELECT type, price
    FROM public.services
    WHERE type IN ('base_storage', 'additional_storage', 'proportional_storage');
  `);
  const masterPrices = masterPricesRes.rows.reduce((acc, s) => {
    acc[s.type] = parseFloat(s.price);
    return acc;
  }, {});
  const masterBasePrice = masterPrices['base_storage'] || 0;
  const masterAdditionalPrice = masterPrices['additional_storage'] || 0;
  const masterProportionalPrice = masterPrices['proportional_storage'] || 0;

  // === 2) Contratos do cliente para armazenamento ===
  const contractsRes = await client.query(`
    SELECT s.type, uc.volume
    FROM public.user_contracts uc
    JOIN public.services s ON uc.service_id = s.id
    WHERE uc.uid = $1 AND s.type IN ('base_storage', 'additional_storage');
  `, [uid]);

  let autoItems = [];
  let autoTotal = 0;

  const baseService = contractsRes.rows.find(c => c.type === 'base_storage');
  if (baseService) {
    // === CÁLCULO PROPORCIONAL: R$ 397,00 ÷ 30 dias × dias restantes no mês ===
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth();
    
    // Se for o mês atual, calcular proporcional
    if (year === currentYear && month === currentMonth + 1) {
      const today = currentDate.getDate();
      const daysInMonth = new Date(year, month, 0).getDate();
      const daysRemaining = daysInMonth - today + 1;
      
      // Cálculo: 397 ÷ 30 × dias restantes
      const dailyRate = masterBasePrice / 30;
      const proportionalPrice = dailyRate * daysRemaining;
      
      autoItems.push({
        description: `Armazenamento Base (até 1m³) - Proporcional ${daysRemaining} dias`,
        quantity: 1,
        unit_price: Math.round(proportionalPrice * 100) / 100,
        total_price: Math.round(proportionalPrice * 100) / 100,
        type: 'storage'
      });
      autoTotal += Math.round(proportionalPrice * 100) / 100;
    } else {
      // Mês completo ou meses anteriores
      autoItems.push({
        description: 'Armazenamento Base (até 1m³)',
        quantity: 1,
        unit_price: masterBasePrice,
        total_price: masterBasePrice,
        type: 'storage'
      });
      autoTotal += masterBasePrice;
    }
  }

  const additionalService = contractsRes.rows.find(c => c.type === 'additional_storage');
  if (additionalService) {
    const quantity = parseInt(additionalService.volume, 10) || 0;
    if (quantity > 0) {
      const total = masterAdditionalPrice * quantity;
      autoItems.push({
        description: 'Armazenamento Adicional (m³)',
        quantity,
        unit_price: masterAdditionalPrice,
        total_price: total,
        type: 'storage'
      });
      autoTotal += total;
    }
  }

  // === 2.1) CÁLCULO PROPORCIONAL AUTOMÁTICO ===
  // O armazenamento base já é calculado proporcionalmente acima
  // Para meses futuros, será cobrado o valor completo

  // === 3) Expedições por período ===
  const shipmentsRes = await client.query(`
    SELECT sm.quantity_change, pt.name as package_type_name, pt.price as package_type_price
    FROM public.stock_movements sm
    JOIN public.skus s ON sm.sku_id = s.id
    LEFT JOIN public.package_types pt ON s.package_type_id = pt.id
    WHERE sm.user_id = $1
      AND sm.movement_type = 'saida'
      AND sm.reason LIKE 'Saída por Venda%'
      AND sm.created_at BETWEEN $2 AND $3;
  `, [uid, startDate, endDate]);

  const shipmentSummary = shipmentsRes.rows.reduce((acc, row) => {
    if (row.package_type_name && row.package_type_price) {
      const key = row.package_type_name;
      if (!acc[key]) acc[key] = { quantity: 0, price: parseFloat(row.package_type_price) };
      acc[key].quantity += row.quantity_change;
    }
    return acc;
  }, {});

  for (const [description, data] of Object.entries(shipmentSummary)) {
    if (data.quantity > 0) {
      const total = data.quantity * data.price;
      autoItems.push({
        description,
        quantity: data.quantity,
        unit_price: data.price,
        total_price: total,
        type: 'shipment'
      });
      autoTotal += total;
    }
  }

  // === 4) Upsert da fatura (cria se não existir) ===
  const dueDate = new Date(Date.UTC(year, month, 5));
  const upsertRes = await client.query(`
    INSERT INTO public.invoices (uid, period, due_date, total_amount, status)
    VALUES ($1, $2, $3, 0, 'pending')
    ON CONFLICT (uid, period) DO UPDATE
      SET due_date = EXCLUDED.due_date,
          status = 'pending'
    RETURNING id;
  `, [uid, period, dueDate]);
  const invoiceId = upsertRes.rows[0].id;

  // === 5) Remove SOMENTE itens automáticos e recria ===
  await client.query(
    `DELETE FROM public.invoice_items WHERE invoice_id = $1 AND type IN ('storage','shipment');`,
    [invoiceId]
  );

  if (autoItems.length) {
    for (const it of autoItems) {
      await client.query(`
        INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price, total_price, type)
        VALUES ($1, $2, $3, $4, $5, $6);
      `, [invoiceId, it.description, it.quantity, it.unit_price, it.total_price, it.type]);
    }
  }

  // === 6) Recalcula total: automáticos + manuais ===
  const manualSumRes = await client.query(`
    SELECT COALESCE(SUM(total_price), 0) AS sum
    FROM public.invoice_items
    WHERE invoice_id = $1 AND type = 'manual';
  `, [invoiceId]);

  const newTotal = autoTotal + parseFloat(manualSumRes.rows[0].sum || 0);
  await client.query(`UPDATE public.invoices SET total_amount = $1 WHERE id = $2;`, [newTotal, invoiceId]);
}

/** ===== ROTAS ===== */

// Lista faturas (gera/atualiza automáticos, preserva manuais)
router.get('/invoices/:uid', authenticateToken, async (req, res) => {
  const { uid } = req.params;
  const periodToProcess = req.query.period || new Date().toISOString().slice(0, 7);

  if (req.user.role !== 'master' && req.user.uid !== uid) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    await calculateAndSaveInvoice(client, uid, periodToProcess);

    const q = `
      SELECT i.id, i.uid, i.period, i.due_date, i.payment_date, i.total_amount, i.status,
             COALESCE(json_agg(json_build_object(
               'description', it.description,
               'quantity', it.quantity,
               'unit_price', it.unit_price,
               'total_price', it.total_price,
               'type', it.type,
               'service_date', it.service_date
             )) FILTER (WHERE it.id IS NOT NULL), '[]') AS items
      FROM public.invoices i
      LEFT JOIN public.invoice_items it ON i.id = it.invoice_id
      WHERE i.uid = $1
      GROUP BY i.id
      ORDER BY i.period DESC;
    `;
    const { rows } = await client.query(q, [uid]);

    await client.query('COMMIT');
    res.json(rows.map(inv => ({
      ...inv,
      total_amount: parseFloat(inv.total_amount)
    })));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao buscar/gerar faturas:', err);
    res.status(500).json({ error: 'Erro interno ao processar faturas.' });
  } finally {
    client.release();
  }
});

// Resumo (master)
router.get('/summary', authenticateToken, requireMaster, async (req, res) => {
  try {
    const q = `
      SELECT 
        u.uid,
        u.email,
        (SELECT i.total_amount FROM public.invoices i WHERE i.uid = u.uid ORDER BY i.period DESC LIMIT 1) AS last_invoice_total,
        (SELECT i.status FROM public.invoices i WHERE i.uid = u.uid ORDER BY i.period DESC LIMIT 1) AS last_invoice_status,
        (SELECT i.period FROM public.invoices i WHERE i.uid = u.uid ORDER BY i.period DESC LIMIT 1) AS last_invoice_period
      FROM public.users u
      WHERE u.role = 'cliente'
      ORDER BY u.email;
    `;
    const { rows } = await db.query(q);
    res.json(rows.map(r => ({
      ...r,
      last_invoice_total: r.last_invoice_total ? parseFloat(r.last_invoice_total) : 0
    })));
  } catch (err) {
    console.error('Erro ao buscar resumo de faturamento:', err);
    res.status(500).json({ error: 'Erro interno ao buscar resumo de faturamento.' });
  }
});

/** ===== NOVO: lista de serviços manuais disponíveis (master) ===== */
router.get('/manual-services', authenticateToken, requireMaster, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, name, type, price, config
      FROM public.services
      WHERE type IN ('avulso_simples', 'avulso_quantidade')
      ORDER BY name;
    `);
    res.json(rows.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      price: s.price !== null ? parseFloat(s.price) : null,
      config: s.config || null
    })));
  } catch (err) {
    console.error('Erro ao listar serviços manuais:', err);
    res.status(500).json({ error: 'Erro ao listar serviços manuais.' });
  }
});

/** Util: define preço por faixa (tiers) para serviços "avulso_quantidade" */
function getTierUnitPrice(cfg, qty) {
  if (!cfg || !Array.isArray(cfg.tiers) || !qty) return null;
  for (const tier of cfg.tiers) {
    const fromOk = typeof tier.from === 'number' ? qty >= tier.from : true;
    const toOk = typeof tier.to === 'number' ? qty <= tier.to : true;
    if (fromOk && toOk) return parseFloat(tier.price);
  }
  // Se não encontrou, usa último tier sem "to"
  const openTier = cfg.tiers.find(t => t.to === null || typeof t.to === 'undefined');
  return openTier ? parseFloat(openTier.price) : null;
}

/** ===== NOVO: adiciona item manual na fatura (master) ===== */
router.post('/add-manual-item', authenticateToken, requireMaster, async (req, res) => {
  const { uid, period, serviceId, quantity, serviceDate } = req.body || {};

  if (!uid || !period || !serviceId) {
    return res.status(400).json({ error: 'uid, period e serviceId são obrigatórios.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Busca o serviço
    const serviceRes = await client.query(`SELECT id, name, type, price, config FROM public.services WHERE id = $1`, [serviceId]);
    if (serviceRes.rowCount === 0) throw new Error('Serviço não encontrado.');
    const service = serviceRes.rows[0];

    // 2) Define quantidade e preço unitário
    let qty = 1;
    let unitPrice = null;

    if (service.type === 'avulso_quantidade') {
      const q = parseInt(quantity, 10);
      if (!q || q < 1) {
        return res.status(400).json({ error: 'Quantidade inválida para serviço por quantidade.' });
      }
      qty = q;
      unitPrice = getTierUnitPrice(service.config, qty);
      if (unitPrice === null) {
        return res.status(400).json({ error: 'Configuração de tiers inválida para este serviço.' });
      }
    } else if (service.type === 'avulso_simples') {
      unitPrice = parseFloat(service.price);
      qty = 1;
    } else {
      return res.status(400).json({ error: 'Tipo de serviço não permitido para lançamento manual.' });
    }

    const totalPrice = unitPrice * qty;

    // 3) Garante fatura do período (gera automáticos e preserva manuais)
    await calculateAndSaveInvoice(client, uid, period);

    // 4) Obtém id da fatura
    const invRes = await client.query(`SELECT id FROM public.invoices WHERE uid = $1 AND period = $2`, [uid, period]);
    if (invRes.rowCount === 0) throw new Error('Fatura não encontrada após geração.');
    const invoiceId = invRes.rows[0].id;

    // 5) Data do serviço (DATE)
    let serviceDateSql = null;
    if (serviceDate) {
      const d = new Date(serviceDate);
      if (!isNaN(d)) serviceDateSql = d.toISOString().slice(0, 10);
    }

    // 6) Insere item manual
    await client.query(`
      INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price, total_price, type, service_date)
      VALUES ($1, $2, $3, $4, $5, 'manual', $6);
    `, [invoiceId, service.name, qty, unitPrice, totalPrice, serviceDateSql]);

    // 7) Recalcula total da fatura (manual + automáticos)
    const sumRes = await client.query(`
      SELECT COALESCE(SUM(total_price), 0) AS sum
      FROM public.invoice_items WHERE invoice_id = $1;
    `, [invoiceId]);
    const newTotal = parseFloat(sumRes.rows[0].sum || 0);
    await client.query(`UPDATE public.invoices SET total_amount = $1 WHERE id = $2`, [newTotal, invoiceId]);

    await client.query('COMMIT');
    res.status(201).json({ ok: true, invoice_id: invoiceId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao adicionar item manual:', err);
    res.status(500).json({ error: 'Erro ao adicionar item manual.' });
  } finally {
    client.release();
  }
});

/** ===== NOVO: histórico (master) de TODOS os serviços manuais lançados ===== */
router.get('/all-manual-services', authenticateToken, requireMaster, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT 
        ii.id,
        ii.service_date,
        ii.description,
        ii.quantity,
        ii.unit_price,
        ii.total_price,
        i.period,
        u.name AS client_name,
        u.email AS client_email
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.users u ON u.uid = i.uid
      WHERE ii.type = 'manual'
      ORDER BY ii.service_date DESC NULLS LAST, i.period DESC, ii.id DESC;
    `);
    res.json(rows.map(r => ({
      id: r.id,
      service_date: r.service_date,
      description: r.description,
      quantity: r.quantity,
      unit_price: parseFloat(r.unit_price),
      total_price: parseFloat(r.total_price),
      period: r.period,
      client_name: r.client_name,
      client_email: r.client_email
    })));
  } catch (err) {
    console.error('Erro ao buscar histórico de serviços manuais:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico.' });
  }
});

module.exports = router;
