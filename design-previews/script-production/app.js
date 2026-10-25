const beats = [
  {
    id: 'beat-hook',
    purpose: '开场钩子',
    title: '古镜里的白光',
    question: '一个现代刑警为什么会在古代刑场醒来？',
    synopsis: '沈砚在现代库房勘查古镜，白光与刀面反光匹配，意识进入古代刑场。',
    action: '先给古镜断弧的清楚近景，再让白光占满画面，切到刑场刀面，最后落到沈砚睁眼和双腕绑绳。',
    dialogue: '沈砚（低声记录）：“现场发现一面古镜。”',
    sound: '雨声与记录仪提示音被白光切断，刀面轻鸣后只剩人群低语。',
    continuity: '镜 01 现代外套与手套；镜 02 已换囚衣，左颧骨浅擦伤，双腕身前绑绳，不把镜面接触解释为确定穿越机制。',
    shots: ['01｜古镜里的白光 · 6s', '02｜醒在刀下 · 6s'],
  },
  {
    id: 'beat-incident',
    purpose: '触发事件',
    title: '两件定罪证物',
    question: '断刀和刀尖真的能证明他杀人吗？',
    synopsis: '书吏宣读罪状，明确断刀与死者骨中刀尖是定罪依据。',
    action: '一个竖屏空间建立镜头交代沈砚、书吏、黎青、顾衡和证物案，再让焦段落到两件证物。',
    dialogue: '书吏：“断刀、骨中刀尖，俱在此！”',
    sound: '宣罪时压低群众声；两件证物落桌各一次短木击。',
    continuity: '刑场南北主轴，县令在北侧高阶，证物案在东侧；演员位置不能在不同镜头互换。',
    shots: ['03｜两件定罪证物 · 7s'],
  },
  {
    id: 'beat-rising',
    purpose: '推进升级',
    title: '要求当众重验',
    question: '县令会不会允许一个死囚质疑卷宗？',
    synopsis: '沈砚提出针对性复核问题，黎青要求重验，顾衡同意并命人看住沈砚。',
    action: '沈砚保持跪姿发问；黎青以职业程序申请重验；守卫扶他起身并移动到证物案。',
    dialogue: '沈砚：“断刀和刀尖，可曾当众合过？” 黎青：“请准当众重验。”',
    sound: '台词之间保留停顿；起立与脚步声承接动作，不用跳切掩盖位置变化。',
    continuity: '绑绳全程不松；黎青右手持竹镊，主角不触碰凶器；守卫数量和站位前后一致。',
    shots: ['04｜先验刀，再杀我 · 7s', '05｜仵作要求重验 · 8s', '06｜靠近证物案 · 8s'],
  },
  {
    id: 'beat-turn',
    purpose: '核心转折',
    title: '断口合不上',
    question: '哪一条证据链会先崩掉？',
    synopsis: '黎青按刃线与刀背两种方向尝试拼合，断口始终错位，证明两件证物不能按卷宗拼成同一把刀。',
    action: '严格俯拍微距，锁定同一几何母版。第一次刃口齐、上部碰撞；第二次刀背齐、刃线错阶，展示完整中间动作。',
    dialogue: '沈砚：“刃口齐了，断口有空；刀背齐了，刃口错开。这两件，拼不成一把刀。”',
    sound: '两次轻触声对应实际接触，不给胜利式音效；台词后留半秒静默。',
    continuity: '断刀几何不翻面、不自修复；竹镊夹持位置固定；只有真实过程通过后，后期细线才能叠在正确断口上。',
    shots: ['07｜断口合不上 · 9s', '08｜一句话拆掉定罪依据 · 9s'],
  },
  {
    id: 'beat-result',
    purpose: '阶段结果',
    title: '停刑，但不是昭雪',
    question: '县令为什么愿意暂停行刑？',
    synopsis: '黎青只要求重查，顾衡下令停刑封存证物，局势得到阶段缓解。',
    action: '黎青放下竹镊作出结论；顾衡压掌下令并离开监斩席，镜头跟随他走向阶下。',
    dialogue: '顾衡：“停刑。证物封存，沈砚押回候审。”',
    sound: '短暂缓解但不做胜利大合奏；顾衡离席后群众只出现一次低语起伏。',
    continuity: '顾衡离席后座位保持空；守卫仍留在画面；证物分离状态延续到下一节拍。',
    shots: ['09｜不是昭雪，是重查 · 8s', '10｜刀下暂留人 · 7s'],
  },
  {
    id: 'beat-tag',
    purpose: '尾钩',
    title: '他叫我沈警官',
    question: '县令为什么知道这个现代称呼？',
    synopsis: '顾衡靠近耳语“沈警官”，袖扣露出与古镜相同的三道断弧，形成下一集钩子。',
    action: '顾衡走完最后两步并俯身耳语，袖口露扣；焦点从铜扣拉回沈砚眼睛，再切黑片名。',
    dialogue: '顾衡（耳语）：“沈警官。” 沈砚：“你怎么知道这个称呼？”',
    sound: '音乐抽空，只留衣料与远声；耳语必须可懂，低频重音后余响切黑。',
    continuity: '耳语在沈砚左耳；袖扣与镜 01 使用同一符号母版；顾衡不回答，悬念不升级成已确认真凶。',
    shots: ['11｜他叫我沈警官 · 8s', '12｜相同的三道断弧 · 7s'],
  },
]

