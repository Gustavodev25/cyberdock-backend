const express = require('express');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');
const fetch = require('node-fetch');

const router = express.Router();

// Armazena os clientes conectados para as atualizações de status via SSE
const clients = {};

// Função para enviar eventos (SSE) para um cliente específico
const sendEvent = (clientId, data) => {
    if (clients[clientId]) {
        clients[clientId].res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
};


/**
 * @route   GET /api/sales/sync-status/:clientId
 * @desc    Endpoint para Server-Sent Events (SSE) que reporta o status da sincronização.
 * @access  Private (implicitamente, pois o clientId é único)
 */
router.get('/sync-status/:clientId', (req, res) => {
    const { clientId } = req.params;
    
    // Configura os headers para a conexão SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
    });

    // Armazena a resposta do cliente para poder enviar eventos futuros
    clients[clientId] = { res };
    console.log(`[SSE] Cliente ${clientId} conectado.`);

    // Envia uma mensagem inicial de conexão estabelecida
    sendEvent(clientId, { progress: 5, message: 'Conexão de status estabelecida. Aguardando início...', type: 'info' });

    // Quando o cliente fecha a conexão, removemos ele da lista
    req.on('close', () => {
        console.log(`[SSE] Cliente ${clientId} desconectado.`);
        delete clients[clientId];
    });
});


/**
 * @route   GET /api/sales/user/:uid
 * @desc    Busca todas as vendas de um usuário específico.
 * @access  Private (Apenas Master)
 */
router.get('/user/:uid', authenticateToken, requireMaster, async (req, res) => {
    const { uid } = req.params;

    if (!uid) {
        return res.status(400).json({ error: 'O UID do usuário é obrigatório.' });
    }

    try {
        const query = `
            SELECT 
                id, sku, uid, seller_id, channel, account_nickname, sale_date, 
                product_title, quantity, shipping_mode, shipping_limit_date, 
                packages, shipping_status, raw_api_data, updated_at, processed_at
            FROM public.sales
            WHERE uid = $1
            ORDER BY sale_date DESC;
        `;
        const { rows } = await db.query(query, [uid]);
        res.json(rows);
    } catch (error) {
        console.error(`Erro ao buscar vendas para o usuário ${uid}:`, error);
        res.status(500).json({ error: 'Erro interno do servidor ao buscar as vendas.' });
    }
});

/**
 * @route   GET /api/sales/my-sales
 * @desc    Busca todas as vendas do usuário logado.
 * @access  Private (Qualquer usuário autenticado)
 */
router.get('/my-sales', authenticateToken, async (req, res) => {
    const { uid } = req.user; // UID vem do token de autenticação
    try {
        const query = `
            SELECT 
                id, sku, uid, seller_id, channel, account_nickname, sale_date, 
                product_title, quantity, shipping_mode, shipping_limit_date, 
                packages, shipping_status, raw_api_data, updated_at, processed_at
            FROM public.sales
            WHERE uid = $1
            ORDER BY sale_date DESC;
        `;
        const { rows } = await db.query(query, [uid]);
        res.json(rows);
    } catch (error) {
        console.error(`Erro ao buscar vendas para o usuário ${uid}:`, error);
        res.status(500).json({ error: 'Erro interno do servidor ao buscar as vendas.' });
    }
});

/**
 * @route   PUT /api/sales/status
 * @desc    Atualiza o status de uma venda específica.
 * @access  Private (Apenas Master)
 */
