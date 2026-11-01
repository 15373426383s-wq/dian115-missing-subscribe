import test from 'node:test'
import assert from 'node:assert/strict'
import { preview, run } from '../jobs/run.js'
import { failedConditions, firstMatch, planIntent } from '../jobs/lib/rules.js'
import { formatEpisodes, parseEpisodes } from '../jobs/lib/episodes.js'

const report = (id, name, missing) => ({ emby_series_id: `s${id}`, series_name: name, tmdb_id: id, missing_detail: JSON.stringify(missing) })
const tv = (name, status, count, extra = {}) => ({ name, status, first_air_date: '2024-01-01', genres: [{ name: '动画' }], origin_country: ['JP'], seasons: [{ season_number: 0, episode_count: 2 }, { season_number: 1, episode_count: count }], poster_path: '/p.jpg', ...extra })

function host({ rows = [], details = {}, intents = [], covered = '', settings = {}, rules = [], store = {}, postError } = {}) {
  const calls = [], data = { rules, ...store }
  const ctx = {
    settings: { get: async () => ({ auto_enabled: true, max_per_run: 20, cooldown_days: 7, ...settings }) },
    storage: { get: async key => data[key], set: async (key, value) => { data[key] = structuredClone(value) } },
    task: { id: 't1', update: async () => {}, log: async () => {}, checkpoint: async () => {} },
    sleep: async () => {},
    notify: async options => { calls.push(['notify', options]) },
    api: {
      get: async path => {
        calls.push(['get', path])
        if (path.startsWith('/api/plugin-host/emby/instances')) return { items: [{ id: 1 }] }
        if (path.startsWith('/api/emby-manager/missing/report')) return { items: rows, total: rows.length }
        if (path.startsWith('/api/subscribe/pool/intents')) return { data: intents }
        if (path.startsWith('/api/plugin-host/emby/episodes')) return { covered_episodes: covered }
        const id = path.match(/\/api\/tmdb\/tv\/(\d+)/)?.[1]
        if (id) return details[id]
        throw new Error(`unexpected ${path}`)
      },
      post: async (path, body) => { calls.push(['post', path, body]); if (postError) throw postError; return { data: { id: 99, state: 'searching' } } },
      patch: async (path, body) => { calls.push(['patch', path, body]); return { data: { id: 5, state: 'searching' } } },
    },
  }
  return { ctx, calls, data }
}

const candidate = over => ({ proxy_id: 1, tmdb_id: 7, season: 2, title: '示例剧', needed: [3, 4], total: 12, owned: 10, airing: true, latest_season: true, year: 2024, genres: ['动画'], countries: ['JP'], library_ids: ['a'], ...over })

test('集号集合互转', () => {
  assert.deepEqual(parseEpisodes('1-3,5'), [1, 2, 3, 5])
  assert.equal(formatEpisodes([5, 1, 2, 3, 3]), '1-3,5')
})

test('规则条件逐项生效', () => {
  assert.deepEqual(failedConditions({ airing: 'airing', season_scope: 'latest', max_missing: 2, genres: ['动画'], countries: ['JP'] }, candidate()), [])
  assert.deepEqual(failedConditions({ airing: 'ended' }, candidate()), ['不是已完结'])
  assert.deepEqual(failedConditions({ max_missing_ratio: 10 }, candidate()), ['缺集比例超过 10%'])
  assert.deepEqual(failedConditions({ min_owned: 11 }, candidate()), ['已有少于 11 集'])
  assert.deepEqual(failedConditions({ title_exclude: '示例' }, candidate()), ['片名被排除'])
  assert.deepEqual(failedConditions({ tmdb_exclude: '7, 8' }, candidate()), ['在 TMDB 排除名单'])
  assert.deepEqual(failedConditions({ library_ids: ['b'] }, candidate()), ['媒体库不符'])
})

test('按顺序取第一条启用的规则', () => {
  const rules = [{ id: 'off', enabled: false, match: {} }, { id: 'miss', match: { airing: 'ended' } }, { id: 'hit', match: {} }, { id: 'late', match: {} }]
  assert.equal(firstMatch(rules, candidate()).id, 'hit')
})

test('不碰用户自己的订阅，只合并插件创建的', () => {
  const options = { now: Date.now(), cooldown_days: 7 }
  assert.equal(planIntent(candidate(), { id: 1, state: 'searching' }, {}, options).kind, 'skip')
  assert.equal(planIntent(candidate(), { id: 1, state: 'searching' }, { intent_id: 1 }, options).kind, 'patch')
  assert.equal(planIntent(candidate(), { id: 1, state: 'transferring' }, { intent_id: 1 }, options).kind, 'skip')
  assert.equal(planIntent(candidate(), { id: 1, state: 'partial', is_upgrade: 1 }, { intent_id: 1 }, options).kind, 'skip')
  assert.equal(planIntent(candidate({ needed: [894] }), null, {}, options).kind, 'skip')
})

