// /server.js

// Carrega as variáveis de ambiente do arquivo .env, se houver
require('dotenv').config();

const express = require('express');
const cors = require('cors');
// O 'body-parser' foi removido, pois sua funcionalidade agora é nativa do Express.

// Importa o arquivo principal de rotas
const mainRouter = require('./router');
// Importa a função de inicialização do banco de dados
const { initializeDatabase } = require('./utils/init-db');
// Importa a nova função para iniciar o Ngrok
const { startNgrok } = require('./ngrok');

const app = express();

// Configuração do CORS
app.use(cors());

// --- CORREÇÃO APLICADA AQUI ---
// Configura o middleware nativo do Express para interpretar o corpo das requisições como JSON.
// Isso substitui o 'body-parser'.
app.use(express.json());

// Usa o roteador principal para todas as requisições que começarem com /api
app.use('/api', mainRouter);

const PORT = process.env.PORT || 3001;

// A função de callback do app.listen agora é assíncrona
app.listen(PORT, async () => {
  // Primeiro, inicializa o banco de dados e espera a conclusão
  await initializeDatabase();

  // Depois, informa que o servidor está a ser executado
  console.log(`🚀 Servidor backend a ser executado na porta ${PORT}`);

  // Inicia o Ngrok apenas se não estiver em ambiente de produção
  if (process.env.NODE_ENV !== 'production') {
    const ngrokUrl = await startNgrok();
    if (ngrokUrl) {
      console.log(`✅ Ngrok a ser executado: ${ngrokUrl}`);
    } else {
      console.log('⚠️ Ngrok não foi iniciado. Verifique o authtoken ou a conexão.');
    }
  }
});
