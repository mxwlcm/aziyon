/**
 * ZeppLife运动助手 —— 青龙面板版（Node.js）  v2.7.0-ql
 *
 * ⚠️⚠️ 部署命名铁律：脚本文件名**绝对不能带空格** ⚠️⚠️
 *   青龙的任务命令会经过 shell 解析，文件名里的空格会被当成分隔符。
 * 
 * ── 版本演进（近几版）──────────────────────────────────────────────
 *   2.7.0  删除推送末行固定文案及其配置项
 *          多账号之间改为随机间隔 10~120 秒（原为固定 HM_SPAN 10 秒，已移除该环境变量）
 *   2.6.0  启动随机延迟 10~60 秒
 *          token 流程简化为两段式：有 token 直接用；失效则账号密码重新获取
 *          （新增配置区开关 USE_RENEW_FALLBACK，默认 false）
 *          读取兼容全部历史缓存文件名，多份缓存合并去重（修 429 根因）
 *          缓存优先写 /ql/data 持久化目录，原子落盘
 *   2.5.0  maxRedirects 默认 0（修 403）、403 专项诊断、HM_MODE=check
 * 
 *
 * ── token 机制 ──────────────────────────────────────────────────────
 *   获取 token 的唯一方式就是「账号密码登录」。
 *   缓存文件默认叫「zepp_token.json」，内容为 JSON（用 fs 读写，不是可执行脚本）：
 *   [账号, login_token, 更新时间, app_token, userid]
 *
 *   每次运行：
 *     ① 缓存里有 token → 直接用它提交步数（token 执行，只发 1 个请求）
 *     ② 提交时发现 token 已失效 → 用账号密码重新获取 token → 再提交
 *
 *   （可选）把配置区 USE_RENEW_FALLBACK 改成 true，失效后会先试一次「刷新 token」，
 *   只有 1 个请求且不会顶号，能明显降低触发华米登录风控(429) 的概率。
 *
 *   存放位置见下方 HM_TOKEN_FILE；写盘采用「临时文件 + 改名」，避免半截 JSON 作废缓存。
 * 
 *
 * ── 配置区（直接在代码里改，不走环境变量）───────────────────────────
 *   STEPS_MIN / STEPS_MAX     每日步数随机区间，默认 21520 ~ 98000。
 * 
 *   DELAY_MIN/MAX_SECONDS     启动随机延迟秒数，默认 10 ~ 60，设 0/0 关闭。
 *   ACCOUNT_GAP_MIN/MAX       多账号之间的随机间隔秒数，默认 10 ~ 120，设 0/0 关闭。
 *  
 *   USE_RENEW_FALLBACK        token 失效后是否先试一次刷新（默认 false）。
 *
 * ── 环境变量 ────────────────────────────────────────────────────────
 *   HM_DATA       必填。账号#密码，多账号用 “ 换行 ” 或者 “ & ” 隔开
 *   HM_NOTIFY     推送方式：ql(默认，面板自带) / webhook / both
 *   HM_WEWORK / HM_DINGDING / HM_FEISHU / HM_PUSHME   仅 HM_NOTIFY=webhook/both 时使用
 *   HM_TIMEOUT      单请求超时 ms，默认 15000
 *   HM_TOKEN_FILE   token 缓存路径，一般不用填。不填则自动选择：
 *                     · 读：扫描「脚本目录 + /ql/data + 当前目录」下的所有
 *                       历史文件名，多份则合并，取最新最全的那条
 *                     · 写：青龙（存在 /ql/data 或 $QL_DIR/data）→ 存到该数据目录，
 *                       因为 /ql/scripts 会被 ql update / 拉库 / 容器重建清空
 *                       其它环境 → 存到脚本同目录
 *   HM_MAXREDIRECT  HTTP 跳转跟随次数，默认 0（对齐 Python 版）
 *   HM_DEBUG        1 = 打印请求明细
 *   HM_MODE         check = 只做连通性自检，不下发步数
 *
 * ── 排查 403 的正确姿势 ─────────────────────────────────────────────
 *   1) 环境变量 HM_MODE 设为 check，执行一次任务，看哪一行不是 200/400/401
 *   2) 全部 403 → 出口 IP 被华米 WAF 拦（青龙多部署在云服务器机房 IP 上，
 *      家宽 IP 正常、机房 IP 被拦很常见）：需换出口 IP 或走代理
 *   3) 仅某一行 403 → 把那一行连同响应头贴出来即可定位
 *   4) 登录 401 且带 attempts/maxAttempts → 密码错太多次，账号被临时锁定
 *
 * 青龙定时规则建议：0 30 8 * *    依赖：axios
 */

'use strict'

const axios = require('axios')
const fs = require('fs')
const path = require('path')

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  配置区：直接改这里，不用加环境变量                                       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// 每日步数随机区间（含两端，区间内均匀随机）
// 想改步数范围就改下面这两个数字，保存即生效
const STEPS_MIN = 21520
const STEPS_MAX = 98000

// ── 启动随机延迟（秒）─────────────────────────────────────────────────
// 每次运行先随机等 DELAY_MIN_SECONDS ~ DELAY_MAX_SECONDS 秒再干活。
// 目的：让每次发起请求的时间点不固定，避免每天都卡在同一秒执行（时间太规律容易被风控盯上）。
// 想关掉就设成 0 / 0；只有 1 个账号时也会生效。
const DELAY_MIN_SECONDS = 10
const DELAY_MAX_SECONDS = 60

// ── 账号之间的随机间隔（秒）──────────────────────────────────────────
// 多账号时：第 1 个账号跑完 → 随机等 ACCOUNT_GAP_MIN ~ MAX 秒 → 第 2 个账号，
// 以此类推；最后一个账号结束后不再等待。
// 只有 1 个账号时不生效。想关掉就设成 0 / 0。
const ACCOUNT_GAP_MIN_SECONDS = 10
const ACCOUNT_GAP_MAX_SECONDS = 120
const AUTHOR_TAG_ENC = 'suHqltDFgPjl1Iqi09/JlMzbjOnSr46q2qf5gMD/qfT9'
const AUTHOR_TAG_KEY = 'ZeppLife@2026'

