// md-memory — 把本地 Markdown 变成 AI 助手的常驻记忆
// 零依赖 / 只读 / 异常一律降级

import fs from 'node:fs'
import path from 'node:path'

// 声明对 systemPrompt 的硬依赖，保证注册时服务已就位
export const inject = ['systemPrompt']

// ── 配置默认值 ──────────────────────────────────────────
const DEFAULT_CONFIG = {
  memoryRoot: '',
  rulesDir: 'rules',
  rulesFiles: [],
  indexFile: 'INDEX.md',
  topicsDir: 'topics',
  maxBytesPerFile: 12_000,
  maxBytesTotal: 32_000,
}

function normalizeConfig(config = {}) {
  return {
    memoryRoot: typeof config.memoryRoot === 'string' ? config.memoryRoot.trim() : '',
    rulesDir: typeof config.rulesDir === 'string' && config.rulesDir.trim() ? config.rulesDir.trim() : DEFAULT_CONFIG.rulesDir,
    rulesFiles: Array.isArray(config.rulesFiles) ? config.rulesFiles.filter((f) => typeof f === 'string') : [],
    indexFile: typeof config.indexFile === 'string' && config.indexFile.trim() ? config.indexFile.trim() : DEFAULT_CONFIG.indexFile,
    topicsDir: typeof config.topicsDir === 'string' && config.topicsDir.trim() ? config.topicsDir.trim() : DEFAULT_CONFIG.topicsDir,
    maxBytesPerFile: Number.isFinite(config.maxBytesPerFile) && config.maxBytesPerFile > 0 ? config.maxBytesPerFile : DEFAULT_CONFIG.maxBytesPerFile,
    maxBytesTotal: Number.isFinite(config.maxBytesTotal) && config.maxBytesTotal > 0 ? config.maxBytesTotal : DEFAULT_CONFIG.maxBytesTotal,
  }
}

function configKey(config) {
  return JSON.stringify(config)
}

