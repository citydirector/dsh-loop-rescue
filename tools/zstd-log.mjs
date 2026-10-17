/**
 * DSH 会话日志的 zstd 读写。
 *
 * session.v4.jsonl.zstd 是多帧文件：头部一帧，之后每次追加一帧。
 *   - zlib.zstdDecompressSync 只解第一帧 —— 直接用它只能读到头部一行，必须逐帧解；
 *   - DSH 列会话时只解第一帧并要求它「恰好一行头部」，否则把会话当损坏、静默隐藏 ——
 *     写回时头部必须单独成帧。
 */
import * as zlib from 'node:zlib'

const MAGIC = 0xfd2fb528
const OPTS = () => ({ params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })

/** RFC 8878 帧边界：返回从 start 开始那一帧的结束偏移。 */
export function frameEnd(buf, start = 0) {
  if (buf.readUInt32LE(start) !== MAGIC) return undefined
  const fhd = buf[start + 4]
  const fcsFlag = fhd >> 6; const single = (fhd >> 5) & 1; const checksum = (fhd >> 2) & 1; const dictFlag = fhd & 3
  let o = start + 5 + (single ? 0 : 1) + [0, 1, 2, 4][dictFlag] + [single ? 1 : 0, 2, 4, 8][fcsFlag]
  for (;;) {
    if (o + 3 > buf.length) return undefined
    const h = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)
    o += 3 + (((h >> 1) & 3) === 1 ? 1 : h >>> 3)
    if (h & 1) break
  }
  o += checksum ? 4 : 0
  return o <= buf.length ? o : undefined
}

export function decodeLog(buf) {
  if (buf.length < 4 || buf.readUInt32LE(0) !== MAGIC) return buf.toString('utf8')
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('需要 Node 22.15+（内置 zstd）。')
  const parts = []
  let o = 0
  while (o < buf.length) {
    const magic = buf.readUInt32LE(o)
    if ((magic & 0xfffffff0) === 0x184d2a50) { o += 8 + buf.readUInt32LE(o + 4); continue }
    const end = frameEnd(buf, o)
    if (end === undefined) throw new Error(`zstd 帧不完整（偏移 ${o}）`)
    parts.push(zlib.zstdDecompressSync(buf.subarray(o, end)))
    o = end
  }
  return Buffer.concat(parts).toString('utf8')
}

export function encodeLog(text, compressed = true) {
  if (!compressed) return Buffer.from(text, 'utf8')
  const nl = text.indexOf('\n')
  const head = nl < 0 ? `${text}\n` : text.slice(0, nl + 1)
  const rest = nl < 0 ? '' : text.slice(nl + 1)
  const frames = [zlib.zstdCompressSync(Buffer.from(head, 'utf8'), OPTS())]
  if (rest.length) frames.push(zlib.zstdCompressSync(Buffer.from(rest, 'utf8'), OPTS()))
  return Buffer.concat(frames)
}
