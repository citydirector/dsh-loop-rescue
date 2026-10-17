/**
 * 面向模型与用户的文案。默认中文；只有显式 `en` 才用英文。
 * @module dsh-loop-rescue/i18n
 */

const ZH = {
  blockName: (kind) => (kind === 'reasoning' ? '思考' : '正文'),
  marker: (kind, chars) => `\n〔已删除 ${chars} 字重复${kind === 'reasoning' ? '思考' : '输出'}〕`,
  // 续跑提示只把模型送回原任务，不要求它「总结收尾」，否则它会放弃进行中的工作。
  resume: (kind, chars) =>
    `上一步的${kind === 'reasoning' ? '思考' : '输出'}陷入了重复（约 ${chars} 字），已被截断并从上下文中删除。`
    + '不要复述刚才的内容，也不要解释发生了什么。直接从上一个有效进展继续你原本的任务，下一步就是具体行动。',
  resumeSummary: (kind, chars) => `已切除 ${chars} 字重复${kind === 'reasoning' ? '思考' : '输出'}并续跑`,
  stall: (n) =>
    `你已连续 ${n} 次只思考、没有任何输出或工具调用。停止空转：直接执行下一步具体操作。`,
  stallSummary: (n) => `连续 ${n} 次仅思考无产出，已提示继续`,
  exhausted: (n) =>
    `循环救援已连续触发 ${n} 次，自动续跑已暂停。请检查任务是否卡在同一处，或换个思路再继续。`,
  exhaustedSummary: (n) => `连续 ${n} 次截断循环，已暂停自动续跑`,
}

const EN = {
  blockName: (kind) => (kind === 'reasoning' ? 'reasoning' : 'output'),
  marker: (kind, chars) => `\n[${chars} chars of repeated ${kind === 'reasoning' ? 'reasoning' : 'output'} removed]`,
  resume: (kind, chars) =>
    `Your previous ${kind === 'reasoning' ? 'reasoning' : 'output'} fell into repetition (~${chars} chars); `
    + 'it was cut off and removed from the context. Do not restate it or explain what happened. '
    + 'Continue the original task from the last real progress; your next move is a concrete action.',
  resumeSummary: (kind, chars) => `removed ${chars} chars of repeated ${kind} and resumed`,
  stall: (n) =>
    `You have made ${n} consecutive calls that only reasoned, with no output or tool call. `
    + 'Stop deliberating and take the next concrete step.',
  stallSummary: (n) => `${n} reasoning-only calls in a row; nudged to continue`,
  exhausted: (n) =>
    `Loop rescue fired ${n} times in a row, so automatic resume is paused. `
    + 'Check whether the task is stuck at the same point, or try a different approach.',
  exhaustedSummary: (n) => `${n} loop cuts in a row; auto-resume paused`,
}

/**
 * @param {'zh' | 'en'} lang
 * @returns {typeof ZH}
 */
export function strings(lang) {
  return lang === 'en' ? EN : ZH
}

/**
 * 读取界面语言。设置服务可选：用 `ctx.get` 读取，缺失或出错一律回退中文。
 * @param {any} ctx
 * @param {'auto' | 'zh' | 'en'} preference 配置里的语言
 * @returns {'zh' | 'en'}
 */
export function resolveLanguage(ctx, preference) {
  if (preference === 'zh' || preference === 'en') return preference
  try {
    const settings = ctx.get?.('settings')
    const section = settings?.get?.('locale')
    const pref = section?.preference
    return typeof pref === 'string' && pref.toLowerCase().startsWith('en') ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}
