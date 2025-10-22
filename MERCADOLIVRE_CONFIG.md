# Configuração da Autenticação do Mercado Livre

Este documento explica como resolver o erro **403 CloudFront** e configurar corretamente a autenticação OAuth do Mercado Livre.

## 🚀 Início Rápido

**Está com erro 403?** Siga estes passos:

1. ✅ **Teste o backend:**
   ```bash
   # Abra o terminal e execute:
   cd backend
   npm start

   # Em outro terminal, teste:
   curl http://localhost:3001/api/ml/test
   ```

2. ✅ **Configure o Mercado Livre:**
   - Acesse: https://developers.mercadolivre.com.br/devcenter
   - Edite sua aplicação (Client ID: 8423050287338772)
   - Adicione em "Redirect URIs": `http://localhost:3001/api/ml/callback`
   - Adicione em "Allowed Domains": `localhost`
   - **Salve e aguarde 5 minutos**

3. ✅ **Teste novamente:**
   - Limpe o cache do navegador (Ctrl+Shift+Del)
   - Tente conectar a conta Mercado Livre novamente

## 🚨 Problema Comum: Erro 403 do CloudFront

```
403 ERROR
The request could not be satisfied.
Request blocked. We can't connect to the server for this app or website at this time.
```

Este erro ocorre **ANTES** da página de login do Mercado Livre carregar, indicando que:
- ❌ A URL de callback não está registrada no painel do Mercado Livre
- ❌ A aplicação pode estar em modo sandbox ou não ativada
- ❌ O Client ID pode estar incorreto ou a aplicação foi desativada
- ❌ Pode haver restrições de domínio não configuradas

## Solução: Configurar URLs no Painel do Mercado Livre

### Passo 1: Verificar Configuração Atual

Primeiro, teste se o backend está funcionando:
```bash
# Local
curl http://localhost:3001/api/ml/test

# Produção
curl https://cyberdock-backend.onrender.com/api/ml/test
```

Depois, verifique a configuração:
```bash
# Local
curl http://localhost:3001/api/ml/config-check

# Produção
curl https://cyberdock-backend.onrender.com/api/ml/config-check
```

### Passo 2: Acessar o Painel de Desenvolvedores

1. **Acesse:** https://developers.mercadolivre.com.br/devcenter
2. **Faça login** com sua conta do Mercado Livre
3. **Localize sua aplicação** com Client ID: `8423050287338772`
   - Se não encontrar, você pode ter sido removido ou a aplicação foi deletada
   - Neste caso, será necessário criar uma nova aplicação

### Passo 3: Editar Configurações da Aplicação

1. Clique no nome da sua aplicação
2. Clique em **"Editar"** ou **"Edit"**
3. Vá até a seção **"Configurações"** ou **"Settings"**

### Passo 4: Configurar URLs de Redirecionamento

Na seção **"Redirect URIs"** ou **"URLs de redirecionamento autorizado"**:

⚠️ **IMPORTANTE:** As URLs devem ser **EXATAMENTE** como mostrado abaixo (incluindo http/https):

#### Para Desenvolvimento Local:
```
http://localhost:3001/api/ml/callback
```

#### Para Produção (Render):
```
https://cyberdock-backend.onrender.com/api/ml/callback
```

#### Para Testes com Ngrok (opcional):
```
https://SEU-ID-NGROK.ngrok-free.app/api/ml/callback
```
⚠️ A URL do ngrok muda toda vez que reinicia. Atualize quando necessário.

**Adicione TODAS as URLs acima!** O Mercado Livre permite múltiplas URLs de callback.

### Passo 5: Configurar Domínios Permitidos

Na seção **"Allowed Domains"** ou **"Domínios permitidos"**, adicione:

```
localhost
cyberdock.com.br
cyberdock-backend.onrender.com
```

### Passo 6: Verificar Modo da Aplicação

⚠️ **CRÍTICO:** Certifique-se de que sua aplicação está em modo **PRODUÇÃO** (Production), não em modo **TESTE** (Sandbox).

- No painel, procure por um toggle ou configuração que diz "Production Mode" ou "Modo Produção"
- Aplicações em modo teste/sandbox têm limitações de URLs

### Passo 4: Verificar Client ID e Client Secret

Certifique-se de que as credenciais no arquivo `.env.render` correspondem às do painel:

```env
ML_CLIENT_ID=8423050287338772
ML_CLIENT_SECRET=WWYgt9KH0HtZFH4YzD2yhrOLYHCUST9D
```

## Variáveis de Ambiente Necessárias

### Arquivo `.env.render` (Produção)

