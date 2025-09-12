/**
 * Construtor de Queries de Cobrança Corrigidas - Backend
 * 
 * Implementação das queries corrigidas para o backend Node.js
 * Resolve o problema de itens aparecendo na cobrança do mês errado
 */

class BillingPeriodCalculator {
    calculatePeriod(year, month) {
        if (month < 1 || month > 12) {
            throw new Error('Mês deve estar entre 1 e 12');
        }
        
        const startDate = new Date(year, month - 1, 1, 0, 0, 0, 0);
        const endDate = new Date(year, month, 0, 23, 59, 59, 999);
        
        return {
            startDate,
            endDate,
            year,
            month,
            daysInMonth: endDate.getDate()
        };
    }
    
    toSQLFormat(period) {
        return {
            startDate: period.startDate.toISOString(),
            endDate: period.endDate.toISOString(),
            startDateLocal: period.startDate.toLocaleDateString('pt-BR'),
            endDateLocal: period.endDate.toLocaleDateString('pt-BR')
        };
    }
    
    formatPeriodDetailed(period) {
        const startFormatted = period.startDate.toLocaleDateString('pt-BR');
        const endFormatted = period.endDate.toLocaleDateString('pt-BR');
        return `${startFormatted} a ${endFormatted}`;
    }
}

class BillingQueryBuilder {
    constructor() {
        this.periodCalculator = new BillingPeriodCalculator();
    }

    /**
     * Query corrigida para vendas expedidas
     * Usa processed_at (data de expedição) ao invés de sale_date
     */
    buildSalesQuery(userId, year, month) {
        const period = this.periodCalculator.calculatePeriod(year, month);
        const sqlFormat = this.periodCalculator.toSQLFormat(period);

        const query = `
            SELECT 
                s.id,
                s.sku,
                s.uid,
                s.seller_id,
                s.channel,
                s.account_nickname,
                s.sale_date,
                s.product_title,
                s.quantity,
                s.shipping_mode,
                s.shipping_limit_date,
                s.packages,
                s.shipping_status,
                s.processed_at,
                -- Data de consumo para cobrança (prioridade: processed_at)
                COALESCE(s.processed_at, s.sale_date, s.updated_at) as consumption_date,
                -- Informações para cobrança
                pt.name as package_type_name,
                pt.price as package_type_price
            FROM public.sales s
            LEFT JOIN public.skus sk ON UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku)) AND sk.user_id = s.uid
            LEFT JOIN public.package_types pt ON sk.package_type_id = pt.id
            WHERE s.uid = $1
                AND s.processed_at IS NOT NULL  -- Apenas vendas processadas (expedidas)
                AND s.processed_at BETWEEN $2::timestamp AND $3::timestamp  -- Filtro de período CORRETO
            ORDER BY s.processed_at DESC, s.id DESC
        `;

        const params = [userId, sqlFormat.startDate, sqlFormat.endDate];

        return {
            query,
            params,
            period,
            description: `Vendas expedidas de ${this.periodCalculator.formatPeriodDetailed(period)}`
        };
    }

    /**
     * Query corrigida para armazenamento com cálculo proporcional
     */
    buildStorageQuery(userId, year, month) {
        const period = this.periodCalculator.calculatePeriod(year, month);
        const sqlFormat = this.periodCalculator.toSQLFormat(period);

        const query = `
            SELECT 
                uc.id,
                uc.uid,
                uc.service_id,
                uc.volume,
                uc.start_date,
                uc.end_date,
                s.name as service_name,
                s.type as service_type,
                s.price as service_price,
                -- Cálculo proporcional para mês de entrada
                CASE 
                    WHEN DATE_PART('year', uc.start_date) = $4 
                         AND DATE_PART('month', uc.start_date) = $5
                         AND DATE_PART('day', uc.start_date) > 1
                         AND s.type = 'base_storage'
                    THEN ROUND((s.price / 30.0) * (DATE_PART('day', DATE_TRUNC('month', uc.start_date) + INTERVAL '1 month' - INTERVAL '1 day') - DATE_PART('day', uc.start_date) + 1), 2)
                    ELSE s.price * COALESCE(uc.volume, 1)
                END as calculated_price,
                -- Descrição com detalhes do cálculo
                CASE 
                    WHEN DATE_PART('year', uc.start_date) = $4 
                         AND DATE_PART('month', uc.start_date) = $5
                         AND DATE_PART('day', uc.start_date) > 1
                         AND s.type = 'base_storage'
                    THEN CONCAT(s.name, ' - Proporcional ', 
                               (DATE_PART('day', DATE_TRUNC('month', uc.start_date) + INTERVAL '1 month' - INTERVAL '1 day') - DATE_PART('day', uc.start_date) + 1)::int,
                               ' dias (entrada dia ', DATE_PART('day', uc.start_date)::int, ')')
                    ELSE s.name
                END as description,
                -- Data de consumo para armazenamento
                CASE 
                    WHEN uc.start_date <= $2::date THEN $2::date
                    ELSE uc.start_date
                END as consumption_date
            FROM public.user_contracts uc
            JOIN public.services s ON uc.service_id = s.id
            WHERE uc.uid = $1
                AND s.type IN ('base_storage', 'additional_storage')
                AND uc.start_date <= $3::date
                AND (uc.end_date IS NULL OR uc.end_date >= $2::date)
            ORDER BY uc.start_date DESC
        `;

        const params = [
            userId, 
            sqlFormat.startDateLocal, 
            sqlFormat.endDateLocal,
            year,
            month
        ];

        return {
            query,
            params,
            period,
            description: `Armazenamento de ${this.periodCalculator.formatPeriodDetailed(period)}`
        };
    }

