-- Script para remover o serviço "Armazenamento Proporcional" e migrar usuários
-- Execute este script após fazer backup do banco de dados

-- 1. Primeiro, vamos verificar se existem usuários com contrato proporcional
SELECT 
    uc.id as contract_id,
    uc.uid,
    uc.service_id,
    uc.start_date,
    uc.created_at,
    s.name as service_name,
    s.type as service_type
FROM public.user_contracts uc
JOIN public.services s ON uc.service_id = s.id
WHERE s.type = 'proportional_storage';

-- 2. Migrar usuários com contrato proporcional para o serviço base
-- (Execute apenas se houver usuários com contrato proporcional)
UPDATE public.user_contracts 
SET service_id = (
    SELECT id FROM public.services WHERE type = 'base_storage'
)
WHERE service_id = (
    SELECT id FROM public.services WHERE type = 'proportional_storage'
);

-- 3. Remover o serviço proporcional
DELETE FROM public.services WHERE type = 'proportional_storage';

-- 4. Verificar se a migração foi bem-sucedida
SELECT 
    uc.id as contract_id,
    uc.uid,
    uc.service_id,
    uc.start_date,
    uc.created_at,
    s.name as service_name,
    s.type as service_type
FROM public.user_contracts uc
JOIN public.services s ON uc.service_id = s.id
WHERE s.type IN ('base_storage', 'additional_storage');

-- 5. Verificar se o serviço proporcional foi removido
SELECT * FROM public.services WHERE type = 'proportional_storage';

