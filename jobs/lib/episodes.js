// 集号集合：宿主用 "1-3,5" 表示。
export function parseEpisodes(text) {
  const out = new Set()
  for (const part of String(text || '').split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/)
    if (!m) continue
    const start = Number(m[1]), end = Number(m[2] || m[1])
    for (let n = start; n <= end && n - start < 10000; n++) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

export function formatEpisodes(list) {
  const sorted = [...new Set(list)].filter(n => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
  const parts = []
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]
    while (sorted[i + 1] === sorted[i] + 1) i++
    parts.push(start === sorted[i] ? String(start) : `${start}-${sorted[i]}`)
  }
  return parts.join(',')
}

export const minusEpisodes = (a, b) => { const drop = new Set(b); return a.filter(n => !drop.has(n)) }
export const fullSeason = total => Array.from({ length: Math.max(0, total) }, (_, i) => i + 1)