    /**
     * Query corrigida para serviços avulsos
     */
    buildServicesQuery(userId, year, month) {
        const period = this.periodCalculator.calculatePeriod(year, month);
        const sqlFormat = this.periodCalculator.toSQLFormat(period);

        const query = `
            SELECT 
                ii.id,
                ii.invoice_id,
                ii.description,
                ii.quantity,
                ii.unit_price,
                ii.total_price,
                ii.service_date,
                ii.type,
                i.uid,
                i.period,
                -- Data de consumo para serviços (prioridade: service_date)
                COALESCE(ii.service_date::timestamp, i.due_date, i.created_at) as consumption_date
            FROM public.invoice_items ii
            JOIN public.invoices i ON ii.invoice_id = i.id
            WHERE i.uid = $1
                AND ii.type = 'manual'  -- Apenas serviços manuais/avulsos
                AND (
                    -- Usar service_date se disponível (CORRETO)
                    (ii.service_date IS NOT NULL 
                     AND ii.service_date BETWEEN $2::date AND $3::date)
                    OR
                    -- Fallback para data de vencimento da fatura
                    (ii.service_date IS NULL 
                     AND i.due_date BETWEEN $4::timestamp AND $5::timestamp)
                )
            ORDER BY consumption_date DESC, ii.id DESC
        `;

        const params = [
            userId, 
            sqlFormat.startDateLocal, 
            sqlFormat.endDateLocal,
            sqlFormat.startDate,
            sqlFormat.endDate
        ];

        return {
            query,
            params,
            period,
            description: `Serviços avulsos de ${this.periodCalculator.formatPeriodDetailed(period)}`
        };
    }