router.put('/status', authenticateToken, requireMaster, async (req, res) => {
    const { saleId, sku, uid, shippingStatus } = req.body;

    if (!saleId || !sku || !uid || !shippingStatus) {
        return res.status(400).json({ error: 'Dados incompletos para atualizar o status da venda.' });
    }
    
    // --- LÓGICA DE BAIXA DE ESTOQUE ADICIONADA AQUI ---
    if (shippingStatus === 'custom_06_despachado') {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');

            const saleQuery = 'SELECT quantity, processed_at FROM public.sales WHERE id = $1 AND sku = $2 AND uid = $3';
            const saleResult = await client.query(saleQuery, [saleId, sku, uid]);

            if (saleResult.rowCount === 0) throw new Error('Venda não encontrada.');
            if (saleResult.rows[0].processed_at) throw new Error('Venda já processada anteriormente.');

            const quantitySold = saleResult.rows[0].quantity;

            const skuQuery = 'SELECT id, quantidade FROM public.skus WHERE sku = $1 AND user_id = $2 FOR UPDATE';
            const skuResult = await client.query(skuQuery, [sku, uid]);

            if (skuResult.rowCount === 0) throw new Error(`SKU '${sku}' não encontrado no armazenamento.`);
            
            const stockItem = skuResult.rows[0];
            if (stockItem.quantidade < quantitySold) throw new Error(`Estoque insuficiente para SKU '${sku}'. Necessário: ${quantitySold}, Disponível: ${stockItem.quantidade}.`);

            await client.query('UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2', [quantitySold, stockItem.id]);
            
            const movementReason = `Saída por Venda - ID: ${saleId}`;
            await client.query('INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id) VALUES ($1, $2, \'saida\', $3, $4, $5)', [stockItem.id, uid, quantitySold, movementReason, saleId]);

            const updateSaleQuery = 'UPDATE public.sales SET shipping_status = $1, processed_at = NOW(), updated_at = NOW() WHERE id = $2 AND sku = $3 AND uid = $4 RETURNING id, shipping_status;';
            const { rows } = await client.query(updateSaleQuery, [shippingStatus, saleId, sku, uid]);

            await client.query('COMMIT');
            res.json({ message: 'Status atualizado e estoque abatido com sucesso.', sale: rows[0] });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Erro ao processar despacho da venda:', error);
            res.status(400).json({ error: error.message || 'Erro interno ao processar despacho.' });
        } finally {
            client.release();
        }
    } else {
        // Comportamento original para outros status
        try {
            const query = `
                UPDATE public.sales
                SET shipping_status = $1, updated_at = NOW()
                WHERE id = $2 AND sku = $3 AND uid = $4
                RETURNING id, shipping_status;
            `;
            const { rows, rowCount } = await db.query(query, [shippingStatus, saleId, sku, uid]);

            if (rowCount === 0) {
                return res.status(404).json({ error: 'Venda não encontrada ou não pertence ao usuário especificado.' });
            }

            res.json({ message: 'Status da venda atualizado com sucesso.', sale: rows[0] });
        } catch (error) {
            console.error('Erro ao atualizar status da venda:', error);
            res.status(500).json({ error: 'Erro interno do servidor.' });
        }
    }
});

/**
 * @route   POST /api/sales/process
 * @desc    Processa uma lista de vendas em lote, com baixa de estoque.
 * @access  Private (Apenas Master)
 */
