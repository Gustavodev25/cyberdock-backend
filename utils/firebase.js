const admin = require('firebase-admin');

const serviceAccount = require('../cyberdock-9b169-firebase-adminsdk-fbsvc-18dbe71411.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL || 'https://cyberdock-9b169-default-rtdb.firebaseio.com'
  });
}

function getDatabase() {
  return admin.database();
}

module.exports = { getDatabase };
