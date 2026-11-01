// 规则判定：纯函数，不碰宿主，便于预览与测试。

export const ACTIVE_LOCKED_STATES = new Set(['transferring', 'waiting', 'verifying', 'needs_attention'])
const CLOSED_STATES = new Set(['failed', 'expired', 'landed', 'cancelled'])

const words = text => String(text || '').split(/[,，\n]/).map(s => s.trim().toLowerCase()).filter(Boolean)
const has = list => Array.isArray(list) && list.length > 0
const num = v => v === '' || v === null || v === undefined ? null : Number(v)

export function isAiring(status) {
  return !['Ended', 'Canceled', 'Cancelled'].includes(status)
}

// 返回不满足的条件；空数组表示命中。
export function failedConditions(match, c) {
  const m = match || {}, failed = []
  const missing = c.needed.length
  const ratio = c.total > 0 ? missing / c.total * 100 : 100
  const min = num(m.min_missing), max = num(m.max_missing), maxRatio = num(m.max_missing_ratio)
  const minOwned = num(m.min_owned), from = num(m.year_from), to = num(m.year_to), seasonMin = num(m.season_min)
  if (has(m.proxy_ids) && !m.proxy_ids.map(Number).includes(c.proxy_id)) failed.push('实例不符')
  if (has(m.library_ids) && !m.library_ids.some(id => c.library_ids?.includes(id))) failed.push('媒体库不符')
  if (m.airing === 'airing' && !c.airing) failed.push('不是连载中')
  if (m.airing === 'ended' && c.airing) failed.push('不是已完结')
  if (m.season_scope === 'latest' && !c.latest_season) failed.push('不是最新季')
  if (seasonMin !== null && c.season < seasonMin) failed.push(`季号低于 ${seasonMin}`)
  if (min !== null && missing < min) failed.push(`缺集少于 ${min}`)
  if (max !== null && missing > max) failed.push(`缺集多于 ${max}`)
  if (maxRatio !== null && ratio > maxRatio) failed.push(`缺集比例超过 ${maxRatio}%`)
  if (minOwned !== null && c.owned < minOwned) failed.push(`已有少于 ${minOwned} 集`)
  if (from !== null && !(c.year >= from)) failed.push(`早于 ${from} 年`)
  if (to !== null && !(c.year <= to)) failed.push(`晚于 ${to} 年`)
  if (has(m.genres) && !m.genres.some(g => c.genres.includes(g))) failed.push('类型不符')
  if (has(m.genres_exclude) && m.genres_exclude.some(g => c.genres.includes(g))) failed.push('类型被排除')
  if (has(m.countries) && !m.countries.some(x => c.countries.includes(x))) failed.push('地区不符')
  const title = c.title.toLowerCase(), include = words(m.title_include), exclude = words(m.title_exclude)
  if (include.length && !include.some(w => title.includes(w))) failed.push('片名不含关键词')
  if (exclude.some(w => title.includes(w))) failed.push('片名被排除')
  const ids = list => String(list || '').split(/[,，\s]+/).filter(Boolean).map(Number)
  const allow = ids(m.tmdb_include), deny = ids(m.tmdb_exclude)
  if (allow.length && !allow.includes(c.tmdb_id)) failed.push('不在 TMDB 名单')
  if (deny.includes(c.tmdb_id)) failed.push('在 TMDB 排除名单')
  return failed
}

// 规则按数组顺序取第一条命中。
export function firstMatch(rules, c) {
  for (const rule of rules) {
    if (rule.enabled !== false && failedConditions(rule.match, c).length === 0) return rule
  }
  return null
}

export const needsLibraries = rules => rules.some(r => r.enabled !== false && has(r.match?.library_ids))

// 决定对已有订阅怎么做。POST 会覆盖宿主的订阅快照，所以进行中的订阅只能 PATCH。
export function planIntent(c, intent, entry, { now, cooldown_days, patch_follow = true }) {
  const maxNeeded = c.needed.reduce((m, n) => n > m ? n : m, 0)
  if (c.total > 0 && maxNeeded > c.total) return { kind: 'skip', reason: '集号延续上季，宿主订阅按季内集号处理，需手动订阅' }
  if (!intent) return { kind: 'create' }
  if (intent.is_upgrade === 1) return { kind: 'skip', reason: '已有洗版订阅' }
  const owned = entry?.intent_id === intent.id
  if (!CLOSED_STATES.has(intent.state)) {
    if (owned) {
      if (ACTIVE_LOCKED_STATES.has(intent.state)) return { kind: 'skip', reason: '订阅正在转存，下轮再合并' }
      return { kind: 'patch' }
    }
    // 他人的订阅：仅当它是“追剧(follow)”订阅且开启合并时，把缺失的过往集并入，不碰固定(fixed)订阅。
    const isFollow = intent.episode_scope_mode === 'follow' || intent.scope === 'follow'
    if (patch_follow && isFollow && !ACTIVE_LOCKED_STATES.has(intent.state)) return { kind: 'patch', owner: 'other-follow' }
    return { kind: 'skip', reason: '已有你自己的订阅' }
  }
  if (!owned && intent.state !== 'landed') return { kind: 'skip', reason: '已有你自己的失败订阅' }
  const last = Date.parse(entry?.last_action_at || '') || 0
  if (now - last < cooldown_days * 86400000) return { kind: 'skip', reason: `冷却中（${cooldown_days} 天）` }
  return { kind: 'create' }
}
