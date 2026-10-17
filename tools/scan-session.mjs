#!/usr/bin/env node
/**
 * 离线扫描：用插件同一份检测器复跑 DSH 会话文件，回答「这些消息会不会被切、切在哪」。
 * 用于调阈值：先扫一遍自己的历史会话，看命中是不是都是真循环。
 *
 * 用法：
 *   node tools/scan-session.mjs <会话文件或目录> [--json] [--all]
 *
 * - 支持纯 jsonl 和 DSH 的 zstd 压缩会话（按内容识别，需要 Node 22.15+）；
 * - 目录会递归扫描其中的 *.jsonl / *.zst / *.zstd；
 * - 只读 `assistant/message` 的已提交内容（即模型下一轮会看到的内容）；
 * - `--all` 连没命中的消息也输出统计；`--json` 输出机器可读结果。
 *
 * 本脚本只导入 ../src/detector.js，不依赖 @deepseek-ai/*，普通 node 即可运行。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { detectInText } from '../src/detector.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const showAll = args.includes('--all')
const targets = args.filter((a) => !a.startsWith('--'))
if (targets.length === 0) {
  console.error('用法: node tools/scan-session.mjs <会话文件或目录> [--json] [--all]')
  process.exit(2)
}

/** @param {string} p */
function* files(p) {
  const st = statSync(p)
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) yield* files(join(p, e))
  } else if (/\.(jsonl|zst|zstd)$/.test(p)) {
    yield p
  }
}

/** @param {string} path */
function readText(path) {
  const buf = readFileSync(path)
  // zstd 魔数 28 B5 2F FD
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0xfd2fb528) {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error('此 Node 版本不支持 zstd，请用 Node 22.15+ 或先解压')
    }
    return zlib.zstdDecompressSync(buf).toString('utf8')
  }
  return buf.toString('utf8')
}

const results = []
let scanned = 0
for (const target of targets) {
  for (const path of files(target)) {
    let text
    try {
      text = readText(path)
    } catch (error) {
      console.error(`跳过 ${path}: ${error.message}`)
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      if (ev?.type !== 'assistant/message') continue
      const blocks = ev.data?.message?.content ?? []
      for (const block of blocks) {
        if (block.type !== 'reasoning' && block.type !== 'text') continue
        scanned++
        const hit = detectInText(block.type, block.text ?? '')
        if (hit === undefined && !showAll) continue
        results.push({
          file: path,
          seq: ev.seq,
          turn: ev.data.turn,
          step: ev.data.step,
          kind: block.type,
          chars: (block.text ?? '').length,
          rule: hit?.rule ?? null,
          repeatedChars: hit ? (block.text ?? '').length - hit.cut : 0,
          cut: hit?.cut ?? null,
          preview: hit ? (block.text ?? '').slice(hit.cut, hit.cut + 80).replace(/\s+/g, ' ') : '',
        })
      }
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ scanned, results }, null, 2))
} else {
  const hits = results.filter((r) => r.rule)
  console.log(`扫描 ${scanned} 个 block，命中 ${hits.length} 个\n`)
  for (const r of results) {
    const tag = r.rule ? `${r.rule.padEnd(5)} 剪 ${r.repeatedChars}/${r.chars}` : `未命中 ${r.chars}`
    console.log(`${r.file}  seq=${r.seq} t${r.turn}s${r.step} ${r.kind.padEnd(9)} ${tag}`)
    if (r.preview) console.log(`    从这里开始剪: ${r.preview}`)
  }
}
