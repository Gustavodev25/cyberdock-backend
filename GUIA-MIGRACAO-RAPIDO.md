# 🚀 Guia Rápido - Migração de Cobrança

## ⚡ Comandos Essenciais

### 1. 📊 Ver o que vai mudar (SEGURO)
```bash
cd backend
npm run migrate-billing report
```
**→ Mostra diferenças sem alterar nada**

### 2. 🧪 Testar com um usuário (SEGURO)
```bash
npm run migrate-billing test usuario@exemplo.com
```
**→ Simula migração sem salvar**

### 3. 🚀 Executar migração completa (CUIDADO!)
```bash
npm run migrate-billing run
```
**→ Altera dados reais - pede confirmação**

## 🎯 O que a migração faz

**PROBLEMA:** Itens de setembro apareciam na cobrança de agosto

**SOLUÇÃO:** Cada item é cobrado no mês correto baseado na data real do serviço

### Exemplo:
- **Serviço executado:** 25/08/2024
- **Lançado no sistema:** 12/09/2024
- **Antes:** Cobrado em setembro ❌
- **Depois:** Cobrado em agosto ✅

## 🛡️ Segurança

✅ **Backups automáticos** de todas as faturas  
✅ **Logs detalhados** de todas as mudanças  
✅ **Transações seguras** - se der erro, reverte tudo  
✅ **Confirmação obrigatória** antes de executar  

## 📋 Passo a Passo Recomendado

1. **Execute o relatório** para ver o impacto:
   ```bash
   npm run migrate-billing report
   ```

2. **Teste com alguns usuários** específicos:
   ```bash
   npm run migrate-billing test cliente1@exemplo.com
   npm run migrate-billing test cliente2@exemplo.com
   ```

3. **Se tudo estiver OK, execute a migração completa**:
   ```bash
   npm run migrate-billing run
   ```

## 🚨 Em caso de problemas

- **Backups estão em:** `invoices_backup_migration`
- **Logs estão em:** `billing_migration_log`
- **Entre em contato** com o desenvolvedor
- **NÃO altere dados manualmente**

---

**💡 DICA:** Sempre execute o `report` primeiro para entender o que vai mudar!