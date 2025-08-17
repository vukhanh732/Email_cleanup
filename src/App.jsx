import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Mail, Trash2, Archive, ScanEye, LogOut, Sparkles, Link2, MailMinus, Settings, Square } from 'lucide-react'

// ---------- helpers ----------
function parseHeader(headers, name) {
  const h = headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())
  return h?.value || ''
}
function extractListUnsubscribe(value) {
  const parts = []
  const rx = /<([^>]+)>/g
  let m
  while ((m = rx.exec(value)) !== null) {
    const v = m[1].trim()
    if (!v) continue
    if (/^mailto:/i.test(v)) parts.push({ kind: 'mailto', url: v })
    else if (/^https?:/i.test(v)) parts.push({ kind: 'http', url: v })
  }
  if (parts.length === 0 && value) {
    for (const raw of value.split(/[\s,]+/)) {
      const v = raw.trim(); if (!v) continue
      if (/^mailto:/i.test(v)) parts.push({ kind: 'mailto', url: v })
      else if (/^https?:/i.test(v)) parts.push({ kind: 'http', url: v })
    }
  }
  return parts
}
function formatGapiError(e) {
  try { return e?.result?.error?.message || e?.message || JSON.stringify(e); }
  catch { return String(e); }
}
async function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`)) return
  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src; s.async = true; s.defer = true
    s.onload = resolve; s.onerror = reject
    document.head.appendChild(s)
  })
}
function emailFrom(fromHeader) {
  if (!fromHeader) return '(unknown)'
  const m = fromHeader.match(/<([^>]+)>/)
  const e = (m ? m[1] : fromHeader).trim().toLowerCase()
  return e
}
function domainFrom(email) {
  const idx = email.indexOf('@')
  return idx > -1 ? email.slice(idx + 1) : '(unknown)'
}

// simple toast system
function uid() { return Math.random().toString(36).slice(2) }
function useToasts() {
  const [toasts, setToasts] = useState([])
  function toast(message, type='info', ttl=3500) {
    const id = uid()
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), ttl)
  }
  return { toasts, toast }
}

// ---------- app ----------
export default function App() {
  // BYO Client ID
  const [clientId, setClientId] = useState(() => localStorage.getItem('gmailCleanup.clientId') || '')
  const [showClientIdTips, setShowClientIdTips] = useState(false)

  const [gisReady, setGisReady] = useState(false)
  const [gapiReady, setGapiReady] = useState(false)
  const [token, setToken] = useState(null)
  const [profile, setProfile] = useState(null)

  const [dryRun, setDryRun] = useState(true)
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState([])
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [query, setQuery] = useState('category:promotions OR has:list-unsubscribe')
  const [status, setStatus] = useState('')
  const [groupBySender, setGroupBySender] = useState(true)
  const [progress, setProgress] = useState({stage:'idle', pages:0, msgs:0})

  // ⚡️ speed controls
  const [maxPages, setMaxPages] = useState(6)          // ~600 messages
  const [concurrency, setConcurrency] = useState(12)   // parallel detail fetches
  const cancelRef = useRef({ cancel: false })

  // UI feedback
  const { toasts, toast } = useToasts()
  const [acting, setActing] = useState(false)
  const [openTabs, setOpenTabs] = useState(false)      // unsubscribe behavior

  useEffect(() => {
    (async () => {
      await loadScript('https://accounts.google.com/gsi/client')
      setGisReady(true)
      await loadScript('https://apis.google.com/js/api.js')
      // eslint-disable-next-line no-undef
      gapi.load('client', async () => {
        try {
          // eslint-disable-next-line no-undef
          await gapi.client.init({})
          setGapiReady(true)
        } catch (e) { console.error(e) }
      })
    })()
  }, [])

  const isAuthed = !!token

  function saveClientId() {
    if (!clientId.trim()) { toast('Enter a valid Web Client ID', 'warn'); return }
    localStorage.setItem('gmailCleanup.clientId', clientId.trim())
    toast('Client ID saved', 'success')
  }
  function clearClientId() {
    localStorage.removeItem('gmailCleanup.clientId')
    setClientId('')
    toast('Client ID cleared', 'success')
  }

  async function signIn() {
    if (!gisReady || !gapiReady) return
    if (!clientId.trim()) { toast('Add your Google Web Client ID first', 'warn'); return }
    // eslint-disable-next-line no-undef
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(),
      scope: 'https://www.googleapis.com/auth/gmail.modify',
      callback: async (resp) => {
        if (resp.error) { console.error(resp); toast(`Sign-in error: ${resp.error}`, 'error'); return }
        setToken(resp.access_token)
        // eslint-disable-next-line no-undef
        gapi.client.setToken({ access_token: resp.access_token })
        // eslint-disable-next-line no-undef
        await gapi.client.load('https://gmail.googleapis.com/$discovery/rest?version=v1')
        await fetchProfile()
      }
    })
    client.requestAccessToken()
  }

  async function fetchProfile() {
    try {
      // eslint-disable-next-line no-undef
      const res = await gapi.client.gmail.users.getProfile({ userId: 'me' })
      setProfile(res.result)
    } catch (e) { console.error(e) }
  }

  // ---------- presets ----------
  function applyPreset(p) {
    const base = '(category:promotions OR has:list-unsubscribe)'
    if (p === 'promotions') setQuery('category:promotions')
    if (p === 'newsletters') setQuery('has:list-unsubscribe')
    if (p === 'last7') setQuery(`${base} newer_than:7d`)
    if (p === 'last30') setQuery(`${base} newer_than:30d`)
    if (p === 'older90') setQuery(`${base} older_than:90d`)
    if (p === 'older180') setQuery(`${base} older_than:180d`)
    if (p === 'older365') setQuery(`${base} older_than:365d`)
    if (p === 'unreadPromotions') setQuery('category:promotions is:unread')
    if (p === 'big5mb') setQuery('larger:5M')
    if (p === 'social') setQuery('category:social')
    if (p === 'primaryUnread') setQuery('category:primary is:unread')
  }

  function stopScan() {
    cancelRef.current.cancel = true
    setStatus('Cancelling…')
  }

  // ---------- scanning (fast, parallel, progressive) ----------
  async function searchMessages() {
    if (!isAuthed) { toast('Sign in first', 'warn'); return }
    cancelRef.current.cancel = false
    setLoading(true); setStatus('Searching…'); setProgress({stage:'listing', pages:0, msgs:0})
    setMessages([]); setSelectedIds(new Set())

    try {
      let pageToken = undefined
      let pagesFetched = 0
      let totalMsgs = 0

      while (!cancelRef.current.cancel && pagesFetched < maxPages) {
        // eslint-disable-next-line no-undef
        const res = await gapi.client.gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100, pageToken })
        const msgs = res.result.messages || []
        if (msgs.length === 0) break
        pagesFetched++
        setProgress(p => ({...p, pages: pagesFetched}))

        // Fetch details concurrently
        await fetchWithConcurrency(msgs.map(m=>m.id), concurrency, async (id) => {
          if (cancelRef.current.cancel) return
          // eslint-disable-next-line no-undef
          const det = await gapi.client.gmail.users.messages.get({
            userId: 'me', id, format: 'metadata',
            metadataHeaders: ['From','Subject','Date','List-Unsubscribe','List-Unsubscribe-Post']
          })
          const headers = det.result.payload?.headers || []
          const from = parseHeader(headers, 'From')
          const subject = parseHeader(headers, 'Subject')
          const date = parseHeader(headers, 'Date')
          const lu = parseHeader(headers, 'List-Unsubscribe')
          const lup = parseHeader(headers, 'List-Unsubscribe-Post')
          const unsub = extractListUnsubscribe(lu)
          const oneClick = /one-click/i.test(lup || '')
          const email = emailFrom(from)
          const domain = domainFrom(email)
          const ts = Date.parse(date) || 0
          const msgObj = { id, snippet: det.result.snippet, from, email, domain, subject, date, ts, unsub, oneClick }
          totalMsgs++
          setMessages(prev => [...prev, msgObj])
          setProgress(p => ({...p, msgs: p.msgs + 1}))
          setStatus(`Scanning… pages: ${pagesFetched}, messages: ${totalMsgs}`)
        })

        pageToken = res.result.nextPageToken
        if (!pageToken) break
      }

      if (cancelRef.current.cancel) setStatus(`Stopped. Fetched ${totalMsgs} messages`)
      else setStatus(`Done. Found ${totalMsgs} messages`)
      setProgress(p => ({...p, stage:'done'}))
    } catch (e) {
      console.error(e)
      setStatus(`Error: ${formatGapiError(e)}`)
      setProgress({stage:'idle', pages:0, msgs:0})
    } finally { setLoading(false) }
  }

  async function fetchWithConcurrency(items, limit, worker) {
    let i = 0
    const runners = Array.from({length: Math.min(limit, items.length)}).map(async () => {
      while (i < items.length && !cancelRef.current.cancel) {
        const cur = items[i++]
        try { await worker(cur) } catch (e) { console.error('worker error', e) }
      }
    })
    await Promise.all(runners)
  }

  // ---------- selection helpers ----------
  function toggle(id) {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelectedIds(next)
  }
  function toggleAll() {
    if (selectedIds.size === messages.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(messages.map(m => m.id)))
  }
  const grouped = useMemo(() => {
    if (!groupBySender) return null
    const map = new Map()
    for (const m of messages) {
      const key = m.email
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(m)
    }
    return map
  }, [messages, groupBySender])
  function toggleSender(key) {
    if (!grouped) return
    const next = new Set(selectedIds)
    const items = grouped.get(key) || []
    const allSelected = items.every(x => next.has(x.id))
    for (const m of items) { if (allSelected) next.delete(m.id); else next.add(m.id) }
    setSelectedIds(next)
  }
  function toggleDomain(domain) {
    const next = new Set(selectedIds)
    const items = messages.filter(m => m.domain === domain)
    const allSelected = items.every(x => next.has(x.id))
    for (const m of items) { if (allSelected) next.delete(m.id); else next.add(m.id) }
    setSelectedIds(next)
  }
  function selectInactiveSenders(days = 90) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const lastBySender = new Map()
    for (const m of messages) {
      const cur = lastBySender.get(m.email) || 0
      lastBySender.set(m.email, Math.max(cur, m.ts || 0))
    }
    const next = new Set(selectedIds)
    for (const m of messages) {
      const last = lastBySender.get(m.email) || 0
      if (last > 0 && last < cutoff) next.add(m.id)
    }
    setSelectedIds(next)
    setStatus(`Selected messages from senders inactive for ≥${days} days`)
  }

  // ---------- actions ----------
  async function doDelete(archiveOnly=false) {
    if (selectedIds.size === 0) { toast('Select at least one message', 'warn'); return }
    const ids = Array.from(selectedIds)
    if (dryRun) { toast(`[Dry-run] Would ${archiveOnly?'archive':'delete'} ${ids.length} messages`, 'info'); return }
    try {
      setActing(true)
      // eslint-disable-next-line no-undef
      await gapi.client.gmail.users.messages.batchModify({
        userId: 'me',
        resource: { ids, addLabelIds: archiveOnly ? [] : ['TRASH'], removeLabelIds: archiveOnly ? ['INBOX'] : [] }
      })
      setMessages(prev => prev.filter(m => !ids.includes(m.id))) // instant UI
      setSelectedIds(new Set())
      toast(`${archiveOnly?'Archived':'Deleted'} ${ids.length} messages`, 'success')
    } catch (e) {
      console.error(e)
      toast(`Delete error: ${formatGapiError(e)}`, 'error')
    } finally { setActing(false) }
  }

  async function doUnsubscribe() {
    if (selectedIds.size === 0) { toast('Select at least one message', 'warn'); return }

    const ids = new Set(selectedIds)
    let posted = 0, fetched = 0, mailed = 0, missing = 0, errors = 0

    setActing(true)
    try {
      for (const msg of messages) {
        if (!ids.has(msg.id)) continue
        const links = msg.unsub || []
        if (links.length === 0) { missing++; continue }

        const http = links.find(l => l.kind === 'http')
        const mail = links.find(l => l.kind === 'mailto')

        if (http) {
          if (dryRun) { fetched++; continue }

          if (msg.oneClick) {
            try {
              await fetch(http.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'List-Unsubscribe=One-Click',
                mode: 'no-cors',
                keepalive: true
              })
              posted++
            } catch { errors++ }
          } else {
            try {
              await fetch(http.url, { method: 'GET', mode: 'no-cors', keepalive: true })
              fetched++
            } catch { errors++ }
          }
          if (openTabs && !dryRun) window.open(http.url, '_blank', 'noopener,noreferrer')
        } else if (mail) {
          if (!dryRun) window.open(mail.url, '_blank', 'noopener,noreferrer')
          mailed++
        } else {
          missing++
        }
      }

      toast(
        dryRun
          ? `[Dry-run] Would: ${posted} POST, ${fetched} GET, ${mailed} mailto; ${missing} missing`
          : `Unsubscribe attempted: ${posted} POST, ${fetched} GET, ${mailed} mailto; ${missing} missing${errors ? `, ${errors} errors` : ''}`,
        errors ? 'warn' : 'success'
      )
    } catch (e) {
      console.error(e)
      toast(`Unsubscribe error: ${formatGapiError(e)}`, 'error')
    } finally {
      setActing(false)
    }
  }

  const pct = Math.min(100, Math.round((progress.msgs % 100) / 100 * 100)) // visual only

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-sky-50 to-teal-50 text-gray-900">
      <div className="max-w-7xl mx-auto p-6">

        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-white shadow flex items-center justify-center"><Mail className="h-5 w-5"/></div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Gmail Cleanup</h1>
              <p className="text-sm text-gray-600">Scan • Group by sender • Select by domain • Inactivity preset • Unsubscribe • Delete • Archive</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* BYO Client ID controls */}
            <div className="flex items-center gap-2 bg-white/70 rounded-xl p-2 shadow">
              <input
                className="border rounded-lg px-2 py-1 w-[260px]"
                placeholder="Your Google Web Client ID"
                value={clientId}
                onChange={e=>setClientId(e.target.value)}
              />
              <button className="text-sm px-3 py-1 rounded-lg bg-slate-900 text-white" onClick={saveClientId}>Save</button>
              <button className="text-sm px-3 py-1 rounded-lg border" onClick={clearClientId}>Clear</button>
              <button className="text-xs underline" onClick={()=>setShowClientIdTips(s=>!s)}>How to get this?</button>
            </div>

            <label className="flex items-center gap-2 text-sm bg-white/70 rounded-xl px-3 py-2 shadow">
              <input type="checkbox" className="accent-indigo-600" checked={dryRun} onChange={e=>setDryRun(e.target.checked)} />
              Dry-run
            </label>
            <label className="flex items-center gap-2 text-xs bg-white/70 rounded-xl px-2 py-1 shadow">
              <input type="checkbox" checked={openTabs} onChange={e=>setOpenTabs(e.target.checked)} />
              Open unsubscribe links in new tabs
            </label>
            {!isAuthed ? (
              <button className="px-4 py-2 rounded-2xl bg-indigo-600 text-white shadow" onClick={signIn}>Sign in with Google</button>
            ) : (
              <div className="text-right bg-white/70 rounded-xl px-3 py-2 shadow">
                <div className="text-sm font-medium">{profile?.emailAddress || 'Signed in'}</div>
                <div className="text-xs text-gray-500">Scope: gmail.modify</div>
              </div>
            )}
          </div>
        </header>

        {/* Client ID tips */}
        <AnimatePresence>
          {showClientIdTips && (
            <motion.div initial={{opacity:0, y:-6}} animate={{opacity:1, y:0}} exit={{opacity:0, y:-6}}
                        className="mb-3 bg-white/90 rounded-xl p-4 border text-sm">
              <div className="font-medium mb-1">Create your Google Web OAuth Client (one-time):</div>
              <ol className="list-decimal ml-5 space-y-1">
                <li>Go to <span className="underline">Google Cloud Console → APIs & Services → Credentials</span>.</li>
                <li><b>Create credentials → OAuth client ID → Application type: Web</b>.</li>
                <li>In <b>Authorized JavaScript origins</b>, add your site origin(s):<br/>
                  <code className="bg-slate-100 px-1 rounded">http://localhost:5173</code>{' '}(dev) and your deployed origin, e.g. <code className="bg-slate-100 px-1 rounded">https://your-domain.example</code>.
                </li>
                <li><b>Leave Authorized redirect URIs empty</b> (this app uses the token client).</li>
                <li>Copy the <b>Client ID</b> and paste it above, then click <b>Save</b>.</li>
              </ol>
              <div className="mt-2 text-xs text-gray-600">
                Note: You control your own OAuth client, so there’s no central verification required. You can change or clear it anytime.
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Presets + Settings */}
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-500 mr-1 flex items-center gap-1"><Sparkles className="h-4 w-4"/> Presets:</span>
            <button className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-indigo-500 to-indigo-600 text-white shadow" onClick={()=>applyPreset('promotions')}>Promotions</button>
            <button className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-sky-600 text-white shadow" onClick={()=>applyPreset('newsletters')}>Newsletters</button>
            <button className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow" onClick={()=>applyPreset('last7')}>Last 7d</button>
            <button className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-teal-500 to-teal-600 text-white shadow" onClick={()=>applyPreset('last30')}>Last 30d</button>
            <button className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-rose-500 to-rose-600 text-white shadow" onClick={()=>applyPreset('older90')}>Older 90d</button>
            <button className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 text-white shadow" onClick={()=>applyPreset('older180')}>Older 180d</button>
            <button className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow" onClick={()=>applyPreset('older365')}>Older 1y</button>
            <button className="px-3 py-1.5 rounded-xl border" onClick={()=>applyPreset('unreadPromotions')}>Unread promos</button>
            <button className="px-3 py-1.5 rounded-xl border" onClick={()=>applyPreset('big5mb')}>Big (&gt;5MB)</button>
            <button className="px-3 py-1.5 rounded-xl border" onClick={()=>applyPreset('social')}>Social</button>
            <button className="px-3 py-1.5 rounded-xl border" onClick={()=>applyPreset('primaryUnread')}>Primary unread</button>
          </div>
          <div className="flex items-center gap-2 bg-white/80 rounded-xl px-3 py-2 shadow border border-white/60">
            <Settings className="h-4 w-4"/>
            <label className="text-sm flex items-center gap-1">Max pages:
              <input type="number" min="1" max="20" value={maxPages} onChange={e=>setMaxPages(parseInt(e.target.value||'1'))} className="w-16 border rounded px-2 py-1"/>
            </label>
            <label className="text-sm flex items-center gap-1">Concurrency:
              <input type="number" min="1" max="24" value={concurrency} onChange={e=>setConcurrency(parseInt(e.target.value||'1'))} className="w-16 border rounded px-2 py-1"/>
            </label>
          </div>
        </div>

        {/* Query + Scan/Stop */}
        <section className="bg-white/80 backdrop-blur rounded-2xl shadow p-4 mb-4 border border-white/60">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 flex items-center gap-2">
              <ScanEye className="h-4 w-4 text-indigo-600"/>
              <input className="flex-1 border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                     value={query} onChange={e=>setQuery(e.target.value)}
                     placeholder="Gmail search query (e.g., has:list-unsubscribe OR category:promotions)" />
            </div>
            {!loading ? (
              <button disabled={!isAuthed} onClick={searchMessages}
                className="px-4 py-2 rounded-2xl bg-gray-900 text-white shadow">Scan</button>
            ) : (
              <button onClick={stopScan}
                className="px-4 py-2 rounded-2xl bg-rose-600 text-white shadow flex items-center gap-2">
                <Square className="h-4 w-4"/>Stop
              </button>
            )}
          </div>

          {/* progress bar */}
          <AnimatePresence>
            {loading && (
              <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="mt-3">
                <div className="h-2 w-full bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500" style={{width: `${Math.min(100, Math.round((progress.msgs % 100) / 100 * 100))}%`, transition:'width .25s'}} />
                </div>
                <div className="text-xs text-gray-600 mt-1">Scanning… pages: {progress.pages}, messages: {progress.msgs}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        {/* Actions + Table */}
        <section className="bg-white/80 backdrop-blur rounded-2xl shadow p-4 border border-white/60">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <button onClick={toggleAll} className="px-3 py-2 rounded-xl border hover:bg-gray-50">
                {selectedIds.size===messages.length?'Unselect all':'Select all'}
              </button>
              <button onClick={()=>doUnsubscribe()} disabled={messages.length===0 || acting}
                      className="px-3 py-2 rounded-xl border hover:bg-gray-50 flex items-center gap-2 disabled:opacity-50">
                <Link2 className="h-4 w-4"/>{acting ? 'Working…' : 'Unsubscribe'}
              </button>
              <button onClick={()=>doDelete(false)} disabled={messages.length===0 || acting}
                      className="px-3 py-2 rounded-xl border hover:bg-gray-50 flex items-center gap-2 disabled:opacity-50">
                <Trash2 className="h-4 w-4"/>{acting ? 'Working…' : 'Delete'}
              </button>
              <button onClick={()=>doDelete(true)} disabled={messages.length===0 || acting}
                      className="px-3 py-2 rounded-xl border hover:bg-gray-50 flex items-center gap-2 disabled:opacity-50">
                <Archive className="h-4 w-4"/>{acting ? 'Working…' : 'Archive'}
              </button>
            </div>
            <div className="text-sm text-gray-600">Selected {selectedIds.size} / {messages.length}</div>
          </div>

          {/* Domain chips */}
          {messages.length>0 && (
            <div className="flex flex-wrap gap-2 text-xs mb-3">
              <span className="text-gray-500">Domains:</span>
              {Array.from(new Set(messages.map(m => m.domain))).map(d => (
                <button key={d} onClick={()=>toggleDomain(d)} className="px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200">{d}</button>
              ))}
            </div>
          )}

          {/* Table */}
          <div className="overflow-auto rounded-xl border">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-100/80">
                <tr>
                  <th className="p-2 w-10"></th>
                  <th className="p-2 text-left">From</th>
                  <th className="p-2 text-left">Subject</th>
                  <th className="p-2 text-left">Date</th>
                  <th className="p-2 text-left">Unsubscribe</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {messages.map(m => (
                    <motion.tr key={m.id} initial={{opacity:0, y:8}} animate={{opacity:1, y:0}} exit={{opacity:0, y:-8}} className="odd:bg-white even:bg-gray-50">
                      <td className="p-2 align-top">
                        <input type="checkbox" className="accent-indigo-600" checked={selectedIds.has(m.id)} onChange={()=>toggle(m.id)} />
                      </td>
                      <td className="p-2 align-top">
                        <div className="font-medium break-words">{m.from || '(unknown)'}</div>
                        <div className="text-xs text-gray-500">{m.email} · {m.domain}</div>
                      </td>
                      <td className="p-2 align-top break-words">{m.subject}</td>
                      <td className="p-2 align-top">{m.date}</td>
                      <td className="p-2 align-top">
                        {(m.unsub?.length||0)===0 ? <span className="text-xs text-gray-400">—</span> : (
                          <div className="flex flex-wrap gap-2">
                            {m.unsub.map((u, i) => (
                              <a key={i} className="text-indigo-700 hover:text-indigo-900 underline"
                                 href={dryRun?'#':u.url}
                                 onClick={e=>{ if(dryRun){ e.preventDefault(); } }}
                                 target="_blank" rel="noreferrer">
                                {u.kind === 'mailto' ? <span className="inline-flex items-center gap-1"><MailMinus className="h-4 w-4"/>mailto</span> :
                                                       <span className="inline-flex items-center gap-1"><Link2 className="h-4 w-4"/>link</span>}
                              </a>
                            ))}
                          </div>
                        )}
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>

          <div className="mt-3 text-sm">{status}</div>
        </section>

        <footer className="text-xs text-gray-600 mt-6 flex items-center gap-2">
          <LogOut className="h-3.5 w-3.5"/>
          <p>Privacy: Everything runs client-side in your browser using your OAuth token.</p>
        </footer>
      </div>

      {/* Toasts */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map(t => (
          <div key={t.id}
               className={`px-4 py-2 rounded-xl shadow text-sm text-white ${
                 t.type==='success' ? 'bg-emerald-600' :
                 t.type==='error'   ? 'bg-rose-600' :
                 t.type==='warn'    ? 'bg-amber-600' : 'bg-slate-700'
               }`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}
