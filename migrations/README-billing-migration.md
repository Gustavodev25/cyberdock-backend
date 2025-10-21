# Migração de Correção de Períodos de Cobrança

## Problema Resolvido

**Antes:** Itens de setembro apareciam na cobrança de agosto (e vice-versa)
**Depois:** Cada item é cobrado no mês correto baseado na data de consumo/execução

## Como Usar

### 1. 📊 Primeiro: Gerar Relatório (Recomendado)

```bash
cd backend
npm run migrate-billing report
```

**O que faz:**
- Compara sistema antigo vs novo
- Mostra quais faturas serão afetadas
- Calcula diferenças de valores
- **NÃO faz mudanças** - apenas análise

**Exemplo de saída:**
```
📊 RELATÓRIO DE COMPARAÇÃO
═══════════════════════════════════════
📋 Faturas com diferenças: 15

1. usuario@exemplo.com - 2024-08
   Antigo: R$ 150.00 (8 itens)
   Novo:   R$ 135.50 (6 itens)
   Diff:   -R$ 14.50

2. cliente@teste.com - 2024-09
   Antigo: R$ 200.00 (10 itens)
   Novo:   R$ 225.00 (12 itens)
   Diff:   +R$ 25.00
```

### 2. 🧪 Testar com Um Usuário Específico

```bash
npm run migrate-billing test usuario@exemplo.com
```

**O que faz:**
- Executa migração apenas para um usuário
- Mostra o que seria alterado
- **NÃO salva mudanças** - apenas teste
- Útil para validar antes da migração completa

### 3. 🚀 Executar Migração Completa

```bash
npm run migrate-billing run
```

**⚠️ ATENÇÃO: Esta operação altera dados reais!**

**O que faz:**
- Recalcula TODAS as faturas de TODOS os usuários
- Usa a nova lógica de período correto
- Cria backups automáticos
- Registra todas as mudanças em logs

**Processo de segurança:**
1. Solicita confirmação digitando "SIM"
2. Cria backup de cada fatura antes de alterar
3. Registra logs detalhados de todas as mudanças
4. Pode ser revertido usando os backups

## Lógica da Correção

### Data de Consumo vs Data de Lançamento

| Tipo de Item | Campo Usado | Exemplo |
|--------------|-------------|---------|
| **Vendas** | `processed_at` | Quando foi expedida |
| **Serviços** | `service_date` | Quando foi executada |
| **Armazenamento** | `start_date` | Quando começou |

### Exemplo Prático

**Cenário:**
- Serviço executado em: 25/08/2024
- Lançado no sistema em: 12/09/2024

**Sistema Antigo (Problemático):**
- Cobrava em setembro (data do lançamento)

**Sistema Novo (Correto):**
- Cobra em agosto (data da execução) ✅

## Tabelas Criadas

### 1. `invoices_backup_migration`
- Backup de todas as faturas originais
- Permite reverter mudanças se necessário
- Inclui timestamp e versão da migração

### 2. `billing_migration_log`
- Log detalhado de todas as mudanças
- Valores antigos vs novos
- Diferenças calculadas
- Útil para auditoria

## Segurança

### Backups Automáticos
- Cada fatura é salva antes de ser alterada
- Inclui todos os itens e valores originais
- Permite reversão completa se necessário

### Logs Detalhados
- Registra cada mudança feita
- Calcula diferenças de valores
- Timestamp de todas as operações
- Facilita auditoria e troubleshooting

### Transações
- Toda a migração roda em uma transação
- Se houver erro, tudo é revertido automaticamente
- Garante consistência dos dados

## Reversão (Se Necessário)

Se precisar reverter a migração:

```sql
-- 1. Verificar backups disponíveis
SELECT uid, period, original_total_amount, backup_timestamp 
FROM invoices_backup_migration 
ORDER BY backup_timestamp DESC;

-- 2. Restaurar uma fatura específica
UPDATE invoices 
SET total_amount = (
    SELECT original_total_amount 
    FROM invoices_backup_migration 
    WHERE uid = 'USER_ID' AND period = 'YYYY-MM'
)
WHERE uid = 'USER_ID' AND period = 'YYYY-MM';

-- 3. Restaurar itens da fatura
-- (Script mais complexo - consulte o desenvolvedor)
```

## Monitoramento

### Durante a Migração
```
🚀 Iniciando migração...
👥 Encontrados 50 usuários com faturas
📋 Processando usuário: cliente@exemplo.com (12 faturas)
  🔄 Recalculando período 2024-08...
    ✅ 2024-08: R$ 150.00 (6 itens)
    📊 Diferença: R$ 200.00 → R$ 150.00 (-R$ 50.00)
✅ Usuário cliente@exemplo.com processado com sucesso
```

### Relatório Final
```
📊 RELATÓRIO FINAL DA MIGRAÇÃO
═══════════════════════════════════════
⏰ Duração: 45 segundos
👥 Usuários processados: 50
📋 Faturas recalculadas: 234
❌ Erros encontrados: 0
✅ MIGRAÇÃO CONCLUÍDA!
```

## Quando Executar

### Recomendação
1. **Primeiro:** Execute `report` para ver o impacto
2. **Depois:** Execute `test` com alguns usuários
3. **Por último:** Execute `run` para migração completa

### Melhor Horário
- Fora do horário comercial
- Quando poucos usuários estão usando o sistema
- Preferencialmente em ambiente de manutenção

## Suporte

Se houver problemas durante a migração:

1. **Verifique os logs** em `billing_migration_log`
2. **Consulte os backups** em `invoices_backup_migration`  
3. **Entre em contato** com o desenvolvedor
4. **NÃO tente corrigir manualmente** sem consultar os backups

---

**⚠️ IMPORTANTE:** Sempre execute `report` primeiro para entender o impacto antes de fazer a migração completa!