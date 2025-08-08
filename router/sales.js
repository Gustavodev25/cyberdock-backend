const express = require('express');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');
const fetch = require('node-fetch');

const router = express.Router();

// Armazena os clientes conectados para SSE
const clients = {};

// ===== Configurações =====
const MAX_ORDERS = 5000;        // máximo de pedidos para evitar loops infinitos
const PAGE_LIMIT = 50;          // limite por página na API ML
const SLA_CONCURRENCY = 10;     // concorrência para chamadas SLA
const UPSERT_BATCH_SIZE = 300;  // tamanho do lote para inserção no banco

// Envia evento SSE para cliente específico
const sendEvent = (clientId, data) => {
  if (clients[clientId]) {
    clients[clientId].res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
};

// JSON seguro
async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

// Executa map com limite de concorrência
async function mapWithConcurrency(items, limit, mapper) {
  const ret = new Array(items.length);
  let i = 0;
  let active = 0;

  return new Promise((resolve) => {
    const next = () => {
      if (i === items.length && active === 0) return resolve(ret);
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve(mapper(items[idx], idx))
          .then(v => { ret[idx] = v; })
          .catch(() => { ret[idx] = null; })
          .finally(() => { active--; next(); });
      }
    };
    next();
  });
}

// Monta linhas para inserir em lote
function buildInsertBatchRows(orders, requesterUid, nickname) {
  const rows = [];
  for (const order of orders) {
    const slaData = order?.sla_data || null;
    const finalShippingLimitDate =
      slaData?.shipping_limit_date ||
      order?.shipping?.shipping_option?.estimated_delivery_time?.shipping_limit_date ||
      null;

    for (const it of (order?.order_items || [])) {
      const sku = it?.item?.seller_sku;
      if (!sku) continue;

      rows.push({
        id: order.id,
        sku,
        uid: requesterUid,
        seller_id: order?.seller?.id,
        channel: 'ML',
        account_nickname: nickname,
        sale_date: order.date_created,
        product_title: it?.item?.title || null,
        quantity: it?.quantity || 1,
        shipping_mode: order?.shipping?.shipping_mode || null,
        shipping_limit_date: finalShippingLimitDate,
        packages: order.pack_id ? 1 : 0,
        shipping_status: order?.shipping?.status || null,
        raw_api_data: order
      });
    }
  }
  return rows;
}

// Monta query multi-insert com DO NOTHING para ignorar duplicados
function buildMultiInsertQuery_DoNothing(rows) {
  const cols = [
    'id','sku','uid','seller_id','channel','account_nickname','sale_date',
    'product_title','quantity','shipping_mode','shipping_limit_date',
    'packages','shipping_status','raw_api_data','updated_at'
  ];
  const values = [];
  const params = [];
  let p = 1;

  for (const r of rows) {
    params.push(
      r.id, r.sku, r.uid, r.seller_id, 'ML', r.account_nickname, r.sale_date,
      r.product_title, r.quantity, r.shipping_mode, r.shipping_limit_date,
      r.packages, r.shipping_status, r.raw_api_data, new Date()
    );
    const placeholders = cols.map(() => `$${p++}`).join(', ');
    values.push(`(${placeholders})`);
  }

  const query = `
    INSERT INTO public.sales (${cols.join(', ')})
    VALUES ${values.join(', ')}
    ON CONFLICT (id, sku, uid) DO NOTHING;
  `;

  return { query, params };
}

// ===== Rotas =====

router.get('/sync-status/:clientId', (req, res) => {
  const { clientId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache'
  });
  clients[clientId] = { res };
  sendEvent(clientId, { progress: 5, message: 'Conexão estabelecida. Aguardando início...', type: 'info' });
  req.on('close', () => {
    delete clients[clientId];
  });
});

router.get('/user/:uid', authenticateToken, requireMaster, async (req, res) => {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: 'O UID do usuário é obrigatório.' });
  try {
    const query = `
      SELECT id, sku, uid, seller_id, channel, account_nickname, sale_date,
        product_title, quantity, shipping_mode, shipping_limit_date,
        packages, shipping_status, raw_api_data, updated_at, processed_at
      FROM public.sales WHERE uid = $1 ORDER BY sale_date DESC;
    `;
    const { rows } = await db.query(query, [uid]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao buscar vendas.' });
  }
});

