import { firstMatch, isAiring, needsLibraries, planIntent } from './lib/rules.js'
import { formatEpisodes, fullSeason, minusEpisodes, parseEpisodes } from './lib/episodes.js'

const REPORT_PAGE = 200
const ITEM_PAGE = 50
const INTENT_PAGE = 200
const HISTORY_LIMIT = 300
const PREVIEW_LIMIT = 500

const keyOf = (proxyID, tmdbID, season) => `${proxyID}:${tmdbID}:${season}`
const withProxy = (path, proxyID) => proxyID ? `${path}${path.includes('?') ? '&' : '?'}proxy_id=${proxyID}` : path

async function listInstances(ctx) {
  const { items = [] } = await ctx.api.get('/api/plugin-host/emby/instances')
  return items.filter(item => item.api_key_configured !== false)
}

async function listMissing(ctx, proxyID) {
  const rows = []
  for (let offset = 0; ; offset += REPORT_PAGE) {
    const page = await ctx.api.get(withProxy(`/api/emby-manager/missing/report?status=incomplete&limit=${REPORT_PAGE}&offset=${offset}`, proxyID))
    rows.push(...(page.items || []))
    if (!page.items?.length || rows.length >= page.total) return rows
  }
}

async function listIntents(ctx) {
  const intents = new Map()
  for (let offset = 0; ; offset += INTENT_PAGE) {
    const page = await ctx.api.get(`/api/subscribe/pool/intents?media_type=tv&limit=${INTENT_PAGE}&offset=${offset}`)
    for (const intent of page.data || []) intents.set(`${intent.tmdb_id}:${intent.season}`, intent)
    if ((page.data || []).length < INTENT_PAGE) return intents
  }
}

// 媒体库 → 剧集 ID；只有规则用到媒体库时才列。
async function listLibraries(ctx, proxyID) {
  const owners = new Map()
  const { items: libraries = [] } = await ctx.api.get(withProxy('/api/plugin-host/emby/libraries', proxyID))
  for (const library of libraries) {
    for (let offset = 0; ; offset += ITEM_PAGE) {
      const page = await ctx.api.get(withProxy(`/api/plugin-host/emby/items?type=Series&library_id=${encodeURIComponent(library.id)}&limit=${ITEM_PAGE}&offset=${offset}`, proxyID))
      for (const item of page.items || []) owners.set(item.id, [...(owners.get(item.id) || []), library.id])
      if (!page.items?.length || offset + ITEM_PAGE >= page.total) break
    }
  }
  return owners
}

function seasonCandidates(row, detail, proxyID, libraryIDs) {
  let missing = []
  try { missing = JSON.parse(row.missing_detail || '[]') } catch { return [] }
  const seasons = (detail.seasons || []).filter(s => s.season_number > 0)
  const latest = Math.max(0, ...seasons.map(s => s.season_number))
  return missing.filter(m => m.season > 0 && m.episodes?.length).map(m => {
    const total = seasons.find(s => s.season_number === m.season)?.episode_count || 0
    return {
      key: keyOf(proxyID, row.tmdb_id, m.season), proxy_id: proxyID, series_id: row.emby_series_id,
      tmdb_id: row.tmdb_id, season: m.season, title: detail.name || row.series_name,
      needed: m.episodes, total, owned: Math.max(0, total - m.episodes.length),
      airing: isAiring(detail.status), latest_season: m.season === latest,
      year: Number(String(detail.first_air_date || '').slice(0, 4)) || 0,
      genres: (detail.genres || []).map(g => g.name), countries: detail.origin_country || [],
      library_ids: libraryIDs, poster_path: detail.poster_path || '', backdrop_path: detail.backdrop_path || '',
    }
  })
}

// 缺集结果是缓存：提交前再问一次 Emby，入库了的不再订阅。
async function liveNeeded(ctx, c) {
  const live = await ctx.api.get(withProxy(`/api/plugin-host/emby/episodes?tmdb_id=${c.tmdb_id}&season=${c.season}&total_episodes=${c.total}`, c.proxy_id))
  const owned = parseEpisodes(live.covered_episodes)
  return { needed: minusEpisodes(c.needed, owned), owned }
}

