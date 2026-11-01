import { styles } from './styles.js'

const SOURCES = [['dianying', '癫影'], ['pt', 'PT'], ['tg', 'Telegram']]
const GENRES = ['动画', '剧情', '喜剧', '犯罪', '科幻', '悬疑', '爱情', '家庭', '纪录', '真人秀']
const COUNTRIES = [['CN', '中国大陆'], ['JP', '日本'], ['KR', '韩国'], ['US', '美国'], ['GB', '英国'], ['TW', '台湾'], ['HK', '香港']]
const ACTIONS = [['subscribe', '自动订阅', 'ok'], ['review', '进待审', 'info'], ['ignore', '忽略', 'warn']]
const HISTORY_LABEL = { subscribed: ['已订阅', 'ok'], merged: ['已合并', 'info'], failed: ['失败', 'bad'] }
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'attention_required'])
const TEMPLATES = [
  ['连载追更', { action: 'subscribe', match: { airing: 'airing', season_scope: 'latest' }, subscribe: { scope: 'fixed', grace_hours: 6 } }],
  ['完结收尾', { action: 'subscribe', match: { airing: 'ended', max_missing_ratio: 30 }, subscribe: { scope: 'fixed', grace_hours: 24 } }],
  ['小缺口补全', { action: 'subscribe', match: { max_missing: 3, min_owned: 1 }, subscribe: { scope: 'fixed' } }],
  ['大缺口待审', { action: 'review', match: { min_missing: 4 }, subscribe: { scope: 'fixed' } }],
]

