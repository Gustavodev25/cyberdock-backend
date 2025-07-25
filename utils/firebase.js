
const admin = require('firebase-admin');

let firebaseConfig;
if (process.env.NODE_ENV === 'production') {
  // Render: credenciais via variáveis de ambiente
  firebaseConfig = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Corrige as quebras de linha do private key
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
} else {
  // Localhost: usa arquivo JSON
  const serviceAccount = require('../cyberdock-9b169-firebase-adminsdk-fbsvc-18dbe71411.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL || 'https://cyberdock-9b169-default-rtdb.firebaseio.com',
  });
}

function getDatabase() {
  return admin.database();
}

module.exports = { getDatabase };