async function createIntent(ctx, c, rule, needed, owned) {
  const scope = rule.subscribe?.scope === 'follow' ? 'follow' : 'fixed'
  const body = {
    tmdb_id: c.tmdb_id, media_type: 'tv', title: c.title, year: c.year ? String(c.year) : '', season: c.season,
    total_episodes: c.total, episode_scope_mode: scope, library_snapshot_provided: true,
    initial_covered_episodes: formatEpisodes(owned), initial_needed_episodes: formatEpisodes(needed),
    poster_path: c.poster_path, backdrop_path: c.backdrop_path,
  }
  if (c.proxy_id) body.proxy_id = c.proxy_id
  if (rule.subscribe?.sources?.length) body.enabled_sources = rule.subscribe.sources
  return (await ctx.api.post('/api/subscribe/pool/intents', body)).data
}

async function mergeIntent(ctx, intent, c, needed) {
  const merged = [...new Set([...parseEpisodes(intent.needed_episodes), ...needed])]
  if (merged.length === parseEpisodes(intent.needed_episodes).length) return null
  const covered = minusEpisodes(fullSeason(c.total), merged)
  return (await ctx.api.patch(`/api/subscribe/pool/intents/${intent.id}/episodes`, {
    needed_episodes: formatEpisodes(merged), covered_episodes: formatEpisodes(covered), total_episodes: c.total,
  })).data
}

function hostErrorCode(error) { return error?.data?.code || '' }

async function notifySummary(ctx, settings, result) {
  if (!settings.notify_enabled) return
  if (!result.subscribed.length && !result.new_review) return
  const lines = result.subscribed.slice(0, 12).map(x => `- ${x.title} S${String(x.season).padStart(2, '0')}：${x.episodes}`)
  if (result.subscribed.length > 12) lines.push(`- 另有 ${result.subscribed.length - 12} 项`)
  if (result.new_review) lines.push(`待审核 ${result.new_review} 项`)
  const options = {
    title: '缺集自动订阅', level: result.failed ? 'warning' : 'success', format: 'markdown',
    body: lines.join('\n'), dedupe_key: `${ctx.task.id}:summary`,
  }
  if (settings.notify_channel && settings.notify_channel !== 'all') options.channels = [settings.notify_channel]
  if (result.new_review) options.buttons = [[{ text: '全部批准', callback_data: 'missing-subscribe:approve' }, { text: '全部忽略', callback_data: 'missing-subscribe:ignore' }]]
  try { await ctx.notify(options) } catch (error) { await ctx.task.log(`通知失败：${error.message}`) }
}

async function loadState(ctx) {
  return {
    ledger: await ctx.storage.get('ledger') || {}, review: await ctx.storage.get('review') || {},
    ignored: await ctx.storage.get('ignored') || {}, history: await ctx.storage.get('history') || [],
  }
}

async function saveState(ctx, state) {
  await ctx.storage.set('ledger', state.ledger)
  await ctx.storage.set('review', state.review)
  await ctx.storage.set('ignored', state.ignored)
  await ctx.storage.set('history', state.history.slice(0, HISTORY_LIMIT))
}

function record(state, c, action, detail, rule) {
  state.history.unshift({ at: new Date().toISOString(), key: c.key, title: c.title, season: c.season, tmdb_id: c.tmdb_id, poster_path: c.poster_path, episodes: formatEpisodes(c.needed), action, detail, rule: rule?.name || '' })
}

// 回写订阅结果。宿主订阅池只返回未收尾的意图（已完成的不在列表里），
// 所以「已补齐」以缺集报告为准：本插件提交过订阅、这一季又不再出现在缺集结果里 => landed。
// 反过来，标记过 landed 的季又缺集了（连载新增集），要退回进行中。
function reconcileLedger(state, intents, seen) {
  const at = new Date().toISOString()
  // 池里一条都没有，说明这轮没读到订阅池（接口异常或空返回），不能据此判定「订阅被删」。
  const poolKnown = intents.size > 0
  const lost = []
  for (const [key, entry] of Object.entries(state.ledger)) {
    const [, tmdbID, season] = key.split(':')
    const intent = intents.get(`${tmdbID}:${season}`)
    if (entry.intent_id && intent?.id === entry.intent_id) entry.outcome = intent.state
    else if (entry.intent_id && poolKnown && !entry.landed_at) lost.push(key)
    if (seen.has(key)) {
      if (entry.outcome === 'landed') { delete entry.outcome; delete entry.landed_at }
      continue
    }
    if (!entry.intent_id) { delete state.ledger[key]; continue }
    if (entry.outcome !== 'landed') { entry.outcome = 'landed'; entry.landed_at = at }
  }
  // 宿主订阅池里已经没有这条订阅（被删或被清理）：不能继续算作进行中。
  // 仍在缺集的由 planIntent 在下一轮重新建订阅，这里只把状态收口。
  for (const key of lost) {
    const entry = state.ledger[key]
    if (!entry || entry.outcome === 'landed' || entry.outcome === 'expired') continue
    entry.outcome = 'expired'
    entry.expired_at = at
  }
  for (const key of Object.keys(state.review)) if (!seen.has(key)) delete state.review[key]
}

