const db = require('./utils/postgres');

async function checkServiceItems() {
    console.log('🔍 Verificando itens de serviço com datas incorretas...');
    
    const query = `
        SELECT 
            ii.id,
            ii.description,
            ii.service_date,
            ii.total_price,
            i.period,
            i.uid,
            u.email
        FROM public.invoice_items ii
        JOIN public.invoices i ON ii.invoice_id = i.id
        JOIN public.users u ON i.uid = u.uid
        WHERE ii.type = 'manual'
        AND (ii.description LIKE '%Coleta%' OR ii.description LIKE '%25/08%' OR ii.description LIKE '%agosto%')
        ORDER BY ii.service_date DESC, i.period DESC
    `;
    
    try {
        const result = await db.query(query);
        console.log('📋 Itens de serviço encontrados:');
        console.log('');
        
        result.rows.forEach((item, index) => {
            const serviceDate = item.service_date ? new Date(item.service_date).toLocaleDateString('pt-BR') : 'NÃO DEFINIDA';
            const shouldBeInPeriod = item.service_date ? item.service_date.toISOString().slice(0, 7) : 'N/A';
            const isInCorrectPeriod = shouldBeInPeriod === item.period;
            
            console.log(`${index + 1}. ${item.email} - ${item.period}`);
            console.log(`   Descrição: ${item.description}`);
            console.log(`   Data do serviço: ${serviceDate}`);
            console.log(`   Deveria estar em: ${shouldBeInPeriod}`);
            console.log(`   Está no período correto: ${isInCorrectPeriod ? '✅ SIM' : '❌ NÃO'}`);
            console.log(`   Valor: R$ ${parseFloat(item.total_price).toFixed(2)}`);
            console.log(`   ID: ${item.id}`);
            console.log('');
        });
        
        if (result.rows.length === 0) {
            console.log('❌ Nenhum item encontrado');
        }
        
        // Verificar todos os itens manuais de setembro
        console.log('🔍 Verificando TODOS os itens manuais de setembro...');
        const septemberQuery = `
            SELECT 
                ii.id,
                ii.description,
                ii.service_date,
                ii.total_price,
                i.period,
                u.email
            FROM public.invoice_items ii
            JOIN public.invoices i ON ii.invoice_id = i.id
            JOIN public.users u ON i.uid = u.uid
            WHERE ii.type = 'manual'
            AND i.period = '2025-09'
            ORDER BY ii.service_date DESC
        `;
        
        const septemberResult = await db.query(septemberQuery);
        console.log(`📋 Todos os itens manuais de setembro (${septemberResult.rows.length} itens):`);
        console.log('');
        
        septemberResult.rows.forEach((item, index) => {
            const serviceDate = item.service_date ? new Date(item.service_date).toLocaleDateString('pt-BR') : 'NÃO DEFINIDA';
            const shouldBeInPeriod = item.service_date ? item.service_date.toISOString().slice(0, 7) : 'N/A';
            const isInCorrectPeriod = shouldBeInPeriod === item.period;
            
            console.log(`${index + 1}. ${item.email}`);
            console.log(`   Descrição: ${item.description}`);
            console.log(`   Data do serviço: ${serviceDate}`);
            console.log(`   Deveria estar em: ${shouldBeInPeriod}`);
            console.log(`   Status: ${isInCorrectPeriod ? '✅ CORRETO' : '❌ PERÍODO ERRADO'}`);
            console.log(`   Valor: R$ ${parseFloat(item.total_price).toFixed(2)}`);
            console.log('');
        });
        
    } catch (error) {
        console.error('❌ Erro:', error.message);
    }
    
    process.exit(0);
}

checkServiceItems();