const flow = [
  ['01', '剧本', '6 个叙事节拍', true],
  ['02', '分镜', '12 / 12 镜已映射', true],
  ['03', '资产', '11 项正式参考，关键断刀已锁定', true],
  ['04', '画面', '12 / 12 镜已有正式画面', true],
  ['05', '视频', '12 镜待定生成方式', false],
  ['06', '声音', '12 镜待补逐镜声音设计', false],
  ['07', '交付', '0 / 12 镜通过完整视频与声音验收', false],
]

const script = {
  logline: '现代刑警穿越成待斩死囚，借一次证物复核争取重查，却发现县令知道他的现代身份。',
  promise: '观众在前 10 秒理解“如果证物不成立，他就有机会活下来”，并持续追问县令为什么认识他。',
  hook: '现代古镜反光切入刑场刀光，人在刀下醒来。',
  payoff: '停刑重查；县令耳语“沈警官”，留下穿越关联。',
  notes: '石灰灰、褪色靛蓝、暗绛红为主体色，铜色只用于关键物件。主角左颧骨浅擦伤与双腕绑绳整集不变；证物断口、人物手别、刑场南北主轴、县令离席后的空座均需连续。静帧、单镜候选和制作清单不得称为完整成片。',
}

let selected = 0
const $ = selector => document.querySelector(selector)
const beatsEl = $('#beats')
const detail = $('#beat-detail')

function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function renderBeats() {
  beatsEl.innerHTML = beats.map((beat, index) => `
    <button data-index="${index}" data-purpose="${beat.id}" aria-pressed="${index === selected}">
      <span>${String(index + 1).padStart(2, '0')}</span>
      <div><small>${esc(beat.purpose)}</small><strong>${esc(beat.title)}</strong><small>${beat.shots.length} 镜 · ${beat.id === 'beat-turn' ? '18s' : '12–23s'}</small></div>
    </button>`).join('')
  beatsEl.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
    selected = Number(button.dataset.index)
    render()
  }))
}