function decodeObfuscated(b64, key) {
  try {
    const raw = Buffer.from(String(b64 || ''), 'base64')
    if (!raw.length) return ''
    const k = String(key || '')
    if (!k) return ''
    const out = Buffer.alloc(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw[i] ^ k.charCodeAt(i % k.length)
    const text = out.toString('utf8')
    if (!text || /[\u0000-\u001f\ufffd]/.test(text)) return '' // 完整性粗检
    return text
  } catch (e) {
    return ''
  }
}

const AUTHOR_TAG = decodeObfuscated(AUTHOR_TAG_ENC, AUTHOR_TAG_KEY)

// ── token 失效后的兜底方式 ─────────────────────────────────────────────
// false = 按需求：token 失效就直接用「账号密码登录」重新获取 token
// true  = 失效后先试一次「刷新 token」（只发 1 个请求，不会顶号，
//         因此更不容易触发华米登录风控 429），刷新不行再密码登录
//
// 默认 false。如果发现账号经常被限流（日志出现 too many requests / HTTP 429），
// 把这里改成 true 能显著减少密码登录次数，从而降低被风控的概率。
const USE_RENEW_FALLBACK = false

// ══════════════════════════════════════════════════════════════════════════

function toInt(v, dft) {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : dft
}

// 新建缓存时用的文件名。
// 特意用「ASCII + .json」而不是 .js：
//   1) .js 会被青龙「脚本管理」当成脚本列出来，可能被误当成任务运行；
//   2) 内容本来就是 JSON，用 .json 名副实归，也不会被 node --check / 依赖扫描误伤；
//   3) 非 ASCII 文件名在部分容器 locale 下容易出幺蛾子。
const CACHE_DEFAULT_NAME = 'zepp_token.json'

// 历史上用过的所有文件名 —— 读取时全部兼容。
// 第 1 个就是「改名前一直能用」的那个名字，所以它同时是新建时的默认名。
// ⚠️ 这里只增不删：任何时候改名都必须把旧名字留在数组里，
//    否则脚本会找不到老缓存 → 每次都密码登录 → 触发华米登录风控(429)。
const CACHE_KNOWN_NAMES = [
  'zepp_token.json',
  'huami_token.json',
  'Zepp Life运动助手token缓存.js',
  'Zepp Life运动助手token缓存.json',
]

/** 候选目录，按「越持久越靠前」排序 */
function cacheDirs() {
  const dirs = []
  if (process.env.QL_DIR) dirs.push(path.join(process.env.QL_DIR, 'data'))
  dirs.push(path.join('/ql', 'data')) // 青龙持久化数据目录
  dirs.push(__dirname) // 脚本同目录（本地调试 / 非青龙）
  // 脚本常被放进子目录（如 /ql/scripts/mxkj/），老缓存却可能留在上一级，
  // 所以父目录也一并搜索，避免「找不到老 token → 每次密码登录 → 撞风控」。
  dirs.push(path.dirname(__dirname))
  dirs.push(path.join('/ql', 'scripts'))
  if (process.cwd() !== __dirname) dirs.push(process.cwd())
  return dirs.filter((d, i) => d && dirs.indexOf(d) === i)
}

/**
 * 决定「新建」缓存写到哪。
 *  1. HM_TOKEN_FILE（用户显式指定，最高优先级）
 *  2. ${QL_DIR}/data 或 /ql/data —— 已存在才用，不主动创建（避免在 Windows 上
 *     凭空造出一个 \ql\data）；这是青龙的持久化卷，`ql update`/拉库不会动它
 *  3. 脚本同目录
 */
function resolveTokenFile() {
  const explicit = (process.env.HM_TOKEN_FILE || '').trim()
  if (explicit) return explicit

  const dataDirs = []
  if (process.env.QL_DIR) dataDirs.push(path.join(process.env.QL_DIR, 'data'))
  dataDirs.push(path.join('/ql', 'data'))
  for (const dir of dataDirs) {
    try {
      if (fs.existsSync(dir)) return path.join(dir, CACHE_DEFAULT_NAME)
    } catch (e) { /* 忽略，继续找下一个 */ }
  }

  return path.join(__dirname, CACHE_DEFAULT_NAME)
}

/**
 * 待搜索的全部缓存路径 = 候选目录 × 已知文件名，外加用户显式指定的那个。
 * 这样无论老缓存叫 zepp_token.json 还是 Zepp Life运动助手token缓存.js、
 * 不管它躺在脚本目录还是 /ql/data，都能被找到并复用。
 */
function tokenFileCandidates() {
  const list = [CFG.tokenFile]
  for (const dir of cacheDirs()) {
    for (const name of CACHE_KNOWN_NAMES) list.push(path.join(dir, name))
  }
  return list.filter((p, i) => p && list.indexOf(p) === i)
}

const CFG = {
  data: (process.env.HM_DATA || '').replace(/&/g, '\n').trim(),
  // 步数区间取自文件顶部「配置区」的 STEPS_MIN / STEPS_MAX
  min: STEPS_MIN,
  max: STEPS_MAX,
  // 推送方式：ql(青龙面板自带，默认) / webhook(脚本内置四渠道) / both
  notify: (process.env.HM_NOTIFY || 'ql').trim().toLowerCase(),
  wework: (process.env.HM_WEWORK || '').trim(),
  dingding: (process.env.HM_DINGDING || '').trim(),
  feishu: (process.env.HM_FEISHU || '').trim(),
  pushme: (process.env.HM_PUSHME || '').trim(),
  timeout: toInt(process.env.HM_TIMEOUT, 15000),
  // token 缓存文件（内容是 JSON，靠 fs 读写）
  tokenFile: resolveTokenFile(),
  // 对齐 Python 版 requests 的 allow_redirects=False
  maxRedirects: toInt(process.env.HM_MAXREDIRECT, 0),
  debug: /^(1|true|yes|on)$/i.test(process.env.HM_DEBUG || ''),
  mode: (process.env.HM_MODE || '').trim().toLowerCase(),
}

const SCRIPT_NAME = 'Zepp Life运动助手'
const SCRIPT_VERSION = '2.7.0-ql'
const DEVICE_ID = '88CC5224060006C4'

const H = {
  userName: '',
  thirdName: 'huami',
  tokenTemp: '',
  tokenInfo: null,
  todaySteps: 0,
  rateLimited: false, // 撞到 429 后置为 true，本次运行不再继续尝试登录
  headers: {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'user-agent': 'MiFit/6.12.0 (MCE16; Android 16; Density/1.5)',
    'app_name': 'com.xiaomi.hm.health',
  },
}

// ============================ 工具 ============================

function log(title, text, push = false) {
  console.log(`${title} ${text}`)
  void push
}

function getRandomNum(min, max) {
  return Math.floor(Math.random() * (max + 1 - min) + min)
}

function getTimestamp(sec = false) {
  const timeNow = Date.now()
  return sec ? Math.floor(timeNow / 1000) : timeNow
}

function getDatetime(only = false) {
  const timeUTC = new Date()
  const newDateChina = new Date(timeUTC.setUTCHours(timeUTC.getUTCHours() + 8))
  const dateChina = newDateChina.toISOString().split('T')[0]
  const datetimeChina = newDateChina.toISOString().split('.')[0].replace('T', ' ')
  return only ? dateChina : datetimeChina
}

function isJSON(s) {
  try {
    const j = JSON.parse(s)
    return Array.isArray(j) || (typeof j === 'object' && j !== null)
  } catch (e) {
    return false
  }
}

function formatStr(str) {
  const lines = (str || '').split(/\r?\n/)
  const result = []
  for (const line of lines) {
    if (line.trim() === '') continue
    const pairs = line.split(',')
    for (const pair of pairs) {
      const trimmedPair = pair.trim()
      if (trimmedPair === '') continue
      const parts = trimmedPair.split('#')
      if (parts.length !== 2 || parts[0].trim() === '' || parts[1].trim() === '') {
        return []
      }
      result.push([parts[0].trim(), parts[1].trim()])
    }
  }
  return result
}

/**
 * 账号 + token 缓存合并 -> [{user, pwd, loginToken, since, appToken, userId, steps}]
 * 兼容两种缓存格式：
 *   旧: [账号, loginToken, 时间戳]
 *   新: [账号, loginToken, 时间戳, appToken, userid]
 */
function mergeArray(group1, group2) {
  const cacheMap = group2.reduce((map, item) => {
    if (!Array.isArray(item) || !item[0]) return map
    map[item[0]] = {
      loginToken: item[1] || '',
      since: item[2] || 0,
      appToken: item[3] || '',
      userId: item[4] || '',
    }
    return map
  }, {})
  const accounts = [...new Set(group1.map((item) => item[0]))]
  return accounts.map((user) => {
    const pwd = group1.find((i) => i[0] === user)[1]
    const c = cacheMap[user] || {}
    return {
      user,
      pwd,
      loginToken: c.loginToken || '',
      since: c.since || 0,
      appToken: c.appToken || '',
      userId: c.userId || '',
      steps: 0,
    }
  })
}

/** 把某个账号的最新 token 写回缓存，保留其他账号的原有记录 */
function updateCache(cacheArr, account) {
  const rows = cacheArr.filter((item) => Array.isArray(item) && item[0] !== account.user)
  rows.push([
    account.user,
    account.loginToken || '',
    getTimestamp(),
    account.appToken || '',
    account.userId || '',
  ])
  return rows
}

function maskHeaders(headers) {
  const out = { ...headers }
  for (const k of Object.keys(out)) {
    if (/cookie|token|authorization|apptoken/i.test(k)) {
      out[k] = String(out[k]).slice(0, 6) + '...'
    }
  }
  return out
}

function proxyEnv() {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
  return keys.filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`)
}

/** 只挑对"谁在挡你"有帮助的响应头 */
function pickHeaders(headers) {
  if (!headers) return {}
  const wanted = [
    'server', 'date', 'content-type', 'x-cache', 'cf-ray',
    'via', 'x-request-id', 'x-amzn-requestid', 'location', 'www-authenticate',
  ]
  const out = {}
  for (const k of wanted) if (headers[k] !== undefined) out[k] = headers[k]
  return out
}

// ============================ token 持久化 ============================

/** 单条缓存记录的「好坏」：先比时间新旧，再比字段完整度 */
function cacheRowScore(row) {
  if (!Array.isArray(row)) return null
  const since = Number(row[2]) || 0
  const complete = (row[1] ? 1 : 0) + (row[3] ? 1 : 0) + (row[4] ? 1 : 0)
  return { since, complete }
}

function cacheRowBetter(a, b) {
  const sa = cacheRowScore(a)
  const sb = cacheRowScore(b)
  if (!sa) return false
  if (!sb) return true
  if (sa.since !== sb.since) return sa.since > sb.since // 越新越可信
  return sa.complete > sb.complete
}

/**
 * 读出 token 缓存。
 *
 * 关键点：会扫描「所有候选目录 × 所有历史文件名」，把找到的缓存合并起来，
 * 每个账号取「时间最新、字段最全」的那一条。
 *
 * 这样即便之前改过缓存文件名（zepp_token.json → Zepp Life运动助手token缓存.js 之类），
 * 老文件里的有效 token 依然能被找回来复用，不会退化成密码登录去撞华米风控。
 *
 * 注意：本函数**不修改** CFG.tokenFile —— 它始终指向「安全的新建位置」，
 * 于是 main() 结尾那次 saveTokenCache 会把合并结果写过去，等于自动迁移。
 */
function loadTokenCache() {
  const hits = []
  for (const file of tokenFileCandidates()) {
    try {
      if (!fs.existsSync(file)) continue
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(arr) && arr.length) hits.push({ file, arr })
    } catch (e) {
      log('🟡', `读取 token 缓存失败（${file}）：${e.message}`)
    }
  }

  if (!hits.length) return []

  if (hits.length === 1) {
    log('🔵', `已读到 token 缓存：${hits[0].file}（${hits[0].arr.length} 个账号）`)
    return hits[0].arr
  }

  // 多份缓存并存 → 按账号合并，取最新最全的一条
  const merged = new Map()
  for (const { arr } of hits) {
    for (const row of arr) {
      if (!Array.isArray(row) || !row[0]) continue
      const prev = merged.get(row[0])
      if (!prev || cacheRowBetter(row, prev)) merged.set(row[0], row)
    }
  }
  log('🔵', `发现 ${hits.length} 份 token 缓存，已合并去重：`)
  for (const { file, arr } of hits) console.log(`     · ${file}（${arr.length} 条）`)
  console.log(`     ↳ 合并后 ${merged.size} 个账号，将统一写入 ${CFG.tokenFile}`)
  return [...merged.values()]
}

function saveTokenCache(arr) {
  // 目标顺序：安全的新建位置优先，然后其它候选位置兜底
  const targets = tokenFileCandidates()
  for (const target of targets) {
    const tmp = `${target}.tmp`
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      // 先写临时文件再改名：避免写到一半被杀进程留下半截 JSON，
      // 下次读取时 JSON.parse 抛错导致缓存整体作废
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2))
      fs.renameSync(tmp, target)
      CFG.tokenFile = target
      return true
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (e2) { /* 清理失败无所谓 */ }
      log('🟡', `写入 token 缓存失败（${target}）：${e.message}`)
    }
  }
  return false
}

// ============================ HTTP ============================

/**
 * 对应 GM_xmlhttpRequest / requests.request
 * 成功返回响应文本；非 200 抛异常（调用方 catch 后返回 null/false）
 */
async function xhr(options) {
  const { method = 'GET', url, headers = {}, data } = options

  if (CFG.debug) {
    console.log(`[DEBUG] --> ${method} ${url}`)
    console.log(`[DEBUG]     headers=${JSON.stringify(maskHeaders(headers))}`)
    console.log(`[DEBUG]     body=${(typeof data === 'string' ? data : JSON.stringify(data || '')).slice(0, 400)}`)
  }

  let res
  try {
    res = await axios({
      method,
      url,
      headers,
      data,
      timeout: CFG.timeout,
      maxRedirects: CFG.maxRedirects,
      transformResponse: [(d) => d],
      // 自己判状态码，避免 axios 抛出 "Request failed with status code XXX"
      validateStatus: () => true,
    })
  } catch (err) {
    if (err.code === 'ECONNABORTED') log('🔴', `请求超时（${CFG.timeout}ms）！${method} ${url}`)
    else if (err.code === 'ERR_FR_TOO_MANY_REDIRECTS') log('🔴', `跳转次数超限！${method} ${url}`)
    else log('🔴', `请求异常！${method} ${url} 🔛${err.code || ''} ${err.message}`)
    throw err
  }

  if (CFG.debug) {
    console.log(`[DEBUG] <-- ${res.status} ${url}`)
    console.log(`[DEBUG]     headers=${JSON.stringify(pickHeaders(res.headers))}`)
    console.log(`[DEBUG]     body=${String(res.data).slice(0, 400)}`)
  }

  if (res.status === 200) return res.data

  if (res.status === 403) {
    log('🔴', '403 Forbidden —— 访问被拒绝，这不是账号密码的问题')
    console.log(`     方法: ${method}`)
    console.log(`     地址: ${url}`)
    console.log(`     响应头: ${JSON.stringify(pickHeaders(res.headers))}`)
    console.log(`     响应体: ${String(res.data).slice(0, 500)}`)
    const pe = proxyEnv()
    if (pe.length) console.log(`     ⚠️ 检测到代理环境变量: ${pe.join(', ')}`)
    console.log('     ↳ 若所有接口都 403：出口 IP 被华米 WAF 拦（机房 IP 常见），需换出口 IP 或走代理')
    console.log('     ↳ 若仅此接口 403：把上面几行贴出来即可定位')
    const err403 = new Error('HTTP 403')
    err403.httpStatus = 403
    throw err403
  }
  if (res.status === 429) {
    H.rateLimited = true // 被限流了，后续不再继续尝试以免加重风控
    log('🟡', `请求过于频繁，请稍后再试！${method} ${url} 🔛${res.data}`, true)
    const err429 = new Error('HTTP 429')
    err429.httpStatus = 429
    throw err429
  }
  if (res.status >= 300 && res.status < 400) {
    // maxRedirects=0 时 3xx 会原样返回，这正是 Python 版的行为
    log('🟡', `收到 ${res.status} 跳转但未跟随（HM_MAXREDIRECT=${CFG.maxRedirects}）：${method} ${url}`)
    console.log(`     location: ${res.headers && res.headers.location}`)
    const err3xx = new Error(`HTTP ${res.status}`)
    err3xx.httpStatus = res.status
    throw err3xx
  }

  log('🔴', `请求失败，状态码：${res.status} ${method} ${url} 🔛${String(res.data).slice(0, 300)}`)
  const errHttp = new Error(`HTTP ${res.status}`)
  errHttp.httpStatus = res.status
  throw errHttp
}

// ============================ 华米接口 ============================

async function login(account) {
  let message = `「${account.user}」获取 AccessToken `
  try {
    const result = await xhr({
      method: 'POST',
      url: `https://api-user.huami.com/registrations/${H.userName}/tokens`,
      headers: H.headers,
      data: new URLSearchParams({
        client_id: 'HuaMi',
        country_code: 'CN',
        json_response: true,
        name: H.userName,
        password: account.pwd,
        redirect_uri: 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html',
        state: 'REDIRECTION',
        token: 'access',
      }).toString(),
    })
    if (result && isJSON(result)) {
      const res = JSON.parse(result)
      if (res.access) {
        H.tokenTemp = res.access
        log('🟢', `${message}成功！`)
      } else {
        let extra = ''
        if (res.attempts !== undefined && res.maxAttempts !== undefined) {
          extra = `（已失败 ${res.attempts}/${res.maxAttempts} 次，达上限后账号会被临时锁定）`
        }
        log('🟡', `「${account.user}」用户名或密码错误！${extra}🔛${result}`, true)
        return false
      }
    } else {
      log('🔴', `${message}失败！🔛${result}`)
      return false
    }
  } catch (e) {
    return null
  }

  message = `「${account.user}」获取 UserInfo `
  try {
    const result = await xhr({
      method: 'POST',
      url: 'https://account.huami.com/v2/client/login',
      headers: H.headers,
      data: new URLSearchParams({
        app_name: 'com.xiaomi.hm.health',
        country_code: 'CN',
        code: H.tokenTemp,
        device_id: '02:00:00:00:00:00',
        device_model: 'android_phone',
        app_version: '6.12.0',
        grant_type: 'access_token',
        allow_registration: false,
        source: 'com.xiaomi.hm.health',
        third_name: H.thirdName,
      }).toString(),
    })
    if (result && isJSON(result)) {
      const res = JSON.parse(result)
      if (res.token_info) {
        H.tokenInfo = {
          id: res.token_info.user_id,
          app: res.token_info.app_token,
          login: res.token_info.login_token,
        }
        account.loginToken = res.token_info.login_token
        account.appToken = res.token_info.app_token
        account.userId = res.token_info.user_id
        log('🟢', `${message}成功！`)
        return true
      }
    }
    log('🔴', `${message}失败！🔛${result}`)
    return false
  } catch (e) {
    return null
  }
}

