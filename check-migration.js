const db = require('./utils/postgres');

async function checkAndRunMigration() {
    const client = await db.pool.connect();
    try {
        console.log('--- Verificando colunas de armazenamento mensal ---');
        
        // Verificar se as colunas já existem
        const columnsCheck = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = 'skus' 
            AND column_name IN ('is_monthly', 'monthly_start_date', 'monthly_price')
        `);
        
        const existingColumns = columnsCheck.rows.map(row => row.column_name);
        console.log('Colunas existentes:', existingColumns);
        
        if (existingColumns.length < 3) {
            console.log('Executando migração...');
            
            await client.query('BEGIN');
            
            // Adicionar coluna is_monthly se não existir
            if (!existingColumns.includes('is_monthly')) {
                console.log('Adicionando coluna is_monthly...');
                await client.query('ALTER TABLE public.skus ADD COLUMN is_monthly BOOLEAN DEFAULT FALSE');
            }
            
            // Adicionar coluna monthly_start_date se não existir
            if (!existingColumns.includes('monthly_start_date')) {
                console.log('Adicionando coluna monthly_start_date...');
                await client.query('ALTER TABLE public.skus ADD COLUMN monthly_start_date DATE DEFAULT NULL');
            }
            
            // Adicionar coluna monthly_price se não existir
            if (!existingColumns.includes('monthly_price')) {
                console.log('Adicionando coluna monthly_price...');
                await client.query('ALTER TABLE public.skus ADD COLUMN monthly_price NUMERIC(10,2) DEFAULT NULL');
            }
            
            // Adicionar comentários
            await client.query(`
                COMMENT ON COLUMN public.skus.is_monthly IS 'Indica se o SKU é cobrado mensalmente';
                COMMENT ON COLUMN public.skus.monthly_start_date IS 'Data de início da cobrança mensal (proporcional)';
                COMMENT ON COLUMN public.skus.monthly_price IS 'Preço mensal do SKU para cobrança proporcional';
            `);
            
            await client.query('COMMIT');
            console.log('✅ Migração executada com sucesso!');
        } else {
            console.log('✅ Todas as colunas já existem. Migração não é necessária.');
        }
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Erro durante a migração:', error);
        throw error;
    } finally {
        client.release();
        process.exit(0);
    }
}

checkAndRunMigration().catch(console.error);
