const ngrok = require('ngrok');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const NGROK_FILE = path.join(__dirname, 'ngrok-url.txt');

async function startNgrok() {
  try {
    const url = await ngrok.connect({ addr: PORT, authtoken: process.env.NGROK_AUTHTOKEN });
    fs.writeFileSync(NGROK_FILE, url, 'utf-8');
    console.log('Ngrok URL:', url);
    return url;
  } catch (err) {
    console.error('Erro ao iniciar ngrok:', err);
    return null;
  }
}

module.exports = { startNgrok, NGROK_FILE };