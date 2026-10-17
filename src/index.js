/**
 * dsh-loop-rescue：在模型陷入重复时切断流，把循环部分从落盘内容里剪掉，再自动续跑。
 *
 * ## 为什么能「剪掉」而不只是「截断」
 *
 * agent-loop 组装 `assistant/message` 时，每个 block 的最终内容取自 `block-end`
 * 的载荷，而不是之前累计的 delta。所以在 `llm/stream` 瀑布里切断时，只要给出
 * 剪过的 `block-end`，落盘的消息（下一轮发给模型的上下文）里就不会有循环部分。
 * 不需要事后改写会话，也不会和会话面的 replace 规则冲突
 * （`assistant/message` 不能携带 `sourceEventSeqs`，因此无法用 replace 改写）。
 * 原始流仍完整保存在事件的 `stream` 记录里，轨迹视图可以看到全部内容。
 *
 * ## 流程
 *
 * 1. 包装每次 agent-loop 发起的模型调用，对每个推理/正文 block 单独跑检测器；
 * 2. 命中后：闭合所有打开的 block（循环所在 block 换成剪过的内容），以 `stop` 结束流；
 * 3. 在 yield 终止 chunk 之前同步拿到 `whenIdle()`，等回合真正结束后用
 *    `followup()` 发一条带纠正语的续跑消息（运行中发出的唤醒会被宿主丢弃）；
 * 4. 续跑的前 N 次请求可选地改用另一组采样参数（temperature / 推理强度）；
 * 5. 连续救援达到上限就停止续跑，留一条提示等用户处理。
 *
 * 打开的 block 里有工具调用时不切：闭合半截工具调用会让宿主执行参数不完整的调用。
 *
 * @module dsh-loop-rescue
 */

import z from '@deepseek-ai/schemastery'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { DEFAULTS, StreamLoopDetector } from './detector.js'
import { resolveLanguage, strings } from './i18n.js'

export { DEFAULTS, StreamLoopDetector, detectInText, normalizeUnit } from './detector.js'

export const name = 'loop-rescue'

/** 通过 `ctx.agents.get(sessionId)` 找到会话的 Agent，必须声明，否则激活即失败。 */
export const inject = ['agents']

const detectorSchema = z.object({
  poolWindow: z.natural().min(8).default(DEFAULTS.poolWindow).description('短句池：参与判定的最近句子数'),
  poolMaxMeanChars: z.natural().min(8).default(DEFAULTS.poolMaxMeanChars).description('短句池：句子平均长度上限（汉字按 3 计）'),
  poolMinChars: z.natural().default(DEFAULTS.poolMinChars).description('短句池：窗口总长度下限'),
  poolMinRepeats: z.natural().min(2).default(DEFAULTS.poolMinRepeats).description('短句池：出现几次算反复'),
  poolMinCoverage: z.number().min(0).max(1).default(DEFAULTS.poolMinCoverage).description('短句池：反复句子的占比下限'),
  poolGapAllowance: z.natural().default(DEFAULTS.poolGapAllowance).description('回溯循环起点时允许夹杂的新句子数'),
  cycleMinPeriod: z.natural().min(4).default(DEFAULTS.cycleMinPeriod).description('逐字周期：最短周期'),
  cycleMaxPeriod: z.natural().min(16).default(DEFAULTS.cycleMaxPeriod).description('逐字周期：最长周期'),
  cycleMinChars: z.natural().min(64).default(DEFAULTS.cycleMinChars).description('逐字周期：重复部分总长下限'),
  cycleMinReps: z.natural().min(2).default(DEFAULTS.cycleMinReps).description('逐字周期：至少重复几遍'),
  cycleCheckEvery: z.natural().min(16).default(DEFAULTS.cycleCheckEvery).description('逐字周期：检查间隔（字符）'),
})

