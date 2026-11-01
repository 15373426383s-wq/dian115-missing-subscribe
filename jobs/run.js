import { firstMatch, isAiring, needsLibraries, planIntent } from './lib/rules.js'
import { formatEpisodes, fullSeason, minusEpisodes, parseEpisodes } from './lib/episodes.js'

const REPORT_PAGE = 200
const ITEM_PAGE = 50
const INTENT_PAGE = 200
const HISTORY_LIMIT = 300
const PREVIEW_LIMIT = 500
const MAX_PAGES = 200          // 分页硬上限：契约变更（total 缺失）时防止死循环/内存暴涨
const TMDB_CONCURRENCY = 4     // TMDB 详情预取并发上限：压墙钟时间又不打爆宿主/触发限流
const TMDB_MIN_INTERVAL = 150  // 对 TMDB 的最小访问间隔（毫秒）：经宿主转发，需克制频率避免限流
// 注意：throttle/cache 状态必须按每次运行隔离（见 evaluate 内声明），否则并发运行会互相串扰。
async function throttleTmdb(ctx, last) {
  const now = Date.now()
  const wait = Math.max(0, last.t + TMDB_MIN_INTERVAL - now)
  if (wait) await ctx.sleep(wait)
  last.t = Date.now()
}
const PRUNABLE_CLOSED = new Set(['landed', 'cancelled']) // 已结束且不会再命中的订阅记录可裁掉

const keyOf = (proxyID, tmdbID, season) => `${proxyID}:${tmdbID}:${season}`
const withProxy = (path, proxyID) => proxyID ? `${path}${path.includes('?') ? '&' : '?'}proxy_id=${proxyID}` : path

// 限并发映射：用固定数量 worker 消费 items，避免大库串行等待或一次性 Promise.all 打爆宿主。
async function mapLimit(items, limit, fn) {
  let i = 0
  const workers = []
  const n = Math.min(limit, items.length)
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (i < items.length) {
        const idx = i++
        await fn(items[idx], idx)
      }
    })())
  }
  await Promise.all(workers)
}

async function listInstances(ctx) {
  const { items = [] } = await ctx.api.get('/api/plugin-host/emby/instances')
  return items.filter(item => item.api_key_configured !== false)
}

// 分页统一受 MAX_PAGES 兜底；total 缺失时仅在 items 取空时退出。
async function listMissing(ctx, proxyID) {
  const rows = []
  for (let offset = 0, pageNo = 0; pageNo < MAX_PAGES; offset += REPORT_PAGE, pageNo++) {
    const page = await ctx.api.get(withProxy(`/api/emby-manager/missing/report?status=incomplete&limit=${REPORT_PAGE}&offset=${offset}`, proxyID))
    const items = page.items || []
    if (items.length) rows.push(...items)
    if (!items.length || (page.total != null && rows.length >= page.total)) return rows
  }
  await ctx.task.log('缺集报告分页超过上限，已截断')
  return rows
}

async function listIntents(ctx) {
  const intents = new Map()
  for (let offset = 0, pageNo = 0; pageNo < MAX_PAGES; offset += INTENT_PAGE, pageNo++) {
    const page = await ctx.api.get(`/api/subscribe/pool/intents?media_type=tv&limit=${INTENT_PAGE}&offset=${offset}`)
    const items = page.data || []
    for (const intent of items) intents.set(`${intent.tmdb_id}:${intent.season}`, intent)
    if (items.length < INTENT_PAGE) return intents
  }
  await ctx.task.log('订阅意图分页超过上限，已截断')
  return intents
}