/**
 * 用 login_token 换一套新 token（renew_login_token → app_tokens）。
 * 只发 2 个请求、不会顶号，对风控友好。
 * 默认流程不调用它 —— 由配置区 USE_RENEW_FALLBACK 决定是否启用。
 */
async function renew(account) {
  let message = `「${account.user}」获取 LoginToken `
  try {
    const result = await xhr({
      url: `https://account-cn.huami.com/v1/client/renew_login_token?login_token=${account.loginToken}`,
      headers: H.headers,
    })
    if (result && isJSON(result)) {
      const res = JSON.parse(result)
      if (res.token_info) {
        H.tokenTemp = res.token_info.login_token
        log('🟢', `${message}成功！`)
      } else {
        log('🟡', `${message}失败！ 🔛${result}`)
        return false
      }
    } else {
      log('🔴', `${message}失败！🔛${result}`)
      return false
    }
  } catch (e) {
    return null
  }

  message = `「${account.user}」获取 AppToken `
  try {
    const result = await xhr({
      url: `https://account-cn.huami.com/v1/client/app_tokens?login_token=${H.tokenTemp}`,
      headers: H.headers,
    })
    if (result && isJSON(result)) {
      const res = JSON.parse(result)
      if (res.token_info) {
        H.tokenInfo = {
          id: res.token_info.user_id,
          app: res.token_info.app_token,
          login: H.tokenTemp,
        }
        account.loginToken = H.tokenTemp
        account.appToken = res.token_info.app_token
        account.userId = res.token_info.user_id
        log('🟢', `${message}成功！`)
        return true
      }
    }
    log('🔴', `${message}失败！🔛${result}`)
    return false
  } catch (e) {
    return null
  }
}

