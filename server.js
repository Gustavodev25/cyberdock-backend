require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mercadoLivreRouter = require('./router/mercadolivre');
const { startNgrok } = require('./ngrok');

const app = express();
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = ['https://cyberdock.com.br', 'http://localhost:5173', 'http://localhost:8080', undefined];
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(bodyParser.json());

app.use('/ml', mercadoLivreRouter);

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

    // Registra a URL do ngrok no console
    console.log('URL do backend (ngrok):', url);

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