// 媒体库 → 剧集 ID；只有规则用到媒体库时才列，且仅拉规则涉及的库（P4）。
// 数组用 push 进既有引用，避免每条插入都重建数组（O(系列×库) 碎写）。
async function listLibraries(ctx, proxyID, onlyIDs) {
  const owners = new Map()
  const { items: libraries = [] } = await ctx.api.get(withProxy('/api/plugin-host/emby/libraries', proxyID))
  const targets = onlyIDs && onlyIDs.size ? libraries.filter(l => onlyIDs.has(String(l.id))) : libraries
  for (const library of targets) {
    for (let offset = 0, pageNo = 0; pageNo < MAX_PAGES; offset += ITEM_PAGE, pageNo++) {
      const page = await ctx.api.get(withProxy(`/api/plugin-host/emby/items?type=Series&library_id=${encodeURIComponent(library.id)}&limit=${ITEM_PAGE}&offset=${offset}`, proxyID))
      const items = page.items || []
      for (const item of items) {
        const list = owners.get(item.id)
        if (list) list.push(library.id)
        else owners.set(item.id, [library.id])
      }
      if (!items.length || (page.total != null && offset + items.length >= page.total)) break
    }
  }
  return owners
}

function seasonCandidates(row, detail, proxyID, libraryIDs) {
  if (!detail) return []
  let missing = []
  try { missing = JSON.parse(row.missing_detail || '[]') } catch { return [] }
  const seasons = (detail.seasons || []).filter(s => s.season_number > 0)
  const latest = seasons.reduce((m, s) => s.season_number > m ? s.season_number : m, 0)
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
  // S4：只下发受控的、长度合理的来源，防止本地存储被篡改后下发非法值。
  if (Array.isArray(rule.subscribe?.sources)) {
    const valid = rule.subscribe.sources.filter(s => typeof s === 'string' && s.length > 0 && s.length <= 32)
    if (valid.length) body.enabled_sources = valid
  }
  return (await ctx.api.post('/api/subscribe/pool/intents', body)).data
}

async function mergeIntent(ctx, intent, c, needed) {
  const existingNeeded = parseEpisodes(intent.needed_episodes)
  const merged = [...new Set([...existingNeeded, ...needed])]
  if (merged.length === existingNeeded.length) return null
  // follow 订阅由宿主管理覆盖集，仅把缺失的过往集追加进 needed，不重写 covered（避免打断追剧逻辑）。
  const isFollow = intent.episode_scope_mode === 'follow' || intent.scope === 'follow'
  const covered = isFollow ? (intent.covered_episodes || '') : formatEpisodes(minusEpisodes(fullSeason(c.total), merged))
  return (await ctx.api.patch(`/api/subscribe/pool/intents/${intent.id}/episodes`, {
    needed_episodes: formatEpisodes(merged), covered_episodes: covered, total_episodes: c.total,
  })).data
}

function hostErrorCode(error) { return error?.data?.code || '' }