async function submit(account) {
  H.todaySteps = 0
  const headers = { ...H.headers }
  headers.apptoken = H.tokenInfo.app
  const todaySteps = getRandomNum(CFG.min, CFG.max)
  const dataJSON = {
    date: getDatetime(true),
    data_hr: '/v7+'.repeat(480),
    data: [
      {
        start: 0,
        stop: 1439,
        value: 'AU'.repeat(1440 * 2),
        tz: 32,
        did: DEVICE_ID,
        src: 24,
      },
    ],
    summary: JSON.stringify({
      v: 6,
      stp: {
        ttl: todaySteps,
        dis: Math.floor(todaySteps * 0.7),
        cal: Math.floor(todaySteps / 25),
        wk: Math.floor(todaySteps / 120),
      },
      goal: 8000,
    }),
    source: 24,
    type: 0,
  }

  const message = `「${account.user}」步数数据提交`
  try {
    const result = await xhr({
      method: 'POST',
      url: `https://api-mifit-cn.huami.com/v1/data/band_data.json?t=${getTimestamp()}`,
      headers,
      data: new URLSearchParams({
        userid: H.tokenInfo.id,
        device_type: 0,
        last_source: 24,
        last_deviceid: DEVICE_ID,
        enableMultiDevice: 1,
        last_sync_data_time: getTimestamp(true),
        data_json: JSON.stringify([dataJSON]),
      }).toString(),
    })
    if (result && isJSON(result)) {
      const res = JSON.parse(result)
      if (res.code && res.code == 1) {
        H.todaySteps = todaySteps
        log('🟣', `${message}完成！今日步数：${todaySteps} 🔛${result}`)
        return 'ok'
      }
      // apptoken 失效的典型响应：{"code":0,"message":"invalid token","data":{"code":"0102"}}
      if (
        /invalid token/i.test(res.message || '') ||
        (res.data && String(res.data.code) === '0102')
      ) {
        return 'token_invalid'
      }
    }
    log('🔴', `${message}失败！🔛${result}`)
    return 'fail'
  } catch (e) {
    // 401 同样代表 apptoken 失效，交给上层刷新后重试
    if (e && e.httpStatus === 401) return 'token_invalid'
    return 'fail'
  }
}

