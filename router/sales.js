// routes/sales.js
const express = require('express');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');
const fetch = require('node-fetch');

const router = express.Router();

const clients = {};

const MAX_ORDERS = 5000;
const PAGE_LIMIT = 50;
const SLA_CONCURRENCY = 10;
const UPSERT_BATCH_SIZE = 300;

const MAX_PROCESS_BATCH = 500;

const sendEvent = (clientId, data) => {
  if (clients[clientId]) {
    clients[clientId].res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
};

async function safeJson(res) {
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
}

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
          .then((v) => {
            ret[idx] = v;
          })
          .catch(() => {
            ret[idx] = null;
          })
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

function buildInsertBatchRows(orders, targetUid, nickname) {
  const rows = [];
  for (const order of orders) {
    const slaData = order?.sla_data || null;
    const finalShippingLimitDate =
      slaData?.shipping_limit_date ||
      order?.shipping?.shipping_option?.estimated_delivery_time?.shipping_limit_date ||
      null;

    let shippingMode = order?.shipping?.logistic_type || order?.shipping?.mode;
    if (!shippingMode && Array.isArray(order.tags)) {
      if (order.tags.includes('fulfillment') || order.tags.includes('pack_order')) {
        shippingMode = 'fulfillment';
      }
    }

    const mapShippingType = (mode) => {
      if (!mode) return 'Outros';
      switch (String(mode).toLowerCase()) {
        case 'fulfillment': return 'FULL';
        case 'self_service': return 'FLEX';
        case 'drop_off': return 'Correios';
        case 'xd_drop_off': return 'Agência';
        case 'cross_docking': return 'Coleta';
        case 'me2': return 'Envio Padrão';
        default: return 'Outros';
      }
    };

    const finalShippingMode = mapShippingType(shippingMode);

    for (const it of order?.order_items || []) {
      const sku = it?.item?.seller_sku || it?.item?.id || null;
      if (!sku) continue;

      // Garantir que seller_id seja um número válido
      let sellerId = order?.seller?.id;
      if (sellerId) {
        sellerId = parseInt(sellerId, 10);
        if (isNaN(sellerId)) {
          console.warn(`seller_id inválido para pedido ${order.id}: ${order?.seller?.id}`);
          sellerId = null;
        }
      }

      // Garantir que o ID do pedido seja um número válido
      let orderId = order.id;
      if (orderId && typeof orderId === 'string') {
        orderId = parseInt(orderId, 10);
        if (isNaN(orderId)) {
          console.warn(`ID do pedido inválido: ${order.id}`);
          continue; // Pular este pedido se o ID for inválido
        }
      }

      // Garantir que packages seja um número válido
      let packages = order.pack_id ? 1 : 0;
      if (packages && typeof packages === 'string') {
        packages = parseInt(packages, 10);
        if (isNaN(packages)) {
          packages = 0;
        }
      }

      rows.push({
        id: orderId,
        sku,
        uid: targetUid,
        seller_id: sellerId,
        channel: 'ML',
        account_nickname: nickname || null,
        sale_date: order.date_created,
        product_title: it?.item?.title || null,
        quantity: it?.quantity || 1,
        shipping_mode: finalShippingMode,
        shipping_limit_date: finalShippingLimitDate,
        packages: packages,
        raw_api_data: order
      });
    }
  }
  return rows;
}

function buildMultiInsertQuery_DoUpdate(rows) {
  const cols = [
    'id', 'sku', 'uid', 'seller_id', 'channel', 'account_nickname',
    'sale_date', 'product_title', 'quantity', 'shipping_mode',
    'shipping_limit_date', 'packages', 'raw_api_data', 'updated_at'
  ];
  const values = [];
  const params = [];
  let p = 1;

  for (const r of rows) {
    // Garantir que todos os campos numéricos sejam do tipo correto
    let id = r.id;
    if (id && typeof id === 'string') {
      id = parseInt(id, 10);
      if (isNaN(id)) {
        console.warn(`id inválido para inserção: ${r.id}`);
        continue; // Pular esta linha se o ID for inválido
      }
    }

    let sellerId = r.seller_id;
    if (sellerId && typeof sellerId === 'string') {
      sellerId = parseInt(sellerId, 10);
      if (isNaN(sellerId)) {
        console.warn(`seller_id inválido para inserção: ${r.seller_id}`);
        sellerId = null;
      }
    }

    let quantity = r.quantity;
    if (quantity && typeof quantity === 'string') {
      quantity = parseInt(quantity, 10);
      if (isNaN(quantity)) {
        console.warn(`quantity inválido para inserção: ${r.quantity}`);
        quantity = 1;
      }
    }

    let packages = r.packages;
    if (packages && typeof packages === 'string') {
      packages = parseInt(packages, 10);
      if (isNaN(packages)) {
        console.warn(`packages inválido para inserção: ${r.packages}`);
        packages = 0;
      }
    }

    params.push(
      id, r.sku, r.uid, sellerId, 'ML', r.account_nickname,
      r.sale_date, r.product_title, quantity, r.shipping_mode,
      r.shipping_limit_date, packages, r.raw_api_data,
      new Date()
    );
    const placeholders = cols.map(() => `$${p++}`).join(', ');
    values.push(`(${placeholders})`);
  }

  const query = `
    INSERT INTO public.sales (${cols.join(', ')})
    VALUES ${values.join(', ')}
    ON CONFLICT (id, sku, uid) DO UPDATE SET
      shipping_mode = EXCLUDED.shipping_mode,
      shipping_limit_date = EXCLUDED.shipping_limit_date,
      packages = EXCLUDED.packages,
      raw_api_data = EXCLUDED.raw_api_data,
      updated_at = EXCLUDED.updated_at
    WHERE public.sales.processed_at IS NULL;
  `;

  return { query, params };
}

/** ======== HELPERS PARA BACKFILL ======== */

function uniqByIdSku(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r.id}::${r.sku}::${r.uid}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

// Atualiza em lote somente campos de enriquecimento sem tocar em processed_at
function buildMultiUpdateQuery_Backfill(rows) {
  // rows: [{ id, sku, uid, shipping_mode, shipping_limit_date, packages, raw_api_data }]
  const cols = ['id', 'sku', 'uid', 'shipping_mode', 'shipping_limit_date', 'packages', 'raw_api_data', 'updated_at'];
  const values = [];
  const params = [];
  let p = 1;

  for (const r of rows) {
    // Garantir que todos os campos numéricos sejam do tipo correto
    let id = r.id;
    if (id && typeof id === 'string') {
      id = parseInt(id, 10);
      if (isNaN(id)) {
        console.warn(`id inválido para backfill: ${r.id}`);
        continue; // Pular esta linha se o ID for inválido
      }
    }

    let packages = r.packages;
    if (packages && typeof packages === 'string') {
      packages = parseInt(packages, 10);
      if (isNaN(packages)) {
        console.warn(`packages inválido para backfill: ${r.packages}`);
        packages = null;
      }
    }

    params.push(
      id, r.sku, r.uid,
      r.shipping_mode ?? null,
      r.shipping_limit_date ?? null,
      packages,
      r.raw_api_data ?? null,
      new Date()
    );
    const placeholders = cols.map(() => `$${p++}`).join(', ');
    values.push(`(${placeholders})`);
  }

  const query = `
    WITH data (${cols.join(', ')}) AS (
      VALUES ${values.join(', ')}
    )
    UPDATE public.sales s
       SET shipping_mode = CASE
                              WHEN s.shipping_mode IS NULL OR s.shipping_mode = 'Outros'
                              THEN d.shipping_mode
                              ELSE s.shipping_mode
                           END,
           shipping_limit_date = COALESCE(s.shipping_limit_date, d.shipping_limit_date::timestamp with time zone),
           packages           = COALESCE(s.packages, d.packages::integer),
           raw_api_data       = COALESCE(d.raw_api_data::jsonb, s.raw_api_data),
           updated_at         = GREATEST(COALESCE(s.updated_at, d.updated_at::timestamp with time zone), d.updated_at::timestamp with time zone)
      FROM data d
     WHERE s.id = d.id::bigint
       AND s.sku = d.sku::text
       AND s.uid = d.uid::text;
  `;
  return { query, params };
}

// Passo de backfill: escaneia vendas salvas com dados faltantes e preenche
async function runBackfillMissing({ db, clientId, nickname, targetUid, userId, access_token, isMaster = false }) {
  sendEvent(clientId, { progress: 40, message: `[${nickname}] Procurando vendas com dados faltantes...`, type: 'info' });

  let candidatesQ, cand;
  if (isMaster) {
    // Para masters, busca vendas da conta específica sem restrição de seller_id
    candidatesQ = `
      SELECT id, sku, uid, seller_id, account_nickname, sale_date
        FROM public.sales
       WHERE uid = $1
         AND (
           raw_api_data IS NULL
           OR raw_api_data->'shipping' IS NULL
           OR raw_api_data->'sla_data' IS NULL
           OR shipping_mode IS NULL
           OR shipping_mode = 'Outros'
           OR shipping_limit_date IS NULL
         )
       ORDER BY sale_date DESC
       LIMIT $2;
    `;
    cand = await db.query(candidatesQ, [targetUid, MAX_ORDERS]);
  } else {
    // Para usuários normais, mantém a restrição de seller_id
    candidatesQ = `
      SELECT id, sku, uid, seller_id, account_nickname, sale_date
        FROM public.sales
       WHERE uid = $1
         AND seller_id = $2
         AND (
           raw_api_data IS NULL
           OR raw_api_data->'shipping' IS NULL
           OR raw_api_data->'sla_data' IS NULL
           OR shipping_mode IS NULL
           OR shipping_mode = 'Outros'
           OR shipping_limit_date IS NULL
         )
       ORDER BY sale_date DESC
       LIMIT $3;
    `;
    cand = await db.query(candidatesQ, [targetUid, userId, MAX_ORDERS]);
  }

  if (cand.rowCount === 0) {
    sendEvent(clientId, { progress: 55, message: `[${nickname}] Nada para completar. Nenhum dado faltante.`, type: 'success' });
    return;
  }

  const byOrder = {};
  for (const r of cand.rows) {
    if (!byOrder[r.id]) byOrder[r.id] = [];
    byOrder[r.id].push(r.sku);
  }
  const orderIds = Object.keys(byOrder);

  sendEvent(clientId, { progress: 50, message: `[${nickname}] Enriquecendo ${orderIds.length} pedidos salvos...`, type: 'info' });

  // 1) Detalhes do pedido + shipments + sla
  const detailedOrders = await mapWithConcurrency(orderIds, SLA_CONCURRENCY, async (orderId, idx) => {
    try {
      const r = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      let order = r.ok ? await r.json() : null;

      if (order?.shipping?.id) {
        const shipId = order.shipping.id;
        const [shipRes, slaRes] = await Promise.all([
          fetch(`https://api.mercadolibre.com/shipments/${shipId}`, { headers: { Authorization: `Bearer ${access_token}` } }),
          fetch(`https://api.mercadolibre.com/shipments/${shipId}/sla`, { headers: { Authorization: `Bearer ${access_token}` } }),
        ]);

        if (shipRes.ok) {
          const ship = await safeJson(shipRes);
          order.shipping = { ...order.shipping, ...ship };
        }
        if (slaRes.ok) {
          order.sla_data = await safeJson(slaRes);
        }
      }

      if (idx > 0 && idx % 10 === 0) {
        const pct = 50 + Math.floor(((idx + 1) / orderIds.length) * 20);
        sendEvent(clientId, { progress: Math.min(70, pct), message: `[${nickname}] Backfill... ${idx + 1}/${orderIds.length}`, type: 'info' });
      }
      return order;
    } catch {
      return null;
    }
  });

  // 2) Linhas apenas para (id, sku, uid) já existentes
  const allowed = new Set(cand.rows.map(r => `${r.id}::${r.sku}::${r.uid}`));
  const rowsRaw = buildInsertBatchRows(detailedOrders.filter(Boolean), targetUid, nickname)
    .filter(r => allowed.has(`${r.id}::${r.sku}::${r.uid}`));
  
  // Garantir que todos os campos numéricos sejam do tipo correto para todas as linhas
  const rows = uniqByIdSku(rowsRaw).map(r => {
    // Converter ID para número
    if (r.id && typeof r.id === 'string') {
      const parsedId = parseInt(r.id, 10);
      if (!isNaN(parsedId)) {
        r.id = parsedId;
      } else {
        console.warn(`id inválido no backfill: ${r.id}`);
        return null; // Retornar null para filtrar esta linha
      }
    }

    // Converter seller_id para número
    if (r.seller_id && typeof r.seller_id === 'string') {
      const parsedSellerId = parseInt(r.seller_id, 10);
      if (!isNaN(parsedSellerId)) {
        r.seller_id = parsedSellerId;
      } else {
        console.warn(`seller_id inválido no backfill: ${r.seller_id}`);
        r.seller_id = null;
      }
    }

    // Converter packages para número
    if (r.packages && typeof r.packages === 'string') {
      const parsedPackages = parseInt(r.packages, 10);
      if (!isNaN(parsedPackages)) {
        r.packages = parsedPackages;
      } else {
        console.warn(`packages inválido no backfill: ${r.packages}`);
        r.packages = null;
      }
    }

    return r;
  }).filter(Boolean); // Remover linhas com ID inválido

  if (rows.length === 0) {
    sendEvent(clientId, { progress: 72, message: `[${nickname}] Nada a atualizar após o enriquecimento.`, type: 'info' });
    return;
  }

  sendEvent(clientId, { progress: 72, message: `[${nickname}] Atualizando ${rows.length} itens existentes...`, type: 'info' });

  const clientDb = await db.pool.connect();
  try {
    await clientDb.query('BEGIN');

    for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
      const chunk = rows.slice(i, i + UPSERT_BATCH_SIZE);
      const { query, params } = buildMultiUpdateQuery_Backfill(chunk);
      await clientDb.query(query, params);

      const pct = 72 + Math.floor(((i + chunk.length) / rows.length) * 13);
      if (i === 0 || i + UPSERT_BATCH_SIZE >= rows.length || i % (UPSERT_BATCH_SIZE * 3) === 0) {
        sendEvent(clientId, { progress: Math.min(85, pct), message: `[${nickname}] Backfill em lote... ${i + chunk.length}/${rows.length}`, type: 'info' });
      }
    }

    await clientDb.query('COMMIT');
    sendEvent(clientId, { progress: 88, message: `[${nickname}] Backfill concluído para ${rows.length} itens.`, type: 'success' });
  } catch (e) {
    await clientDb.query('ROLLBACK');
    throw e;
  } finally {
    clientDb.release();
  }
}

