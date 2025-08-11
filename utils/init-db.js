// backend/utils/init-db.js

const db = require('./postgres');

const schema = {
    package_types: `
        CREATE TABLE public.package_types (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            price NUMERIC(10, 2) NOT NULL
        );`,
    services: `
        CREATE TABLE public.services (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            price NUMERIC(10,2) NOT NULL,
            description TEXT,
            type VARCHAR(50)
        );`,
    users: `
        CREATE TABLE public.users (
            uid VARCHAR(255) PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            role VARCHAR(50) NOT NULL DEFAULT 'cliente',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            password_hash VARCHAR(255)
        );`,
    ml_accounts: `
        CREATE TABLE public.ml_accounts (
            uid VARCHAR(255) NOT NULL,
            user_id BIGINT NOT NULL,
            nickname VARCHAR(255),
            access_token TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            expires_in BIGINT,
            status VARCHAR(50) DEFAULT 'active',
            connected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE,
            PRIMARY KEY (uid, user_id)
        );`,
    sales: `
        CREATE TABLE public.sales (
            id BIGINT NOT NULL,
            sku VARCHAR(255) NOT NULL,
            uid VARCHAR(255) NOT NULL,
            seller_id BIGINT NOT NULL,
            channel VARCHAR(50),
            account_nickname VARCHAR(255),
            sale_date TIMESTAMP WITH TIME ZONE,
            product_title TEXT,
            quantity INTEGER,
            shipping_mode VARCHAR(255),
            shipping_limit_date TIMESTAMP WITH TIME ZONE,
            packages INTEGER,
            shipping_status VARCHAR(100) DEFAULT 'pending',
            raw_api_data JSONB,
            updated_at TIMESTAMP WITH TIME ZONE,
            processed_at TIMESTAMP WITH TIME ZONE
        );`,
    system_settings: `
        CREATE TABLE public.system_settings (
            key VARCHAR(100) PRIMARY KEY,
            value JSONB,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );`,
    skus: `
        CREATE TABLE public.skus (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
            sku VARCHAR(255) NOT NULL,
            descricao TEXT,
            dimensoes JSONB,
            quantidade INTEGER DEFAULT 0,
            package_type_id INTEGER REFERENCES public.package_types(id) ON DELETE SET NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE,
            UNIQUE (user_id, sku)
        );`,
    stock_movements: `
        CREATE TABLE public.stock_movements (
            id SERIAL PRIMARY KEY,
            sku_id INTEGER NOT NULL REFERENCES public.skus(id) ON DELETE CASCADE,
            user_id VARCHAR(255) NOT NULL,
            movement_type VARCHAR(20) NOT NULL,
            quantity_change INTEGER NOT NULL,
            reason TEXT,
            related_sale_id BIGINT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );`,
    user_contracts: `
        CREATE TABLE public.user_contracts (
            id SERIAL PRIMARY KEY,
            uid VARCHAR(255) NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
            service_id INTEGER NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
            name VARCHAR(255) NOT NULL,
            price NUMERIC(10,2) NOT NULL,
            volume INTEGER,
            start_date DATE NOT NULL,
            CONSTRAINT unique_contract UNIQUE (uid, service_id)
        );`,
    user_settings: `
        CREATE TABLE public.user_settings (
            uid VARCHAR(255) PRIMARY KEY REFERENCES public.users(uid) ON DELETE CASCADE,
            statuses JSONB,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );`,
    invoices: `
        CREATE TABLE public.invoices (
            id SERIAL PRIMARY KEY,
            uid VARCHAR(255) NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
            period VARCHAR(7) NOT NULL,
            due_date DATE NOT NULL,
            payment_date DATE,
            total_amount NUMERIC(10, 2) NOT NULL,
            status VARCHAR(50) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(uid, period)
        );`,
    invoice_items: `
        CREATE TABLE public.invoice_items (
            id SERIAL PRIMARY KEY,
            invoice_id INTEGER NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
            description TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            unit_price NUMERIC(10, 2) NOT NULL,
            total_price NUMERIC(10, 2) NOT NULL,
            type VARCHAR(50) NOT NULL
        );`
};

