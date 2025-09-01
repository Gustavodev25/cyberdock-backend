-- Migração para adicionar coluna updated_at à tabela sku_kit_components
-- Esta migração verifica se a coluna existe antes de adicioná-la

DO $$
BEGIN
    -- Verifica se a coluna updated_at existe na tabela sku_kit_components
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'sku_kit_components' 
        AND column_name = 'updated_at'
    ) THEN
        -- Adiciona a coluna updated_at se ela não existir
        ALTER TABLE public.sku_kit_components 
        ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
        
        RAISE NOTICE 'Coluna updated_at adicionada à tabela sku_kit_components';
    ELSE
        RAISE NOTICE 'Coluna updated_at já existe na tabela sku_kit_components';
    END IF;
END $$;

