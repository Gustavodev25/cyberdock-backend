const express = require('express');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');

const router = express.Router();

async function calculateAndSaveInvoice(client, uid, period) {
    const [year, month] = period.split('-').map(Number);
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, -1));

    let totalAmount = 0;
    const items = [];

    const masterPricesQuery = `SELECT type, price FROM public.services WHERE type IN ('base_storage', 'additional_storage');`;
    const masterPricesResult = await client.query(masterPricesQuery);
    const masterPrices = masterPricesResult.rows.reduce((acc, service) => {
        acc[service.type] = parseFloat(service.price);
        return acc;
    }, {});

    const masterBasePrice = masterPrices['base_storage'] || 0;
    const masterAdditionalPrice = masterPrices['additional_storage'] || 0;

    const contractsQuery = `
        SELECT s.type, uc.volume
        FROM public.user_contracts uc
        JOIN public.services s ON uc.service_id = s.id
        WHERE uc.uid = $1 AND s.type IN ('base_storage', 'additional_storage');
    `;
    const contractsResult = await client.query(contractsQuery, [uid]);

    const baseService = contractsResult.rows.find(c => c.type === 'base_storage');
    if (baseService) {
        items.push({ description: 'Armazenamento Base (até 1m³)', quantity: 1, unit_price: masterBasePrice, total_price: masterBasePrice, type: 'storage' });
        totalAmount += masterBasePrice;
    }

    const additionalService = contractsResult.rows.find(c => c.type === 'additional_storage');
    if (additionalService) {
        const quantity = parseInt(additionalService.volume, 10) || 0;
        if (quantity > 0) {
            const total = masterAdditionalPrice * quantity;
            items.push({ description: 'Armazenamento Adicional (m³)', quantity, unit_price: masterAdditionalPrice, total_price: total, type: 'storage' });
            totalAmount += total;
        }
    }

    const shipmentsQuery = `
        SELECT sm.quantity_change, pt.name as package_type_name, pt.price as package_type_price
        FROM public.stock_movements sm
        JOIN public.skus s ON sm.sku_id = s.id
        LEFT JOIN public.package_types pt ON s.package_type_id = pt.id
        WHERE sm.user_id = $1
          AND sm.movement_type = 'saida'
          AND sm.reason LIKE 'Saída por Venda%'
          AND sm.created_at BETWEEN $2 AND $3;
    `;
    const shipmentsResult = await client.query(shipmentsQuery, [uid, startDate, endDate]);
    
    const shipmentSummary = shipmentsResult.rows.reduce((acc, shipment) => {
        if (shipment.package_type_name && shipment.package_type_price) {
            const type = shipment.package_type_name;
            if (!acc[type]) {
                acc[type] = { quantity: 0, price: parseFloat(shipment.package_type_price) };
            }
            acc[type].quantity += shipment.quantity_change;
        }
        return acc;
    }, {});

    for (const [description, data] of Object.entries(shipmentSummary)) {
        if (data.quantity > 0) {
            const total = data.quantity * data.price;
            items.push({ description, quantity: data.quantity, unit_price: data.price, total_price: total, type: 'shipment' });
            totalAmount += total;
        }
    }

    const dueDate = new Date(Date.UTC(year, month, 5));
    
    const upsertInvoiceQuery = `
        INSERT INTO public.invoices (uid, period, due_date, total_amount, status)
        VALUES ($1, $2, $3, $4, 'pending')
        ON CONFLICT (uid, period) DO UPDATE SET
            due_date = EXCLUDED.due_date,
            total_amount = EXCLUDED.total_amount,
            status = 'pending'
        RETURNING id;
    `;
    const invoiceRes = await client.query(upsertInvoiceQuery, [uid, period, dueDate, totalAmount]);
    const invoiceId = invoiceRes.rows[0].id;

    await client.query('DELETE FROM public.invoice_items WHERE invoice_id = $1', [invoiceId]);

    if (items.length > 0) {
        for (const item of items) {
            const insertItemQuery = `
                INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price, total_price, type)
                VALUES ($1, $2, $3, $4, $5, $6);
            `;
            await client.query(insertItemQuery, [invoiceId, item.description, item.quantity, item.unit_price, item.total_price, item.type]);
        }
    }
}

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

        const query = `
            SELECT i.id, i.uid, i.period, i.due_date, i.payment_date, i.total_amount, i.status,
                   COALESCE(json_agg(json_build_object(
                       'description', it.description,
                       'quantity', it.quantity,
                       'unit_price', it.unit_price,
                       'total_price', it.total_price,
                       'type', it.type
                   )) FILTER (WHERE it.id IS NOT NULL), '[]') as items
            FROM public.invoices i
            LEFT JOIN public.invoice_items it ON i.id = it.invoice_id
            WHERE i.uid = $1
            GROUP BY i.id
            ORDER BY i.period DESC;
        `;
        const { rows: invoices } = await client.query(query, [uid]);

        await client.query('COMMIT');
        res.json(invoices);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao buscar/gerar faturas:', error);
        res.status(500).json({ error: 'Erro interno ao processar faturas.' });
    } finally {
        client.release();
    }
});

router.get('/summary', authenticateToken, requireMaster, async (req, res) => {
    try {
        const query = `
            SELECT 
                u.uid,
                u.email,
                (SELECT i.total_amount 
                 FROM public.invoices i 
                 WHERE i.uid = u.uid 
                 ORDER BY i.period DESC 
                 LIMIT 1) as last_invoice_total,
                (SELECT i.status 
                 FROM public.invoices i 
                 WHERE i.uid = u.uid 
                 ORDER BY i.period DESC 
                 LIMIT 1) as last_invoice_status,
                (SELECT i.period 
                 FROM public.invoices i 
                 WHERE i.uid = u.uid 
                 ORDER BY i.period DESC 
                 LIMIT 1) as last_invoice_period
            FROM public.users u
            WHERE u.role = 'cliente'
            ORDER BY u.email;
        `;
        const { rows } = await db.query(query);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar resumo de faturamento:', error);
        res.status(500).json({ error: 'Erro interno ao buscar resumo de faturamento.' });
    }
});

module.exports = router;