async function syncDatabaseSchema() {
    const client = await db.pool.connect();
    try {
        console.log('--- Iniciando sincronização do esquema do banco de dados ---');
        const res = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
        const existingTables = res.rows.map(row => row.tablename);
        const desiredTables = Object.keys(schema);
        
        const tablesInOrder = [
            'users', 'package_types', 'services', 'ml_accounts', 'system_settings',
            'user_settings', 'user_contracts', 'skus', 'sales', 'stock_movements',
            'invoices', 'invoice_items'
        ];

        await client.query('BEGIN');
        for (const tableName of tablesInOrder) {
            if (!existingTables.includes(tableName)) {
                console.log(`   -> Criando tabela: public.${tableName}`);
                await client.query(schema[tableName]);
            }
        }
        await client.query('COMMIT');
        console.log('✅ Esquema do banco de dados está atualizado.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Erro durante a sincronização do esquema:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function seedInitialData() {
    const client = await db.pool.connect();
    try {
        console.log('--- Verificando e inserindo dados iniciais (seeding) ---');
        await client.query('BEGIN');

        const packageCheck = await client.query('SELECT COUNT(*) FROM public.package_types');
        if (parseInt(packageCheck.rows[0].count, 10) === 0) {
            console.log('Nenhum tipo de pacote encontrado. Inserindo padrões...');
            await client.query(
                `INSERT INTO public.package_types (name, price) VALUES 
                    ('Expedição Comum', 2.97),
                    ('Expedição Premium', 3.97)`
            );
            console.log('Tipos de pacote padrão inseridos.');
        }

        const servicesCheck = await client.query('SELECT COUNT(*) FROM public.services');
        if (parseInt(servicesCheck.rows[0].count, 10) === 0) {
            console.log('Nenhum serviço encontrado. Inserindo exemplos...');
            await client.query(
                `INSERT INTO public.services (name, price, description, type) VALUES 
                    ('Armazenamento Base (até 1m³)', 397.00, 'Taxa base de armazenamento para o primeiro metro cúbico.', 'base_storage'),
                    ('Metro Cúbico Adicional', 197.00, 'Custo por cada metro cúbico adicional utilizado.', 'additional_storage')`
            );
            console.log('Serviços de exemplo inseridos.');
        }

        const defaultStatuses = [
            { value: 'custom_01_imprimir_etiqueta', label: '01 Imprimir Etiqueta' },
            { value: 'custom_02_preparar_pacote', label: '02 Preparar Pacote' },
            { value: 'custom_03_pacote_embalado', label: '03 Pacote Embalado' },
            { value: 'custom_04_aguardando_coleta', label: '04 Aguardando Coleta' },
            { value: 'custom_05_enviado', label: '05 Enviado' },
            { value: 'custom_06_despachado', label: '06 Despachado' }
        ];
        const statusesCheck = await client.query("SELECT 1 FROM public.system_settings WHERE key = 'sales_statuses'");
        if (statusesCheck.rows.length === 0) {
            console.log('Nenhuma configuração de status encontrada. Inserindo padrões...');
            await client.query(
                'INSERT INTO public.system_settings (key, value) VALUES ($1, $2)',
                ['sales_statuses', JSON.stringify(defaultStatuses)]
            );
            console.log('Status padrão inseridos.');
        }

        await client.query('COMMIT');
        console.log('--- Verificação de dados iniciais concluída ---');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Erro ao inserir dados iniciais:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function initializeDatabase() {
    try {
        await syncDatabaseSchema();
        await seedInitialData();
        console.log('✅ Banco de dados inicializado e pronto para uso.');
    } catch (error) {
        console.error('Falha crítica ao inicializar o banco de dados. A aplicação não pode continuar.');
        process.exit(1);
    }
}

module.exports = { initializeDatabase };