export async function mount(root, ctx) {
  const doc = root.ownerDocument
  const el = (tag, attrs = {}, ...children) => {
    const node = doc.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'innerHTML' || key === 'outerHTML') continue // S1：禁止直接注入 HTML
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else if (key in node && key !== 'list') node[key] = value
      else node.setAttribute(key, value)
    }
    node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false))
    return node
  }
  const state = { tab: 'overview', rules: [], settings: {}, last: null, preview: null, review: {}, ignored: {}, history: [], ledger: {}, instances: [], libraries: [], running: '' }
  let disposed = false, toastTimer = 0

  const shell = el('section', { className: 'ms' })
  shell.append(el('style', { textContent: styles }), el('div', { className: 'ms-ambient', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')))
  shell.insertAdjacentHTML('beforeend', '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="ms-refraction" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency=".008 .012" numOctaves="2" seed="4"/><feGaussianBlur stdDeviation="2"/><feDisplacementMap in="SourceGraphic" scale="34" xChannelSelector="R" yChannelSelector="G"/></filter></svg>')
  // SVG 折射只有 Chromium 支持；其他浏览器留在模糊玻璃
  if (doc.defaultView?.chrome) shell.classList.add('ms-refract')
  const content = el('div', { className: 'ms-content' })
  const pill = el('span', { className: 'ms-pill' })
  const dock = el('nav', { className: 'ms-glass ms-lens ms-dock', role: 'tablist', 'aria-label': '缺集自动订阅' })
  shell.append(content, el('div', { className: 'ms-dock-wrap' }, dock))
  root.append(shell)

  const stopTheme = ctx.theme.subscribe(mode => { shell.dataset.mode = mode })
  const onMove = event => {
    const card = event.target.closest?.('.ms-glass')
    if (!card) return
    const box = card.getBoundingClientRect()
    card.style.setProperty('--mx', `${event.clientX - box.left}px`)
    card.style.setProperty('--my', `${event.clientY - box.top}px`)
    card.style.setProperty('--glow', '1')
  }
  const onOut = event => event.target.closest?.('.ms-glass')?.style.setProperty('--glow', '0')
  shell.addEventListener('pointermove', onMove)
  shell.addEventListener('pointerout', onOut)

  function toast(text) {
    shell.querySelector('.ms-toast')?.remove()
    const node = el('div', { className: 'ms-glass ms-toast', role: 'status', textContent: text })
    shell.append(node)
    doc.defaultView.clearTimeout(toastTimer)
    toastTimer = doc.defaultView.setTimeout(() => node.remove(), 3200)
  }
  const failure = error => error?.response?.data?.error || error?.data?.error || error?.message || '操作失败'
  const read = async (key, fallback) => { try { return await ctx.storage.get(key) ?? fallback } catch { return fallback } }

  async function refresh() {
    const [rules, last, preview, review, ignored, history, ledger, settings] = await Promise.all([
      read('rules', []), read('last_run', null), read('preview', null), read('review', {}),
      read('ignored', {}), read('history', []), read('ledger', {}), ctx.settings.get(),
    ])
    Object.assign(state, { rules, last, preview, review, ignored, history, ledger, settings })
  }

  async function runJob(job, input, label) {
    if (state.running) return
    state.running = label
    render()
    try {
      const started = await ctx.tasks.run(job, `${job}:${Date.now()}`, input)
      let run = started
      let polls = 0
      while (!TERMINAL.has(run.status) && polls < 4000) { // S5：兜底超时，避免状态契约异常时无限轮询
        await new Promise(resolve => doc.defaultView.setTimeout(resolve, 900))
        if (disposed) return
        run = await ctx.tasks.get(started.id)
        polls++
      }
      if (!TERMINAL.has(run.status)) throw new Error('任务状态轮询超时，请到任务队列查看')
      if (run.status !== 'succeeded') throw new Error(run.error || '任务未完成，请到任务队列查看')
      await refresh()
      toast(`${label}完成`)
    } catch (error) {
      toast(failure(error))
    } finally {
      state.running = ''
      if (!disposed) render()
    }
  }

  const saveRules = async () => {
    try { await ctx.storage.set('rules', state.rules) } catch (error) { toast(failure(error)) }
    render()
  }

  function poster(path, title) {
    const fallback = () => el('div', { className: 'ms-poster', textContent: (title || '?').slice(0, 1) })
    // S3：只允许相对路径且不含 ".."，防止 tmdb-image 端点被绝对路径/穿越利用。
    if (!path || typeof path !== 'string' || !path.startsWith('/') || path.includes('..')) return fallback()
    const image = el('img', { className: 'ms-poster', alt: '', loading: 'lazy', src: `/api/emby-manager/tmdb-image?path=${encodeURIComponent(path)}` })
    image.addEventListener('error', () => image.replaceWith(fallback()), { once: true })
    return image
  }
  const season = n => `S${String(n).padStart(2, '0')}`
  const when = text => text ? new Date(text).toLocaleString('zh-CN', { hour12: false }) : '—'

  function viewOverview() {
    const last = state.last
    const landed = Object.values(state.ledger).filter(x => x.outcome === 'landed').length
    const active = Object.values(state.ledger).filter(x => x.intent_id && !['landed', 'failed', 'expired'].includes(x.outcome)).length
    const stat = (value, label) => el('div', { className: 'ms-glass ms-stat' }, el('b', { textContent: value }), el('span', { textContent: label }))
    return [
      el('div', { className: 'ms-grid' }, stat(Object.keys(state.review).length, '待审核'), stat(active, '订阅进行中'), stat(landed, '已补齐'), stat(state.rules.filter(r => r.enabled !== false).length, '启用规则')),
      el('div', { className: 'ms-glass ms-section' },
        el('div', { className: 'ms-row ms-spread' },
          el('div', {}, el('h2', { textContent: '自动运行', style: 'margin:0' }), el('div', { className: 'ms-muted', textContent: '每小时检查一次，缺集扫描完成后也会立即运行' })),
          el('input', { className: 'ms-switch', type: 'checkbox', role: 'switch', checked: !!state.settings.auto_enabled, 'aria-label': '开启自动运行', onchange: async event => {
            state.settings.auto_enabled = event.target.checked
            try { await ctx.settings.set(state.settings); toast(event.target.checked ? '自动运行已开启' : '自动运行已关闭') } catch (error) { toast(failure(error)) }
          } }))),
      el('div', { className: 'ms-glass ms-section' },
        el('h2', { textContent: '上次运行' }),
        last ? el('div', { className: 'ms-row' },
          el('span', { className: 'ms-tag', textContent: when(last.at) }),
          el('span', { className: 'ms-tag', textContent: `检查 ${last.scanned} 季` }),
          el('span', { className: 'ms-tag ok', textContent: `订阅 ${last.subscribed?.length || 0}` }),
          el('span', { className: 'ms-tag info', textContent: `待审 +${last.new_review || 0}` }),
          last.deferred ? el('span', { className: 'ms-tag warn', textContent: `顺延 ${last.deferred}` }) : null,
          last.failed ? el('span', { className: 'ms-tag bad', textContent: `失败 ${last.failed}` }) : null,
          last.stopped ? el('span', { className: 'ms-tag bad', textContent: last.stopped }) : null)
          : el('div', { className: 'ms-muted', textContent: '还没有运行过。建议先添加规则，再用试运行看看结果。' })),
    ]
  }

  function viewRules() {
    const list = state.rules.map((rule, index) => {
      const action = ACTIONS.find(a => a[0] === rule.action) || ACTIONS[0]
      const move = delta => () => { const [item] = state.rules.splice(index, 1); state.rules.splice(index + delta, 0, item); saveRules() }
      return el('div', { className: 'ms-glass ms-item' },
        el('input', { className: 'ms-switch', type: 'checkbox', role: 'switch', checked: rule.enabled !== false, 'aria-label': `启用 ${rule.name}`, onchange: event => { rule.enabled = event.target.checked; saveRules() } }),
        el('div', { className: 'grow' }, el('strong', { textContent: rule.name }), el('div', { className: 'ms-muted', textContent: describe(rule) })),
        el('span', { className: `ms-tag ${action[2]}`, textContent: action[1] }),
        el('button', { className: 'ms-btn small', disabled: index === 0, 'aria-label': '上移', textContent: '↑', onclick: move(-1) }),
        el('button', { className: 'ms-btn small', disabled: index === state.rules.length - 1, 'aria-label': '下移', textContent: '↓', onclick: move(1) }),
        el('button', { className: 'ms-btn small', textContent: '编辑', onclick: () => editRule(rule) }))
    })
    return [
      el('div', { className: 'ms-list' }, list.length ? list : el('div', { className: 'ms-glass ms-empty', textContent: '还没有规则。从下面的模板开始，或新建一条。' })),
      el('div', { className: 'ms-glass ms-section' }, el('h2', { textContent: '从模板添加' }),
        el('div', { className: 'ms-chips' }, TEMPLATES.map(([name, template]) => el('button', { className: 'ms-btn small', textContent: name, onclick: () => editRule({ ...structuredClone(template), name, enabled: true }, true) })))),
      el('p', { className: 'ms-muted', textContent: '规则从上到下匹配，每季只按第一条命中的规则处理。' }),
    ]
  }

  function describe(rule) {
    const m = rule.match || {}, parts = []
    if (m.airing === 'airing') parts.push('连载中')
    if (m.airing === 'ended') parts.push('已完结')
    if (m.season_scope === 'latest') parts.push('最新季')
    if (m.min_missing) parts.push(`缺 ≥ ${m.min_missing}`)
    if (m.max_missing) parts.push(`缺 ≤ ${m.max_missing}`)
    if (m.max_missing_ratio) parts.push(`缺集比例 ≤ ${m.max_missing_ratio}%`)
    if (m.min_owned) parts.push(`已有 ≥ ${m.min_owned}`)
    if (m.year_from || m.year_to) parts.push(`${m.year_from || ''}–${m.year_to || ''} 年`)
    if (m.genres?.length) parts.push(m.genres.join('/'))
    if (m.countries?.length) parts.push(m.countries.join('/'))
    if (m.library_ids?.length) parts.push(`${m.library_ids.length} 个媒体库`)
    if (m.title_include) parts.push(`含 ${m.title_include}`)
    return parts.join(' · ') || '所有缺集'
  }

  function editRule(source, isNew = false) {
    const draft = structuredClone(source)
    draft.match ||= {}
    draft.subscribe ||= {}
    draft.action ||= 'subscribe'
    const text = (label, get, set, type = 'text', wide = false, placeholder = '') => el('label', { className: `ms-field${wide ? ' wide' : ''}` }, label, el('input', { type, value: get() ?? '', placeholder, oninput: event => set(event.target.value) }))
    const num = (label, key, target = draft.match) => text(label, () => target[key], value => { if (value === '') delete target[key]; else target[key] = Number(value) }, 'number')
    const str = (label, key, placeholder, wide = true) => text(label, () => draft.match[key], value => { draft.match[key] = value }, 'text', wide, placeholder)
    const seg = (options, get, set) => { const box = el('div', { className: 'ms-seg' }); const paint = () => box.replaceChildren(...options.map(([value, label]) => el('button', { type: 'button', textContent: label, 'aria-pressed': String((get() || '') === value), onclick: () => { set(value); paint() } }))); paint(); return box }
    const chips = (options, target, key) => {
      const box = el('div', { className: 'ms-chips' })
      const paint = () => box.replaceChildren(...options.map(([value, label]) => el('button', { type: 'button', className: 'ms-chip', textContent: label, 'aria-pressed': String((target[key] || []).includes(value)), onclick: () => {
        const list = target[key] || []
        target[key] = list.includes(value) ? list.filter(x => x !== value) : [...list, value]
        paint()
      } })))
      paint()
      return box
    }
    const field = (label, control) => el('div', { className: 'ms-field wide' }, label, control)
    const close = () => scrim.remove()
    const sheet = el('form', { className: 'ms-glass ms-sheet', onsubmit: event => {
      event.preventDefault()
      if (!draft.name?.trim()) return toast('请填写规则名称')
      if (isNew) state.rules.push({ ...draft, id: `r${Date.now().toString(36)}` })
      else Object.assign(source, draft)
      close()
      saveRules()
    } },
      el('h2', { textContent: isNew ? '新建规则' : '编辑规则' }),
      el('div', { className: 'ms-fields' },
        text('规则名称', () => draft.name, value => { draft.name = value }, 'text', true),
        field('命中后', seg(ACTIONS.map(a => [a[0], a[1]]), () => draft.action, value => { draft.action = value }))),
      el('h2', { textContent: '筛选条件' }),
      el('div', { className: 'ms-fields' },
        field('播出状态', seg([['', '不限'], ['airing', '连载中'], ['ended', '已完结']], () => draft.match.airing, value => { draft.match.airing = value })),
        field('季范围', seg([['', '所有已收藏季'], ['latest', '只看最新季']], () => draft.match.season_scope, value => { draft.match.season_scope = value })),
        num('最少缺几集', 'min_missing'), num('最多缺几集', 'max_missing'),
        num('缺集比例上限 %', 'max_missing_ratio'), num('至少已有几集', 'min_owned'),
        num('首播年份从', 'year_from'), num('首播年份到', 'year_to'),
        state.instances.length > 1 ? field('Emby 实例', chips(state.instances.map(x => [x.id, x.name]), draft.match, 'proxy_ids')) : null,
        state.libraries.length ? field('媒体库', chips(state.libraries.map(x => [x.id, x.name]), draft.match, 'library_ids')) : null,
        field('类型（任一）', chips(GENRES.map(x => [x, x]), draft.match, 'genres')),
        field('排除类型', chips(GENRES.map(x => [x, x]), draft.match, 'genres_exclude')),
        field('地区（任一）', chips(COUNTRIES, draft.match, 'countries')),
        str('片名包含', 'title_include', '逗号分隔，任一命中'), str('片名排除', 'title_exclude', '逗号分隔'),
        str('只看这些 TMDB ID', 'tmdb_include', '逗号分隔', false), str('排除这些 TMDB ID', 'tmdb_exclude', '逗号分隔', false)),
      el('h2', { textContent: '订阅方式' }),
      el('div', { className: 'ms-fields' },
        field('范围', seg([['fixed', '只补当前缺的集'], ['follow', '补完后继续跟新集']], () => draft.subscribe.scope || 'fixed', value => { draft.subscribe.scope = value })),
        field('资源来源（不选用宿主默认）', chips(SOURCES, draft.subscribe, 'sources')),
        num('观察期（小时）', 'grace_hours', draft.subscribe), num('单轮上限', 'max_per_run', draft.subscribe),
        field('追光 follow 剧', seg([['', '不并入'], ['1', '补过往缺集']], () => draft.subscribe.patch_follow === false ? '' : '1', value => { draft.subscribe.patch_follow = value === '1' }))),
      el('div', { className: 'ms-glass ms-actions' },
        isNew ? null : el('button', { type: 'button', className: 'ms-btn danger', textContent: '删除', onclick: () => { state.rules = state.rules.filter(r => r !== source); close(); saveRules() } }),
        el('button', { type: 'button', className: 'ms-btn', textContent: '取消', onclick: close }),
        el('button', { type: 'submit', className: 'ms-btn primary', textContent: '保存' })))
    const scrim = el('div', { className: 'ms-scrim', onclick: event => { if (event.target === scrim) close() } }, sheet)
    shell.append(scrim)
  }

  function item(entry, tags, actions = []) {
    return el('div', { className: 'ms-glass ms-item' }, poster(entry.poster_path, entry.title),
      el('div', { className: 'grow' }, el('strong', { textContent: `${entry.title} ${season(entry.season)}` }),
        el('div', { className: 'ms-muted', textContent: `缺 ${entry.episodes || '—'}` })),
      tags, actions)
  }

  function viewPreview() {
    const data = state.preview
    const tone = reason => reason.startsWith('将') ? 'ok' : reason === '待审核' ? 'info' : ''
    return [
      el('div', { className: 'ms-glass ms-section' }, el('div', { className: 'ms-row ms-spread' },
        el('div', {}, el('h2', { textContent: '试运行', style: 'margin:0' }), el('div', { className: 'ms-muted', textContent: data ? `${when(data.at)} · 检查 ${data.scanned} 季` : '按当前规则模拟一遍，不会创建订阅' })),
        el('button', { className: 'ms-btn primary', disabled: !!state.running, textContent: '开始试运行', onclick: () => runJob('preview', {}, '试运行') }))),
      el('div', { className: 'ms-list', style: 'margin-top:14px' }, (data?.items || []).map(entry => item(entry, [
        entry.rule ? el('span', { className: 'ms-tag', textContent: entry.rule }) : null,
        el('span', { className: `ms-tag ${tone(entry.reason)}`, textContent: entry.reason }),
      ]))),
    ]
  }

  function viewReview() {
    const entries = Object.values(state.review)
    if (!entries.length) return el('div', { className: 'ms-glass ms-empty', textContent: '没有待审核的缺集。' })
    return [
      el('div', { className: 'ms-row', style: 'margin-bottom:14px' },
        el('button', { className: 'ms-btn primary', disabled: !!state.running, textContent: `全部批准（${entries.length}）`, onclick: () => runJob('run', { approve: entries.map(x => x.key) }, '批准') }),
        el('button', { className: 'ms-btn', disabled: !!state.running, textContent: '全部忽略', onclick: () => runJob('run', { action: 'ignore' }, '忽略') })),
      el('div', { className: 'ms-list' }, entries.map(entry => item(entry, [el('span', { className: 'ms-tag', textContent: entry.rule })], [
        el('button', { className: 'ms-btn small', disabled: !!state.running, textContent: '批准', onclick: () => runJob('run', { approve: [entry.key] }, '批准') }),
        el('button', { className: 'ms-btn small', disabled: !!state.running, textContent: '忽略', onclick: () => runJob('run', { action: 'ignore', keys: [entry.key] }, '忽略') }),
      ]))),
    ]
  }

  function viewHistory() {
    const ignored = Object.entries(state.ignored)
    return [
      state.history.length ? el('div', { className: 'ms-list' }, state.history.map(entry => {
        const [label, tone] = HISTORY_LABEL[entry.action] || [entry.action, '']
        return item(entry, [el('span', { className: 'ms-muted', textContent: entry.detail || when(entry.at) }), el('span', { className: `ms-tag ${tone}`, textContent: label })])
      })) : el('div', { className: 'ms-glass ms-empty', textContent: '还没有记录。' }),
      ignored.length ? el('div', { className: 'ms-glass ms-section' }, el('h2', { textContent: '已忽略' }),
        el('div', { className: 'ms-chips' }, ignored.map(([key, entry]) => el('button', { className: 'ms-chip', disabled: !!state.running, title: '恢复', textContent: `${entry.title} ${season(entry.season)} ×`, onclick: () => runJob('run', { action: 'unignore', keys: [key] }, '恢复') })))) : null,
    ]
  }

  const TABS = [['overview', '总览', viewOverview], ['rules', '规则', viewRules], ['preview', '试运行', viewPreview], ['review', '审核', viewReview], ['history', '记录', viewHistory]]

  function render() {
    const view = TABS.find(t => t[0] === state.tab)
    content.replaceChildren(
      el('header', { className: 'ms-head' },
        el('div', {}, el('h1', { textContent: '缺集自动订阅' }), el('p', { textContent: state.running ? `${state.running}进行中…` : '按规则把缺集变成订阅' })),
        el('div', { className: 'ms-row' },
          state.tab === 'rules' ? el('button', { className: 'ms-btn', textContent: '新建规则', onclick: () => editRule({ name: '', action: 'subscribe', enabled: true }, true) }) : null,
          el('button', { className: 'ms-btn primary', disabled: !!state.running, textContent: '立即运行', onclick: () => runJob('run', { manual: true }, '运行') }))),
      ...[view[2]()].flat().filter(Boolean))
    const pending = Object.keys(state.review).length
    dock.replaceChildren(pill, ...TABS.map(([id, label]) => el('button', { className: 'ms-tab', role: 'tab', 'aria-selected': String(id === state.tab), onclick: () => { state.tab = id; render() } }, label, id === 'review' && pending ? el('sup', { textContent: pending }) : null)))
    const active = dock.querySelector('[aria-selected=true]')
    pill.style.width = `${active.offsetWidth}px`
    pill.style.transform = `translateX(${active.offsetLeft}px)`
  }

  try {
    await refresh()
    state.instances = (await ctx.api.get('/api/plugin-host/emby/instances')).items || []
    state.libraries = (await ctx.api.get('/api/plugin-host/emby/libraries').catch(() => ({}))).items || []
  } catch (error) {
    toast(failure(error))
  }
  if (!disposed) render()

  return () => {
    disposed = true
    doc.defaultView.clearTimeout(toastTimer)
    stopTheme()
    shell.remove()
  }
}
