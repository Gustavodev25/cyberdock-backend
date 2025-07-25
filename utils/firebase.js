
const admin = require('firebase-admin');

if (!admin.apps.length) {
  if (process.env.NODE_ENV === 'production') {
    // Em produção, usar as variáveis de ambiente do Render
    const firebaseConfig = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
    };

    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig),
      databaseURL: process.env.FIREBASE_DB_URL
    });
  } else {
    // Em desenvolvimento, usar o arquivo JSON
    const serviceAccount = require('../cyberdock-9b169-firebase-adminsdk-fbsvc-18dbe71411.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL || 'https://cyberdock-9b169-default-rtdb.firebaseio.com'
    });
  }
}

function getDatabase() {
  return admin.database();
}

module.exports = { getDatabase };