#!/usr/bin/env node
/**
 * 离线清洗：把 DSH 会话历史里已经提交的循环截掉，让「已经嗝屁」的会话重新可用。
 *
 * 为什么是离线脚本：DSH 发给模型的请求是会话日志的纯投影且被冻结，插件只能读不能改；
 * 所以只能在 DSH 关闭时直接改会话文件。检测规则与插件同一份（../src/detector.js），
 * 只看已提交文本，没装过插件的老会话同样适用。
 *
 * 用法（不需要会话 ID）：
 *   node tools/clean-session.mjs                 自动找 DSH 数据目录，列出有循环的会话，按序号选
 *   node tools/clean-session.mjs --all           列表里也显示没有循环的会话
 *   node tools/clean-session.mjs --data D:\dsh-desktop\data
 *   node tools/clean-session.mjs <会话文件夹或文件>  直接处理这一个（可把文件夹拖到命令行）
 *   node tools/clean-session.mjs --undo          从备份恢复（同样按序号选）
 *   选项：--dry-run 只看不改；--yes 不再确认；--force 检测到 DSH 在运行也继续（不推荐）
 *
 * 改动内容（只动命中的 assistant/message 事件，其余行逐字节保留）：
 *   - message.content 里命中的 text/reasoning 块截到循环起点；
 *   - data.stream 里同一块的增量记录与 block-end 同步截断；
 *   - 删掉该消息的 source.replayState（里面存着原文副本，留着会被原样重放）。
 * 原文件先备份到 <data>/sessions-loop-rescue-backup/，再以带校验的 zstd 原子写回。
 *
 * 需要 Node 22.15+（内置 zstd）。不依赖 @deepseek-ai/*。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'node:fs'
import { join, resolve, dirname, basename, relative } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import * as zlib from 'node:zlib'
import { detectInText } from '../src/detector.js'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--data')
const DRY = flag('--dry-run'), YES = flag('--yes'), FORCE = flag('--force'), ALL = flag('--all'), UNDO = flag('--undo')
const GEN = /^session\.v(\d+)\.jsonl(\.zstd)?$/
const BACKUP_DIR = 'sessions-loop-rescue-backup'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = async (q) => (await rl.question(q)).trim()
const die = (m) => { console.error(m); rl.close(); process.exit(1) }

// ---------- 读写 ----------
function readSession(path) {
  const buf = readFileSync(path)
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0xfd2fb528) {
    if (typeof zlib.zstdDecompressSync !== 'function') die('需要 Node 22.15+（内置 zstd）。')
    return zlib.zstdDecompressSync(buf).toString('utf8')
  }
  return buf.toString('utf8')
}
function writeSession(path, text) {
  const out = path.endsWith('.zstd')
    ? zlib.zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
    : Buffer.from(text, 'utf8')
  const tmp = `${path}.loop-rescue-tmp`
  writeFileSync(tmp, out)
  renameSync(tmp, path)
}
/** 会话文件夹里版本号最高的那一代日志。 */
function latestGeneration(dir) {
  let best
  for (const f of readdirSync(dir)) {
    const m = GEN.exec(f)
    if (m && (!best || Number(m[1]) > best.v)) best = { v: Number(m[1]), path: join(dir, f) }
  }
  return best
}

// ---------- 找数据目录 ----------
function findDataRoots() {
  const given = opt('--data') ?? process.env.DSH_DATA
  if (given) return [resolve(given)]
  const roots = new Set()
  // 1) 脚本放在数据目录里面时，向上找
  for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) {
    if (existsSync(join(d, 'sessions'))) roots.add(d)
    if (existsSync(join(d, 'data', 'sessions'))) roots.add(join(d, 'data'))
    if (dirname(d) === d) break
  }
  // 2) 常见位置
  const cands = []
  if (process.platform === 'win32') {
    for (const drive of 'CDEFG') for (const n of ['dsh-desktop', 'dsh-portable', 'dsh']) cands.push(`${drive}:\\${n}\\data`)
    if (process.env.APPDATA) cands.push(join(process.env.APPDATA, 'dsh'), join(process.env.APPDATA, 'dsh-desktop'))
    if (process.env.LOCALAPPDATA) cands.push(join(process.env.LOCALAPPDATA, 'dsh'), join(process.env.LOCALAPPDATA, 'dsh-desktop'))
  }
  cands.push(join(homedir(), '.dsh'), join(homedir(), '.config', 'dsh'), join(homedir(), '.local', 'share', 'dsh'))
  for (const c of cands) if (existsSync(join(c, 'sessions'))) roots.add(resolve(c))
  return [...roots]
}

// ---------- DSH 是否在运行 ----------
function dshRunning() {
  try {
    const out = process.platform === 'win32'
      ? execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 10000 })
      : execFileSync('ps', ['-eo', 'comm='], { encoding: 'utf8', timeout: 10000 })
    return out.split(/\r?\n/).map((l) => l.replace(/^"|".*$/g, '')).filter((n) => /\bdsh/i.test(n) && !/loop-rescue/i.test(n))
  } catch { return [] }
}

