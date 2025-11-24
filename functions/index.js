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
        client_name: 'Finance Tracker',
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
