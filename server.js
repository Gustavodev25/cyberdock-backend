require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mercadoLivreRouter = require('./router/mercadolivre');
const shopeeRouter = require('./router/shopee');
const { startNgrok } = require('./ngrok');

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use('/ml', mercadoLivreRouter);
app.use('/shopee', shopeeRouter);

const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log(`Servidor backend rodando na porta ${PORT}`);
  
  const url = await startNgrok();
  if (url) {
    console.log('Ngrok URL:', url);
    const fs = require('fs');
    const path = require('path');
    
    // Configuração para Mercado Livre (existente)
    const mlRedirectUri = `${url}/ml/callback`;
    process.env.ML_REDIRECT_URI = mlRedirectUri;

    // ================== ALTERAÇÃO IMPORTANTE ==================
    // Adiciona a URL do Ngrok a uma variável de ambiente para a Shopee
    const shopeeRedirectUri = `${url}/shopee/callback`;
    process.env.SHOPEE_REDIRECT_URI = shopeeRedirectUri;
    console.log(`Variável de ambiente SHOPEE_REDIRECT_URI definida como: ${process.env.SHOPEE_REDIRECT_URI}`);
    // ==========================================================

    // Atualiza o .env do frontend com a VITE_API_URL (existente)
    const frontendEnvPath = path.join(__dirname, '..', '.env');
    let frontendEnvContent = fs.existsSync(frontendEnvPath) ? fs.readFileSync(frontendEnvPath, 'utf-8') : '';
    const newApiUrl = `VITE_API_URL=${url}`;
    if (frontendEnvContent.includes('VITE_API_URL=')) {
      frontendEnvContent = frontendEnvContent.replace(/VITE_API_URL=.*/g, newApiUrl);
    } else {
      frontendEnvContent += `\n${newApiUrl}`;
    }
    fs.writeFileSync(frontendEnvPath, frontendEnvContent, 'utf-8');
    console.log('VITE_API_URL atualizado no .env do frontend:', url);
  }
});