router.post('/process', authenticateToken, requireMaster, async (req, res) => {
    const { salesToProcess } = req.body;

    if (!Array.isArray(salesToProcess) || salesToProcess.length === 0) {
        return res.status(400).json({ error: 'Nenhuma venda para processar.' });
    }

    const results = { success: [], failed: [] };
    const client = await db.pool.connect();
    
    try {
        // --- LÓGICA DE BAIXA DE ESTOQUE ADICIONADA AQUI ---
        await client.query('BEGIN');

        for (const sale of salesToProcess) {
            try {
                if (sale.processed_at) {
                    results.failed.push({ saleId: sale.id, sku: sale.sku, reason: 'Venda já processada anteriormente.' });
                    continue;
                }

                const skuQuery = 'SELECT id, quantidade FROM public.skus WHERE sku = $1 AND user_id = $2 FOR UPDATE';
                const skuResult = await client.query(skuQuery, [sale.sku, sale.uid]);

                if (skuResult.rowCount === 0) {
                    throw new Error(`SKU '${sale.sku}' não encontrado no armazenamento.`);
                }

                const stockItem = skuResult.rows[0];
                if (stockItem.quantidade < sale.quantity) {
                    throw new Error(`Estoque insuficiente para SKU '${sale.sku}'. Necessário: ${sale.quantity}, Disponível: ${stockItem.quantidade}.`);
                }

                await client.query('UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2', [sale.quantity, stockItem.id]);
                
                const movementReason = `Saída por Venda em Lote - ID: ${sale.id}`;
                await client.query('INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id) VALUES ($1, $2, \'saida\', $3, $4, $5)', [stockItem.id, sale.uid, sale.quantity, movementReason, sale.id]);
                
                const updateSaleQuery = 'UPDATE public.sales SET processed_at = NOW(), updated_at = NOW() WHERE id = $1 AND sku = $2 AND uid = $3 AND processed_at IS NULL RETURNING id;';
                const { rowCount } = await client.query(updateSaleQuery, [sale.id, sale.sku, sale.uid]);
                
                if (rowCount > 0) {
                    results.success.push({ saleId: sale.id, sku: sale.sku });
                } else {
                    throw new Error('Venda não pôde ser atualizada (pode já ter sido processada em outra sessão).');
                }
            } catch (e) {
                results.failed.push({ saleId: sale.id, sku: sale.sku, reason: e.message });
            }
        }

        // Se houver qualquer falha, reverte tudo. Senão, commita.
        if (results.failed.length > 0) {
            await client.query('ROLLBACK');
            res.status(400).json({ message: 'Processamento em lote falhou. Nenhuma alteração foi salva.', ...results });
        } else {
            await client.query('COMMIT');
            res.json({ message: 'Lote processado com sucesso.', ...results });
        }

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Erro no processamento em lote de vendas:", error);
        res.status(500).json({ error: 'Erro crítico no processamento em lote.' });
    } finally {
        client.release();
    }
});


/**
 * @route   POST /api/sales/sync-account
 * @desc    Sincroniza as vendas de uma conta específica do Mercado Livre.
 * @access  Private (Qualquer usuário autenticado)
 */
