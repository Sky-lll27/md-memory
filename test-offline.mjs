// 离线测试：不加载 DSH、不装插件，直接喂用例看行为
// 跑法：node test-offline.mjs
//
// 全部用 test-fixtures/ 里的示例数据，不读任何真实目录。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { __test } from './index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = path.join(__dirname, 'test-fixtures')

let pass = 0
let fail = 0
function check(ok, label, extra = '') {
  if (ok) {
    pass++
    console.log(`✅ ${label}${extra ? ' — ' + extra : ''}`)
  } else {
    fail++
    console.log(`❌ ${label}${extra ? ' — ' + extra : ''}`)
  }
}

// ─────────────────────────────────────────────
console.log('\n═══ A. 未配置（config = {}）═══')
{
  const cfg = __test.normalizeConfig({})
  const text = __test.buildRulesText(cfg)
  check(text.includes('未配置 memoryRoot'), 'section 含「未配置 memoryRoot」')
  check(__test.matchRoutes('随便说点什么', cfg).length === 0, '路由命中 0 条')
}

// ─────────────────────────────────────────────
console.log('\n═══ B. 配了示例目录 ═══')
{
  const cfg = __test.normalizeConfig({ memoryRoot: FIXTURE_ROOT })
  const files = __test.resolveRulesFiles(cfg)
  check(files.length === 2, 'rulesDir 下扫到 2 个 md', `实际 ${files.length}`)

  const text = __test.buildRulesText(cfg)
  check(text.includes('示例条目一') && text.includes('示例条目三'), '两份规则都进了 section')
  check(!text.includes('已截断'), '没有触发截断')
}

// ─────────────────────────────────────────────
console.log('\n═══ C. 触发用例 ═══')
{
  const cfg = __test.normalizeConfig({ memoryRoot: FIXTURE_ROOT })
  const cases = [
    ['好的，继续吧', 0],
    ['这个界面怎么部署', 1],
    ['数据库要迁移吗', 1],
    ['报错了帮我看看', 1],
    ['今天天气不错', 0],
  ]
  for (const [input, expect] of cases) {
    const filler = __test.isFiller(input)
    const routes = filler ? [] : __test.matchRoutes(input, cfg)
    const ok = expect === 0 ? routes.length === 0 : routes.length >= 1
    const first = routes.length ? routes[0].target : '—'
    console.log(`\n输入: ${input}`)
    console.log(`  废话闸: ${filler ? '拦截' : '放行'}`)
    console.log(`  命中数: ${routes.length}${first !== '—' ? `（${first}）` : ''}`)
    check(ok, ok ? '符合预期' : '不符合预期')
  }
}

// ─────────────────────────────────────────────
console.log(`\n========== ${pass} 通过 / ${fail} 失败 ==========`)
process.exit(fail === 0 ? 0 : 1)