/**
 * token 生命周期：用账号密码获取 token，有效就直接执行；失效就重新获取
 *   ① 缓存里有 token → 直接提交步数（token 执行，只发 1 个请求）
 *   ② 提交时发现 token 已失效 → 账号密码重新登录获取 token → 再提交
 *
 * 不区分缓存新旧：token 到底还能不能用，让接口说了算，比自己按天数猜更准。
 *
 * 配置区 USE_RENEW_FALLBACK=true 时，会在 ①② 之间插入一步「刷新 token」
 * （1 个请求、不顶号，能降低登录风控概率），刷新不行再走 ②。
 */
async function loginAndSubmit(account) {
  // 已经撞到限流就不要再试了，越试冷却越久
  if (H.rateLimited) {
    log('🟡', `「${account.user}」仍处于限流状态，本次跳过以免加重风控`)
    return false
  }

  // ① 用缓存 token 直接执行
  if (account.appToken && account.userId) {
    H.tokenInfo = { id: account.userId, app: account.appToken, login: account.loginToken }
    log('🟢', `「${account.user}」使用 token 提交步数`)
    const r = await submit(account)
    if (r === 'ok') return true
    log(
      '🟡',
      `「${account.user}」${r === 'token_invalid' ? 'token 已失效' : '提交未成功'}，准备重新获取 token...`
    )
  } else {
    log('🟡', `「${account.user}」本地没有可用 token，使用账号密码获取...`)
  }

  // ② 可选：先尝试刷新 token（不顶号，风控友好）
  if (USE_RENEW_FALLBACK && account.loginToken && !H.rateLimited) {
    log('🟡', `「${account.user}」尝试刷新 token...`)
    if (await renew(account)) {
      const r = await submit(account)
      if (r === 'ok') return true
    }
    if (!H.rateLimited) log('🟡', `「${account.user}」刷新 token 未能奏效`)
  }

  // ③ 账号密码重新登录，获取新 token
  if (H.rateLimited) {
    log('🟡', `「${account.user}」已被限流，本次不再重试（等冷却后自动恢复）`)
    return false
  }
  log('🟡', `「${account.user}」使用账号密码重新获取 token...`)
  if (!(await login(account))) return false
  return (await submit(account)) === 'ok'
}

