// /ngrok.js

const ngrok = require('ngrok');

/**
 * Inicia o Ngrok e define a variável de ambiente NGROK_URL.
 * @returns {Promise<string|null>} A URL do Ngrok ou null em caso de erro.
 */
async function startNgrok() {
  try {
    // Pega o authtoken das variáveis de ambiente para não precisar de o digitar sempre
    const authtoken = process.env.NGROK_AUTHTOKEN;
    if (authtoken) {
      await ngrok.authtoken(authtoken);
    }

    // Conecta-se à porta do seu backend (3001)
    const url = await ngrok.connect(process.env.PORT || 3001);

    // --- ESTA É A CORREÇÃO MAIS IMPORTANTE ---
    // Define a URL gerada como uma variável de ambiente global
    // para que outras partes da aplicação (como mercadolivre.js) possam usá-la.
    process.env.NGROK_URL = url;

    return url;
  } catch (error) {
    console.error('❌ Erro ao iniciar o Ngrok:', error);
    return null;
  }
}

module.exports = { startNgrok };
