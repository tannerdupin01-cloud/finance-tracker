# Admin Account Setup Guide

This guide explains how to set up and use the admin account system in DoughMain Finance Tracker.

## Overview

The admin system allows designated users to:
- View platform statistics (total users, transactions, accounts)
- Manage user accounts (enable/disable users)
- Create and manage global content (announcements, tips, etc.)
- Monitor platform health and usage

## Initial Setup

### Step 1: Deploy Firebase Functions

First, deploy the backend functions that handle admin operations:

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

### Step 2: Set Admin Key

Set a secret admin key in Firebase Functions configuration:

```bash
firebase functions:config:set admin.key="YOUR_SECRET_ADMIN_KEY_HERE"
```

Replace `YOUR_SECRET_ADMIN_KEY_HERE` with a strong, random secret key. Keep this secure!

After setting the config, redeploy functions:

```bash
firebase deploy --only functions
```

### Step 3: Grant Admin Role to User

To grant admin privileges to a user, you'll need to call the `setAdminRole` function. You can do this using curl or any HTTP client:

```bash
curl -X POST https://YOUR-PROJECT-ID.cloudfunctions.net/setAdminRole \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "adminKey": "YOUR_SECRET_ADMIN_KEY_HERE"
  }'
```

Replace:
- `YOUR-PROJECT-ID` with your Firebase project ID (found in firebase.json or Firebase console)
- `admin@example.com` with the email of the user you want to make an admin
- `YOUR_SECRET_ADMIN_KEY_HERE` with the secret key you set in Step 2

**Important:** The user must already have an account in your system before you can grant them admin privileges.

### Step 4: Verify Admin Access

1. Sign out if currently logged in
2. Sign in with the admin account
3. The admin should automatically be granted access to admin features

## Admin Features

### Platform Statistics

Admins can view:
- Total number of users
- Active user count
- Total transactions across all users
- Total connected accounts
- Platform usage metrics

### User Management

Admins can:
- View all user accounts
- See user details (email, creation date, last sign-in)
- Enable or disable user accounts
- View which users have admin privileges

### Content Management

Admins can create and manage global content items that appear to all users:
- **Announcements**: Important platform updates or messages
- **Tips**: Financial advice or platform usage tips
- **Featured Content**: Highlight specific features or content

Content items support:
- Title and description
- Rich text formatting
- Published/unpublished status
- Priority ordering

## Using the Admin Panel

### Accessing Admin Features

Once logged in as an admin, you'll see an additional "Admin" tab in the navigation menu.

### Managing Users

1. Navigate to the Admin tab
2. Click on "User Management"
3. You'll see a list of all users with options to:
   - View user details
   - Enable/disable user accounts
   - See admin status

### Managing Content

1. Navigate to the Admin tab
2. Click on "Content Management"
3. To add new content:
   - Click "+ Add Announcement"
   - Fill in the title and description
   - Set priority (optional)
   - Click "Save"
4. To edit existing content:
   - Click the edit button on any content item
   - Make your changes
   - Click "Update"
5. To delete content:
   - Click the delete button on any content item
   - Confirm the deletion

### Viewing Statistics

1. Navigate to the Admin tab
2. View the dashboard with real-time statistics:
   - User growth metrics
   - Transaction volume
   - Platform engagement stats

## Security Best Practices

1. **Protect Your Admin Key**: Never commit the admin key to version control or share it publicly
2. **Limit Admin Accounts**: Only grant admin privileges to trusted users
3. **Regular Audits**: Periodically review the list of admin users
4. **Secure Admin Email**: Ensure admin accounts use strong passwords and 2FA
5. **Monitor Admin Actions**: Keep logs of admin activities for audit purposes

## Firestore Security Rules

Update your Firestore security rules to protect admin-only data:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // User data - users can only read/write their own data
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      
      match /{document=**} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
    
    // Global content - all authenticated users can read, only admins can write
    match /global_content/{document=**} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.token.admin == true;
    }
  }
}
```

Deploy the rules:

```bash
firebase deploy --only firestore:rules
```

## Troubleshooting

### Admin Access Not Working

1. **Verify Admin Status**: Check that the user has the admin custom claim:
   ```bash
   firebase auth:export users.json
   # Check the exported file for customClaims
   ```

2. **Force Token Refresh**: Have the user sign out and sign back in to refresh their auth token

3. **Check Function Logs**: View Firebase Function logs for any errors:
   ```bash
   firebase functions:log
   ```

### Cannot Call Admin Functions

1. **CORS Issues**: Ensure your Firebase Functions have CORS properly configured
2. **Authentication**: Verify the user is properly authenticated
3. **Function Deployment**: Confirm all functions are deployed successfully

### Content Not Appearing

1. **Check Firestore**: Verify content is being saved to Firestore
2. **Security Rules**: Ensure security rules allow reading global content
3. **Function Errors**: Check for any errors in the browser console

## API Reference

### Admin Functions

#### `setAdminRole`
Grants admin privileges to a user.

**Request:**
```json
{
  "email": "user@example.com",
  "adminKey": "secret-key"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Admin role granted to user@example.com",
  "uid": "user-uid"
}
```

#### `getAllUsers` (callable)
Returns list of all users (admin only).

**Returns:**
```json
{
  "users": [
    {
      "uid": "user-id",
      "email": "user@example.com",
      "displayName": "User Name",
      "creationTime": "2024-01-01T00:00:00Z",
      "lastSignInTime": "2024-01-15T00:00:00Z",
      "isAdmin": false
    }
  ]
}
```

#### `getPlatformStats` (callable)
Returns platform statistics (admin only).

**Returns:**
```json
{
  "totalUsers": 100,
  "activeUsers": 85,
  "totalTransactions": 5000,
  "totalAccounts": 150,
  "timestamp": "2024-01-15T12:00:00Z"
}
```

#### `manageContentItem` (callable)
Create, update, or delete global content (admin only).

**Request:**
```json
{
  "action": "create|update|delete",
  "collection": "announcements",
  "itemData": {
    "title": "New Feature!",
    "description": "Check out our new budgeting tool",
    "priority": 1
  },
  "itemId": "item-id" // required for update/delete
}
```

#### `toggleUserStatus` (callable)
Enable or disable a user account (admin only).

**Request:**
```json
{
  "uid": "user-id",
  "disable": true
}
```

## Support

For additional help or questions about the admin system:
1. Check the Firebase Console for logs and errors
2. Review the function source code in `functions/index.js`
3. Consult Firebase documentation for Authentication and Functions

## Future Enhancements

Potential admin features to add:
- Bulk user operations
- Advanced analytics and reporting
- Email notification system
- Content scheduling
- Role-based permissions (super admin, moderator, etc.)
- Audit log viewer
- Data export capabilities
- User impersonation for support