// S2：通知正文转义 markdown 特殊字符并截断标题，避免外部 TMDB 数据破坏消息或注入。
const escMarkdown = s => String(s).replace(/([`*_~>#[\]\\])/g, '\\$1').slice(0, 80)

async function notifySummary(ctx, settings, result) {
  if (!settings.notify_enabled) return
  if (!result.subscribed.length && !result.new_review) return
  const lines = result.subscribed.slice(0, 12).map(x => `- ${escMarkdown(x.title)} S${String(x.season).padStart(2, '0')}：${x.episodes}`)
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

// 回写订阅结果，并清掉不再缺集、且订阅已结束的观察记录（P5：裁掉 landed/cancelled 等不再命中的记录，遏制 ledger 无限增长）。
function reconcileLedger(state, intents, seen) {
  for (const [key, entry] of Object.entries(state.ledger)) {
    const [, tmdbID, season] = key.split(':')
    const intent = intents.get(`${tmdbID}:${season}`)
    if (entry.intent_id && intent?.id === entry.intent_id) entry.outcome = intent.state
    const prunable = intent && PRUNABLE_CLOSED.has(intent.state)
    if (!seen.has(key) && (!entry.intent_id || prunable || !intent)) delete state.ledger[key]
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

// 单个候选的匹配与提交。run 携带可变运行态（budget/stopped/perRule/result 等）。
async function processCandidate(ctx, c, run) {
  const { settings, state, rules, intents, dryRun, approved, now, result, previews, seen, perRule } = run
  seen.add(c.key)
  result.scanned++
  const entry = state.ledger[c.key] ||= {}
  entry.first_seen ||= now
  const rule = firstMatch(rules, c)
  const item = { key: c.key, title: c.title, season: c.season, tmdb_id: c.tmdb_id, poster_path: c.poster_path, episodes: formatEpisodes(c.needed), count: c.needed.length, total: c.total, airing: c.airing, rule: rule?.name || '', action: rule?.action || 'none', reason: '' }
  const isApproved = approved.has(c.key)
  const finish = reason => { item.reason = reason; if (dryRun) previews.push(item); else result.skipped++ }
  if (state.ignored[c.key]) { finish('已忽略'); return }
  if (!rule && !isApproved) { finish('没有规则命中'); return }
  if (rule?.action === 'ignore' && !isApproved) { finish('规则设为忽略'); return }
  result.matched++
  const plan = planIntent(c, intents.get(`${c.tmdb_id}:${c.season}`), entry, { now, cooldown_days: Number(settings.cooldown_days) || 0, patch_follow: rule?.subscribe?.patch_follow !== false })
  if (plan.kind === 'skip') { finish(plan.reason); return }
  const graceHours = Number(rule?.subscribe?.grace_hours) || 0
  if (!isApproved && now - entry.first_seen < graceHours * 3600000) { finish(`观察期内（${graceHours} 小时）`); return }
  if (rule?.action === 'review' && !isApproved) {
    if (!dryRun && !state.review[c.key]) { state.review[c.key] = { ...item, at: new Date(now).toISOString() }; result.new_review++ }
    finish('待审核')
    return
  }
  if (dryRun) { previews.push({ ...item, reason: plan.kind === 'patch' ? '将合并进订阅' : '将自动订阅' }); return }

  const ruleCap = Number(rule?.subscribe?.max_per_run) || Infinity
  if (run.stopped || run.budget <= 0 || (perRule.get(rule?.id) || 0) >= ruleCap) { result.deferred++; return }
  try {
    const live = await liveNeeded(ctx, c)
    if (!live.needed.length) { result.skipped++; return }
    const intent = intents.get(`${c.tmdb_id}:${c.season}`)
    if (plan.owner === 'other-follow') {
      // 他人的 follow 订阅：已并入过则跳过，避免每轮重复 PATCH（mergeIntent 本身也幂等）。
      if (entry.patched_follow === intent?.id) { result.skipped++; return }
    }
    const useRule = rule || { subscribe: {} }
    const saved = plan.kind === 'patch' ? await mergeIntent(ctx, intent, c, live.needed) : await createIntent(ctx, c, useRule, live.needed, live.owned)
    if (!saved) { result.skipped++; return }
    if (plan.owner === 'other-follow') {
      // 不抢占所有权（intent_id 仍归属追光），仅记录已并入，便于去重与对账。
      entry.patched_follow = saved.id
      entry.last_action_at = new Date().toISOString()
    } else {
      Object.assign(entry, { intent_id: saved.id, rule_id: rule?.id || '', last_action_at: new Date().toISOString(), outcome: saved.state })
    }
    delete state.review[c.key]
    run.budget--
    perRule.set(rule?.id, (perRule.get(rule?.id) || 0) + 1)
    c.needed = live.needed
    if (plan.kind === 'patch') result.merged++
    result.subscribed.push({ title: c.title, season: c.season, episodes: formatEpisodes(live.needed) })
    record(state, c, plan.kind === 'patch' ? 'merged' : 'subscribed', '', rule)
    // P7：仅在真正写入订阅或出错时落检查点，避免每个候选都写盘。
    await ctx.task.checkpoint({ stage: 'subscribe', subscribed: result.subscribed.length })
    await ctx.sleep(Number(settings.throttle_ms) || 0)
  } catch (error) {
    const code = hostErrorCode(error)
    if (code === 'no_episodes_needed' || code === 'duplicate') { result.skipped++; return }
    result.failed++
    record(state, c, 'failed', error.data?.error || error.message, rule)
    await ctx.task.log(`${c.title} S${c.season}：${error.message}`)
    await ctx.task.checkpoint({ stage: 'subscribe', failed: result.failed })
    if (code === 'not_premium' || code === 'no_source') run.stopped = error.data?.error || code
  }
  await ctx.task.update({ stage: 'subscribe', message: c.title, done: result.subscribed.length, failed: result.failed })
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

  // 规则涉及的媒体库集合，只拉这些库。
  const ruleLibraryIDs = new Set()
  if (needsLibraries(rules)) for (const r of rules) if (r.enabled !== false && Array.isArray(r.match?.library_ids)) for (const id of r.match.library_ids) ruleLibraryIDs.add(String(id))

  const [instances, intents] = [await listInstances(ctx), await listIntents(ctx)]

  // 阶段1：收集缺集行（轻量，不展开候选，避免一次性持有全量候选对象 P2）。
  const rows = []
  for (const instance of instances) {
    const proxyID = instance.id || 0
    const owners = needsLibraries(rules) ? await listLibraries(ctx, proxyID, ruleLibraryIDs) : new Map()
    for (const row of await listMissing(ctx, proxyID)) {
      if (!row.tmdb_id) continue
      rows.push({ proxyID, row, owners: owners.get(row.emby_series_id) || [] })
    }
  }

  // 阶段2：并发预取 TMDB 详情（P3），用限并发压墙钟时间，又不打爆宿主。
  const details = new Map()
  const failedDetails = new Set()
  const tmdbCache = new Map()    // 仅本次运行内去重，避免跨运行串扰
  const tmdbLast = { t: 0 }
  const ids = [...new Set(rows.map(r => r.row.tmdb_id))]
  if (ids.length) {
    let fetched = 0
    await ctx.task.update({ stage: 'fetch', message: `读取 ${ids.length} 部剧集信息`, total: ids.length, done: 0, failed: 0 })
    await mapLimit(ids, TMDB_CONCURRENCY, async id => {
      try {
        if (tmdbCache.has(id)) { details.set(id, tmdbCache.get(id)) }
        else { await throttleTmdb(ctx, tmdbLast); const d = await ctx.api.get(`/api/tmdb/tv/${id}`); tmdbCache.set(id, d); details.set(id, d) }
      }
      catch (error) { failedDetails.add(id); await ctx.task.log(`TMDB 读取失败 ${id}：${error.message}`) }
      fetched++
      await ctx.task.update({ stage: 'fetch', done: fetched, failed: failedDetails.size })
    })
  }

  // 阶段3：逐候选匹配 / 订阅（订阅写保持串行节流，符合 115 限速）。
  const now = Date.now()
  const result = { dry_run: dryRun, scanned: 0, matched: 0, subscribed: [], merged: 0, skipped: 0, failed: 0, new_review: 0, deferred: 0 }
  const previews = []
  const seen = new Set()
  const perRule = new Map()
  const run = { settings, state, rules, intents, dryRun, approved, manual, now, result, previews, seen, perRule, budget: Number(settings.max_per_run) || 20, stopped: '' }
  for (const { proxyID, row, owners } of rows) {
    if (failedDetails.has(row.tmdb_id)) { result.failed++; continue }
    const detail = details.get(row.tmdb_id)
    for (const c of seasonCandidates(row, detail, proxyID, owners)) {
      await processCandidate(ctx, c, run)
    }
  }

  if (dryRun) {
    const output = { ...result, at: new Date(now).toISOString(), items: previews.slice(0, PREVIEW_LIMIT), truncated: previews.length > PREVIEW_LIMIT }
    await ctx.storage.set('preview', output)
    return { scanned: result.scanned, items: previews.length }
  }
  // TMDB 读取失败时这一轮看到的不完整，不能据此清记录。
  if (!result.failed) reconcileLedger(state, intents, seen)
  await saveState(ctx, state)
  const summary = { ...result, stopped: run.stopped, at: new Date(now).toISOString(), source: approved.size ? 'approve' : input.type ? 'event' : manual ? 'manual' : 'schedule' }
  await ctx.storage.set('last_run', summary)
  await notifySummary(ctx, settings, result)
  if (run.stopped) throw new Error(`已停止：${run.stopped}`)
  return summary
}

// 每轮都先重读订阅与缺集结果，已提交的会被判为已有订阅，重跑不会重复创建。
export async function recover() {
  return { action: 'resume' }
}