export const Config = z.object({
  mode: z.union(['rescue', 'cut', 'observe']).default('rescue')
    .description('rescue：切断+剪除+自动续跑；cut：切断+剪除，不续跑；observe：只记日志'),
  watch: z.union(['both', 'reasoning', 'text']).default('both').description('检测哪类内容'),
  marker: z.boolean().default(true).description('在剪除处留一行标记，让模型知道这里删过东西'),
  maxConsecutiveRescues: z.natural().min(1).default(3)
    .description('连续救援上限；中间出现一次正常调用就清零'),
  stallCalls: z.natural().default(3)
    .description('连续多少次「只思考无产出」的调用后提示继续；0 关闭'),
  stallMinReasoningChars: z.natural().default(1024).description('计入空转的单次推理最小长度'),
  retryTemperature: z.number().min(0).max(2).description('续跑请求改用的 temperature；不填则不改'),
  retryReasoningEffort: z.string().description('续跑请求改用的推理强度 ID（如 low）；不填则不改'),
  retryRequests: z.natural().default(1).description('续跑后多少次请求使用上面的参数'),
  language: z.union(['auto', 'zh', 'en']).default('auto').description('提示语言；auto 跟随界面'),
  detector: detectorSchema.default({}),
})

const SOURCE = { kind: 'loop-rescue' }

/**
 * 构造一条插件来源的 notice 消息。
 * @param {string} text
 * @param {string} summary 聊天区折叠行显示的一句话（宿主限 120 字）
 */
function notice(text, summary) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...SOURCE, form: 'notice', summary: summary.slice(0, 120) },
  })
}

/**
 * @typedef {object} RescueState
 * @property {number} consecutive 连续救援次数
 * @property {number} stall 连续空转调用次数
 * @property {number} overrides 剩余需要改采样参数的请求数
 * @property {number} generation 每次救援自增；续跑前比较，判断期间是否已有新调用
 */

