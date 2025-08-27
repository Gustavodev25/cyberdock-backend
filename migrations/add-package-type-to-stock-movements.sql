-- Migração para adicionar campos de package_type à tabela stock_movements
-- Data: 2024-12-19
-- Descrição: Adiciona campos para rastrear package_type baseado no contexto da venda

-- Adiciona coluna package_type_id (referência para package_types)
ALTER TABLE public.stock_movements 
ADD COLUMN IF NOT EXISTS package_type_id INTEGER REFERENCES public.package_types(id);

-- Adiciona coluna package_type_context (texto explicativo do contexto)
ALTER TABLE public.stock_movements 
ADD COLUMN IF NOT EXISTS package_type_context TEXT;

-- Comentário explicativo
COMMENT ON COLUMN public.stock_movements.package_type_id IS 'ID do tipo de pacote usado na movimentação (próprio SKU ou herdado do kit)';
COMMENT ON COLUMN public.stock_movements.package_type_context IS 'Contexto do package_type (SKU próprio, Kit: SKU_DO_KIT, etc.)';

-- Índice para otimizar consultas por package_type_id
CREATE INDEX IF NOT EXISTS idx_stock_movements_package_type_id 
ON public.stock_movements(package_type_id);

-- Índice para otimizar consultas por package_type_context
CREATE INDEX IF NOT EXISTS idx_stock_movements_package_type_context 
ON public.stock_movements(package_type_context);