test('失败订阅过了冷却才重试', () => {
  const intent = { id: 1, state: 'failed' }, now = Date.now()
  assert.equal(planIntent(candidate(), intent, { intent_id: 1, last_action_at: new Date(now - 86400000).toISOString() }, { now, cooldown_days: 7 }).kind, 'skip')
  assert.equal(planIntent(candidate(), intent, { intent_id: 1, last_action_at: new Date(now - 8 * 86400000).toISOString() }, { now, cooldown_days: 7 }).kind, 'create')
})

test('自动运行关闭时不读取也不提交', async () => {
  const { ctx, calls } = host({ settings: { auto_enabled: false } })
  assert.equal((await run(ctx, {})).skipped, '自动运行未开启')
  assert.equal(calls.length, 0)
})

test('试运行只写预览，不创建订阅', async () => {
  const { ctx, calls, data } = host({ rows: [report(7, '剧', [{ season: 1, episodes: [3] }])], details: { 7: tv('剧', 'Returning Series', 3) }, rules: [{ id: 'r', name: '全部', action: 'subscribe', match: {} }] })
  await preview(ctx, {})
  assert.equal(calls.filter(c => c[0] === 'post').length, 0)
  assert.equal(data.preview.items[0].reason, '将自动订阅')
  assert.equal(data.ledger, undefined)
})

test('提交前用实时结果扣掉已入库的集', async () => {
  const { ctx, calls, data } = host({ covered: '1,2,3', rows: [report(7, '剧', [{ season: 1, episodes: [3, 4] }])], details: { 7: tv('剧', 'Returning Series', 4) }, rules: [{ id: 'r', action: 'subscribe', match: {}, subscribe: { sources: ['pt'] } }] })
  await run(ctx, {})
  const body = calls.find(c => c[0] === 'post')[2]
  assert.equal(body.initial_needed_episodes, '4')
  assert.equal(body.initial_covered_episodes, '1-3')
  assert.equal(body.library_snapshot_provided, true)
  assert.equal(body.episode_scope_mode, 'fixed')
  assert.deepEqual(body.enabled_sources, ['pt'])
  assert.equal(data.ledger['1:7:1'].intent_id, 99)
})

test('插件创建的订阅只合并新增集', async () => {
  const { ctx, calls } = host({ intents: [{ id: 5, tmdb_id: 7, season: 1, state: 'searching', needed_episodes: '3' }], store: { ledger: { '1:7:1': { intent_id: 5 } } }, rows: [report(7, '剧', [{ season: 1, episodes: [3, 4] }])], details: { 7: tv('剧', 'Returning Series', 4) }, rules: [{ id: 'r', action: 'subscribe', match: {} }] })
  await run(ctx, {})
  assert.equal(calls.filter(c => c[0] === 'post').length, 0)
  const body = calls.find(c => c[0] === 'patch')[2]
  assert.equal(body.needed_episodes, '3-4')
  assert.equal(body.covered_episodes, '1-2')
})

test('观察期与审核队列', async () => {
  const rows = [report(7, '剧', [{ season: 1, episodes: [3] }])], details = { 7: tv('剧', 'Returning Series', 3) }
  const grace = host({ rows, details, rules: [{ id: 'r', action: 'subscribe', match: {}, subscribe: { grace_hours: 24 } }] })
  await run(grace.ctx, {})
  assert.equal(grace.calls.filter(c => c[0] === 'post').length, 0)
  const review = host({ rows, details, rules: [{ id: 'r', action: 'review', match: {} }] })
  const result = await run(review.ctx, {})
  assert.equal(result.new_review, 1)
  assert.ok(review.data.review['1:7:1'])
  await run(review.ctx, { approve: ['1:7:1'] })
  assert.equal(review.calls.filter(c => c[0] === 'post').length, 1)
  assert.equal(review.data.review['1:7:1'], undefined)
})

test('单轮上限之外留到下一轮', async () => {
  const rows = [report(7, 'A', [{ season: 1, episodes: [3] }]), report(8, 'B', [{ season: 1, episodes: [3] }])]
  const { ctx, calls } = host({ settings: { max_per_run: 1 }, rows, details: { 7: tv('A', 'Ended', 3), 8: tv('B', 'Ended', 3) }, rules: [{ id: 'r', action: 'subscribe', match: {} }] })
  assert.equal((await run(ctx, {})).deferred, 1)
  assert.equal(calls.filter(c => c[0] === 'post').length, 1)
})

test('未授权时停止提交并报错', async () => {
  const error = Object.assign(new Error('403'), { data: { code: 'not_premium', error: '需要高级版' } })
  const rows = [report(7, 'A', [{ season: 1, episodes: [3] }]), report(8, 'B', [{ season: 1, episodes: [3] }])]
  const { ctx, calls } = host({ postError: error, rows, details: { 7: tv('A', 'Ended', 3), 8: tv('B', 'Ended', 3) }, rules: [{ id: 'r', action: 'subscribe', match: {} }] })
  await assert.rejects(run(ctx, {}), /需要高级版/)
  assert.equal(calls.filter(c => c[0] === 'post').length, 1)
})