// ---------- 分析一个会话 ----------
function analyze(path) {
  const text = readSession(path)
  const lines = text.split('\n')
  let header, title, last = 0, loops = 0
  const hits = [] // {line, blocks:[{idx, cut}]}
  lines.forEach((line, li) => {
    if (!line.trim()) return
    let ev
    try { ev = JSON.parse(line) } catch { return }
    if (ev.type === 'session' && header === undefined) header = ev
    if (typeof ev.time === 'number') last = Math.max(last, ev.time)
    if (ev.type === 'session/title') title = ev.data?.title
    if (ev.type !== 'assistant/message') return
    const blocks = []
    ;(ev.data?.message?.content ?? []).forEach((b, idx) => {
      if (b.type !== 'text' && b.type !== 'reasoning') return
      const d = detectInText(b.type, b.text ?? '')
      if (d) blocks.push({ idx, cut: d.cut, removed: (b.text ?? '').length - d.cut })
    })
    if (blocks.length) { hits.push({ line: li, blocks }); loops += blocks.length }
  })
  return { path, text, lines, header, title, last, loops, hits }
}

/** 截断一条消息事件，返回新事件。 */
function trimEvent(ev, blocks) {
  const content = ev.data.message.content
  const cutByIndex = new Map()
  for (const { idx, cut } of blocks) {
    const b = content[idx]
    b.text = b.text.slice(0, cut).replace(/\s+$/, '')
    cutByIndex.set(idx, b.text)
  }
  // stream：截断对应块的增量与 block-end
  if (Array.isArray(ev.data.stream)) {
    const posByIdx = new Map()
    // content 下标与流里的 block index 一一对应（同序），按出现顺序映射
    const streamIdx = []
    for (const r of ev.data.stream) {
      if (r.type === 'chunk' && r.chunk?.type === 'block-start') streamIdx.push(r.chunk.index)
    }
    const map = new Map() // stream index -> kept text
    for (const [ci, kept] of cutByIndex) if (streamIdx[ci] !== undefined) map.set(streamIdx[ci], kept)
    ev.data.stream = ev.data.stream.map((r) => {
      if ((r.type === 'text-chunks' || r.type === 'reasoning-chunks') && map.has(r.index)) {
        const kept = map.get(r.index)
        let used = posByIdx.get(r.index) ?? 0
        const texts = [], dt = []
        for (let i = 0; i < r.texts.length && used < kept.length; i++) {
          const piece = r.texts[i].slice(0, kept.length - used)
          texts.push(piece); used += piece.length
          if (i > 0) dt.push(r.dt[i - 1])
        }
        posByIdx.set(r.index, used)
        if (texts.length === 0) return null
        return { ...r, texts, dt }
      }
      if (r.type === 'chunk' && r.chunk?.type === 'block-end' && map.has(r.chunk.index)) {
        return { ...r, chunk: { ...r.chunk, block: { ...r.chunk.block, text: map.get(r.chunk.index) } } }
      }
      return r
    }).filter(Boolean)
  }
  const src = ev.data.message.source
  if (src && src.replayState !== undefined) {
    const { replayState, ...rest } = src
    ev.data.message.source = rest
  }
  return ev
}

// ---------- 列表与选择 ----------
function listSessions(roots) {
  const out = []
  for (const root of roots) {
    const sdir = join(root, 'sessions')
    for (const proj of safeDir(sdir)) {
      const pdir = join(sdir, proj)
      if (!statSync(pdir).isDirectory()) continue
      for (const s of safeDir(pdir)) {
        const dir = join(pdir, s)
        if (!statSync(dir).isDirectory()) continue
        const g = latestGeneration(dir)
        if (!g) continue
        try { out.push({ root, gen: g, ...analyze(g.path) }) } catch (e) { console.error(`跳过 ${dir}：${e.message}`) }
      }
    }
  }
  return out.sort((a, b) => b.last - a.last)
}
function safeDir(d) { try { return readdirSync(d) } catch { return [] } }
const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '?')

async function pick(items, render, prompt) {
  items.forEach((it, i) => console.log(`${String(i + 1).padStart(3)}. ${render(it)}`))
  const a = await ask(prompt)
  if (a === '') return items[0]
  const n = Number(a)
  if (!Number.isInteger(n) || n < 1 || n > items.length) die('没有这个序号，已退出。')
  return items[n - 1]
}