// ============================ 消息推送 ============================

function buildWebhooks() {
  return [
    {
      name: '企业微信',
      url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=',
      key: CFG.wework,
      msg: {
        msgtype: 'markdown_v2',
        markdown_v2: {
          get content() {
            return `> ${H.datetimeChina}\n\n ## ${SCRIPT_NAME}\n ${H.sendMSG}`
          },
        },
      },
    },
    {
      name: '钉钉',
      url: 'https://oapi.dingtalk.com/robot/send?access_token=',
      key: CFG.dingding,
      msg: {
        msgtype: 'markdown',
        markdown: {
          title: SCRIPT_NAME,
          get text() {
            return `> ${H.datetimeChina}\n ### ${SCRIPT_NAME}\n ${H.sendMSG}`
          },
        },
      },
    },
    {
      name: '飞书',
      url: 'https://open.feishu.cn/open-apis/bot/v2/hook/',
      key: CFG.feishu,
      msg: {
        msg_type: 'interactive',
        card: {
          schema: '2.0',
          header: {
            title: { tag: 'plain_text', content: SCRIPT_NAME },
            template: 'orange',
          },
          body: {
            elements: [
              {
                tag: 'markdown',
                text_align: 'center',
                get content() {
                  return `#### ${H.datetimeChina}\n ${H.sendMSG}`
                },
              },
            ],
          },
        },
      },
    },
    {
      name: 'PushMe',
      url: 'https://push.i-i.me/?push_key=',
      key: CFG.pushme,
      msg: {
        type: 'markdown',
        title: SCRIPT_NAME,
        get content() {
          return `\n ${H.sendMSG}`
        },
      },
    },
  ]
}

/**
 * 加载青龙面板自带的 sendNotify.js
 * 官方版与社区版（ccwav 等）导出形式一致：module.exports = { sendNotify }
 * 官方签名 sendNotify(title, content)，社区版 sendNotify(text, desp, params, author, strsummary)
 * 两者前两个参数都是「标题, 内容」，直接调用即可兼容。
 */
function loadQLNotify() {
  const qlDir = process.env.QL_DIR || '/ql'
  const candidates = [
    './sendNotify', // 与脚本同目录（青龙脚本管理里的 sendNotify.js）
    path.join(qlDir, 'scripts', 'sendNotify.js'),
    '/ql/scripts/sendNotify.js',
    '/ql/data/scripts/sendNotify.js',
  ]
  for (const c of candidates) {
    try {
      const m = require(c)
      if (m && typeof m.sendNotify === 'function') return m.sendNotify
      if (typeof m === 'function') return m
    } catch (e) {
      /* 换下一个候选路径 */
    }
  }
  return null
}

/** 走青龙面板自带的推送（渠道在「系统设置 - 通知设置」里配置） */
async function pushViaQL(title, content) {
  const sendNotify = loadQLNotify()
  if (!sendNotify) {
    log('🟡', '未找到青龙自带的 sendNotify.js（脚本管理里应存在该文件），无法使用面板推送')
    return false
  }
  try {
    await sendNotify(title, content)
    log('🟣', `青龙面板推送已触发（渠道见「系统设置 - 通知设置」）`)
    return true
  } catch (e) {
    log('🔴', `青龙面板推送失败（与步数写入无关）：${e.message}`)
    // 尽力定位是哪个渠道挂了
    if (e && e.config && e.config.url) console.log(`     出错接口: ${e.config.url}`)
    if (e && e.response) {
      console.log(`     接口返回: HTTP ${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}`)
    }
    if (e && e.stack) {
      const trace = String(e.stack).split('\n').slice(0, 5)
      console.log(`     调用堆栈:\n       ${trace.join('\n       ')}`)
    }
    console.log('     ↳ 这是「通知渠道」的问题，不是脚本或账号的问题，步数已正常写入')
    console.log('     ↳ 到青龙「系统设置 - 通知设置」逐个渠道点「测试」，哪个报 403 就关掉或修好它')
    console.log('     ↳ 云服务器常见元凶：Telegram / Bark(api.day.app) 等境外服务直连被拦')
    console.log('     ↳ 想完全绕过面板推送，把环境变量 HM_NOTIFY 设为 webhook')
    return false
  }
}