    /**
     * Função principal que substitui calculateAndSaveInvoice
     * Implementa a lógica corrigida de cobrança
     */
    async calculateAndSaveInvoiceFixed(client, uid, period) {
        const [year, month] = period.split('-').map(Number);
        
        console.log(`[BILLING-FIX] Calculando cobrança corrigida para ${uid}, período ${period}`);
        
        // 1. Calcular período exato
        const periodData = this.periodCalculator.calculatePeriod(year, month);
        console.log(`[BILLING-FIX] Período: ${this.periodCalculator.formatPeriodDetailed(periodData)}`);

        // 2. Buscar preços master dos serviços
        const masterPricesRes = await client.query(`
            SELECT type, price
            FROM public.services
            WHERE type IN ('base_storage', 'additional_storage');
        `);
        const masterPrices = masterPricesRes.rows.reduce((acc, s) => {
            acc[s.type] = parseFloat(s.price);
            return acc;
        }, {});

        let autoItems = [];
        let autoTotal = 0;

        // 3. Armazenamento com cálculo proporcional correto
        const storageQuery = this.buildStorageQuery(uid, year, month);
        const storageRes = await client.query(storageQuery.query, storageQuery.params);
        
        console.log(`[BILLING-FIX] Encontrados ${storageRes.rows.length} itens de armazenamento`);
        
        for (const storage of storageRes.rows) {
            const item = {
                description: storage.description,
                quantity: storage.service_type === 'additional_storage' ? storage.volume : 1,
                unit_price: storage.calculated_price,
                total_price: storage.calculated_price,
                type: 'storage'
            };
            autoItems.push(item);
            autoTotal += storage.calculated_price;
            
            console.log(`[BILLING-FIX] Armazenamento: ${item.description} - R$ ${item.total_price}`);
        }

        // 4. Vendas expedidas com filtro de período correto
        const salesQuery = this.buildSalesQuery(uid, year, month);
        const salesRes = await client.query(salesQuery.query, salesQuery.params);
        
        console.log(`[BILLING-FIX] Encontradas ${salesRes.rows.length} vendas expedidas no período correto`);

        // Agrupar vendas por tipo de pacote
        const shipmentSummary = salesRes.rows.reduce((acc, sale) => {
            if (sale.package_type_name && sale.package_type_price) {
                const key = sale.package_type_name;
                if (!acc[key]) {
                    acc[key] = { 
                        quantity: 0, 
                        price: parseFloat(sale.package_type_price) 
                    };
                }
                acc[key].quantity += parseInt(sale.quantity) || 1;
            }
            return acc;
        }, {});

        for (const [description, data] of Object.entries(shipmentSummary)) {
            if (data.quantity > 0) {
                const total = data.quantity * data.price;
                const item = {
                    description,
                    quantity: data.quantity,
                    unit_price: data.price,
                    total_price: total,
                    type: 'shipment'
                };
                autoItems.push(item);
                autoTotal += total;
                
                console.log(`[BILLING-FIX] Expedição: ${description} x${data.quantity} - R$ ${total}`);
            }
        }

        // 5. Upsert da fatura
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

        // 6. Remove SOMENTE itens automáticos e recria
        await client.query(
            `DELETE FROM public.invoice_items WHERE invoice_id = $1 AND type IN ('storage','shipment');`,
            [invoiceId]
        );

        // 7. Insere novos itens automáticos
        if (autoItems.length) {
            for (const item of autoItems) {
                await client.query(`
                    INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price, total_price, type)
                    VALUES ($1, $2, $3, $4, $5, $6);
                `, [invoiceId, item.description, item.quantity, item.unit_price, item.total_price, item.type]);
            }
        }

        // 8. Recalcula total: automáticos + manuais
        const manualSumRes = await client.query(`
            SELECT COALESCE(SUM(total_price), 0) AS sum
            FROM public.invoice_items
            WHERE invoice_id = $1 AND type = 'manual';
        `, [invoiceId]);

        const newTotal = autoTotal + parseFloat(manualSumRes.rows[0].sum || 0);
        await client.query(`UPDATE public.invoices SET total_amount = $1 WHERE id = $2;`, [newTotal, invoiceId]);

        console.log(`[BILLING-FIX] Cobrança calculada: R$ ${newTotal} (${autoItems.length} itens automáticos)`);
        
        return {
            invoiceId,
            autoItems,
            autoTotal,
            newTotal,
            period: periodData
        };
    }

    /**
     * Query de debug para comparar sistema antigo vs novo
     */
    buildComparisonQuery(userId, year, month) {
        const period = this.periodCalculator.calculatePeriod(year, month);
        const sqlFormat = this.periodCalculator.toSQLFormat(period);

        const query = `
            WITH old_system AS (
                -- Sistema antigo (problemático): usa sale_date
                SELECT 
                    COUNT(*) as total_items,
                    SUM(s.quantity * COALESCE(pt.price, 0)) as total_amount,
                    'old_system' as system_type
                FROM public.sales s
                LEFT JOIN public.skus sk ON UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku)) AND sk.user_id = s.uid
                LEFT JOIN public.package_types pt ON sk.package_type_id = pt.id
                WHERE s.uid = $1
                    AND s.processed_at IS NOT NULL
                    AND s.sale_date BETWEEN $2::timestamp AND $3::timestamp  -- PROBLEMA: usa sale_date
            ),
            new_system AS (
                -- Sistema novo (corrigido): usa processed_at
                SELECT 
                    COUNT(*) as total_items,
                    SUM(s.quantity * COALESCE(pt.price, 0)) as total_amount,
                    'new_system' as system_type
                FROM public.sales s
                LEFT JOIN public.skus sk ON UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku)) AND sk.user_id = s.uid
                LEFT JOIN public.package_types pt ON sk.package_type_id = pt.id
                WHERE s.uid = $1
                    AND s.processed_at IS NOT NULL
                    AND s.processed_at BETWEEN $2::timestamp AND $3::timestamp  -- CORRETO: usa processed_at
            )
            SELECT * FROM old_system
            UNION ALL
            SELECT * FROM new_system
        `;

        const params = [userId, sqlFormat.startDate, sqlFormat.endDate];

        return {
            query,
            params,
            period,
            description: `Comparação de sistemas para ${this.periodCalculator.formatPeriodDetailed(period)}`
        };
    }
}

module.exports = {
    BillingQueryBuilder,
    BillingPeriodCalculator
};