// ---------- 主流程 ----------
async function main() {
  // 撤销
  if (UNDO) {
    const roots = findDataRoots()
    const backups = []
    for (const root of roots) collectBackups(join(root, BACKUP_DIR), root, backups)
    if (!backups.length) die('没有找到备份。')
    backups.sort((a, b) => b.mtime - a.mtime)
    const b = await pick(backups, (x) => `${fmtTime(x.mtime)}  ${x.target}`, '恢复哪个？（回车=最新）')
    guardRunning()
    if (!YES && (await ask(`用备份覆盖 ${b.target}？[y/N] `)).toLowerCase() !== 'y') die('已取消。')
    copyFileSync(b.path, b.target)
    console.log('已恢复。')
    return rl.close()
  }

  let session
  if (positional[0]) {
    const p = resolve(positional[0])
    const file = statSync(p).isDirectory() ? latestGeneration(p)?.path : p
    if (!file) die(`${p} 里没有会话日志。`)
    // 推断数据目录：…/data/sessions/<项目>/<会话>/file
    const root = dirname(dirname(dirname(dirname(file))))
    session = { root, gen: { path: file, v: Number(GEN.exec(basename(file))?.[1] ?? 0) }, ...analyze(file) }
  } else {
    const roots = findDataRoots()
    if (!roots.length) die('没找到 DSH 数据目录。用 --data 指定，例如：--data D:\\dsh-desktop\\data')
    console.log(`扫描：${roots.map((r) => join(r, 'sessions')).join('，')}\n`)
    let list = listSessions(roots)
    if (!ALL) list = list.filter((s) => s.loops > 0)
    if (!list.length) { console.log(ALL ? '没有会话。' : '没有发现带循环的会话。加 --all 可看全部。'); return rl.close() }
    session = await pick(list, (s) => {
      const sub = s.header?.origin === 'subagent' ? '[子] ' : ''
      return `${fmtTime(s.last)}  ${sub}${s.title ?? '(无标题)'}  —  ${s.header?.cwd ?? '?'}  循环 ${s.loops} 段`
    }, '\n选哪个？（回车=第一个）')
  }

  if (session.loops === 0) { console.log('这个会话里没有检测到循环。'); return rl.close() }
  if (session.gen.v !== 4) die(`目前只支持 v4 会话，这个是 v${session.gen.v}。`)

  const removed = session.hits.reduce((s, h) => s + h.blocks.reduce((t, b) => t + b.removed, 0), 0)
  console.log(`\n${session.title ?? ''}\n  文件：${session.path}\n  将截断 ${session.loops} 段循环（${session.hits.length} 条消息），删除约 ${removed} 字。`)
  for (const h of session.hits.slice(0, 3)) {
    const ev = JSON.parse(session.lines[h.line])
    const b = ev.data.message.content[h.blocks[0].idx]
    console.log(`  · 第 ${ev.data.turn} 轮：…${b.text.slice(Math.max(0, h.blocks[0].cut - 60), h.blocks[0].cut).replace(/\s+/g, ' ')} ✂ ${b.text.slice(h.blocks[0].cut, h.blocks[0].cut + 40).replace(/\s+/g, ' ')}…`)
  }
  if (DRY) { console.log('\n--dry-run：未做任何修改。'); return rl.close() }

  guardRunning()
  if (!YES && (await ask('\n确认修改？会先自动备份。[y/N] ')).toLowerCase() !== 'y') die('已取消。')

  // 备份
  const rel = relative(join(session.root, 'sessions'), session.path)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = rel.startsWith('..') ? `${session.path}.${stamp}.bak` : join(session.root, BACKUP_DIR, `${rel}.${stamp}`)
  mkdirSync(dirname(bak), { recursive: true })
  copyFileSync(session.path, bak)

  // 改写
  const lines = session.lines.slice()
  for (const h of session.hits) lines[h.line] = JSON.stringify(trimEvent(JSON.parse(lines[h.line]), h.blocks))
  const text = lines.join('\n')
  // 自检：重新读回不应再有循环、事件数不变
  const check = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  if (check.length !== session.lines.filter((l) => l.trim()).length) die('自检失败：事件数变化，未写入。')
  writeSession(session.path, text)
  const after = analyze(session.path)
  console.log(`\n完成。剩余循环 ${after.loops} 段。备份：${bak}\n撤销：node tools/clean-session.mjs --undo`)
  rl.close()
}

function collectBackups(dir, root, out) {
  for (const e of safeDir(dir)) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) collectBackups(p, root, out)
    else {
      const m = /^(.*)\.\d{4}-\d{2}-\d{2}T[\d-]+Z$/.exec(p)
      if (m) out.push({ path: p, mtime: st.mtimeMs, target: join(root, 'sessions', relative(join(root, BACKUP_DIR), m[1])) })
    }
  }
}

function guardRunning() {
  const procs = dshRunning()
  if (procs.length && !FORCE) die(`检测到 DSH 正在运行（${[...new Set(procs)].join('、')}）。请先完全退出 DSH 再运行；确定无关可加 --force。`)
}

main().catch((e) => die(e.stack ?? String(e)))