/** 走脚本内置的四个 Webhook（原逻辑，需配 HM_WEWORK 等） */
async function pushViaWebhook() {
  H.datetimeChina = getDatetime()
  const enabled = buildWebhooks().filter((i) => i.key)
  if (enabled.length === 0) return false
  await Promise.all(
    enabled.map(async (i) => {
      const message = `「${i.name}」消息推送`
      try {
        const result = await xhr({
          method: 'POST',
          url: i.url + i.key,
          headers: { 'content-type': 'application/json; charset=UTF-8' },
          data: JSON.stringify(i.msg),
        })
        if (result) log('🟣', `${message}完成 🔛${result}`)
      } catch (e) {
        return null
      }
    })
  )
  return true
}

/** 统一推送入口 */
async function pushSummary(title, content) {
  const mode = CFG.notify

  if (mode === 'webhook') return pushViaWebhook()

  const ok = await pushViaQL(title, content)

  if (mode === 'both') await pushViaWebhook()

  // 面板推送不可用时自动回退，避免静默丢通知
  if (!ok && mode !== 'both') {
    const fb = await pushViaWebhook()
    if (!fb) log('🟡', '面板推送与内置 Webhook 均不可用，本次通知未发出')
  }
  return ok
}

// ============================ 连通性自检（HM_MODE=check） ============================

async function probe(name, options) {
  const { method = 'GET', url, headers = {}, data } = options
  try {
    const res = await axios({
      method,
      url,
      headers,
      data,
      timeout: CFG.timeout,
      maxRedirects: CFG.maxRedirects,
      transformResponse: [(d) => d],
      validateStatus: () => true,
    })
    const body = String(res.data).replace(/\s+/g, ' ').slice(0, 200)
    const mark = res.status === 403 ? '🔴' : res.status >= 400 ? '🟡' : '🟢'
    console.log(`${mark} [${res.status}] ${name}`)
    console.log(`      ${method} ${url}`)
    console.log(`      headers: ${JSON.stringify(pickHeaders(res.headers))}`)
    console.log(`      body: ${body}`)
    return res.status
  } catch (e) {
    console.log(`🔴 [ERR] ${name}`)
    console.log(`      ${method} ${url}`)
    console.log(`      ${e.code || ''} ${e.message}`)
    return 0
  }
}

async function checkMode() {
  console.log('══════════ 华米接口连通性自检 ══════════')
  console.log(`Node: ${process.version}`)
  console.log(`脚本版本: ${SCRIPT_VERSION}`)
  const pe = proxyEnv()
  console.log(`代理环境变量: ${pe.length ? pe.join(', ') : '（无）'}`)
  console.log(`maxRedirects: ${CFG.maxRedirects}   超时: ${CFG.timeout}ms`)
  console.log(`步数区间: ${CFG.min} ~ ${CFG.max}   推送方式: ${CFG.notify}`)

  let outIP = '（获取失败）'
  try {
    const r = await axios({
      url: 'https://api.ipify.org?format=json',
      timeout: 8000,
      transformResponse: [(d) => d],
    })
    outIP = JSON.parse(r.data).ip
  } catch (e) {
    /* 取不到就忽略 */
  }
  console.log(`本机出口 IP: ${outIP}`)
  console.log('')

  const BAND_DATA =
    'userid=1&device_type=0&last_source=24&last_deviceid=88CC5224060006C4&enableMultiDevice=1&last_sync_data_time=1&data_json=%5B%5D'

  const results = []
  results.push(
    await probe('① 登录 api-user.huami.com', {
      method: 'POST',
      url: 'https://api-user.huami.com/registrations/13800000000/tokens',
      headers: H.headers,
      data: 'client_id=HuaMi&country_code=CN&json_response=true&name=13800000000&password=probe&redirect_uri=https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html&state=REDIRECTION&token=access',
    })
  )
  results.push(
    await probe('② account.huami.com/v2/client/login', {
      method: 'POST',
      url: 'https://account.huami.com/v2/client/login',
      headers: H.headers,
      data: 'app_name=com.xiaomi.hm.health&country_code=CN&code=probe&device_id=02:00:00:00:00:00&device_model=android_phone&app_version=6.12.0&grant_type=access_token&allow_registration=false&source=com.xiaomi.hm.health&third_name=huami',
    })
  )
  results.push(
    await probe('③ account-cn renew_login_token', {
      url: 'https://account-cn.huami.com/v1/client/renew_login_token?login_token=probe',
      headers: H.headers,
    })
  )
  results.push(
    await probe('④ account-cn app_tokens', {
      url: 'https://account-cn.huami.com/v1/client/app_tokens?login_token=probe',
      headers: H.headers,
    })
  )
  results.push(
    await probe('⑤ api-mifit-cn 提交数据', {
      method: 'POST',
      url: `https://api-mifit-cn.huami.com/v1/data/band_data.json?t=${Date.now()}`,
      headers: { ...H.headers, apptoken: 'probe' },
      data: BAND_DATA,
    })
  )
  results.push(
    await probe('⑥ api-mifit 备用域名', {
      method: 'POST',
      url: `https://api-mifit.huami.com/v1/data/band_data.json?t=${Date.now()}`,
      headers: { ...H.headers, apptoken: 'probe' },
      data: BAND_DATA,
    })
  )

  console.log('')
  console.log('────────── 结论 ──────────')
  const blocked = results.filter((s) => s === 403).length
  const netErr = results.filter((s) => s === 0).length
  if (blocked === results.length) {
    console.log('🔴 全部接口 403：出口 IP 被华米 WAF 拦截。')
    console.log('   青龙多部署在云服务器（机房 IP），华米对机房 IP 返回 403，家宽 IP 通常正常。')
    console.log('   处理办法：更换出口 IP / 走代理 / 改在家庭网络环境运行。')
  } else if (blocked > 0) {
    console.log(`🔴 有 ${blocked} 个接口返回 403，请把上面标红的行连同响应头贴出来进一步定位。`)
  } else if (netErr > 0) {
    console.log(`🟡 有 ${netErr} 个接口网络异常（DNS/超时/连接被拒），请检查青龙容器的网络与 DNS。`)
  } else {
    console.log('🟢 全部接口连通正常，没有出现 403。')
    console.log('   说明 403 不来自华米侧，请确认运行的确实是本脚本，')
    console.log('   并检查推送渠道（企业微信/钉钉/飞书/PushMe）的 key 是否正确。')
  }
  console.log('════════════════════════════')
}