/**
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
  /** @type {WeakMap<object, RescueState>} */
  const states = new WeakMap()
  const stateOf = (agent) => {
    let s = states.get(agent)
    if (s === undefined) {
      s = { consecutive: 0, stall: 0, overrides: 0, generation: 0 }
      states.set(agent, s)
    }
    return s
  }
  const lang = () => resolveLanguage(ctx, config.language)
  const watches = (kind) => config.watch === 'both' || config.watch === kind

  /**
   * 回合结束后续跑。必须在 yield 终止 chunk 之前调用，拿到的 `whenIdle()` 才对应本回合。
   * 期间若已有新的模型调用（用户发话、别的插件唤醒），本次续跑作废。
   */
  function scheduleFollowup(agent, state, message) {
    if (typeof agent.whenIdle !== 'function' || typeof agent.followup !== 'function') return
    const generation = state.generation
    const idle = agent.whenIdle()
    void Promise.resolve(idle).then(() => {
      if (state.generation !== generation) return
      if (agent.inbox?.hasPending) return
      agent.followup(message)
      ctx.logger.debug('loop-rescue: resumed after cut')
    }).catch((error) => {
      ctx.logger.warn(`loop-rescue: resume failed: ${String(error)}`)
    })
  }

  ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options) || options.sessionId === undefined) return next()
    const agent = ctx.agents.get(options.sessionId)
    if (agent === undefined) return next()
    const state = stateOf(agent)
    // 新调用开始：之前排队的续跑作废。
    state.generation++

    return (async function* rescued() {
      /** @type {Map<number, {blockType: string, text: string, detector?: StreamLoopDetector}>} */
      const open = new Map()
      let reasoningChars = 0
      let hasOutput = false
      let finished = false

      for await (const chunk of next()) {
        if (chunk.type === 'block-start') {
          const kind = chunk.blockType
          const detector = (kind === 'reasoning' || kind === 'text') && watches(kind)
            ? new StreamLoopDetector(kind, config.detector)
            : undefined
          open.set(chunk.index, { blockType: kind, text: '', detector })
        } else if (chunk.type === 'block-end') {
          open.delete(chunk.index)
        } else if (chunk.type === 'tool-call-delta') {
          hasOutput = true
        } else if (chunk.type === 'finish') {
          finished = true
        }

        let hit
        let hitBlock
        if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
          if (chunk.type === 'text-delta') hasOutput = true
          else reasoningChars += chunk.text.length
          const block = open.get(chunk.index)
          if (block !== undefined) {
            block.text += chunk.text
            hit = block.detector?.push(chunk.text)
            if (hit !== undefined) hitBlock = { index: chunk.index, ...block }
          }
        }

        if (hit === undefined) {
          yield chunk
          continue
        }

        const kind = hitBlock.blockType
        ctx.logger.warn(`loop-rescue: ${kind} loop detected (rule ${hit.rule}, ${hit.repeatedChars} chars)`)
        if (config.mode === 'observe') {
          hitBlock.detector = undefined
          const live = open.get(hitBlock.index)
          if (live) live.detector = undefined
          yield chunk
          continue
        }
        // 半截工具调用不能闭合，放弃本次切断，继续透传。
        if ([...open.values()].some((b) => b.blockType !== 'text' && b.blockType !== 'reasoning')) {
          ctx.logger.warn('loop-rescue: a non-text block is open; not cutting')
          const live = open.get(hitBlock.index)
          if (live) live.detector = undefined
          yield chunk
          continue
        }

        const s = strings(lang())
        state.consecutive++
        state.stall = 0
        // 先不 yield 当前 chunk：它的内容已在 block.text 里，剪切按累计文本进行。
        const tail = []
        for (const [index, block] of open) {
          let text = block.text
          if (index === hitBlock.index) {
            text = text.slice(0, hit.cut).replace(/\s+$/, '')
            if (config.marker) text += s.marker(kind, hit.repeatedChars)
          }
          tail.push({ type: 'block-end', index, block: { type: block.blockType, text } })
        }
        tail.push({ type: 'finish', reason: { kind: 'stop' } })

        if (config.mode === 'rescue') {
          if (state.consecutive > config.maxConsecutiveRescues) {
            ctx.logger.warn(`loop-rescue: ${state.consecutive} consecutive cuts; auto-resume paused`)
            agent.inject?.(notice(s.exhausted(state.consecutive), s.exhaustedSummary(state.consecutive)))
          } else {
            state.overrides = config.retryRequests
            scheduleFollowup(agent, state,
              notice(s.resume(kind, hit.repeatedChars), s.resumeSummary(kind, hit.repeatedChars)))
          }
        }
        for (const c of tail) yield c
        return
      }

      // 流自然结束。
      if (!finished) return
      if (hasOutput) {
        state.consecutive = 0
        state.stall = 0
        return
      }
      // 只有推理、没有正文和工具调用：空转计数。
      if (config.stallCalls > 0 && reasoningChars >= config.stallMinReasoningChars && config.mode === 'rescue') {
        state.stall++
        if (state.stall >= config.stallCalls) {
          const s = strings(lang())
          const n = state.stall
          state.stall = 0
          ctx.logger.warn(`loop-rescue: ${n} reasoning-only calls in a row`)
          scheduleFollowup(agent, state, notice(s.stall(n), s.stallSummary(n)))
        }
      }
    })()
  })

  // 续跑请求可选地换一组采样参数，打破同一前缀下的确定性复读。
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const agent = payload?.agent
    if (agent === undefined) return resolved
    const state = states.get(agent)
    if (state === undefined || state.overrides <= 0) return resolved
    state.overrides--
    const patch = {}
    if (config.retryTemperature !== undefined) patch.temperature = config.retryTemperature
    if (config.retryReasoningEffort) patch.reasoningEffort = config.retryReasoningEffort
    return Object.keys(patch).length === 0 ? resolved : { ...resolved, ...patch }
  })
}

export default { name, inject, Config, apply }
