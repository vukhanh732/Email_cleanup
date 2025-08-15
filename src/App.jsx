import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Mail, Trash2, Archive, ScanEye, LogOut, Sparkles, Link2, MailMinus, Settings, Square } from 'lucide-react'

// 🔐 Put your Web OAuth Client ID here
const GCP_CLIENT_ID = '586502355695-nt8rk43ialc5fosanf74t3tup1jpvb99.apps.googleusercontent.com'
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

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

export default function App() {
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

  // ⚡️ Speed controls
  const [maxPages, setMaxPages] = useState(6) // ~600 messages
  const [concurrency, setConcurrency] = useState(12) // parallel message.get calls
  const cancelRef = useRef({ cancel: false })

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

  async function signIn() {
    if (!gisReady || !gapiReady) return
    // eslint-disable-next-line no-undef
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GCP_CLIENT_ID,
      scope: GMAIL_SCOPE,
      callback: async (resp) => {
        if (resp.error) { console.error(resp); return }
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

  function applyPreset(p) {
    if (p === 'promotions') setQuery('category:promotions')
    if (p === 'newsletters') setQuery('has:list-unsubscribe')
    if (p === 'older90') setQuery('(category:promotions OR has:list-unsubscribe) older_than:90d')
    if (p === 'older180') setQuery('(category:promotions OR has:list-unsubscribe) older_than:180d')
  }

  function stopScan() {
    cancelRef.current.cancel = true
    setStatus('Cancelling…')
  }

  // 🚀 FAST: parallel detail fetch + progressive render
  async function searchMessages() {
    if (!isAuthed) return
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

        // fetch details with concurrency pool
        await fetchWithConcurrency(msgs.map(m=>m.id), concurrency, async (id) => {
          if (cancelRef.current.cancel) return
          // eslint-disable-next-line no-undef
          const det = await gapi.client.gmail.users.messages.get({
            userId: 'me', id, format: 'metadata',
            metadataHeaders: ['From','Subject','Date','List-Unsubscribe']
          })
          const headers = det.result.payload?.headers || []
          const from = parseHeader(headers, 'From')
          const subject = parseHeader(headers, 'Subject')
          const date = parseHeader(headers, 'Date')
          const lu = parseHeader(headers, 'List-Unsubscribe')
          const unsub = extractListUnsubscribe(lu)
          const email = emailFrom(from)
          const domain = domainFrom(email)
          const ts = Date.parse(date) || 0
          const msgObj = { id, snippet: det.result.snippet, from, email, domain, subject, date, ts, unsub }
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
    for (const m of items) {
      if (allSelected) next.delete(m.id); else next.add(m.id)
    }
    setSelectedIds(next)
  }

  function toggleDomain(domain) {
    const next = new Set(selectedIds)
    const items = messages.filter(m => m.domain === domain)
    const allSelected = items.every(x => next.has(x.id))
    for (const m of items) {
      if (allSelected) next.delete(m.id); else next.add(m.id)
    }
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

  async function doDelete(archiveOnly=false) {
    if (selectedIds.size === 0) { setStatus('Select at least one message'); return }
    const ids = Array.from(selectedIds)
    if (dryRun) { setStatus(`[Dry-run] Would ${archiveOnly?'archive':'delete'} ${ids.length} messages`); return }
    try {
      // eslint-disable-next-line no-undef
      await gapi.client.gmail.users.messages.batchModify({
        userId: 'me',
        resource: { ids, addLabelIds: archiveOnly ? [] : ['TRASH'], removeLabelIds: archiveOnly ? ['INBOX'] : [] }
      })
      setStatus(`${archiveOnly?'Archived':'Deleted'} ${ids.length} messages`)
      await searchMessages()
    } catch (e) { console.error(e); setStatus(`Error: ${formatGapiError(e)}`) }
  }

  async function doUnsubscribe() {
    if (selectedIds.size === 0) { setStatus('Select at least one message'); return }
    const ids = new Set(selectedIds)
    let opened = 0, mailed = 0, failed = 0
    for (const msg of messages) {
      if (!ids.has(msg.id)) continue
      const links = msg.unsub || []
      if (links.length === 0) { failed++; continue }
      for (const l of links) {
        if (l.kind === 'http') {
          if (dryRun) continue
          try { await fetch(l.url, { method: 'GET', mode: 'no-cors' }); opened++ }
          catch { window.open(l.url, '_blank'); opened++ }
        } else if (l.kind === 'mailto') {
          mailed++; if (!dryRun) window.open(l.url, '_blank')
        }
      }
    }
    setStatus(`${dryRun?'[Dry-run] Would attempt':'Attempted'} unsubscribe: ${opened} link(s), ${mailed} mailto(s), ${failed} without headers`)
  }

  const pct = Math.min(100, Math.round((progress.msgs % 100) / 100 * 100)) // visual only

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-sky-50 to-teal-50 text-gray-900">
      <div className="max-w-7xl mx-auto p-6">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-white shadow flex items-center justify-center"><Mail className="h-5 w-5"/></div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Gmail Cleanup</h1>
              <p className="text-sm text-gray-600">Scan • Group by sender • Select by domain • Inactivity preset • Unsubscribe • Delete • Archive</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm bg-white/70 rounded-xl px-3 py-2 shadow">
              <input type="checkbox" className="accent-indigo-600" checked={dryRun} onChange={e=>setDryRun(e.target.checked)} />
              Dry-run
            </label>
            {!isAuthed ? (
              <button className="px-4 py-2 rounded-2xl bg-indigo-600 text-white shadow hover:shadow-md" onClick={signIn}>Sign in with Google</button>
            ) : (
              <div className="text-right bg-white/70 rounded-xl px-3 py-2 shadow">
                <div className="text-sm font-medium">{profile?.emailAddress || 'Signed in'}</div>
                <div className="text-xs text-gray-500">Scope: gmail.modify</div>
              </div>
            )}
          </div>
        </header>

        {/* Settings row */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-500 mr-1 flex items-center gap-1"><Sparkles className="h-4 w-4"/> Presets:</span>
            <button className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-indigo-500 to-indigo-600 text-white shadow" onClick={()=>applyPreset('promotions')}>Promotions</button>
            <button className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-sky-600 text-white shadow" onClick={()=>applyPreset('newsletters')}>Newsletters</button>
            <button className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-rose-500 to-rose-600 text-white shadow" onClick={()=>applyPreset('older90')}>Older than 90d</button>
            <button className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 text-white shadow" onClick={()=>applyPreset('older180')}>Older than 180d</button>
          </div>
          <div className="flex items-center gap-2 bg-white/80 rounded-xl px-3 py-2 shadow border border-white/60">
            <Settings className="h-4 w-4"/>
            <label className="text-sm flex items-center gap-1">Max pages: <input type="number" min="1" max="20" value={maxPages} onChange={e=>setMaxPages(parseInt(e.target.value||'1'))} className="w-16 border rounded px-2 py-1"/></label>
            <label className="text-sm flex items-center gap-1">Concurrency: <input type="number" min="1" max="24" value={concurrency} onChange={e=>setConcurrency(parseInt(e.target.value||'1'))} className="w-16 border rounded px-2 py-1"/></label>
          </div>
        </div>

        {/* Query + Scan/Stop */}
        <section className="bg-white/80 backdrop-blur rounded-2xl shadow p-4 mb-4 border border-white/60">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 flex items-center gap-2">
              <ScanEye className="h-4 w-4 text-indigo-600"/>
              <input className="flex-1 border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Gmail search query (e.g., has:list-unsubscribe OR category:promotions)" />
            </div>
            {!loading ? (
              <button disabled={!isAuthed} onClick={searchMessages} className="px-4 py-2 rounded-2xl bg-gray-900 text-white shadow">Scan</button>
            ) : (
              <button onClick={stopScan} className="px-4 py-2 rounded-2xl bg-rose-600 text-white shadow flex items-center gap-2"><Square className="h-4 w-4"/>Stop</button>
            )}
          </div>

          {/* progress bar */}
          <AnimatePresence>
            {loading && (
              <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="mt-3">
                <div className="h-2 w-full bg-white/60 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500" style={{width: `${pct}%`, transition:'width .25s'}} />
                </div>
                <div className="text-xs text-gray-600 mt-1">Scanning… pages: {progress.pages}, messages: {progress.msgs}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        {/* Actions + Status */}
        <section className="bg-white/80 backdrop-blur rounded-2xl shadow p-4 border border-white/60">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <button onClick={toggleAll} className="px-3 py-2 rounded-xl border hover:bg-gray-50">{selectedIds.size===messages.length?'Unselect all':'Select all'}</button>
              <button onClick={()=>doUnsubscribe()} disabled={messages.length===0} className="px-3 py-2 rounded-xl border hover:bg-gray-50 flex items-center gap-2"><Link2 className="h-4 w-4"/>Unsubscribe</button>
              <button onClick={()=>doDelete(false)} disabled={messages.length===0} className="px-3 py-2 rounded-xl border hover:bg-gray-50 flex items-center gap-2"><Trash2 className="h-4 w-4"/>Delete</button>
              <button onClick={()=>doDelete(true)} disabled={messages.length===0} className="px-3 py-2 rounded-xl border hover:bg-gray-50 flex items-center gap-2"><Archive className="h-4 w-4"/>Archive</button>
            </div>
            <div className="text-sm text-gray-600">Selected {selectedIds.size} / {messages.length}</div>
          </div>

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
                              <a key={i} className="text-indigo-700 hover:text-indigo-900 underline" href={dryRun?'#':u.url} onClick={e=>{ if(dryRun){ e.preventDefault(); } }} target="_blank" rel="noreferrer">
                                {u.kind === 'mailto' ? <span className="inline-flex items-center gap-1"><MailMinus className="h-4 w-4"/>mailto</span> : <span className="inline-flex items-center gap-1"><Link2 className="h-4 w-4"/>link</span>}
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
    </div>
  )
}