/** ======== ROTAS ======== */

router.get('/sync-status/:clientId', (req, res) => {
  const { clientId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
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
  const { saleId, sku, uid, shippingStatus, force } = req.body;
  if (!saleId || !sku || !uid || !shippingStatus) {
    return res.status(400).json({ error: 'Dados incompletos.' });
  }

  const isDespachado = /despachado/i.test(String(shippingStatus));

  if (isDespachado) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const saleQ = `
        SELECT id, sku, uid, quantity, processed_at
          FROM public.sales
         WHERE id = $1 AND sku = $2 AND uid = $3
         FOR UPDATE;
      `;
      const saleR = await client.query(saleQ, [saleId, sku, uid]);
      if (saleR.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Venda não encontrada.' });
      }

      const sale = saleR.rows[0];

      if (sale.processed_at) {
        if (!force) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Venda já processada.' });
        }

        const updForced = `
          UPDATE public.sales
             SET shipping_status = $1,
                 updated_at     = NOW()
           WHERE id = $2 AND sku = $3 AND uid = $4
           RETURNING id, shipping_status, processed_at;
        `;
        const forcedRes = await client.query(updForced, [shippingStatus, saleId, sku, uid]);
        await client.query('COMMIT');
        return res.status(200).json({
          message: 'Status atualizado (forçado) sem reprocessar estoque.',
          sale: forcedRes.rows[0]
        });
      }

      const quantitySold = Number(sale.quantity || 0);
      if (!quantitySold) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Quantidade da venda inválida.' });
      }

      const skuQ = `
        SELECT s.id, s.quantidade, s.is_kit, s.package_type_id, s.sku as sku_code
          FROM public.skus s
         WHERE UPPER(TRIM(s.sku)) = UPPER(TRIM($1))
           AND s.user_id = $2
         FOR UPDATE;
      `;
      const skuR = await client.query(skuQ, [sku, uid]);
      if (skuR.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `SKU '${sku}' não encontrado.` });
      }

      const stock = skuR.rows[0];
      
      // Check if this SKU is a component of any kit (for package_type logic)
      let isKitComponent = false;
      let kitPackageTypeId = null;
      let kitSkuCode = null;
      
      if (!stock.is_kit) {
        // Check if this SKU is used as a component in any kit
        const kitComponentCheckQuery = `
          SELECT kc.kit_sku_id, ks.sku as kit_sku_code, ks.package_type_id
          FROM public.sku_kit_components kc
          JOIN public.skus ks ON kc.kit_sku_id = ks.id
          WHERE kc.child_sku_id = $1 AND ks.user_id = $2
        `;
        const kitComponentCheck = await client.query(kitComponentCheckQuery, [stock.id, uid]);
        
        if (kitComponentCheck.rows.length > 0) {
          isKitComponent = true;
          // Use the first kit's package_type (assuming one component can't be in multiple kits)
          kitPackageTypeId = kitComponentCheck.rows[0].package_type_id;
          kitSkuCode = kitComponentCheck.rows[0].kit_sku_code;
        }
      }
      
      // Handle kit vs regular SKU logic
      if (stock.is_kit) {
        // For kits, check component availability and deduct from child SKUs
        const kitComponentsQuery = `
          SELECT child_sku_id, quantity_per_kit
          FROM public.sku_kit_components
          WHERE kit_sku_id = $1
        `;
        const kitComponents = await client.query(kitComponentsQuery, [stock.id]);

        if (kitComponents.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Kit '${sku}' não possui componentes configurados.` });
        }

        // Check if we have enough stock of all child SKUs
        for (const component of kitComponents.rows) {
          const childSkuQuery = 'SELECT id, sku, quantidade FROM public.skus WHERE id = $1 FOR UPDATE';
          const childSku = await client.query(childSkuQuery, [component.child_sku_id]);
          
          if (childSku.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `SKU filho não encontrado para o kit '${sku}'.` });
          }
          
          const requiredQuantity = component.quantity_per_kit * quantitySold;
          if (childSku.rows[0].quantidade < requiredQuantity) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
              error: `Estoque insuficiente do SKU filho ${childSku.rows[0].sku} para o kit '${sku}'. Disponível: ${childSku.rows[0].quantidade}, Necessário: ${requiredQuantity}` 
            });
          }
        }

        // Deduct from child SKUs
        for (const component of kitComponents.rows) {
          const requiredQuantity = component.quantity_per_kit * quantitySold;
          
          // Update child SKU quantity
          const updateChildQuery = `
            UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2;
          `;
          await client.query(updateChildQuery, [requiredQuantity, component.child_sku_id]);
          
          // Record movement for child SKU
          const insertChildMovementQuery = `
            INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
            VALUES ($1, $2, 'saida', $3, $4, $5)
          `;
          await client.query(insertChildMovementQuery, [
            component.child_sku_id, 
            uid, 
            requiredQuantity, 
            `Saída por Kit: Saída por Venda - ID: ${saleId}`, 
            saleId
          ]);
        }

        // Record movement for the kit itself (informational)
        const insertKitMovementQuery = `
          INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
          VALUES ($1, $2, 'saida', $3, $4, $5)
        `;
        await client.query(insertKitMovementQuery, [
          stock.id, 
          uid, 
          quantitySold, 
          `Saída por Venda - ID: ${saleId}`, 
          saleId
        ]);
      } else {
        // Regular SKU logic
        if (Number(stock.quantidade) < quantitySold) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Estoque insuficiente para SKU '${sku}'.` });
        }

        await client.query(
          'UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2',
          [quantitySold, stock.id]
        );

        const reason = `Saída por Venda - ID: ${saleId}`;
        
        // Determine which package_type to use based on context
        let effectivePackageTypeId = stock.package_type_id;
        let packageTypeContext = 'SKU próprio';
        
        if (isKitComponent && kitPackageTypeId) {
          // If this SKU is a kit component, use the kit's package_type for billing
          effectivePackageTypeId = kitPackageTypeId;
          packageTypeContext = `Kit: ${kitSkuCode}`;
        }
        
        await client.query(
          `INSERT INTO public.stock_movements
             (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, package_type_id, package_type_context)
           VALUES ($1, $2, 'saida', $3, $4, $5, $6, $7)`,
          [stock.id, uid, quantitySold, reason, saleId, effectivePackageTypeId, packageTypeContext]
        );
      }

      const updSaleQ = `
        UPDATE public.sales
           SET shipping_status = $1,
               processed_at   = NOW(),
               updated_at     = NOW()
         WHERE id  = $2
           AND sku = $3
           AND uid = $4
         RETURNING id, shipping_status, processed_at;
      `;
      const { rows } = await client.query(updSaleQ, [shippingStatus, saleId, sku, uid]);

      await client.query('COMMIT');
      return res.json({ message: 'Status atualizado e estoque abatido.', sale: rows[0] });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
      return res.status(400).json({ error: err.message || 'Erro interno ao processar despacho.' });
    } finally {
      client.release();
    }
  }

  try {
    const query = `
      UPDATE public.sales
         SET shipping_status = $1,
             updated_at      = NOW()
       WHERE id = $2
         AND sku = $3
         AND uid = $4
       RETURNING id, shipping_status, processed_at;
    `;
    const { rows, rowCount } = await db.query(query, [shippingStatus, saleId, sku, uid]);
    if (rowCount === 0) return res.status(404).json({ error: 'Venda não encontrada ou sem permissão.' });
    return res.json({ message: 'Status atualizado.', sale: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

router.post('/process', authenticateToken, requireMaster, async (req, res) => {
  const { salesToProcess } = req.body;

  if (!Array.isArray(salesToProcess) || salesToProcess.length === 0) {
    return res.status(400).json({ error: 'Nenhuma venda para processar.' });
  }

  const sanitized = salesToProcess.map((s) => ({
    id: s.id,
    sku: String(s.sku || '').trim(),
    uid: s.uid,
    quantity: Number(s.quantity || 0)
  }));

  if (sanitized.length > MAX_PROCESS_BATCH) {
    return res.status(413).json({
      error: `Lote muito grande. Envie até ${MAX_PROCESS_BATCH} itens por requisição.`
    });
  }

  const results = { success: [], failed: [] };
  const client = await db.pool.connect();

  try {
    for (const sale of sanitized) {
      try {
        if (!sale.id || !sale.sku || !sale.uid || !sale.quantity) {
          throw new Error('Dados da venda incompletos (id, sku, uid, quantity).');
        }

        await client.query('BEGIN');

        const skuQ = `
          SELECT id, quantidade, is_kit
            FROM public.skus
           WHERE UPPER(TRIM(sku)) = UPPER(TRIM($1))
             AND user_id = $2
           FOR UPDATE;
        `;
        const skuR = await client.query(skuQ, [sale.sku, sale.uid]);
        if (skuR.rowCount === 0) throw new Error(`SKU '${sale.sku}' não encontrado.`);

        const stock = skuR.rows[0];
        
        // Handle kit vs regular SKU logic
        if (stock.is_kit) {
          // For kits, check component availability and deduct from child SKUs
          const kitComponentsQuery = `
            SELECT child_sku_id, quantity_per_kit
            FROM public.sku_kit_components
            WHERE kit_sku_id = $1
          `;
          const kitComponents = await client.query(kitComponentsQuery, [stock.id]);

          if (kitComponents.rows.length === 0) {
            throw new Error(`Kit '${sale.sku}' não possui componentes configurados.`);
          }

          // Check if we have enough stock of all child SKUs
          for (const component of kitComponents.rows) {
            const childSkuQuery = 'SELECT id, sku, quantidade FROM public.skus WHERE id = $1 FOR UPDATE';
            const childSku = await client.query(childSkuQuery, [component.child_sku_id]);
            
            if (childSku.rows.length === 0) {
              throw new Error(`SKU filho não encontrado para o kit '${sale.sku}'.`);
            }
            
            const requiredQuantity = component.quantity_per_kit * sale.quantity;
            if (childSku.rows[0].quantidade < requiredQuantity) {
              throw new Error(`Estoque insuficiente do SKU filho ${childSku.rows[0].sku} para o kit '${sale.sku}'. Disponível: ${childSku.rows[0].quantidade}, Necessário: ${requiredQuantity}`);
            }
          }

          // Deduct from child SKUs
          for (const component of kitComponents.rows) {
            const requiredQuantity = component.quantity_per_kit * sale.quantity;
            
            // Update child SKU quantity
            const updateChildQuery = `
              UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2;
            `;
            await client.query(updateChildQuery, [requiredQuantity, component.child_sku_id]);
            
            // Record movement for child SKU
            const insertChildMovementQuery = `
              INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
              VALUES ($1, $2, 'saida', $3, $4, $5)
            `;
            await client.query(insertChildMovementQuery, [
              component.child_sku_id, 
              sale.uid, 
              requiredQuantity, 
              `Saída por Kit: Saída por Venda em Lote - ID: ${sale.id}`, 
              sale.id
            ]);
          }

          // Record movement for the kit itself (informational)
          const insertKitMovementQuery = `
            INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
            VALUES ($1, $2, 'saida', $3, $4, $5)
          `;
          await client.query(insertKitMovementQuery, [
            stock.id, 
            sale.uid, 
            sale.quantity, 
            `Saída por Venda em Lote - ID: ${sale.id}`, 
            sale.id
          ]);
        } else {
          // Regular SKU logic
          if (Number(stock.quantidade) < Number(sale.quantity)) {
            throw new Error(`Estoque insuficiente para SKU '${sale.sku}'.`);
          }

          await client.query('UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2', [
            sale.quantity,
            stock.id
          ]);

          const reason = `Saída por Venda em Lote - ID: ${sale.id}`;
          await client.query(
            `INSERT INTO public.stock_movements
               (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
             VALUES ($1, $2, 'saida', $3, $4, $5)`,
            [stock.id, sale.uid, sale.quantity, reason, sale.id]
          );
        }

        const updSaleQ = `
          UPDATE public.sales
             SET processed_at = COALESCE(processed_at, NOW()),
                 updated_at   = NOW()
           WHERE id = $1
             AND sku = $2
             AND uid = $3
           RETURNING id;
        `;
        const upd = await client.query(updSaleQ, [sale.id, sale.sku, sale.uid]);
        if (upd.rowCount === 0) throw new Error('Venda não pode ser atualizada.');

        await client.query('COMMIT');
        results.success.push({ saleId: sale.id, sku: sale.sku });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
        results.failed.push({ saleId: sale.id, sku: sale.sku, reason: e.message });
      }
    }

    return res.json({ message: 'Processamento concluído.', ...results });
  } catch (error) {
    console.error('Erro crítico no processamento em lote:', error);
    return res.status(500).json({ error: 'Erro crítico no processamento em lote.' });
  } finally {
    client.release();
  }
});

router.post('/sync-account', authenticateToken, async (req, res) => {
  const { userId, accountNickname: nickname, clientId, force, backfill, clientUid } = req.body;
  let targetUid = clientUid || req.user.uid;

  if (!userId || !clientId) return res.status(400).json({ error: 'ID usuário e clientId obrigatórios.' });

  res.status(202).json({ message: 'Sincronização iniciada. Acompanhe status.' });

  try {
    sendEvent(clientId, { progress: 10, message: `[${nickname}] Buscando credenciais...`, type: 'info' });
    
    // Resolver credenciais da conta ML (permitir MASTER sincronizar sem estar logado no dono)
    let access_token, refresh_token;
    if (req.user.role === 'master') {
      if (clientUid) {
        const accRes = await db.query(
          'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1 AND uid = $2',
          [userId, clientUid]
        );
        if (accRes.rowCount === 0) {
          // Fallback: localizar pela conta ML (seller_id) e deduzir o UID do dono
          const fallback = await db.query(
            'SELECT access_token, refresh_token, uid FROM public.ml_accounts WHERE user_id = $1 LIMIT 1',
            [userId]
          );
          if (fallback.rowCount === 0) throw new Error('Conta ML não encontrada.');
          ({ access_token, refresh_token } = fallback.rows[0]);
          targetUid = fallback.rows[0].uid;
        } else {
          ({ access_token, refresh_token } = accRes.rows[0]);
          targetUid = clientUid;
        }
      } else {
        // MASTER sem clientUid: localizar pela conta ML (seller_id) e deduzir o UID do dono
        const accRes = await db.query(
          'SELECT access_token, refresh_token, uid FROM public.ml_accounts WHERE user_id = $1 LIMIT 1',
          [userId]
        );
        if (accRes.rowCount === 0) throw new Error('Conta ML não encontrada.');
        ({ access_token, refresh_token } = accRes.rows[0]);
        targetUid = accRes.rows[0].uid;
      }
    } else {
      const accRes = await db.query(
        'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1 AND uid = $2',
        [userId, targetUid]
      );
      if (accRes.rowCount === 0) throw new Error('Conta ML não encontrada ou não pertence ao usuário.');
      ({ access_token, refresh_token } = accRes.rows[0]);
    }

    if (backfill) {
      await runBackfillMissing({ 
        db, 
        clientId, 
        nickname, 
        targetUid, 
        userId, 
        access_token, 
        isMaster: req.user.role === 'master' 
      });
    }

    let lastSyncDate;
    const maxLookbackDate = new Date();
    maxLookbackDate.setDate(maxLookbackDate.getDate() - 180);

    if (force) {
      lastSyncDate = maxLookbackDate;
      sendEvent(clientId, { progress: 15, message: `[${nickname}] Sincronização forçada iniciada...`, type: 'info' });
    } else {
      let lastSyncRes;
      if (req.user.role === 'master') {
        // Para masters, busca a última venda da conta específica, independente do seller_id
        lastSyncRes = await db.query(
          `SELECT MAX(sale_date) AS last_sale FROM public.sales WHERE uid = $1`,
          [targetUid]
        );
      } else {
        // Para usuários normais, mantém a restrição de seller_id
        lastSyncRes = await db.query(
          `SELECT MAX(sale_date) AS last_sale FROM public.sales WHERE uid = $1 AND seller_id = $2`,
          [targetUid, userId]
        );
      }
      
      lastSyncDate = lastSyncRes.rows[0]?.last_sale ? new Date(lastSyncRes.rows[0].last_sale) : null;

      if (!lastSyncDate || lastSyncDate < maxLookbackDate) {
        lastSyncDate = maxLookbackDate;
      } else {
        lastSyncDate.setDate(lastSyncDate.getDate() - 1);
      }
    }

    sendEvent(clientId, { progress: 20, message: `[${nickname}] Buscando resumo de vendas desde ${lastSyncDate.toLocaleDateString('pt-BR')}...`, type: 'info' });

    let orderSummaries = [];
    let offset = 0;

    while (orderSummaries.length < MAX_ORDERS) {
      const limit = Math.min(PAGE_LIMIT, MAX_ORDERS - orderSummaries.length);
      const ordersUrl =
        `https://api.mercadolibre.com/orders/search` +
        `?seller=${userId}&offset=${offset}&limit=${limit}&sort=date_desc` +
        `&order.date_created.from=${encodeURIComponent(lastSyncDate.toISOString())}`;

      let ordersResponse = await fetch(ordersUrl, { headers: { Authorization: `Bearer ${access_token}` } });

      if (ordersResponse.status === 401) {
        sendEvent(clientId, { progress: 25, message: `[${nickname}] Token expirado. Tentando renovar...`, type: 'info' });
        const CLIENT_ID = process.env.ML_CLIENT_ID;
        const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
        const refreshResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refresh_token
          })
        });
        if (!refreshResponse.ok) {
          if (req.user.role === 'master') {
            await db.query("UPDATE public.ml_accounts SET status = 'reconnect_needed' WHERE uid = $1", [targetUid]);
          } else {
            await db.query("UPDATE public.ml_accounts SET status = 'reconnect_needed' WHERE user_id = $1 AND uid = $2", [userId, targetUid]);
          }
          throw new Error('Falha ao renovar token. É necessário reconectar a conta.');
        }
        const newTokenData = await refreshResponse.json();
        access_token = newTokenData.access_token;
        refresh_token = newTokenData.refresh_token;
        if (req.user.role === 'master') {
          await db.query(
            'UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = \'active\', updated_at = NOW() WHERE user_id = $4 AND uid = $5',
            [access_token, refresh_token, newTokenData.expires_in, userId, targetUid]
          );
        } else {
          await db.query(
            'UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = \'active\', updated_at = NOW() WHERE user_id = $4 AND uid = $5',
            [access_token, refresh_token, newTokenData.expires_in, userId, targetUid]
          );
        }
        sendEvent(clientId, { progress: 30, message: `[${nickname}] Token atualizado. Retomando busca...`, type: 'info' });
        ordersResponse = await fetch(ordersUrl, { headers: { Authorization: `Bearer ${access_token}` } });
      }

      if (!ordersResponse.ok) {
        const errorBody = await safeJson(ordersResponse);
        const errorMessage = errorBody?.message || ordersResponse.statusText;
        
        // Tratamento específico para erro de permissão
        if (errorMessage.includes('caller.id does not match buyer or seller')) {
          console.error(`[${nickname}] Erro de permissão na API: ${errorMessage}`);
          sendEvent(clientId, {
            progress: 0,
            message: `[${nickname}] Erro de permissão: Token e conta não correspondem (caller.id mismatch). Verifique se está sincronizando a conta correta. Não é necessário reconectar.`,
            type: 'error'
          });
          
          // Marcar conta como necessitando reconexão
          // Não marque a conta para reconexão para este erro específico,
          // pois normalmente é causado por parâmetro 'seller' incorreto (account mismatch).
          throw new Error(`Erro de permissão na API do Mercado Livre: ${errorMessage}. Verifique se a conta selecionada corresponde ao token conectado (seller_id incorreto). O status da conta não foi alterado.`);
        }
        
        throw new Error(`Erro na API do Mercado Livre: ${errorMessage}`);
      }

      const pageData = await ordersResponse.json();
      const items = pageData.results || [];
      if (items.length === 0) break;

      const filteredItems = items.filter((o) => new Date(o.date_created) >= lastSyncDate);
      orderSummaries.push(...filteredItems);

      if (items.length > 0) {
        const lastDateInPage = new Date(items[items.length - 1]?.date_created);
        if (lastDateInPage < lastSyncDate) break;
      }

      if (items.length < limit) break;
      offset += limit;
    }

    if (orderSummaries.length === 0) {
      sendEvent(clientId, { progress: 100, message: `[${nickname}] Nenhuma venda nova encontrada. Tudo atualizado!`, type: 'success' });
      return;
    }

    sendEvent(clientId, { progress: 45, message: `[${nickname}] Buscando detalhes de ${orderSummaries.length} vendas...`, type: 'info' });
    const allOrders = await mapWithConcurrency(orderSummaries, SLA_CONCURRENCY, async (order, index) => {
      try {
        const orderDetailsRes = await fetch(`https://api.mercadolibre.com/orders/${order.id}`, { headers: { Authorization: `Bearer ${access_token}` } });
        if (orderDetailsRes.ok) {
          const orderDetails = await orderDetailsRes.json();
          if (index > 0 && index % 10 === 0) {
            const pct = 45 + Math.floor(((index + 1) / orderSummaries.length) * 15);
            sendEvent(clientId, { progress: Math.min(60, pct), message: `[${nickname}] Detalhando... ${index + 1}/${orderSummaries.length}`, type: 'info' });
          }
          return orderDetails;
        }
        return order;
      } catch (e) {
        console.error(`Falha ao buscar detalhes do pedido ${order.id}:`, e);
        return order;
      }
    });

    sendEvent(clientId, { progress: 65, message: `[${nickname}] Enriquecendo dados de envio para ${allOrders.length} vendas...`, type: 'info' });
    const enrichedOrders = await mapWithConcurrency(allOrders, SLA_CONCURRENCY, async (order, index) => {
      const shipmentId = order?.shipping?.id;
      if (!shipmentId) return order;

      try {
        const shipmentRes = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, { headers: { Authorization: `Bearer ${access_token}` } });
        if (shipmentRes.ok) {
          const shipmentDetails = await safeJson(shipmentRes);
          if (shipmentDetails) order.shipping = { ...order.shipping, ...shipmentDetails };
        }

        const slaRes = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}/sla`, { headers: { Authorization: `Bearer ${access_token}` } });
        if (slaRes.ok) {
          const slaData = await safeJson(slaRes);
          if (slaData) order.sla_data = slaData;
        }

        if (index > 0 && index % 10 === 0) {
          const pct = 65 + Math.floor(((index + 1) / allOrders.length) * 20);
          sendEvent(clientId, { progress: Math.min(85, pct), message: `[${nickname}] Enriquecendo... ${index + 1}/${allOrders.length}`, type: 'info' });
        }

        return order;
      } catch (e) {
        console.error(`Falha ao enriquecer dados para envio ${shipmentId}:`, e);
        return order;
      }
    });

    const allRows = buildInsertBatchRows(enrichedOrders.filter(Boolean), targetUid, nickname);
    sendEvent(clientId, { progress: 85, message: `[${nickname}] Preparando ${allRows.length} itens para salvar...`, type: 'info' });

    const clientDb = await db.pool.connect();
    try {
      await clientDb.query('BEGIN');
      for (let i = 0; i < allRows.length; i += UPSERT_BATCH_SIZE) {
        const chunk = allRows.slice(i, i + UPSERT_BATCH_SIZE);

        const { query, params } = buildMultiInsertQuery_DoUpdate(chunk);
        await clientDb.query(query, params);

        const pct = 85 + Math.floor(((i + chunk.length) / allRows.length) * 15);
        if (i === 0 || i + UPSERT_BATCH_SIZE >= allRows.length || i % (UPSERT_BATCH_SIZE * 3) === 0) {
          sendEvent(clientId, { progress: Math.min(99, pct), message: `[${nickname}] Salvando lote... ${i + chunk.length}/${allRows.length}`, type: 'info' });
        }
      }
      await clientDb.query('COMMIT');
      sendEvent(clientId, { 
        progress: 100, 
        message: `[${nickname}] Sincronização concluída. ${allRows.length} itens processados.`, 
        type: 'success',
        newSalesCount: allRows.length
      });
    } catch (e) {
      await clientDb.query('ROLLBACK');
      throw e;
    } finally {
      clientDb.release();
    }
  } catch (error) {
    console.error(`[SYNC ERROR] Cliente ${clientId} | Conta ${nickname}:`, error);
    sendEvent(clientId, { progress: 100, message: `Erro em [${nickname}]: ${error.message}`, type: 'error' });
  } finally {
    if (clients[clientId]) {
      clients[clientId].res.end();
      delete clients[clientId];
    }
  }
});

// Endpoint para verificar a última sincronização de uma conta
router.get('/last-sync/:mlAccountId', authenticateToken, async (req, res) => {
  try {
    const { mlAccountId } = req.params;
    let targetUid = req.query.clientUid || req.user.uid;

    if (!mlAccountId) {
      return res.status(400).json({ error: 'ID da conta ML é obrigatório.' });
    }

    // Se MASTER e nenhum clientUid informado, descobrir automaticamente o dono da conta ML
    if (req.user.role === 'master' && !req.query.clientUid) {
      const owner = await db.query('SELECT uid FROM public.ml_accounts WHERE user_id = $1 LIMIT 1', [mlAccountId]);
      if (owner.rowCount > 0) {
        targetUid = owner.rows[0].uid;
      }
    }

    // Busca a última venda sincronizada para esta conta
    const lastSyncRes = await db.query(
      `SELECT MAX(sale_date) AS last_sale FROM public.sales WHERE uid = $1 AND seller_id = $2`,
      [targetUid, mlAccountId]
    );
 
    const lastSync = lastSyncRes.rows[0]?.last_sale;
    
    res.json({
      lastSync: lastSync ? lastSync.toISOString() : null,
      accountId: mlAccountId,
      message: lastSync ? 'Última sincronização encontrada' : 'Nunca sincronizada'
    });

  } catch (error) {
    console.error('Erro ao verificar última sincronização:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;