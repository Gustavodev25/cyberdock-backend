/**
 * Migração para Correção de Períodos de Cobrança
 * 
 * Este script recalcula todas as faturas existentes usando a nova lógica
 * de filtro de período correto, garantindo que itens sejam cobrados no
 * mês correto baseado na data de consumo/execução, não na data de lançamento.
 */

const db = require('../utils/postgres');
const { BillingQueryBuilder } = require('../utils/billingQueryBuilder');

class BillingPeriodMigration {
    constructor() {
        this.billingQueryBuilder = new BillingQueryBuilder();
        this.processedUsers = 0;
        this.processedInvoices = 0;
        this.errors = [];
        this.startTime = new Date();
    }

    /**
     * Executa a migração completa
     */
    async run() {
        console.log('🚀 Iniciando migração de correção de períodos de cobrança...');
        console.log(`⏰ Início: ${this.startTime.toLocaleString('pt-BR')}`);
        
        const client = await db.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // 1. Buscar todos os usuários com faturas
            const users = await this.getUsersWithInvoices(client);
            console.log(`👥 Encontrados ${users.length} usuários com faturas`);
            
            // 2. Processar cada usuário
            for (const user of users) {
                await this.processUser(client, user);
            }
            
            await client.query('COMMIT');
            
            // 3. Relatório final
            this.generateFinalReport();
            
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('❌ Erro durante a migração:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Busca todos os usuários que possuem faturas
     */
    async getUsersWithInvoices(client) {
        const query = `
            SELECT DISTINCT 
                i.uid,
                u.email,
                u.name,
                COUNT(i.id) as total_invoices,
                MIN(i.period) as first_period,
                MAX(i.period) as last_period
            FROM public.invoices i
            JOIN public.users u ON i.uid = u.uid
            WHERE u.role = 'cliente'
            GROUP BY i.uid, u.email, u.name
            ORDER BY u.email
        `;
        
        const result = await client.query(query);
        return result.rows;
    }

    /**
     * Processa um usuário específico
     */
    async processUser(client, user) {
        console.log(`\n📋 Processando usuário: ${user.email} (${user.total_invoices} faturas)`);
        
        try {
            // Buscar todos os períodos de fatura deste usuário
            const periods = await this.getUserPeriods(client, user.uid);
            
            for (const period of periods) {
                await this.recalculateInvoiceForPeriod(client, user.uid, period, user.email);
            }
            
            this.processedUsers++;
            console.log(`✅ Usuário ${user.email} processado com sucesso`);
            
        } catch (error) {
            console.error(`❌ Erro ao processar usuário ${user.email}:`, error.message);
            this.errors.push({
                user: user.email,
                error: error.message,
                timestamp: new Date()
            });
        }
    }

    /**
     * Busca todos os períodos de fatura de um usuário
     */
    async getUserPeriods(client, uid) {
        const query = `
            SELECT DISTINCT period
            FROM public.invoices
            WHERE uid = $1
            ORDER BY period DESC
        `;
        
        const result = await client.query(query, [uid]);
        return result.rows.map(row => row.period);
    }

    /**
     * Função original de cálculo de fatura (copiada do billing.js)
     */
    async calculateAndSaveInvoiceOriginal(client, uid, period) {
        const [year, month] = period.split('-').map(Number);
        const startDate = new Date(Date.UTC(year, month - 1, 1));
        const endDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, -1));

        // === 1) Preços "master" dos serviços de armazenamento ===
        const masterPricesRes = await client.query(`
            SELECT type, price
            FROM public.services
            WHERE type IN ('base_storage', 'additional_storage');
        `);
        const masterPrices = masterPricesRes.rows.reduce((acc, s) => {
            acc[s.type] = parseFloat(s.price);
            return acc;
        }, {});
        const masterBasePrice = masterPrices['base_storage'] || 0;
        const masterAdditionalPrice = masterPrices['additional_storage'] || 0;

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
            autoItems.push({
                description: 'Armazenamento Base (até 1m³)',
                quantity: 1,
                unit_price: masterBasePrice,
                total_price: masterBasePrice,
                type: 'storage'
            });
            autoTotal += masterBasePrice;
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

        // === 3) Expedições por período (QUERY CORRIGIDA) ===
        console.log(`[BILLING-FIX] Buscando expedições para ${uid}, período ${period}`);
        
        // Usar query corrigida que filtra por processed_at ao invés de created_at
        const salesQuery = this.billingQueryBuilder.buildSalesQuery(uid, year, month);
        const shipmentsRes = await client.query(salesQuery.query, salesQuery.params);
        
        console.log(`[BILLING-FIX] Encontradas ${shipmentsRes.rows.length} vendas expedidas no período correto`);

        const shipmentSummary = shipmentsRes.rows.reduce((acc, sale) => {
            if (sale.package_type_name && sale.package_type_price) {
                const key = sale.package_type_name;
                if (!acc[key]) acc[key] = { quantity: 0, price: parseFloat(sale.package_type_price) };
                acc[key].quantity += parseInt(sale.quantity) || 1;
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

        return { newTotal, autoItems, invoiceId };
    }

    /**
     * Recalcula uma fatura específica usando a nova lógica
     */
    async recalculateInvoiceForPeriod(client, uid, period, userEmail) {
        console.log(`  🔄 Recalculando período ${period}...`);
        
        try {
            // Backup da fatura original
            await this.backupOriginalInvoice(client, uid, period);
            
            // Usar a função existente que já funciona
            await this.calculateAndSaveInvoiceOriginal(client, uid, period);
            
            const result = {
                newTotal: 0,
                autoItems: [],
                period: this.billingQueryBuilder.periodCalculator.calculatePeriod(...period.split('-').map(Number))
            };
            
            console.log(`    ✅ ${period}: R$ ${result.newTotal} (${result.autoItems.length} itens)`);
            this.processedInvoices++;
            
            // Log das diferenças encontradas
            await this.logInvoiceChanges(client, uid, period, result);
            
        } catch (error) {
            console.error(`    ❌ Erro no período ${period}:`, error.message);
            this.errors.push({
                user: userEmail,
                period: period,
                error: error.message,
                timestamp: new Date()
            });
        }
    }

    /**
     * Faz backup da fatura original antes da migração
     */
    async backupOriginalInvoice(client, uid, period) {
        // Criar tabela de backup se não existir
        await client.query(`
            CREATE TABLE IF NOT EXISTS public.invoices_backup_migration (
                id SERIAL PRIMARY KEY,
                original_invoice_id INTEGER,
                uid TEXT,
                period TEXT,
                original_total_amount DECIMAL(10,2),
                original_items JSONB,
                backup_timestamp TIMESTAMP DEFAULT NOW(),
                migration_version TEXT DEFAULT 'billing-period-fix-v1'
            )
        `);

        // Buscar fatura original
        const invoiceQuery = `
            SELECT i.id, i.total_amount,
                   COALESCE(json_agg(json_build_object(
                       'id', ii.id,
                       'description', ii.description,
                       'quantity', ii.quantity,
                       'unit_price', ii.unit_price,
                       'total_price', ii.total_price,
                       'type', ii.type,
                       'service_date', ii.service_date
                   )) FILTER (WHERE ii.id IS NOT NULL), '[]') as items
            FROM public.invoices i
            LEFT JOIN public.invoice_items ii ON i.id = ii.invoice_id
            WHERE i.uid = $1 AND i.period = $2
            GROUP BY i.id, i.total_amount
        `;

        const invoiceResult = await client.query(invoiceQuery, [uid, period]);
        
        if (invoiceResult.rows.length > 0) {
            const invoice = invoiceResult.rows[0];
            
            // Salvar backup
            await client.query(`
                INSERT INTO public.invoices_backup_migration 
                (original_invoice_id, uid, period, original_total_amount, original_items)
                VALUES ($1, $2, $3, $4, $5)
            `, [
                invoice.id,
                uid,
                period,
                invoice.total_amount,
                JSON.stringify(invoice.items)
            ]);
        }
    }

    /**
     * Registra as mudanças feitas na fatura
     */
    async logInvoiceChanges(client, uid, period, result) {
        // Criar tabela de log se não existir
        await client.query(`
            CREATE TABLE IF NOT EXISTS public.billing_migration_log (
                id SERIAL PRIMARY KEY,
                uid TEXT,
                period TEXT,
                old_total DECIMAL(10,2),
                new_total DECIMAL(10,2),
                difference DECIMAL(10,2),
                items_count INTEGER,
                migration_timestamp TIMESTAMP DEFAULT NOW(),
                migration_version TEXT DEFAULT 'billing-period-fix-v1'
            )
        `);

        // Buscar total antigo do backup
        const backupQuery = `
            SELECT original_total_amount
            FROM public.invoices_backup_migration
            WHERE uid = $1 AND period = $2
            ORDER BY backup_timestamp DESC
            LIMIT 1
        `;
        
        const backupResult = await client.query(backupQuery, [uid, period]);
        const oldTotal = backupResult.rows.length > 0 ? parseFloat(backupResult.rows[0].original_total_amount) : 0;
        const newTotal = result.newTotal;
        const difference = newTotal - oldTotal;

        // Registrar mudança
        await client.query(`
            INSERT INTO public.billing_migration_log 
            (uid, period, old_total, new_total, difference, items_count)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [uid, period, oldTotal, newTotal, difference, result.autoItems.length]);

        // Log no console se houver diferença significativa
        if (Math.abs(difference) > 0.01) {
            console.log(`    📊 Diferença: R$ ${oldTotal.toFixed(2)} → R$ ${newTotal.toFixed(2)} (${difference >= 0 ? '+' : ''}${difference.toFixed(2)})`);
        }
    }

    /**
     * Gera relatório final da migração
     */
    generateFinalReport() {
        const endTime = new Date();
        const duration = Math.round((endTime - this.startTime) / 1000);
        
        console.log('\n' + '='.repeat(60));
        console.log('📊 RELATÓRIO FINAL DA MIGRAÇÃO');
        console.log('='.repeat(60));
        console.log(`⏰ Início: ${this.startTime.toLocaleString('pt-BR')}`);
        console.log(`⏰ Fim: ${endTime.toLocaleString('pt-BR')}`);
        console.log(`⏱️  Duração: ${duration} segundos`);
        console.log(`👥 Usuários processados: ${this.processedUsers}`);
        console.log(`📋 Faturas recalculadas: ${this.processedInvoices}`);
        console.log(`❌ Erros encontrados: ${this.errors.length}`);
        
        if (this.errors.length > 0) {
            console.log('\n❌ ERROS DETALHADOS:');
            this.errors.forEach((error, index) => {
                console.log(`${index + 1}. ${error.user} (${error.period || 'geral'}): ${error.error}`);
            });
        }
        
        console.log('\n✅ MIGRAÇÃO CONCLUÍDA!');
        console.log('📝 Backups salvos em: invoices_backup_migration');
        console.log('📊 Logs salvos em: billing_migration_log');
        console.log('='.repeat(60));
    }

    /**
     * Executa apenas um teste com um usuário específico
     */
    async runTest(userEmail) {
        console.log(`🧪 Executando teste para usuário: ${userEmail}`);
        
        const client = await db.pool.connect();
        
        try {
            // Buscar usuário específico
            const userQuery = `
                SELECT DISTINCT 
                    i.uid,
                    u.email,
                    u.name,
                    COUNT(i.id) as total_invoices
                FROM public.invoices i
                JOIN public.users u ON i.uid = u.uid
                WHERE u.email = $1
                GROUP BY i.uid, u.email, u.name
            `;
            
            const userResult = await client.query(userQuery, [userEmail]);
            
            if (userResult.rows.length === 0) {
                console.log(`❌ Usuário ${userEmail} não encontrado ou sem faturas`);
                return;
            }
            
            const user = userResult.rows[0];
            console.log(`📋 Testando usuário: ${user.email} (${user.total_invoices} faturas)`);
            
            // Processar apenas este usuário (sem commit)
            await client.query('BEGIN');
            await this.processUser(client, user);
            await client.query('ROLLBACK'); // Rollback para não salvar as mudanças
            
            console.log('✅ Teste concluído (mudanças não foram salvas)');
            
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('❌ Erro durante o teste:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Gera relatório de comparação sem fazer mudanças
     */
    async generateComparisonReport() {
        console.log('📊 Gerando relatório de comparação...');
        
        const client = await db.pool.connect();
        
        try {
            const users = await this.getUsersWithInvoices(client);
            console.log(`👥 Analisando ${users.length} usuários...`);
            
            const comparisons = [];
            
            for (const user of users) {
                const periods = await this.getUserPeriods(client, user.uid);
                
                for (const period of periods) {
                    const comparison = await this.compareInvoicePeriod(client, user.uid, period, user.email);
                    if (comparison) {
                        comparisons.push(comparison);
                    }
                }
            }
            
            // Exibir relatório
            this.displayComparisonReport(comparisons);
            
        } catch (error) {
            console.error('❌ Erro ao gerar relatório:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Compara uma fatura específica entre sistema antigo e novo
     */
    async compareInvoicePeriod(client, uid, period, userEmail) {
        try {
            const [year, month] = period.split('-').map(Number);
            
            // Query do sistema antigo vs novo
            const comparison = this.billingQueryBuilder.buildComparisonQuery(uid, year, month);
            const result = await client.query(comparison.query, comparison.params);
            
            const oldSystem = result.rows.find(r => r.system_type === 'old_system');
            const newSystem = result.rows.find(r => r.system_type === 'new_system');
            
            if (oldSystem && newSystem) {
                const difference = parseFloat(newSystem.total_amount) - parseFloat(oldSystem.total_amount);
                
                if (Math.abs(difference) > 0.01) {
                    return {
                        user: userEmail,
                        period,
                        oldTotal: parseFloat(oldSystem.total_amount),
                        newTotal: parseFloat(newSystem.total_amount),
                        difference,
                        oldItems: parseInt(oldSystem.total_items),
                        newItems: parseInt(newSystem.total_items)
                    };
                }
            }
            
            return null;
            
        } catch (error) {
            console.error(`Erro ao comparar ${userEmail} ${period}:`, error.message);
            return null;
        }
    }

    /**
     * Exibe relatório de comparação
     */
    displayComparisonReport(comparisons) {
        console.log('\n' + '='.repeat(80));
        console.log('📊 RELATÓRIO DE COMPARAÇÃO - SISTEMA ANTIGO vs NOVO');
        console.log('='.repeat(80));
        
        if (comparisons.length === 0) {
            console.log('✅ Nenhuma diferença encontrada entre os sistemas');
            return;
        }
        
        console.log(`📋 Faturas com diferenças: ${comparisons.length}`);
        console.log('\nDETALHES:');
        console.log('-'.repeat(80));
        
        let totalDifference = 0;
        
        comparisons.forEach((comp, index) => {
            console.log(`${index + 1}. ${comp.user} - ${comp.period}`);
            console.log(`   Antigo: R$ ${comp.oldTotal.toFixed(2)} (${comp.oldItems} itens)`);
            console.log(`   Novo:   R$ ${comp.newTotal.toFixed(2)} (${comp.newItems} itens)`);
            console.log(`   Diff:   ${comp.difference >= 0 ? '+' : ''}R$ ${comp.difference.toFixed(2)}`);
            console.log('');
            
            totalDifference += comp.difference;
        });
        
        console.log('-'.repeat(80));
        console.log(`💰 Diferença total: ${totalDifference >= 0 ? '+' : ''}R$ ${totalDifference.toFixed(2)}`);
        console.log('='.repeat(80));
    }
}

// Função principal para executar a migração
async function runMigration() {
    const migration = new BillingPeriodMigration();
    
    try {
        await migration.run();
        process.exit(0);
    } catch (error) {
        console.error('💥 Falha na migração:', error);
        process.exit(1);
    }
}

// Função para executar apenas um teste
async function runTest(userEmail) {
    const migration = new BillingPeriodMigration();
    
    try {
        await migration.runTest(userEmail);
        process.exit(0);
    } catch (error) {
        console.error('💥 Falha no teste:', error);
        process.exit(1);
    }
}

// Função para gerar relatório de comparação
async function generateReport() {
    const migration = new BillingPeriodMigration();
    
    try {
        await migration.generateComparisonReport();
        process.exit(0);
    } catch (error) {
        console.error('💥 Falha no relatório:', error);
        process.exit(1);
    }
}

// Exportar para uso em outros arquivos
module.exports = {
    BillingPeriodMigration,
    runMigration,
    runTest,
    generateReport
};

// Executar se chamado diretamente
if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];
    
    switch (command) {
        case 'run':
            console.log('🚀 Executando migração completa...');
            runMigration();
            break;
            
        case 'test':
            const userEmail = args[1];
            if (!userEmail) {
                console.error('❌ Uso: node fix-billing-periods-migration.js test <email-do-usuario>');
                process.exit(1);
            }
            runTest(userEmail);
            break;
            
        case 'report':
            console.log('📊 Gerando relatório de comparação...');
            generateReport();
            break;
            
        default:
            console.log('📋 Uso:');
            console.log('  node fix-billing-periods-migration.js run     # Executa migração completa');
            console.log('  node fix-billing-periods-migration.js test <email>  # Testa um usuário específico');
            console.log('  node fix-billing-periods-migration.js report  # Gera relatório de comparação');
            process.exit(1);
    }
}