router.post('/sync-account', authenticateToken, async (req, res) => {
    const { userId, accountNickname: nickname, clientId } = req.body;
    const requesterUid = req.user.uid;

    if (!userId || !clientId) {
        return res.status(400).json({ error: 'O ID de usuário (userId) e o ID de cliente (clientId) são obrigatórios.' });
    }

    res.status(202).json({ message: 'Sincronização iniciada. Acompanhe o status.' });

    try {
        sendEvent(clientId, { progress: 10, message: 'Buscando credenciais da conta...', type: 'info' });
        const accountQuery = `SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1 AND uid = $2`;
        const accountRes = await db.query(accountQuery, [userId, requesterUid]);

        if (accountRes.rowCount === 0) {
            throw new Error('Conta do Mercado Livre não encontrada ou não pertence a este usuário.');
        }
        let { access_token, refresh_token } = accountRes.rows[0];

        let allOrders = [];
        let offset = 0;
        const limit = 50;

        sendEvent(clientId, { progress: 20, message: 'Buscando histórico de vendas no Mercado Livre...', type: 'info' });

        while (true) {
            const ordersUrl = `https://api.mercadolibre.com/orders/search?seller=${userId}&offset=${offset}&limit=${limit}&sort=date_desc`;
            let ordersResponse = await fetch(ordersUrl, {
                headers: { 'Authorization': `Bearer ${access_token}` }
            });

            if (ordersResponse.status === 401) {
                sendEvent(clientId, { progress: 30, message: `Token expirado. Tentando atualizar...`, type: 'info' });
                const CLIENT_ID = process.env.ML_CLIENT_ID;
                const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
                const refreshResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refresh_token,
                    }),
                });

                if (!refreshResponse.ok) {
                    await db.query("UPDATE public.ml_accounts SET status = 'reconnect_needed' WHERE user_id = $1 AND uid = $2", [userId, requesterUid]);
                    throw new Error('Falha ao atualizar token. Por favor, reconecte a conta.');
                }

                const newTokenData = await refreshResponse.json();
                access_token = newTokenData.access_token;
                await db.query(
                    "UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = 'active', updated_at = NOW() WHERE user_id = $4 AND uid = $5",
                    [newTokenData.access_token, newTokenData.refresh_token, newTokenData.expires_in, userId, requesterUid]
                );
                
                sendEvent(clientId, { progress: 40, message: 'Token atualizado! Continuando busca...', type: 'info' });
                ordersResponse = await fetch(ordersUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
            }

            if (!ordersResponse.ok) {
                const errorBody = await ordersResponse.json();
                throw new Error(`Erro ao buscar vendas do ML: ${errorBody.message}`);
            }

            const pageData = await ordersResponse.json();
            if (pageData.results.length > 0) {
                allOrders.push(...pageData.results);
                offset += limit;
                sendEvent(clientId, { progress: 45, message: `Encontradas ${allOrders.length} vendas até agora...`, type: 'info' });
            } else {
                break;
            }
        }

        if (allOrders.length === 0) {
            sendEvent(clientId, { progress: 100, message: 'Nenhuma venda encontrada no histórico da conta.', type: 'success' });
            return;
        }

        sendEvent(clientId, { progress: 60, message: `Total de ${allOrders.length} vendas encontradas. Processando e salvando...`, type: 'info' });
        const clientDb = await db.pool.connect();
        let upsertedCount = 0;
        try {
            await clientDb.query('BEGIN');
            for (const [index, order] of allOrders.entries()) {
                let slaData = null;
                if (order.shipping && order.shipping.id) {
                    try {
                        const slaResponse = await fetch(`https://api.mercadolibre.com/shipments/${order.shipping.id}/sla`, {
                            headers: { 'Authorization': `Bearer ${access_token}` }
                        });
                        if (slaResponse.ok) {
                            slaData = await slaResponse.json();
                            order.sla_data = slaData;
                        }
                    } catch (slaError) {
                        console.error(`Falha ao buscar SLA para o shipment ${order.shipping.id}:`, slaError.message);
                    }
                }

                for (const item of order.order_items) {
                    if (!item.item.seller_sku) continue;

                    const upsertQuery = `
                        INSERT INTO public.sales (
                            id, sku, uid, seller_id, channel, account_nickname, sale_date,
                            product_title, quantity, shipping_mode, shipping_limit_date,
                            packages, shipping_status, raw_api_data, updated_at
                        ) VALUES ($1, $2, $3, $4, 'ML', $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
                        ON CONFLICT (id, sku, uid) DO UPDATE SET
                            shipping_status = EXCLUDED.shipping_status,
                            shipping_limit_date = EXCLUDED.shipping_limit_date,
                            raw_api_data = EXCLUDED.raw_api_data,
                            updated_at = NOW();
                    `;
                    
                    const finalShippingLimitDate = slaData?.shipping_limit_date || order.shipping.shipping_option?.estimated_delivery_time?.shipping_limit_date || null;

                    const result = await clientDb.query(upsertQuery, [
                        order.id, item.item.seller_sku, requesterUid, order.seller.id, nickname, order.date_created,
                        item.item.title, item.quantity, order.shipping.shipping_mode,
                        finalShippingLimitDate,
                        order.pack_id ? 1 : 0, order.shipping.status, order
                    ]);
                    if (result.rowCount > 0) upsertedCount++;
                }
                const currentProgress = 60 + Math.round(((index + 1) / allOrders.length) * 40);
                sendEvent(clientId, { progress: currentProgress, message: `Processando venda ${index + 1} de ${allOrders.length}...`, type: 'info' });
            }
            await clientDb.query('COMMIT');
            sendEvent(clientId, { progress: 100, message: `Sincronização concluída. ${upsertedCount} vendas foram inseridas/atualizadas.`, type: 'success' });
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