router.get('/my-sales', authenticateToken, async (req, res) => {
  const { uid } = req.user;
  try {
    const query = `
      SELECT id, sku, uid, seller_id, channel, account_nickname, sale_date,
        product_title, quantity, shipping_mode, shipping_limit_date,
        packages, shipping_status, raw_api_data, updated_at, processed_at
      FROM public.sales WHERE uid = $1 ORDER BY sale_date DESC;
    `;
    const { rows } = await db.query(query, [uid]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao buscar vendas.' });
  }
});

router.put('/status', authenticateToken, requireMaster, async (req, res) => {
  const { saleId, sku, uid, shippingStatus } = req.body;
  if (!saleId || !sku || !uid || !shippingStatus) return res.status(400).json({ error: 'Dados incompletos.' });

  if (shippingStatus === 'custom_06_despachado') {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const saleQ = 'SELECT quantity, processed_at FROM public.sales WHERE id = $1 AND sku = $2 AND uid = $3';
      const saleR = await client.query(saleQ, [saleId, sku, uid]);
      if (saleR.rowCount === 0) throw new Error('Venda não encontrada.');
      if (saleR.rows[0].processed_at) throw new Error('Venda já processada.');

      const quantitySold = saleR.rows[0].quantity;
      const skuQ = 'SELECT id, quantidade FROM public.skus WHERE sku = $1 AND user_id = $2 FOR UPDATE';
      const skuR = await client.query(skuQ, [sku, uid]);
      if (skuR.rowCount === 0) throw new Error(`SKU '${sku}' não encontrado.`);
      const stock = skuR.rows[0];
      if (stock.quantidade < quantitySold) throw new Error(`Estoque insuficiente para SKU '${sku}'.`);

      await client.query('UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2', [quantitySold, stock.id]);
      const reason = `Saída por Venda - ID: ${saleId}`;
      await client.query('INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id) VALUES ($1, $2, \'saida\', $3, $4, $5)', [stock.id, uid, quantitySold, reason, saleId]);

      const updSaleQ = 'UPDATE public.sales SET shipping_status = $1, processed_at = NOW(), updated_at = NOW() WHERE id = $2 AND sku = $3 AND uid = $4 RETURNING id, shipping_status';
      const { rows } = await client.query(updSaleQ, [shippingStatus, saleId, sku, uid]);

      await client.query('COMMIT');
      res.json({ message: 'Status atualizado e estoque abatido.', sale: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message || 'Erro interno ao processar despacho.' });
    } finally {
      client.release();
    }
  } else {
    try {
      const query = `
        UPDATE public.sales SET shipping_status = $1, updated_at = NOW()
        WHERE id = $2 AND sku = $3 AND uid = $4 RETURNING id, shipping_status;
      `;
      const { rows, rowCount } = await db.query(query, [shippingStatus, saleId, sku, uid]);
      if (rowCount === 0) return res.status(404).json({ error: 'Venda não encontrada ou sem permissão.' });
      res.json({ message: 'Status atualizado.', sale: rows[0] });
    } catch (err) {
      res.status(500).json({ error: 'Erro interno.' });
    }
  }
});

router.post('/process', authenticateToken, requireMaster, async (req, res) => {
  const { salesToProcess } = req.body;
  if (!Array.isArray(salesToProcess) || salesToProcess.length === 0) return res.status(400).json({ error: 'Nenhuma venda para processar.' });

  const results = { success: [], failed: [] };
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');
    for (const sale of salesToProcess) {
      try {
        if (sale.processed_at) {
          results.failed.push({ saleId: sale.id, sku: sale.sku, reason: 'Venda já processada.' });
          continue;
        }
        const skuQ = 'SELECT id, quantidade FROM public.skus WHERE sku = $1 AND user_id = $2 FOR UPDATE';
        const skuR = await client.query(skuQ, [sale.sku, sale.uid]);
        if (skuR.rowCount === 0) throw new Error(`SKU '${sale.sku}' não encontrado.`);
        const stock = skuR.rows[0];
        if (stock.quantidade < sale.quantity) throw new Error(`Estoque insuficiente para SKU '${sale.sku}'.`);

        await client.query('UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2', [sale.quantity, stock.id]);
        const reason = `Saída por Venda em Lote - ID: ${sale.id}`;
        await client.query('INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id) VALUES ($1, $2, \'saida\', $3, $4, $5)', [stock.id, sale.uid, sale.quantity, reason, sale.id]);

        const updSaleQ = 'UPDATE public.sales SET processed_at = NOW(), updated_at = NOW() WHERE id = $1 AND sku = $2 AND uid = $3 AND processed_at IS NULL RETURNING id';
        const { rowCount } = await client.query(updSaleQ, [sale.id, sale.sku, sale.uid]);
        if (rowCount > 0) results.success.push({ saleId: sale.id, sku: sale.sku });
        else throw new Error('Venda não pode ser atualizada.');
      } catch (e) {
        results.failed.push({ saleId: sale.id, sku: sale.sku, reason: e.message });
      }
    }
    if (results.failed.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Falha no processamento em lote.', ...results });
    }
    await client.query('COMMIT');
    res.json({ message: 'Lote processado com sucesso.', ...results });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro crítico no processamento em lote.' });
  } finally {
    client.release();
  }
});

