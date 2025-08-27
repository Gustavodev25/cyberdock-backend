-- Migração para adicionar campos de armazenamento mensal
ALTER TABLE public.skus 
ADD COLUMN IF NOT EXISTS is_monthly BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS monthly_start_date DATE DEFAULT NULL,
ADD COLUMN IF NOT EXISTS monthly_price NUMERIC(10,2) DEFAULT NULL;

-- Comentários para documentar os novos campos
COMMENT ON COLUMN public.skus.is_monthly IS 'Indica se o SKU é cobrado mensalmente';
COMMENT ON COLUMN public.skus.monthly_start_date IS 'Data de início da cobrança mensal (proporcional)';
COMMENT ON COLUMN public.skus.monthly_price IS 'Preço mensal do SKU para cobrança proporcional';