function renderDetail() {
  const beat = beats[selected]
  detail.innerHTML = `
    <header><div><span class="eyebrow">${esc(beat.purpose)}</span><h2>${esc(beat.title)}</h2></div><span class="count">${beat.shots.length} 个镜头</span></header>
    <div class="detail-grid">
      <section><span>戏剧问题</span><p>${esc(beat.question)}</p></section>
      <section><span>节拍概述</span><p>${esc(beat.synopsis)}</p></section>
      <section class="primary-text"><span>视觉动作方向</span><p>${esc(beat.action)}</p></section>
      <section><span>对白 / 旁白意图</span><p>${esc(beat.dialogue)}</p></section>
      <section><span>声音</span><p>${esc(beat.sound)}</p></section>
      <section><span>连续性</span><p>${esc(beat.continuity)}</p></section>
    </div>
    <div class="shot-map"><div class="section-head"><h2>映射分镜</h2><span>${beat.shots.length} 个</span></div>
      <div class="shot-grid">${beat.shots.map((shot, index) => `<button data-shot="${index}"><span>${String(beat.id === 'beat-hook' ? index + 1 : beat.id === 'beat-incident' ? 3 : beat.id === 'beat-rising' ? index + 4 : beat.id === 'beat-turn' ? index + 7 : beat.id === 'beat-result' ? index + 9 : index + 11).padStart(2, '0')}</span><div><strong>${esc(shot)}</strong><small>点击查看分镜制作字段</small></div><svg><use href="#i-arrow"/></svg></button>`).join('')}</div>
    </div>`
  detail.querySelectorAll('[data-shot]').forEach(button => button.addEventListener('click', () => toast('预览页：此处进入对应分镜镜头')))
}

function render() {
  renderBeats()
  renderDetail()
}

function renderFlow() {
  $('#flow').innerHTML = flow.map(([index, label, detail, ready]) => `<div><span>${index}</span><div><strong>${label}</strong><p>${detail}</p></div><svg><use href="#${ready ? 'i-check' : 'i-alert'}"/></svg></div>`).join('')
}

function toast(message) {
  const element = $('#toast')
  element.textContent = message
  element.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { element.hidden = true }, 2200)
}

$('#theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  $('#theme use').setAttribute('href', next === 'dark' ? '#i-moon' : '#i-sun')
})

$('#compact').addEventListener('click', event => {
  const compact = $('#studio').classList.toggle('compact')
  event.currentTarget.setAttribute('aria-pressed', String(compact))
})

$('#logline-toggle').addEventListener('click', event => {
  const expanded = event.currentTarget.getAttribute('aria-expanded') !== 'true'
  event.currentTarget.setAttribute('aria-expanded', String(expanded))
  $('#logline-full').hidden = !expanded
  event.currentTarget.querySelector('span:last-child').innerHTML = expanded ? '收起全文 <b>⌃</b>' : '展开全文 <b>⌄</b>'
})

for (const selector of ['#agent', '#agent-2']) {
  $(selector).addEventListener('click', event => {
    const button = event.currentTarget
    button.classList.add('agent-loading')
    button.disabled = true
    setTimeout(() => {
      button.classList.remove('agent-loading')
      button.disabled = false
      toast('已将整集剧本重构要求引用到 Agent')
    }, 700)
  })
}

$('#edit').addEventListener('click', () => {
  $('#logline-input').value = script.logline
  $('#promise-input').value = script.promise
  $('#hook-input').value = script.hook
  $('#payoff-input').value = script.payoff
  $('#notes-input').value = script.notes
  $('#editor-beat-name').textContent = beats[selected].title
  $('#question-input').value = beats[selected].question
  $('#action-input').value = beats[selected].action
  $('#continuity-input').value = beats[selected].continuity
  $('#editor').showModal()
})

$('#editor form').addEventListener('submit', event => {
  if (event.submitter?.value !== 'save') return
  script.logline = $('#logline-input').value
  script.promise = $('#promise-input').value
  script.hook = $('#hook-input').value
  script.payoff = $('#payoff-input').value
  script.notes = $('#notes-input').value
  beats[selected].question = $('#question-input').value
  beats[selected].action = $('#action-input').value
  beats[selected].continuity = $('#continuity-input').value
  $('.logline h2').textContent = script.logline
  $('.logline>p').textContent = script.promise
  $('.production-notes>p').textContent = script.notes
  render()
  toast('剧本已保存到本次预览')
})

render()
renderFlow()
