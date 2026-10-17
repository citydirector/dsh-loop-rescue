import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectInText } from '../src/detector.js'

const PRE = "Now I'm clear. Let me get back to work: check the status, then report back.\nLet me do one combined command.\n"
function poolLoop(phrases, rounds) {
  let s = ''
  for (let i = 0; i < rounds; i++) {
    for (const p of phrases) s += p + '\n'
    if (i % 3 === 0) s += 'Let me write the call.\n'
  }
  return s
}

test('短句池轮转：在循环起点剪切，保留前文', () => {
  const text = PRE + poolLoop(['Now.', 'OK.', 'Enough.', 'Let me write.', 'Emit.', 'Producing.', 'I emit.'], 20)
  const hit = detectInText('reasoning', text)
  assert.equal(hit?.rule, 'pool')
  assert.equal(hit.cut, PRE.length)
})

test('中文短句轮转（无空格分隔）', () => {
  let loop = ''
  for (let i = 0; i < 15; i++) loop += '好。执行。好。继续。写。输出。'
  const hit = detectInText('reasoning', '先看一下配置文件。然后决定。' + loop)
  assert.equal(hit?.rule, 'pool')
  assert.equal(hit.cut, '先看一下配置文件。然后决定。'.length)
})

test('逐字周期：保留第一份拷贝', () => {
  const para = 'I will now update the config file to add the new route and restart the service.\n'
  const text = 'Intro.\n' + para.repeat(10)
  const hit = detectInText('text', text)
  assert.equal(hit?.rule, 'cycle')
  assert.equal(hit.cut, 'Intro.\n'.length + para.length)
})

test('不误伤：表格、代码块、正常推理、编号清单', () => {
  let table = '| a | b |\n|---|---|\n'
  for (let i = 0; i < 80; i++) table += `| item ${i} | ok |\n`
  assert.equal(detectInText('text', table), undefined)

  assert.equal(detectInText('text', '```js\n' + 'console.log(1)\n'.repeat(80) + '```\n'), undefined)

  let prose = ''
  for (let i = 0; i < 80; i++) prose += `Let me check file ${i} for the ${['bug', 'route', 'config', 'schema'][i % 4]} issue. `
  assert.equal(detectInText('reasoning', prose), undefined)

  let steps = ''
  for (let i = 1; i <= 60; i++) steps += `${i}. Run step ${i} and verify the output.\n`
  assert.equal(detectInText('text', steps), undefined)
})

test('不误伤：带少量口头禅的正常推理', () => {
  let s = ''
  for (let i = 0; i < 40; i++) s += `OK. The function at line ${i * 7} returns ${i}. Now check the caller in module ${i}. `
  assert.equal(detectInText('reasoning', s), undefined)
})
