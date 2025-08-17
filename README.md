
# Gmail Cleanup — Web (BYO Google Client ID)

A fast, client‑side Gmail cleanup app built with **Vite + React** that lets you scan, group, unsubscribe, delete, and archive emails.  
Runs entirely in your browser using your Google OAuth token — no server.

## ✨ Highlights
- **Bring Your Own Google OAuth Client ID** (no central verification needed)
- **Fast scanning** with parallel requests, progress bar, and a **Stop** button
- Presets: Promotions, Newsletters, **Last 7/30 days**, **Older 90/180/365 days**, Unread promos, Social, Big (>5MB), Primary unread
- **Unsubscribe** supports RFC 8058 **One‑Click (POST)** and regular GET/mailto
- **Delete/Archive** with instant UI update (no auto-rescan)
- **Toasts & spinners** so you always see what’s happening
- Privacy‑friendly: everything stays **client-side**

---

## 🚀 Quick Start (Local)

```bash
npm install
npm run dev
# open http://localhost:5173
```

1) At the top of the page, paste **your Google Web OAuth Client ID**.  
2) Click **Save** → **Sign in with Google**.  
3) Click **Scan**, tweak presets, and take action (turn off **Dry‑run** to execute).

> BYO Client ID means each user uses **their own** OAuth client, so you don’t need Google’s app verification for public use.

---

## 🔧 Create Your Google Web OAuth Client (one‑time, per user)

1. Go to **Google Cloud Console → APIs & Services → Credentials**.  
2. **Create credentials → OAuth client ID → Application type: Web**.  
3. In **Authorized JavaScript origins**, add the exact origins you’ll use:
   - `http://localhost:5173` (dev)
   - your production origin, e.g. `https://your-domain.example` or `https://your-vercel-project.vercel.app`
4. **Leave Authorized redirect URIs empty** (this app uses the token client, not redirects).  
5. Copy the **Client ID** and paste it into the app’s **Client ID** field → **Save**.

> ✅ **Required:** The **Authorized JavaScript origins** must match your page’s origin exactly (no trailing slash).

---

## 🌍 Deploy (Vercel / Netlify / GitHub Pages)

This is a static site.

### Vercel (recommended)
- Import your repo.
- Build Command: `vite build`
- Output Directory: `dist`

### Netlify
- Build Command: `npm run build`
- Publish Directory: `dist`

### GitHub Pages
- Build locally (`npm run build`) and publish the `dist/` folder, or use Actions.

After deploy, users simply:
1. Open your site.
2. Paste **their own** Web Client ID (created via steps above).
3. Sign in and use the app.

---

## 🧰 Environment Variables (optional)

You can pre-fill the Client ID via Vite env:
- Add in Vercel/Netlify: `VITE_GCP_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com"`
- In code: read `import.meta.env.VITE_GCP_CLIENT_ID` and default to that when `localStorage` is empty.

The current app uses a **BYO Client ID** field in the UI by default, so env vars are optional.

---

## 📁 Project Structure

```
/ (repo root)
├─ src/
│  ├─ App.jsx         # main app (BYO Client ID + fast scanner + actions)
│  ├─ main.jsx
│  └─ styles.css
├─ public/
│  └─ examples/       
├─ index.html
├─ package.json
├─ vite.config.js
├─ .gitignore
└─ README.md
```

---

## 🔒 Scopes & Privacy

- Scope used: `https://www.googleapis.com/auth/gmail.modify`
- All actions happen **client‑side** in your browser with your OAuth token.
- The app does **not** send your data to a server.

---

## ❗ Common Issues

**`redirect_uri_mismatch` or blocked popup**  
- Make sure **Authorized JavaScript origins** includes the exact origin (e.g., `http://localhost:5173`, your production origin).  
- No trailing slash; no path segments.  
- You’re using a **Web** client (not “Desktop”).

**Unsubscribe opens blank tab**  
- Many unsubscribe endpoints return `204 No Content` (blank).  
- The app also tries **One‑Click (POST)** silently; enable “Open unsubscribe links in new tabs” if you want to see them.

**Nothing happens on Delete/Archive**  
- Turn **Dry‑run OFF** to actually execute.  
- After success, items disappear from the list without a rescan.

**Rate limits / CORS**  
- Gmail APIs may throttle; the app fetches with `no-cors` for unsubscribe to avoid errors.  
- Tune **Concurrency** and **Max pages** in the Settings row.

---

## 🧪 Dev Tips

- Start narrow queries (e.g., `has:list-unsubscribe newer_than:30d`).  
- Increase Concurrency (8–16) and reduce Max pages (3–6) for speed.  
- Use **Stop** to cancel large scans.  
- Use **Dry‑run** first to preview actions.

---

## 📜 License

MIT — do what you like, be nice, no warranty.