function resolveRulesFiles(config) {
  if (!config.memoryRoot) return []
  const rulesDir = path.isAbsolute(config.rulesDir) ? config.rulesDir : path.join(config.memoryRoot, config.rulesDir)
  if (config.rulesFiles.length) {
    return config.rulesFiles.map((f) => path.isAbsolute(f) ? f : path.join(rulesDir, f))
  }
  try {
    return fs.readdirSync(rulesDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => path.join(rulesDir, e.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
  } catch {
    return [rulesDir]
  }
}

function resolveIndexFile(config) {
  if (!config.memoryRoot) return null
  return path.isAbsolute(config.indexFile) ? config.indexFile : path.join(config.memoryRoot, config.indexFile)
}

function resolveTarget(target, config) {
  try {
    const short = target.replace(/（[^）]*）/g, '').trim()
    if (!short) return target
    const candidates = [
      path.join(config.memoryRoot, config.rulesDir, short + '.md'),
      path.join(config.memoryRoot, config.topicsDir, short + '.md'),
    ]
    for (const fp of candidates) {
      if (fs.existsSync(fp)) {
        return path.relative(config.memoryRoot, fp)
      }
    }
    return short
  } catch {
    return target
  }
}

// 废字黑名单：永不单独触发
const FILLER_CHARS = new Set(['的', '了', '是', '在', '我', '你', '他', '这', '那', '就', '也', '都', '啊', '吧', '吗', '呢'])

// ── 工具：纯函数 ─────────────────────────────────────────

/** 读文件；任何异常返回 null */
function readFileSafe(fp) {
  try {
    return fs.readFileSync(fp, 'utf8')
  } catch {
    return null
  }
}

/** 取文件 mtime（毫秒）；失败返回 0 */
function mtimeOf(fp) {
  try {
    return fs.statSync(fp).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 按字节预算截断 UTF-8 文本。
 * 超预算时在末尾追加一行「已截断到第 N 行」。
 */
function truncateWithNote(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const lines = text.split('\n')
  let acc = ''
  let lastLine = 0
  for (let i = 0; i < lines.length; i++) {
    const next = acc + (i === 0 ? '' : '\n') + lines[i]
    if (Buffer.byteLength(next, 'utf8') > maxBytes) break
    acc = next
    lastLine = i + 1
  }
  return acc + `\n\n[已截断到第 ${lastLine} 行]`
}

// 客套短语：整句就是这些 → 直接拦截
const FILLER_PHRASES = /^(好的?|嗯+|哦+|啊+|是|对|行|好|ok|okay|yes|no|继续|继续吧|接着|接着吧|谢谢|谢了|收到|明白|了解|知道|知道了|可以|行吧|嗯嗯|好好好)[\s，。！？!,.，。]*$/i

/** 废话闸：整句是客套短语，或清洗后实义字符 ≤ 2 → true */
function isFiller(text) {
  if (!text) return true
  const trimmed = text.trim()
  if (FILLER_PHRASES.test(trimmed)) return true
  const cleaned = trimmed.replace(/[\s，。！？、；：""''（）《》【】…—～·.,!?;:'"()\[\]<>-]/g, '')
  return cleaned.length <= 2
}

/** 简单分词：CJK 按字、英文/数字按词 */
function tokenize(text) {
  const tokens = []
  const words = text.toLowerCase().match(/[a-z0-9_]+/g) || []
  tokens.push(...words)
  const cjk = text.match(/[一-鿿]/g) || []
  tokens.push(...cjk)
  return tokens
}

/**
 * 从总索引 md 解析「触发词 → 文件路径」路由表。
 * 只认「听到这些 / 取这个文件」这张表，其他表格一律跳过。
 * 遇到空行或非表格行就停。
 * 返回 [{ keywords: [...], target: '短名' }]
 */
function extractRoutes(indexMd) {
  if (!indexMd) return []
  const lines = indexMd.split('\n')
  // 1) 定位表头行
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('听到这些') && lines[i].includes('取这个文件')) {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0) return []

  // 2) 从表头之后开始，跳过分隔行 |---|---|，然后连续解析 | 行
  const routes = []
  let started = false
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    // 分隔行 |---|...| → 跳过
    if (/^\|[\s\-|]+\|/.test(line)) continue
    // 表格行
    const m = line.match(/^\|(.+?)\|\s*`([^`]+)`\s*\|/)
    if (m) {
      started = true
      const keywords = m[1]
        .split(/[\/、，,]/)
        .map((s) => s.trim().replace(/\*\*/g, ''))
        .filter(Boolean)
      const target = m[2].trim()
      if (keywords.length && target) routes.push({ keywords, target })
      continue
    }
    // 已开始之后遇到非表格行 → 停
    if (started) break
  }
  return routes
}

/**
 * 词频匹配（简化版）。
 * 规则：
 *  - 关键词是单字 → query 里出现这个单字就命中（废字黑名单除外），1 分
 *  - 关键词是多字 → 必须整词出现在 query 原文里，2 分
 */
function scoreRoute(queryText, queryTokens, keywords) {
  if (!keywords.length) return 0
  const tokenSet = new Set(queryTokens)
  let score = 0
  for (const kw of keywords) {
    const k = kw.trim()
    if (!k) continue
    if (k.length === 1 && /[一-鿿]/.test(k)) {
      // 单字关键词
      if (FILLER_CHARS.has(k)) continue
      if (tokenSet.has(k)) score += 1
    } else {
      // 多字关键词：整词包含匹配
      if (queryText.includes(k)) score += 2
    }
  }
  return score
}

/** 从消息 content 提取文本（content 可能是 string 或 block 数组） */
function extractTextFromBlocks(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === 'text')
      .map((b) => b.text || '')
      .join(' ')
  }
  return ''
}

/** 取 agent 最新一条 user 消息文本（参考 cue-bank 的 latestUserText） */
function latestUserText(agent) {
  try {
    const events = agent.session?.events || []
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.type === 'user/message') {
        const text = extractTextFromBlocks(ev.data?.message?.content)
        if (text) return text
      }
    }
    return ''
  } catch {
    return ''
  }
}

// ── 规则缓存（按 mtime + 配置失效） ─────────────────────
const rulesCache = { key: '', text: '' }

function buildRulesText(config) {
  try {
    const cfg = normalizeConfig(config)
    if (!cfg.memoryRoot) {
      return '[md-memory] 未配置 memoryRoot，插件未启用。请在 cordis.patch.yml 的 config 里填你的记忆库目录。'
    }

    const files = resolveRulesFiles(cfg)
    const mtimeKey = files.map((fp) => mtimeOf(fp)).join('|')
    const key = configKey(cfg) + '|' + mtimeKey
    if (key === rulesCache.key && rulesCache.text) {
      return rulesCache.text
    }

    const parts = []
    let totalBytes = 0
    for (const fp of files) {
      const raw = readFileSafe(fp)
      const basename = path.basename(fp)
      if (raw === null) {
        parts.push(`\n## ${basename}\n[读不到 ${basename}，已跳过]\n`)
        continue
      }
      const truncated = truncateWithNote(raw, cfg.maxBytesPerFile)
      const sectionBytes = Buffer.byteLength(truncated, 'utf8')
      if (totalBytes + sectionBytes > cfg.maxBytesTotal) {
        parts.push(`\n[总量超 ${cfg.maxBytesTotal} 字节，已跳过 ${basename}]\n`)
        continue
      }
      parts.push(truncated)
      totalBytes += sectionBytes
    }

    const text = parts.join('')
    rulesCache.key = key
    rulesCache.text = text
    return text
  } catch (err) {
    return `[md-memory] buildRulesText 异常: ${err?.message || err}`
  }
}

// ── 路由匹配 ───────────────────────────────────────────
let routesCache = { key: '', routes: [] }

function getRoutes(config) {
  const cfg = normalizeConfig(config)
  if (!cfg.memoryRoot) return []
  const indexFile = resolveIndexFile(cfg)
  if (!indexFile) return []
  const mt = mtimeOf(indexFile)
  const key = configKey(cfg) + '|' + mt
  if (key === routesCache.key && routesCache.routes.length) {
    return routesCache.routes
  }
  const md = readFileSafe(indexFile)
  routesCache = { key, routes: extractRoutes(md) }
  return routesCache.routes
}

function matchRoutes(userText, config) {
  const queryTokens = tokenize(userText)
  if (!queryTokens.length) return []
  const routes = getRoutes(config)
  const scored = routes
    .map((r) => ({ route: r, score: scoreRoute(userText, queryTokens, r.keywords) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.map((x) => x.route)
}

function formatReminder(routes, config) {
  const lines = routes.map((r) => `- 触发「${r.keywords.join(' / ')}」→ 查 \`${resolveTarget(r.target, config)}\``)
  return [
    '<system-reminder>',
    '📌 记忆库路由命中：建议按下列文件查证后再答',
    ...lines,
    '</system-reminder>',
  ].join('\n')
}

// ── 主挂载 ─────────────────────────────────────────────
export function apply(ctx, config) {
  try {
    ctx.on('agent/created', (payload) => {
      try {
        const agent = payload?.agent
        if (!agent) return

        // section：每轮全量规则
        try {
          agent.ctx.systemPrompt.section({
            name: 'memory-rules',
            order: 80000,
            text: () => buildRulesText(config),
          })
        } catch (err) {
          console.error('[md-memory] section 注册失败:', err?.message || err)
        }

        // context：路由提醒
        try {
          agent.ctx.systemPrompt.context({
            name: 'memory-route',
            order: 80001,
            text: () => {
              try {
                const userText = latestUserText(agent)
                if (isFiller(userText)) return ''
                const routes = matchRoutes(userText, config)
                if (!routes.length) return ''
                return formatReminder(routes.slice(0, 3), config)
              } catch {
                return ''
              }
            },
          })
        } catch (err) {
          console.error('[md-memory] context 注册失败:', err?.message || err)
        }
      } catch (err) {
        console.error('[md-memory] agent/created 处理失败:', err?.message || err)
      }
    })
  } catch (err) {
    console.error('[md-memory] apply 失败:', err?.message || err)
  }
}

// ── 导出纯函数供离线测试用 ────────────────────────────
export const __test = {
  tokenize,
  isFiller,
  extractRoutes,
  scoreRoute,
  matchRoutes,
  resolveTarget,
  latestUserText,
  extractTextFromBlocks,
  buildRulesText,
  truncateWithNote,
  normalizeConfig,
  resolveRulesFiles,
  resolveIndexFile,
}
