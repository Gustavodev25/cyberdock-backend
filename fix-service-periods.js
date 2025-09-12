const db = require('./utils/postgres');

async function fixServicePeriods() {
    console.log('🔧 Corrigindo períodos de serviços manuais...');
    
    const client = await db.pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // 1. Encontrar todos os itens com período incorreto
        const findIncorrectItemsQuery = `
            SELECT 
                ii.id,
                ii.invoice_id,
                ii.description,
                ii.service_date,
                ii.quantity,
                ii.unit_price,
                ii.total_price,
                ii.type,
                i.period as current_period,
                i.uid,
                u.email,
                -- Calcular período correto baseado na service_date
                TO_CHAR(ii.service_date, 'YYYY-MM') as correct_period
            FROM public.invoice_items ii
            JOIN public.invoices i ON ii.invoice_id = i.id
            JOIN public.users u ON i.uid = u.uid
            WHERE ii.type = 'manual'
            AND ii.service_date IS NOT NULL
            AND TO_CHAR(ii.service_date, 'YYYY-MM') != i.period
            ORDER BY u.email, ii.service_date
        `;
        
        const incorrectItems = await client.query(findIncorrectItemsQuery);
        
        console.log(`📋 Encontrados ${incorrectItems.rows.length} itens em períodos incorretos:`);
        console.log('');
        
        if (incorrectItems.rows.length === 0) {
            console.log('✅ Todos os itens já estão nos períodos corretos!');
            await client.query('COMMIT');
            return;
        }
        
        // 2. Processar cada item incorreto
        for (const item of incorrectItems.rows) {
            console.log(`🔄 Processando: ${item.email}`);
            console.log(`   Item: ${item.description}`);
            console.log(`   Data do serviço: ${new Date(item.service_date).toLocaleDateString('pt-BR')}`);
            console.log(`   Período atual: ${item.current_period}`);
            console.log(`   Período correto: ${item.correct_period}`);
            console.log(`   Valor: R$ ${parseFloat(item.total_price).toFixed(2)}`);
            
            // 3. Verificar se existe fatura no período correto
            let correctInvoiceId;
            const correctInvoiceQuery = `
                SELECT id FROM public.invoices 
                WHERE uid = $1 AND period = $2
            `;
            
            const correctInvoiceResult = await client.query(correctInvoiceQuery, [item.uid, item.correct_period]);
            
            if (correctInvoiceResult.rows.length > 0) {
                correctInvoiceId = correctInvoiceResult.rows[0].id;
                console.log(`   ✅ Fatura do período correto já existe (ID: ${correctInvoiceId})`);
            } else {
                // 4. Criar fatura no período correto se não existir
                const [year, month] = item.correct_period.split('-').map(Number);
                const dueDate = new Date(Date.UTC(year, month, 5));
                
                const createInvoiceQuery = `
                    INSERT INTO public.invoices (uid, period, due_date, total_amount, status)
                    VALUES ($1, $2, $3, 0, 'pending')
                    RETURNING id
                `;
                
                const newInvoiceResult = await client.query(createInvoiceQuery, [item.uid, item.correct_period, dueDate]);
                correctInvoiceId = newInvoiceResult.rows[0].id;
                console.log(`   ✅ Nova fatura criada no período correto (ID: ${correctInvoiceId})`);
            }
            
            // 5. Mover o item para a fatura correta
            const moveItemQuery = `
                UPDATE public.invoice_items 
                SET invoice_id = $1
                WHERE id = $2
            `;
            
            await client.query(moveItemQuery, [correctInvoiceId, item.id]);
            console.log(`   ✅ Item movido para o período correto`);
            
            // 6. Recalcular totais das faturas afetadas
            await recalculateInvoiceTotal(client, item.invoice_id); // Fatura antiga
            await recalculateInvoiceTotal(client, correctInvoiceId); // Fatura nova
            
            console.log(`   ✅ Totais das faturas recalculados`);
            console.log('');
        }
        
        await client.query('COMMIT');
        
        console.log('🎉 CORREÇÃO CONCLUÍDA!');
        console.log(`✅ ${incorrectItems.rows.length} itens movidos para os períodos corretos`);
        console.log('');
        
        // 7. Verificar resultado final
        console.log('🔍 Verificando resultado final...');
        const finalCheckResult = await db.query(findIncorrectItemsQuery);
        
        if (finalCheckResult.rows.length === 0) {
            console.log('✅ Todos os itens agora estão nos períodos corretos!');
        } else {
            console.log(`❌ Ainda restam ${finalCheckResult.rows.length} itens em períodos incorretos`);
        }
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Erro durante a correção:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Função auxiliar para recalcular total da fatura
async function recalculateInvoiceTotal(client, invoiceId) {
    const recalcQuery = `
        UPDATE public.invoices 
        SET total_amount = (
            SELECT COALESCE(SUM(total_price), 0) 
            FROM public.invoice_items 
            WHERE invoice_id = $1
        )
        WHERE id = $1
    `;
    
    await client.query(recalcQuery, [invoiceId]);
}

// Executar se chamado diretamente
if (require.main === module) {
    fixServicePeriods()
        .then(() => {
            console.log('✅ Script concluído com sucesso!');
            process.exit(0);
        })
        .catch(error => {
            console.error('💥 Falha no script:', error);
            process.exit(1);
        });
}

module.exports = { fixServicePeriods };