```env
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://cyberdock.com.br
ML_CLIENT_ID=8423050287338772
ML_CLIENT_SECRET=WWYgt9KH0HtZFH4YzD2yhrOLYHCUST9D
ML_REDIRECT_URI=https://cyberdock-backend.onrender.com/api/ml/callback
```

### Arquivo `.env` (Desenvolvimento Local)

```env
ML_CLIENT_ID=8423050287338772
ML_CLIENT_SECRET=WWYgt9KH0HtZFH4YzD2yhrOLYHCUST9D
ML_REDIRECT_URI=http://localhost:3001/api/ml/callback
```

## Como Testar

1. **Salve as alterações** no painel do Mercado Livre
2. **Reinicie o servidor backend** (no Render ou localmente)
3. **Limpe o cache do navegador** (Ctrl+Shift+Del)
4. Tente conectar uma conta novamente

## Logs de Depuração

O sistema agora exibe logs detalhados:

```
[ML Auth] Iniciando autenticação para UID: xxxxx
[ML Auth] Redirect URI: https://cyberdock-backend.onrender.com/api/ml/callback
[ML Callback] Processando callback com redirect_uri: https://cyberdock-backend.onrender.com/api/ml/callback
```

Se aparecer um aviso:
```
[ML Auth] URL de redirect não está na lista permitida
```

Verifique se a URL está cadastrada no painel do Mercado Livre.

## Se o Erro 403 Persistir

Se após seguir todos os passos acima o erro 403 ainda ocorrer, tente estas soluções:

### Solução 1: Criar Nova Aplicação

O erro pode indicar que a aplicação está bloqueada ou desativada. Criar uma nova:

1. Acesse: https://developers.mercadolivre.com.br/devcenter
2. Clique em **"Criar nova aplicação"** ou **"Create new app"**
3. Preencha os dados:
   - **Nome:** CyberDock (ou outro nome)
   - **Descrição:** Sistema de gestão de vendas
   - **Categoria:** Seller Tools ou similar
4. Após criar, anote o novo **Client ID** e **Client Secret**
5. Configure as URLs de callback e domínios permitidos (passos 4 e 5 acima)
6. Atualize os arquivos `.env` com as novas credenciais

### Solução 2: Aguardar Propagação

Às vezes, as mudanças no painel do Mercado Livre demoram para propagar:

- ⏰ Aguarde **5-10 minutos** após salvar as configurações
- 🔄 Limpe o cache do navegador (Ctrl+Shift+Del)
- 🔄 Tente em uma aba anônima/privada
- 🔄 Tente em outro navegador

### Solução 3: Verificar Status da Aplicação

1. No painel do ML, verifique se há algum aviso ou notificação
2. Verifique se a aplicação está **ativa** e **aprovada**
3. Algumas aplicações precisam passar por revisão do Mercado Livre

### Solução 4: Usar Ngrok Temporariamente

Se localhost não funcionar, use ngrok:

```bash
# Instalar ngrok (se ainda não tiver)
npm install -g ngrok

# Iniciar ngrok
ngrok http 3001

# Copie a URL fornecida (ex: https://abc123.ngrok-free.app)
# Adicione no painel do ML: https://abc123.ngrok-free.app/api/ml/callback
```

## Checklist de Solução de Problemas

- [ ] Backend está rodando (teste com `/api/ml/test`)
- [ ] URLs de callback cadastradas no painel do ML (EXATAMENTE como especificado)
- [ ] Domínios permitidos configurados
- [ ] Variáveis de ambiente corretas (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
- [ ] Aplicação em modo **PRODUÇÃO** no painel do ML (não sandbox)
- [ ] Servidor reiniciado após alterações
- [ ] Cache do navegador limpo
- [ ] Aguardados alguns minutos após salvar no painel do ML
- [ ] Tentado em aba anônima/outro navegador

## Erro Comum: invalid_grant

Se você receber o erro `invalid_grant`, isso significa:

1. A URL de callback **não está registrada** no painel
2. A URL de callback está **incorreta** (http vs https, porta errada, etc.)
3. O código de autorização **expirou** (tente novamente)

## Suporte

Se o problema persistir:

1. Verifique os logs do backend no Render
2. Confira se todas as URLs estão EXATAMENTE como especificado
3. Certifique-se de que a aplicação está em modo **Produção** (não Sandbox) no painel do ML
4. Aguarde alguns minutos após salvar as configurações no painel do ML (pode demorar para propagar)

## Links Úteis

- Painel de Desenvolvedores: https://developers.mercadolivre.com.br/devcenter
- Documentação OAuth ML: https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao
- Aplicações ML: https://developers.mercadolivre.com.br/apps/home