// ============================ 主流程 ============================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  if (CFG.mode === 'check') {
    await checkMode()
    return
  }

  log('🔵', `${SCRIPT_NAME} v${SCRIPT_VERSION} 开始执行`)
  if (AUTHOR_TAG) log('🔵', AUTHOR_TAG)

  const pe = proxyEnv()
  if (pe.length) log('🟡', `检测到代理环境变量：${pe.join(', ')}（若出现 403 请优先怀疑这里）`)

  const userData = formatStr(CFG.data)
  if (userData.length === 0) {
    log('🔴', '账号#密码填写格式错误或未配置环境变量 HM_DATA，请检查！', true)
    process.exitCode = 1
    return
  }
  if (CFG.min > CFG.max) {
    log('🟡', `步数区间配置异常（MIN ${CFG.min} > MAX ${CFG.max}），已自动对调`)
    const t = CFG.min
    CFG.min = CFG.max
    CFG.max = t
  }

  // 启动随机延迟：先校验完配置再等，免得配错了还要白等一分钟
  const startupDelay = getRandomNum(DELAY_MIN_SECONDS, DELAY_MAX_SECONDS)
  if (startupDelay > 0) {
    log('🔵', `随机延迟 ${startupDelay} 秒后开始（区间 ${DELAY_MIN_SECONDS}~${DELAY_MAX_SECONDS} 秒）`)
    await sleep(startupDelay * 1000)
  }

  let tokenCache = loadTokenCache()
  const accounts = mergeArray(userData, tokenCache)

  log('🔵', `共 ${accounts.length} 个账号，步数区间 ${CFG.min} ~ ${CFG.max}`)

  for (const [index, account] of accounts.entries()) {
    const total = accounts.length
    account.steps = 0
    log('🔵', `开始处理第 ${index + 1}/${total} 个账号「${account.user}」`)

    if (account.user.indexOf('@') !== -1) {
      H.userName = account.user
      H.thirdName = 'huami'
    } else {
      H.userName = `+86${account.user}`
      H.thirdName = 'huami_phone'
    }

    try {
      const lastAppToken = account.appToken
      const ok = await loginAndSubmit(account)
      account.steps = H.todaySteps
      // 只有 token 真的换了才写缓存，避免每次运行都无谓落盘
      if (account.appToken && account.appToken !== lastAppToken) {
        tokenCache = updateCache(tokenCache, account)
        saveTokenCache(tokenCache)
        log('🟣', `「${account.user}」token 缓存已更新`)
      }
      if (!ok) log('🟡', `「${account.user}」本次未能完成步数提交`)
    } catch (e) {
      log('🔴', `「${account.user}」处理出错 🔛${e.message || e}`)
    }

    // 账号之间的随机间隔：第 1 个跑完 → 随机等 10~120 秒 → 第 2 个，以此类推。
    // 最后一个账号结束后不再等待。
    if (index < total - 1) {
      const gap = getRandomNum(ACCOUNT_GAP_MIN_SECONDS, ACCOUNT_GAP_MAX_SECONDS)
      log(
        '🔵',
        `「${account.user}」完成，随机延迟 ${gap} 秒后开始下一个账号（区间 ${ACCOUNT_GAP_MIN_SECONDS}~${ACCOUNT_GAP_MAX_SECONDS} 秒）`
      )
      await sleep(gap * 1000)
    }
  }

  const before = tokenCache.length
  const sevenDaysAgo = getTimestamp() - 7 * 24 * 60 * 60 * 1000
  tokenCache = tokenCache.filter((item) => Array.isArray(item) && item[2] >= sevenDaysAgo)
  if (before !== tokenCache.length) {
    saveTokenCache(tokenCache)
    log('🟣', `token 缓存过期数据清理完成（${before} -> ${tokenCache.length}）`)
  }

  const total = accounts.length
  const success = accounts.filter((a) => a.steps > 0).length
  const failed = total - success

  // 推送标题只通过 sendNotify 的标题参数传一次。
  // ⚠️ 不要把标题再写进正文 —— 渠道会把两者都显示出来，实际推送里标题就重复了。
  const pushTitle = `${SCRIPT_NAME} 步数结果`

  // 推送正文：共计账号 → 账号/步数 → ✅成功 ｜❌失败
  const body = total
    ? accounts.map((a) => `账号：${a.user}\n步数：${a.steps}`).join('\n\n')
    : '**ERROR**'
  H.sendMSG = `共计账号：${total}\n---\n${body}\n---\n✅成功 ${success}/${total} ｜❌失败 ${failed}/${total}\n`

  // 任务日志也打一份（推送失败时仍能看到结果）；版本号只写进日志，不进推送，保持通知简洁
  console.log(H.sendMSG.trimEnd())
  console.log(`（${SCRIPT_NAME} v${SCRIPT_VERSION}）`)

  // 先报运行结果，再推送 —— 这样推送出错也不会盖住上面的结论
  log('🟣', `所有任务处理完成：成功 ${success}/${total}，详情见上方日志！`, true)

  await pushSummary(pushTitle, H.sendMSG)

  if (success === 0) process.exitCode = 1
}

main().catch((e) => {
  log('🔴', `脚本运行异常：${e.stack || e}`)
  process.exitCode = 1
})