function callbackAction(input) {
  const data = input?.data
  if (data === 'missing-subscribe:approve') return 'approve-all'
  if (data === 'missing-subscribe:ignore') return 'ignore-all'
  return ''
}

async function applyQueueAction(ctx, input, state, action) {
  const keys = input.keys?.length ? input.keys : Object.keys(state.review)
  for (const key of keys) {
    if (action === 'ignore' && state.review[key]) { state.ignored[key] = { title: state.review[key].title, season: state.review[key].season, at: new Date().toISOString() }; delete state.review[key] }
    if (action === 'unignore') delete state.ignored[key]
  }
  await saveState(ctx, state)
  return { action, count: keys.length }
}

export async function run(ctx, input = {}) {
  return evaluate(ctx, input, false)
}

export async function preview(ctx, input = {}) {
  return evaluate(ctx, input, true)
}

async function evaluate(ctx, input, dryRun) {
  const settings = await ctx.settings.get()
  const state = await loadState(ctx)
  const fromCallback = callbackAction(input)
  const action = fromCallback === 'ignore-all' ? 'ignore' : input.action
  if (action === 'ignore' || action === 'unignore') return applyQueueAction(ctx, input, state, action)
  const approveAll = fromCallback === 'approve-all'
  const approved = new Set(approveAll ? Object.keys(state.review) : input.approve || [])
  const manual = input.manual === true || approved.size > 0
  if (!dryRun && !manual && !settings.auto_enabled) return { skipped: '自动运行未开启' }

  const rules = await ctx.storage.get('rules') || []
  await ctx.task.update({ stage: 'load', message: '读取缺集结果与订阅' })
  const [instances, intents] = [await listInstances(ctx), await listIntents(ctx)]
  const now = Date.now(), seen = new Set(), details = new Map(), candidates = []
  const result = { dry_run: dryRun, scanned: 0, matched: 0, subscribed: [], merged: 0, skipped: 0, failed: 0, new_review: 0, deferred: 0 }

  for (const instance of instances) {
    const proxyID = instance.id || 0
    const owners = needsLibraries(rules) ? await listLibraries(ctx, proxyID) : new Map()
    for (const row of await listMissing(ctx, proxyID)) {
      if (!row.tmdb_id) continue
      try {
        if (!details.has(row.tmdb_id)) details.set(row.tmdb_id, await ctx.api.get(`/api/tmdb/tv/${row.tmdb_id}`))
      } catch (error) {
        result.failed++
        await ctx.task.log(`${row.series_name}：读取 TMDB 失败：${error.message}`)
        continue
      }
      candidates.push(...seasonCandidates(row, details.get(row.tmdb_id), proxyID, owners.get(row.emby_series_id) || []))
    }
  }
  await ctx.task.update({ stage: 'match', total: candidates.length, done: 0, failed: 0 })

  const previews = [], perRule = new Map()
  let budget = Number(settings.max_per_run) || 20, stopped = ''
  for (const c of candidates) {
    seen.add(c.key)
    result.scanned++
    const entry = state.ledger[c.key] ||= {}
    entry.first_seen ||= now
    // 存下可用于展示的字段：收起订阅后 ledger 也要能自解释，不必再回查宿主。
    entry.title = c.title
    entry.season = c.season
    entry.episodes = formatEpisodes(c.needed)
    if (c.poster_path) entry.poster_path = c.poster_path
    const rule = firstMatch(rules, c)
    const item = { key: c.key, title: c.title, season: c.season, tmdb_id: c.tmdb_id, poster_path: c.poster_path, episodes: formatEpisodes(c.needed), count: c.needed.length, total: c.total, airing: c.airing, rule: rule?.name || '', action: rule?.action || 'none', reason: '' }
    const isApproved = approved.has(c.key)
    const finish = reason => { item.reason = reason; if (dryRun) previews.push(item); else result.skipped++ }
    if (state.ignored[c.key]) { finish('已忽略'); continue }
    if (!rule && !isApproved) { finish('没有规则命中'); continue }
    if (rule?.action === 'ignore' && !isApproved) { finish('规则设为忽略'); continue }
    result.matched++
    const plan = planIntent(c, intents.get(`${c.tmdb_id}:${c.season}`), entry, { now, cooldown_days: Number(settings.cooldown_days) || 0 })
    if (plan.kind === 'skip') { finish(plan.reason); continue }
    const graceHours = Number(rule?.subscribe?.grace_hours) || 0
    if (!isApproved && now - entry.first_seen < graceHours * 3600000) { finish(`观察期内（${graceHours} 小时）`); continue }
    if (rule?.action === 'review' && !isApproved) {
      if (!dryRun && !state.review[c.key]) { state.review[c.key] = { ...item, at: new Date(now).toISOString() }; result.new_review++ }
      finish('待审核')
      continue
    }
    if (dryRun) { previews.push({ ...item, reason: plan.kind === 'patch' ? '将合并进订阅' : '将自动订阅' }); continue }

    const ruleCap = Number(rule?.subscribe?.max_per_run) || Infinity
    if (stopped || budget <= 0 || (perRule.get(rule?.id) || 0) >= ruleCap) { result.deferred++; continue }
    try {
      const live = await liveNeeded(ctx, c)
      if (!live.needed.length) { result.skipped++; continue }
      const intent = intents.get(`${c.tmdb_id}:${c.season}`)
      const useRule = rule || { subscribe: {} }
      const saved = plan.kind === 'patch' ? await mergeIntent(ctx, intent, c, live.needed) : await createIntent(ctx, c, useRule, live.needed, live.owned)
      if (!saved) { result.skipped++; continue }
      Object.assign(entry, { intent_id: saved.id, rule_id: rule?.id || '', last_action_at: new Date().toISOString(), outcome: saved.state })
      delete state.review[c.key]
      budget--
      perRule.set(rule?.id, (perRule.get(rule?.id) || 0) + 1)
      c.needed = live.needed
      if (plan.kind === 'patch') result.merged++
      result.subscribed.push({ title: c.title, season: c.season, episodes: formatEpisodes(live.needed) })
      record(state, c, plan.kind === 'patch' ? 'merged' : 'subscribed', '', rule)
      await ctx.sleep(Number(settings.throttle_ms) || 0)
    } catch (error) {
      const code = hostErrorCode(error)
      if (code === 'no_episodes_needed' || code === 'duplicate') { result.skipped++; continue }
      result.failed++
      record(state, c, 'failed', error.data?.error || error.message, rule)
      await ctx.task.log(`${c.title} S${c.season}：${error.message}`)
      if (code === 'not_premium' || code === 'no_source') stopped = error.data?.error || code
    }
    await ctx.task.update({ stage: 'subscribe', message: c.title, done: result.subscribed.length, failed: result.failed })
    await ctx.task.checkpoint({ stage: 'subscribe', subscribed: result.subscribed.length })
  }

  if (dryRun) {
    const output = { ...result, at: new Date(now).toISOString(), items: previews.slice(0, PREVIEW_LIMIT), truncated: previews.length > PREVIEW_LIMIT }
    await ctx.storage.set('preview', output)
    return { scanned: result.scanned, items: previews.length }
  }
  // TMDB 读取失败时这一轮看到的不完整，不能据此清记录
  if (!result.failed) reconcileLedger(state, intents, seen)
  await saveState(ctx, state)
  const summary = { ...result, stopped, at: new Date(now).toISOString(), source: approved.size ? 'approve' : input.type ? 'event' : manual ? 'manual' : 'schedule' }
  await ctx.storage.set('last_run', summary)
  await notifySummary(ctx, settings, result)
  if (stopped) throw new Error(`已停止：${stopped}`)
  return summary
}

// 每轮都先重读订阅与缺集结果，已提交的会被判为已有订阅，重跑不会重复创建。
export async function recover() {
  return { action: 'resume' }
}
