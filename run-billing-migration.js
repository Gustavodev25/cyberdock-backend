#!/usr/bin/env node

/**
 * Script para executar a migração de correção de períodos de cobrança
 * 
 * Este script facilita a execução da migração com diferentes opções
 */

const { runMigration, runTest, generateReport } = require('./migrations/fix-billing-periods-migration');

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    
    console.log('🔧 Migração de Correção de Períodos de Cobrança');
    console.log('=' .repeat(50));
    
    switch (command) {
        case 'report':
            console.log('📊 Gerando relatório de comparação (sem fazer mudanças)...');
            console.log('Este relatório mostra as diferenças entre sistema antigo e novo');
            console.log('');
            await generateReport();
            break;
            
        case 'test':
            const userEmail = args[1];
            if (!userEmail) {
                console.error('❌ Uso: npm run migrate-billing test <email-do-usuario>');
                console.log('Exemplo: npm run migrate-billing test usuario@exemplo.com');
                process.exit(1);
            }
            console.log(`🧪 Testando migração para usuário: ${userEmail}`);
            console.log('(As mudanças não serão salvas - apenas teste)');
            console.log('');
            await runTest(userEmail);
            break;
            
        case 'run':
            console.log('🚀 EXECUTANDO MIGRAÇÃO COMPLETA...');
            console.log('⚠️  ATENÇÃO: Esta operação irá recalcular TODAS as faturas!');
            console.log('📝 Backups serão criados automaticamente');
            console.log('');
            
            // Confirmação de segurança
            const readline = require('readline');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            const answer = await new Promise(resolve => {
                rl.question('Tem certeza que deseja continuar? (digite "SIM" para confirmar): ', resolve);
            });
            
            rl.close();
            
            if (answer !== 'SIM') {
                console.log('❌ Migração cancelada pelo usuário');
                process.exit(0);
            }
            
            console.log('✅ Confirmação recebida. Iniciando migração...');
            console.log('');
            await runMigration();
            break;
            
        default:
            console.log('📋 Comandos disponíveis:');
            console.log('');
            console.log('  npm run migrate-billing report');
            console.log('    📊 Gera relatório de comparação sem fazer mudanças');
            console.log('    🔍 Mostra quais faturas serão afetadas e por quanto');
            console.log('');
            console.log('  npm run migrate-billing test <email>');
            console.log('    🧪 Testa a migração em um usuário específico');
            console.log('    📝 Não salva as mudanças - apenas para verificação');
            console.log('');
            console.log('  npm run migrate-billing run');
            console.log('    🚀 Executa a migração completa em todos os usuários');
            console.log('    ⚠️  CUIDADO: Altera dados reais!');
            console.log('');
            console.log('💡 Recomendação: Execute "report" primeiro para ver o impacto');
            process.exit(1);
    }
}

// Executar
main().catch(error => {
    console.error('💥 Erro:', error.message);
    process.exit(1);
});