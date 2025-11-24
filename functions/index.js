const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({origin: true});
const { PlaidApi, Configuration, PlaidEnvironments } = require('plaid');

admin.initializeApp();

// Initialize Plaid client
let client = null;

function getPlaidClient() {
  if (!client) {
    const config = functions.config();
    if (!config.plaid || !config.plaid.client_id || !config.plaid.secret) {
      throw new Error('Plaid configuration missing. Please set plaid.client_id and plaid.secret using Firebase Functions config.');
    }
    
    const configuration = new Configuration({
      basePath: PlaidEnvironments.sandbox, // Sandbox environment for testing
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': config.plaid.client_id,
          'PLAID-SECRET': config.plaid.secret,
        },
      },
    });
    
    client = new PlaidApi(configuration);
  }
  return client;
}

// Create Plaid Link Token
exports.createLinkToken = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { user_id } = req.body;
      
      const configs = {
        user: {
          client_user_id: user_id,
        },
        client_name: 'DoughMain',
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
        webhook: 'https://webhook.example.com', // Replace with your webhook URL
      };

      const plaidClient = getPlaidClient();
      const response = await plaidClient.linkTokenCreate(configs);
      res.json(response.data);
    } catch (error) {
      console.error('Error creating link token:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Exchange public token for access token
exports.exchangePublicToken = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { public_token, user_id } = req.body;
      
      const plaidClient = getPlaidClient();
      const response = await plaidClient.itemPublicTokenExchange({
        public_token: public_token,
      });

      const { access_token, item_id } = response.data;

      // Get account information
      const accountsResponse = await plaidClient.accountsGet({
        access_token: access_token,
      });

      const accounts = accountsResponse.data.accounts;

      // Store access token and account info in Firestore
      const db = admin.firestore();
      await db.collection('users').doc(user_id).collection('plaid_items').doc(item_id).set({
        access_token: access_token,
        item_id: item_id,
        accounts: accounts,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Store individual accounts for easier access
      for (const account of accounts) {
        await db.collection('users').doc(user_id).collection('accounts').doc(account.account_id).set({
          account_id: account.account_id,
          name: account.name,
          official_name: account.official_name,
          type: account.type,
          subtype: account.subtype,
          balance: account.balances.current,
          available: account.balances.available,
          item_id: item_id,
          plaid_account: true,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      res.json({ 
        success: true, 
        accounts: accounts,
        message: 'Bank account connected successfully!'
      });
    } catch (error) {
      console.error('Error exchanging public token:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Fetch transactions
exports.fetchTransactions = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { user_id, start_date, end_date } = req.body;
      
      const db = admin.firestore();
      const plaidItems = await db.collection('users').doc(user_id).collection('plaid_items').get();
      
      let allTransactions = [];

      for (const doc of plaidItems.docs) {
        const { access_token } = doc.data();
        
        const plaidClient = getPlaidClient();
        const response = await plaidClient.transactionsGet({
          access_token: access_token,
          start_date: start_date || '2023-01-01',
          end_date: end_date || new Date().toISOString().split('T')[0],
        });

        const transactions = response.data.transactions.map(tx => ({
          id: tx.transaction_id,
          account_id: tx.account_id,
          amount: -tx.amount, // Plaid uses positive for debits, we want negative for expenses
          date: tx.date,
          description: tx.name,
          category: tx.category ? tx.category[0] : 'Other',
          type: tx.amount > 0 ? 'expense' : 'income',
          merchant_name: tx.merchant_name,
          plaid_transaction: true,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        }));

        // Store transactions in Firestore
        const batch = db.batch();
        transactions.forEach(tx => {
          const txRef = db.collection('users').doc(user_id).collection('transactions').doc(tx.id);
          batch.set(txRef, tx, { merge: true });
        });
        await batch.commit();

        allTransactions = allTransactions.concat(transactions);
      }

      res.json({ 
        success: true, 
        transactions: allTransactions,
        count: allTransactions.length
      });
    } catch (error) {
      console.error('Error fetching transactions:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Update account balances
exports.updateBalances = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { user_id } = req.body;
      
      const db = admin.firestore();
      const plaidItems = await db.collection('users').doc(user_id).collection('plaid_items').get();
      
      for (const doc of plaidItems.docs) {
        const { access_token, item_id } = doc.data();
        
        const plaidClient = getPlaidClient();
        const response = await plaidClient.accountsGet({
          access_token: access_token,
        });

        const accounts = response.data.accounts;

        // Update account balances
        for (const account of accounts) {
          await db.collection('users').doc(user_id).collection('accounts').doc(account.account_id).update({
            balance: account.balances.current,
            available: account.balances.available,
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      res.json({ 
        success: true, 
        message: 'Account balances updated successfully!'
      });
    } catch (error) {
      console.error('Error updating balances:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Scheduled function to automatically sync transactions daily
exports.scheduledTransactionSync = functions.pubsub.schedule('every 24 hours').onRun(async (context) => {
  console.log('Starting scheduled transaction sync...');
  
  const db = admin.firestore();
  const usersSnapshot = await db.collection('users').get();
  
  for (const userDoc of usersSnapshot.docs) {
    const userId = userDoc.id;
    console.log(`Syncing transactions for user: ${userId}`);
    
    try {
      const plaidItems = await db.collection('users').doc(userId).collection('plaid_items').get();
      
      for (const doc of plaidItems.docs) {
        const { access_token } = doc.data();
        
        const endDate = new Date().toISOString().split('T')[0];
        const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // Last 30 days
        
        const plaidClient = getPlaidClient();
        const response = await plaidClient.transactionsGet({
          access_token: access_token,
          start_date: startDate,
          end_date: endDate,
        });

        const transactions = response.data.transactions.map(tx => ({
          id: tx.transaction_id,
          account_id: tx.account_id,
          amount: -tx.amount,
          date: tx.date,
          description: tx.name,
          category: tx.category ? tx.category[0] : 'Other',
          type: tx.amount > 0 ? 'expense' : 'income',
          merchant_name: tx.merchant_name,
          plaid_transaction: true,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        }));

        // Store new transactions
        const batch = db.batch();
        transactions.forEach(tx => {
          const txRef = db.collection('users').doc(userId).collection('transactions').doc(tx.id);
          batch.set(txRef, tx, { merge: true });
        });
        await batch.commit();
      }
    } catch (error) {
      console.error(`Error syncing transactions for user ${userId}:`, error);
    }
  }
  
  console.log('Scheduled transaction sync completed');
});

// ============ ADMIN FUNCTIONS ============

// Set admin role for a user (call this manually or via admin interface)
exports.setAdminRole = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { email, adminKey } = req.body;
      
      // Verify admin key (set this in Firebase Functions config)
      const config = functions.config();
      const expectedKey = config.admin && config.admin.key ? config.admin.key : 'your-secret-admin-key';
      
      if (adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Unauthorized' });
      }
      
      // Get user by email
      const user = await admin.auth().getUserByEmail(email);
      
      // Set custom claim
      await admin.auth().setCustomUserClaims(user.uid, { admin: true });
      
      // Update Firestore user document
      const db = admin.firestore();
      await db.collection('users').doc(user.uid).set({
        admin: true,
        adminSince: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      
      res.json({ 
        success: true, 
        message: `Admin role granted to ${email}`,
        uid: user.uid
      });
    } catch (error) {
      console.error('Error setting admin role:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Check if user is admin
exports.checkAdminStatus = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { uid } = req.body;
      
      if (!uid) {
        return res.status(400).json({ error: 'User ID required' });
      }
      
      const user = await admin.auth().getUser(uid);
      const isAdmin = user.customClaims && user.customClaims.admin === true;
      
      res.json({ isAdmin: isAdmin });
    } catch (error) {
      console.error('Error checking admin status:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Get all users (admin only)
exports.getAllUsers = functions.https.onCall(async (data, context) => {
  // Check if user is admin
  if (!context.auth || !context.auth.token.admin) {
    throw new functions.https.HttpsError('permission-denied', 'Only admins can access user list');
  }
  
  try {
    const listUsersResult = await admin.auth().listUsers(1000);
    const users = listUsersResult.users.map(user => ({
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      disabled: user.disabled,
      creationTime: user.metadata.creationTime,
      lastSignInTime: user.metadata.lastSignInTime,
      isAdmin: user.customClaims && user.customClaims.admin === true
    }));
    
    return { users };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// Create/Update global content items (admin only)
exports.manageContentItem = functions.https.onCall(async (data, context) => {
  // Check if user is admin
  if (!context.auth || !context.auth.token.admin) {
    throw new functions.https.HttpsError('permission-denied', 'Only admins can manage content');
  }
  
  try {
    const { action, itemId, itemData, collection } = data;
    const db = admin.firestore();
    
    if (!['create', 'update', 'delete'].includes(action)) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid action');
    }
    
    if (!collection) {
      throw new functions.https.HttpsError('invalid-argument', 'Collection name required');
    }
    
    if (action === 'create') {
      const docRef = await db.collection('global_content').doc(collection).collection('items').add({
        ...itemData,
        createdBy: context.auth.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { success: true, id: docRef.id, action: 'created' };
    }
    
    if (action === 'update') {
      if (!itemId) {
        throw new functions.https.HttpsError('invalid-argument', 'Item ID required for update');
      }
      await db.collection('global_content').doc(collection).collection('items').doc(itemId).update({
        ...itemData,
        updatedBy: context.auth.uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { success: true, id: itemId, action: 'updated' };
    }
    
    if (action === 'delete') {
      if (!itemId) {
        throw new functions.https.HttpsError('invalid-argument', 'Item ID required for delete');
      }
      await db.collection('global_content').doc(collection).collection('items').doc(itemId).delete();
      return { success: true, id: itemId, action: 'deleted' };
    }
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// Get all global content items
exports.getContentItems = functions.https.onCall(async (data, context) => {
  try {
    const { collection } = data;
    
    if (!collection) {
      throw new functions.https.HttpsError('invalid-argument', 'Collection name required');
    }
    
    const db = admin.firestore();
    const snapshot = await db.collection('global_content').doc(collection).collection('items').get();
    
    const items = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    return { items };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// Get platform statistics (admin only)
exports.getPlatformStats = functions.https.onCall(async (data, context) => {
  // Check if user is admin
  if (!context.auth || !context.auth.token.admin) {
    throw new functions.https.HttpsError('permission-denied', 'Only admins can view platform stats');
  }
  
  try {
    const db = admin.firestore();
    
    // Get user count
    const listUsersResult = await admin.auth().listUsers(1000);
    const totalUsers = listUsersResult.users.length;
    const activeUsers = listUsersResult.users.filter(user => !user.disabled).length;
    
    // Get total transactions count
    let totalTransactions = 0;
    const usersSnapshot = await db.collection('users').get();
    for (const userDoc of usersSnapshot.docs) {
      const txSnapshot = await db.collection('users').doc(userDoc.id).collection('transactions').count().get();
      totalTransactions += txSnapshot.data().count;
    }
    
    // Get connected accounts count
    let totalAccounts = 0;
    for (const userDoc of usersSnapshot.docs) {
      const accSnapshot = await db.collection('users').doc(userDoc.id).collection('accounts').count().get();
      totalAccounts += accSnapshot.data().count;
    }
    
    return {
      totalUsers,
      activeUsers,
      totalTransactions,
      totalAccounts,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// Disable/Enable user account (admin only)
exports.toggleUserStatus = functions.https.onCall(async (data, context) => {
  // Check if user is admin
  if (!context.auth || !context.auth.token.admin) {
    throw new functions.https.HttpsError('permission-denied', 'Only admins can toggle user status');
  }
  
  try {
    const { uid, disable } = data;
    
    if (!uid) {
      throw new functions.https.HttpsError('invalid-argument', 'User ID required');
    }
    
    await admin.auth().updateUser(uid, { disabled: disable });
    
    return { 
      success: true, 
      uid, 
      status: disable ? 'disabled' : 'enabled' 
    };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// Save site customization settings (admin only)
exports.saveSiteSettings = functions.https.onCall(async (data, context) => {
  // Check if user is admin
  if (!context.auth || !context.auth.token.admin) {
    throw new functions.https.HttpsError('permission-denied', 'Only admins can modify site settings');
  }
  
  try {
    const { settings } = data;
    const db = admin.firestore();
    
    await db.collection('site_settings').doc('global').set({
      ...settings,
      updatedBy: context.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    return { success: true };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// Get site customization settings
exports.getSiteSettings = functions.https.onCall(async (data, context) => {
  try {
    const db = admin.firestore();
    const doc = await db.collection('site_settings').doc('global').get();
    
    if (!doc.exists) {
      // Return default settings
      return {
        settings: {
          siteName: 'DoughMain',
          tagline: 'Take Control of Your Money',
          primaryColor: '#4f46e5',
          secondaryColor: '#764ba2',
          accentColor: '#667eea',
          heroTitle: 'Transform Your Financial Future',
          heroSubtitle: 'Your journey to financial freedom starts here. Track every dollar, crush your goals, and build the wealth you deserve.',
          ctaText: 'Start Free Today'
        }
      };
    }
    
    return { settings: doc.data() };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});
