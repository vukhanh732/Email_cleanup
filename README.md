# Gmail Cleanup (Web)

A client-only React app that connects to Gmail and lets you scan, group by sender, unsubscribe, delete, and archive messages. Includes presets like Promotions and older_than filters.

## Prereqs
- Node.js 18+
- A Google Cloud project with Gmail API enabled

## Google Cloud setup
1. Go to **Google Cloud Console → APIs & Services → Credentials**.
2. **Create Credentials → OAuth client ID → Web application**.
3. Add **Authorized JavaScript origins** (e.g., `http://localhost:5173`).
4. Save your **Client ID**.
5. Go to **Library** and enable **Gmail API** for your project.

## Local dev
```bash
npm install
# Set your Client ID in src/App.jsx: const GCP_CLIENT_ID = "REPLACE_ME.apps.googleusercontent.com";
npm run dev