// ROTA PRINCIPAL DE SINCRONIZAÇÃO, puxando vendas desde 01/01/2025

router.post('/sync-account', authenticateToken, async (req, res) => {
  const { userId, accountNickname: nickname, clientId } = req.body;
  const requesterUid = req.user.uid;

  if (!userId || !clientId) return res.status(400).json({ error: 'ID usuário e clientId obrigatórios.' });

  res.status(202).json({ message: 'Sincronização iniciada. Acompanhe status.' });

  try {
    sendEvent(clientId, { progress: 10, message: 'Buscando credenciais...', type: 'info' });
    const accQ = 'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1 AND uid = $2';
    const accRes = await db.query(accQ, [userId, requesterUid]);
    if (accRes.rowCount === 0) throw new Error('Conta ML não encontrada ou não pertence ao usuário.');
    let { access_token, refresh_token } = accRes.rows[0];

    let allOrders = [];
    let offset = 0;
    const startDateFilter = new Date('2025-01-01T00:00:00Z');

    sendEvent(clientId, { progress: 20, message: 'Buscando vendas desde 01/01/2025...', type: 'info' });

    while (allOrders.length < MAX_ORDERS) {
      const limit = Math.min(PAGE_LIMIT, MAX_ORDERS - allOrders.length);
      const ordersUrl = `https://api.mercadolibre.com/orders/search?seller=${userId}&offset=${offset}&limit=${limit}&sort=date_desc`;

      let ordersResponse = await fetch(ordersUrl, { headers: { Authorization: `Bearer ${access_token}` } });

      if (ordersResponse.status === 401) {
        // Refresh token - mantenha sua lógica atual aqui
        const CLIENT_ID = process.env.ML_CLIENT_ID;
        const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
        const refreshResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refresh_token,
          }),
        });
        if (!refreshResponse.ok) {
          await db.query("UPDATE public.ml_accounts SET status = 'reconnect_needed' WHERE user_id = $1 AND uid = $2", [userId, requesterUid]);
          throw new Error('Falha ao atualizar token. Refaça a conexão.');
        }
        const newTokenData = await refreshResponse.json();
        access_token = newTokenData.access_token;
        refresh_token = newTokenData.refresh_token;
        await db.query(
          "UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = 'active', updated_at = NOW() WHERE user_id = $4 AND uid = $5",
          [access_token, refresh_token, newTokenData.expires_in, userId, requesterUid]
        );
        sendEvent(clientId, { progress: 40, message: 'Token atualizado. Continuando...', type: 'info' });
        ordersResponse = await fetch(ordersUrl, { headers: { Authorization: `Bearer ${access_token}` } });
      }

      if (!ordersResponse.ok) {
        const errorBody = await safeJson(ordersResponse);
        throw new Error(`Erro ao buscar vendas ML: ${errorBody?.message || ordersResponse.statusText}`);
      }

      const pageData = await ordersResponse.json();
      const items = pageData.results || [];
      if (items.length === 0) break;

      // Filtra vendas >= 01/01/2025
      const filteredItems = items.filter(o => new Date(o.date_created) >= startDateFilter);
      allOrders.push(...filteredItems);

      const lastDate = new Date(items[items.length - 1]?.date_created);
      if (lastDate < startDateFilter) break;

      if (filteredItems.length < limit) break;

      offset += limit;

      sendEvent(clientId, {
        progress: 20 + Math.floor((allOrders.length / MAX_ORDERS) * 25),
        message: `Coletadas ${allOrders.length} vendas desde 01/01/2025...`,
        type: 'info'
      });
    }

    if (allOrders.length === 0) {
      sendEvent(clientId, { progress: 100, message: 'Nenhuma venda encontrada.', type: 'success' });
      return;
    }

    // Busca SLA com concorrência
    sendEvent(clientId, { progress: 55, message: 'Buscando SLA dos envios...', type: 'info' });
    const shipments = allOrders.map(o => o?.shipping?.id || null);
    const slaResults = await mapWithConcurrency(shipments, SLA_CONCURRENCY, async (shipmentId) => {
      if (!shipmentId) return null;
      const res = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}/sla`, { headers: { Authorization: `Bearer ${access_token}` } });
      if (!res.ok) return null;
      return await res.json();
    });
    for (let i = 0; i < allOrders.length; i++) {
      if (slaResults[i]) allOrders[i].sla_data = slaResults[i];
    }

    // Deduplicação inteligente
    const sellerId = allOrders?.[0]?.seller?.id || userId;
    const existingRes = await db.query(`SELECT 1 FROM public.sales WHERE uid = $1 AND seller_id = $2 LIMIT 1`, [requesterUid, sellerId]);
    const isNewAccount = existingRes.rowCount === 0;
    const allRows = buildInsertBatchRows(allOrders, requesterUid, nickname);
    let rowsToInsert = allRows;

    if (!isNewAccount) {
      const orderIds = Array.from(new Set(allOrders.map(o => o.id))).slice(0, MAX_ORDERS);
      const existingKeysRes = await db.query(
        `SELECT id, sku FROM public.sales WHERE uid = $1 AND seller_id = $2 AND id = ANY($3)`,
        [requesterUid, sellerId, orderIds]
      );
      const existingKeySet = new Set(existingKeysRes.rows.map(r => `${r.id}|${r.sku}`));
      rowsToInsert = allRows.filter(r => !existingKeySet.has(`${r.id}|${r.sku}`));
    }

    sendEvent(clientId, { progress: 60, message: isNewAccount ? 'Primeira sincronização: salvando todas...' : `Detectadas ${rowsToInsert.length} novas vendas. Salvando...`, type: 'info' });
    if (rowsToInsert.length === 0) {
      sendEvent(clientId, { progress: 100, message: 'Tudo atualizado. Nada novo para salvar.', type: 'success' });
      if (clients[clientId]) {
        clients[clientId].res.end();
        delete clients[clientId];
      }
      return;
    }

    const clientDb = await db.pool.connect();
    let insertedCount = 0;
    try {
      await clientDb.query('BEGIN');
      for (let i = 0; i < rowsToInsert.length; i += UPSERT_BATCH_SIZE) {
        const chunk = rowsToInsert.slice(i, i + UPSERT_BATCH_SIZE);
        const { query, params } = buildMultiInsertQuery_DoNothing(chunk);
        await clientDb.query(query, params);
        insertedCount += chunk.length;

        const pct = 60 + Math.floor((insertedCount / rowsToInsert.length) * 40);
        if (i === 0 || i + UPSERT_BATCH_SIZE >= rowsToInsert.length || i % (UPSERT_BATCH_SIZE * 3) === 0) {
          sendEvent(clientId, { progress: Math.min(99, pct), message: `Salvando lote... ${insertedCount}/${rowsToInsert.length}`, type: 'info' });
        }
      }
      await clientDb.query('COMMIT');
      sendEvent(clientId, { progress: 100, message: `Sincronização concluída. ${insertedCount} vendas inseridas.`, type: 'success' });
    } catch (e) {
      await clientDb.query('ROLLBACK');
      throw e;
    } finally {
      clientDb.release();
    }
  } catch (error) {
    console.error(`[SYNC ERROR] Cliente ${clientId}:`, error);
    sendEvent(clientId, { progress: 100, message: `Erro: ${error.message}`, type: 'error' });
  } finally {
    if (clients[clientId]) {
      clients[clientId].res.end();
      delete clients[clientId];
    }
  }
});

module.exports = router;
