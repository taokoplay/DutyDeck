// 独立 HTML 交互稿：素材来自既有规划稿；所有修改仅保存在当前浏览器。
'use strict';

// 页面图标统一使用线性描边，不加载第三方脚本或字体。
const ICONS = {
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  chat:'<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V5a3 3 0 0 1 3-3h8a8 8 0 0 1 8 9Z"/><path d="M7 8h9M7 12h6"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  film:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4m10 0h4M3 16h4m10 0h4"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  spark:'<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z"/>',
  check:'<path d="m5 12 4 4L19 6"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>',
  link:'<path d="m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0) scale(.92)"/>',
  'arrow-up':'<path d="M12 20V4m-7 7 7-7 7 7"/>',chevron:'<path d="m6 9 6 6 6-6"/>',
  expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  collapse:'<path d="M3 8h5V3m13 5h-5V3M3 16h5v5m13-5h-5v5"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',minus:'<path d="M5 12h14"/>',
  play:'<path d="m8 5 11 7-11 7Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',
  previous:'<path d="M5 5v14m14-14L9 12l10 7Z"/>',next:'<path d="M19 5v14M5 5l10 7-10 7Z"/>',
  layers:'<path d="m12 3 10 6-10 6L2 9l10-6Zm-9 11 9 5 9-5m-18 5 9 5 9-5" transform="translate(0 -1) scale(1 .95)"/>',
  undo:'<path d="M3 10h11a6 6 0 0 1 0 12M3 10l5-5m-5 5 5 5" transform="translate(0 -2)"/>',
  redo:'<path d="M21 10H10a6 6 0 0 0 0 12m11-12-5-5m5 5-5 5" transform="translate(0 -2)"/>',
  scissors:'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8 8 13 13M8 16 21 3"/>',
  fit:'<path d="M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5M7 12h10m-7-3-3 3 3 3m4-6 3 3-3 3"/>',
  mic:'<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  music:'<path d="M9 17V5l11-2v12M9 8l11-2"/><ellipse cx="5.5" cy="18" rx="3.5" ry="3"/><ellipse cx="16.5" cy="16" rx="3.5" ry="3"/>',
  captions:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M9 9H6v6h3m9-6h-3v6h3"/>',
  settings:'<path d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="12" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  left:'<path d="m14 5-7 7 7 7"/>',right:'<path d="m10 5 7 7-7 7"/>',
  trash:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>'
};

/** 根据图标名返回可信 SVG 标记，无外部输入。 */
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.film}</svg>`; }
/** 填充容器中的声明式图标。 */
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); }); }
/** 将用户输入转为安全文本标记，防止本地草稿注入 HTML。 */
function escapeText(value) { return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
/** 以选择器取得唯一节点。 */
function $(selector) { return document.querySelector(selector); }
/** 将秒转换为播放器时间文本。 */
function time(value) { return `${String(Math.floor(value / 60)).padStart(2,'0')}:${String(Math.floor(value % 60)).padStart(2,'0')}`; }
/** 四舍五入到百分之一秒，避免累计浮点误差。 */
function rounded(value) { return Math.round(value * 100) / 100; }
/** 将值限制在闭区间内。 */
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
/** 深复制纯数据，防止候选、撤销记录共享可变数组。 */
function copy(value) { return structuredClone(value); }

// 示例镜头保持与原影像创作稿同一作品；图片仅用于静帧连播。
const SOURCES = [
  {id:'p1',title:'晨光启幕',subtitle:'光，陪你开始平凡的一天。',duration:6,version:1},
  {id:'p2',title:'触见细节',subtitle:'简单的形状，装得下温暖。',duration:6,version:1},
  {id:'p3',title:'夜读时光',subtitle:'也陪你，把时间留给自己。',duration:6,version:2},
  {id:'p4',title:'带光出发',subtitle:'走远一点，光也跟着你。',duration:6,version:1},
  {id:'p5',title:'轻松随行',subtitle:'提起温暖，继续出发。',duration:6,version:1},
  {id:'p6',title:'把光带向生活',subtitle:'LUMA，把光带向生活。',duration:6,version:1}
].map((source,index) => ({...source,image:`../visual-production/assets/promo-${index+1}.svg`,order:index+1}));
// 每集独立保存剪辑；第二集用来体验从空项目建立粗剪。
const EPISODES = {main:{title:'品牌主片',sources:SOURCES},teaser:{title:'社交预告',sources:[SOURCES[0],SOURCES[3],SOURCES[5]]}};
const STORAGE_KEY = 'dutydeck:editing-html:v1';
/** 从镜头创建独立时间线片段，引用固定素材版本。 */
function makeClip(source) { return {id:crypto.randomUUID(),sourceId:source.id,title:source.title,image:source.image,sourceDuration:source.duration,in:0,out:source.duration,volume:100,subtitle:source.subtitle,version:source.version}; }
/** 创建指定集数的初始剪辑，空集数不伪造完成状态。 */
function makeCut(episode) { return {clips:episode==='main'?SOURCES.map(makeClip):[],voice:100,music:25,captions:true,revision:1}; }
// 视图状态与剪辑数据分离，展开/收起不会重建内容。
let cuts = {main:makeCut('main'),teaser:makeCut('teaser')};
let episode = 'main';
let selectedId = cuts.main.clips[0].id;
let playhead = 0;
let playing = false;
let frameId = 0;
let lastFrame = 0;
let zoom = 1;
let timelineWidth = 620;
let candidate = null;
let previewCandidate = false;
let undoStack = [];
let redoStack = [];
let toastTimer = 0;
let dragId = null;
let modalMode = '';
let assetFilter = 'all';
let assetSearch = '';
let assetSelection = new Set();
let exportOptions = {ratio:'16:9',resolution:'1080p',captions:true};
let exportTimer = 0;
let exportProgress = 0;
let modalTrigger = null;

/** 校验本地草稿结构与素材身份，仅恢复有限、可信的演示数据。 */
function validCut(cut) {
  return cut && Array.isArray(cut.clips) && cut.clips.length<=30 && typeof cut.captions==='boolean' && Number.isFinite(cut.music) && cut.music>=0 && cut.music<=100 && Number.isFinite(cut.voice) && cut.voice>=0 && cut.voice<=100 && Number.isInteger(cut.revision) && cut.clips.every(clip => {
    const source = SOURCES.find(item=>item.id===clip.sourceId);
    return source && typeof clip.id==='string' && /^[a-zA-Z0-9-]{1,80}$/.test(clip.id) && typeof clip.title==='string' && clip.title.length<=100 && typeof clip.subtitle==='string' && clip.subtitle.length<=120 && clip.image===source.image && clip.sourceDuration===source.duration && clip.version===source.version && Number.isFinite(clip.in) && Number.isFinite(clip.out) && clip.in>=0 && clip.out<=source.duration && clip.out-clip.in>=.25 && Number.isFinite(clip.volume) && clip.volume>=0 && clip.volume<=100;
  });
}
try {
  // 只恢复本原型自己的键；损坏或旧格式保持初始示例。
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
  if (stored && validCut(stored.main) && validCut(stored.teaser)) { cuts=stored; selectedId=cuts.main.clips[0]?.id||null; }
} catch { /* 浏览器存储不可用时保留内存演示。 */ }

/** 返回当前实际展示的剪辑；候选预览不写入正式草稿。 */
function visibleCut() { return previewCandidate && candidate && candidate.episode===episode && candidate.baseRevision===cuts[episode].revision ? candidate.cut : cuts[episode]; }
/** 计算指定剪辑片段的总时长。 */
function duration(cut = visibleCut()) { return rounded(cut.clips.reduce((sum,clip)=>sum+clip.out-clip.in,0)); }
/** 返回选中片段，没有选择时使用第一段。 */
function selected(cut=visibleCut()) { return cut.clips.find(clip=>clip.id===selectedId)||cut.clips[0]; }
/** 取得片段在成片中的开始时间。 */
function clipStart(id,cut=visibleCut()) { let start=0; for (const clip of cut.clips) { if(clip.id===id) return start; start+=clip.out-clip.in; } return 0; }
/** 将当前草稿保存到浏览器，失败时明确显示未持久化。 */
function persist() { try { localStorage.setItem(STORAGE_KEY,JSON.stringify(cuts)); $('#save-status').innerHTML=icon('check')+'已保存在此浏览器'; } catch { $('#save-status').textContent='仅保存在当前页面'; } }
/** 显示短暂反馈，复用单一计时器。 */
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent=message; $('#toast').hidden=false; toastTimer=setTimeout(()=>{$('#toast').hidden=true;},2800); }
/** 写入一个可撤销操作；自动使旧 Agent 候选失效。 */
function commit(update,message) {
  pause(); previewCandidate=false;
  undoStack.push(copy(cuts[episode])); undoStack=undoStack.slice(-20); redoStack=[];
  update(cuts[episode]); cuts[episode].revision+=1;
  playhead=clamp(playhead,0,duration(cuts[episode])); persist(); render(); if(message) toast(message);
}
/** 在同一集数内撤销或重做，版本仍单调递增。 */
function historyStep(redo=false) {
  const from=redo?redoStack:undoStack;
  const to=redo?undoStack:redoStack;
  if(!from.length) return;
  pause(); previewCandidate=false; to.push(copy(cuts[episode]));
  const revision=cuts[episode].revision+1;
  cuts[episode]=from.pop(); cuts[episode].revision=revision;
  playhead=clamp(playhead,0,duration()); persist(); render(); toast(redo?'已重做':'已撤销');
}

/** 生成装饰性示例波形，不代表真实音频分析或音频播放。 */
function wave(seed) { return `<span class="waveform" aria-hidden="true">${Array.from({length:145},(_,index)=>`<i style="height:${4+Math.abs(Math.sin(index*1.37+seed)*Math.cos(index*.39))*19}px"></i>`).join('')}</span>`; }
/** 渲染播放器之外的内容；播放期间只更新必要节点，避免逐帧重建 DOM。 */
function render() {
  const cut=visibleCut();
  const total=duration(cut);
  const clip=selected(cut);
  if(clip) selectedId=clip.id;
  $('#episode-name').textContent=EPISODES[episode].title;
  $('#cut-label').textContent=previewCandidate?'方案预览':'主剪辑';
  $('#timeline-summary').textContent=`${cut.clips.length} 个片段 · ${total} 秒`;
  $('#agent-context').textContent=`${EPISODES[episode].title}${clip?` · ${String(cut.clips.indexOf(clip)+1).padStart(2,'0')} ${clip.title}`:' · 尚无片段'}`;
  $('#selection-bar').hidden=!clip;
  $('#empty-action').hidden=!!cut.clips.length;
  $('#preview-empty').hidden=!!cut.clips.length;
  $('#preview-image').hidden=!cut.clips.length;
  $('#preview-corner').hidden=!cut.clips.length;
  $('#preview-play').hidden=!cut.clips.length;
  $('#scrubber').disabled=!cut.clips.length; $('#scrubber').max=String(total||1);
  $('[data-action=undo]').disabled=!undoStack.length;
  $('[data-action=redo]').disabled=!redoStack.length;
  $('[data-action=split]').disabled=!cut.clips.length||previewCandidate;
  $('[data-action=export]').disabled=!cut.clips.length||previewCandidate;
  $('#preview-screen').disabled=!cut.clips.length;
  $('.playback-button').disabled=!cut.clips.length;
  $('#voice-volume').textContent=`${cut.voice}%`; $('#music-volume').textContent=`${cut.music}%`;
  $('.captions-toggle').setAttribute('aria-pressed',String(cut.captions));
  if(clip) $('#selection-bar').innerHTML=`<span class="selected-number">${String(cut.clips.indexOf(clip)+1).padStart(2,'0')}</span><div class="selected-copy"><strong>${escapeText(clip.title)}</strong><span>${rounded(clip.out-clip.in)}s · v${clip.version}</span></div><button class="selected-link" data-action="source">${icon('link')}来源</button><button class="button" data-action="clip-settings">${icon('settings')}片段设置</button>`;
  $('#library-list').innerHTML=EPISODES[episode].sources.map(source=>`<button class="library-card" data-library="${source.id}" aria-label="添加素材：${source.title}"><img src="${source.image}" alt=""><span><strong>${source.title}</strong><small>${source.duration}s · v${source.version}</small></span>${icon('plus')}</button>`).join('');
  $('.library-count>span').textContent=String(EPISODES[episode].sources.length);
  renderCandidate(); renderTimeline(); paintPlayer();
  document.querySelectorAll('[data-episode]').forEach(button=>button.setAttribute('aria-checked',String(button.dataset.episode===episode)));
  document.querySelectorAll('.change-actions [data-action]').forEach(button=>{
    const available=candidate && button.dataset.candidate===candidate.id && candidate.episode===episode && candidate.baseRevision===cuts[episode].revision;
    button.disabled=!available;
  });
}
/** 绘制与滚动容器宽度一致的轨道和刻度。 */
function renderTimeline() {
  const cut=visibleCut();
  const total=duration(cut);
  const scaleTotal=Math.max(total,12);
  const available=$('#timeline-scroll').clientWidth;
  timelineWidth=Math.max(available,Math.max(420,total*17.22)*zoom);
  $('#timeline-content').style.width=`${timelineWidth}px`;
  $('#timeline-content').style.setProperty('--clip-px',`${timelineWidth/scaleTotal}px`);
  $('#zoom-label').textContent=`${Math.round(zoom*100)}%`;
  $('#ruler').innerHTML=Array.from({length:Math.floor(scaleTotal/3)+1},(_,index)=>`<span style="left:${index*3/scaleTotal*100}%;${index*3>=scaleTotal?'transform:translateX(-100%)':''}">${time(index*3)}</span>`).join('');
  $('#video-track').innerHTML=cut.clips.length?cut.clips.map((clip,index)=>`<button class="timeline-clip ${clip.id===selectedId?'selected':''}" data-clip="${clip.id}" draggable="${!previewCandidate}" aria-label="${index+1} ${escapeText(clip.title)}，${rounded(clip.out-clip.in)}秒" aria-pressed="${clip.id===selectedId}" style="width:${(clip.out-clip.in)/scaleTotal*100}%"><img src="${clip.image}" alt="" draggable="false"><span class="clip-caption"><strong>${String(index+1).padStart(2,'0')} ${escapeText(clip.title)}</strong><small>${rounded(clip.out-clip.in)}s</small></span></button>`).join(''):'<div class="empty-track-note">从分镜创建剪辑，或添加项目素材</div>';
  $('#voice-track').innerHTML=cut.clips.length?`<button class="audio-block" data-action="voice" style="width:${total/scaleTotal*100}%;opacity:${cut.voice===0?.35:1}" aria-label="设置旁白音量">${wave(2)}<span>品牌主片 · 示例旁白</span></button>`:'';
  $('#music-track').innerHTML=cut.clips.length?`<button class="audio-block" data-action="music" style="width:${total/scaleTotal*100}%;opacity:${cut.music===0?.35:1}" aria-label="设置背景音乐音量">${wave(5)}<span>Soft morning · ${cut.music}%</span></button>`:'';
  $('#subtitle-track').classList.toggle('muted-track',!cut.captions);
  $('#subtitle-track').innerHTML=cut.clips.map(clip=>`<button class="subtitle-block" data-subtitle="${clip.id}" style="width:${(clip.out-clip.in)/scaleTotal*100}%" title="${escapeText(clip.subtitle)}">${escapeText(clip.subtitle)}</button>`).join('');
}
/** 仅更新当前画面、字幕、时间码和播放头；素材由本地 SVG 提供。 */
function paintPlayer() {
  const cut=visibleCut();
  const total=duration(cut);
  let accumulated=0;
  const index=cut.clips.findIndex(clip=>{accumulated+=clip.out-clip.in;return playhead<accumulated;});
  const current=cut.clips[index<0?cut.clips.length-1:index];
  if(current){
    if($('#preview-image').getAttribute('src')!==current.image) $('#preview-image').src=current.image;
    $('#preview-image').alt=`${current.title}示例画面`;
    $('#preview-corner').textContent=`${String((index<0?cut.clips.length-1:index)+1).padStart(2,'0')} / ${String(cut.clips.length).padStart(2,'0')}`;
    $('#preview-subtitle').textContent=current.subtitle;
  }
  $('#preview-subtitle').hidden=!cut.captions||!current;
  $('#timecode').innerHTML=`${time(playhead)} <span>/ ${time(total)}</span>`;
  $('#scrubber').value=String(playhead);
  $('#playhead').style.left=`${playhead/Math.max(total,12)*timelineWidth}px`;
  $('.playback-button').innerHTML=icon(playing?'pause':'play');
  $('.playback-button').setAttribute('aria-label',playing?'暂停静帧预演':'播放静帧预演');
  $('#preview-screen').setAttribute('aria-label',playing?'暂停静帧预演':'播放静帧预演');
  $('#preview-play').innerHTML=icon(playing?'pause':'play');
  $('#workspace').classList.toggle('playing',playing);
}
/** 停止预演并释放动画帧，隐藏页面和打开弹窗时同样调用。 */
function pause() { playing=false;cancelAnimationFrame(frameId);frameId=0;paintPlayer(); }
/** 根据真实经过时间推进静帧预演，到尾自动暂停。 */
function tick(timestamp) {
  if(!playing) return;
  playhead=Math.min(duration(),playhead+(timestamp-lastFrame)/1000); lastFrame=timestamp;
  paintPlayer();
  if(playhead>=duration()){pause();return;}
  frameId=requestAnimationFrame(tick);
}
/** 开关播放，不启动媒体生成或声音合成。 */
function togglePlay(){if(!visibleCut().clips.length)return;if(playing){pause();return;}if(playhead>=duration())playhead=0;playing=true;lastFrame=performance.now();paintPlayer();frameId=requestAnimationFrame(tick);}
/** 选择片段并定位到片头，同步 Agent 引用上下文。 */
function selectClip(id){pause();selectedId=id;playhead=clipStart(id);render();}
/** 跳到相邻片段，保持首尾有界。 */
function stepClip(direction){const clips=visibleCut().clips; if(!clips.length)return;let start=0;const current=clips.findIndex(clip=>{start+=clip.out-clip.in;return playhead<start;});const index=clamp((current<0?clips.length-1:current)+direction,0,clips.length-1);selectClip(clips[index].id);}
/** 移动片段，保留素材引用和裁切范围。 */
function moveClip(id,targetIndex){if(previewCandidate){toast('先采用或退出方案预览');return;}const clips=cuts[episode].clips;const from=clips.findIndex(clip=>clip.id===id);if(from<0||targetIndex<0||targetIndex>=clips.length||from===targetIndex)return;commit(cut=>{cut.clips.splice(targetIndex,0,cut.clips.splice(from,1)[0]);},'片段顺序已调整');playhead=clipStart(id);paintPlayer();}
/** 在播放头拆分素材引用，原文件不变；两段均至少四分之一秒。 */
function splitClip(){
  if(previewCandidate)return;
  let start=0;
  const clip=cuts[episode].clips.find(item=>{if(playhead>=start&&playhead<start+item.out-item.in)return true;start+=item.out-item.in;return false;});
  if(!clip||playhead-start<.25||clip.out-clip.in-(playhead-start)<.25){toast('将播放头移到片段中间，前后至少保留 0.25 秒');return;}
  if(cuts[episode].clips.length>=30){toast('交互稿最多保留 30 个片段');return;}
  const point=rounded(clip.in+playhead-start);
  commit(cut=>{const index=cut.clips.findIndex(item=>item.id===clip.id);const right={...copy(cut.clips[index]),id:crypto.randomUUID(),in:point};cut.clips[index].out=point;cut.clips.splice(index+1,0,right);selectedId=right.id;},'已在播放头分割，可撤销');
}

/** 打开统一弹窗并保留触发元素，用于关闭后的焦点恢复。 */
function openModal(mode,title,description,body,footer){pause();modalMode=mode;modalTrigger=document.activeElement;$('#modal-title').textContent=title;$('#modal-description').textContent=description;$('#modal-body').innerHTML=body;$('#modal-footer').innerHTML=footer;hydrateIcons($('#modal'));if(!$('#modal').open)$('#modal').showModal();}
/** 关闭弹窗并停止该弹窗的演示任务。 */
function closeModal(){clearInterval(exportTimer);exportTimer=0;$('#modal').close();modalMode='';if(modalTrigger?.isConnected)modalTrigger.focus();}
/** 构造固定页脚的取消和主要操作。 */
function modalActions(action,label){return `<button class="button" data-action="close-modal">取消</button><button class="button primary" data-action="${action}">${label}</button>`;}
/** 展示片段裁切、字幕与原声表单，所有输入在保存前均为草稿。 */
function openClipSettings(){
  if(previewCandidate){toast('先采用或退出方案预览，再编辑片段');return;}
  const clip=selected(); if(!clip)return;
  const index=cuts[episode].clips.indexOf(clip);
  openModal('clip','片段设置',`${EPISODES[episode].title} / ${String(index+1).padStart(2,'0')} ${clip.title}`,
    `<div class="clip-edit-top"><img src="${clip.image}" alt="${escapeText(clip.title)}"><div><strong>${escapeText(clip.title)}</strong><p>引用分镜 ${SOURCES.find(source=>source.id===clip.sourceId).order} · 源素材 ${clip.sourceDuration} 秒</p><span class="version-tag">已采用 v${clip.version}</span></div></div><div class="field-grid"><label class="field"><span>素材入点</span><div class="inline-controls"><input id="clip-in" type="number" min="0" max="${clip.sourceDuration}" step="0.1" value="${clip.in}" aria-label="素材入点"><span>秒</span></div></label><label class="field"><span>素材出点</span><div class="inline-controls"><input id="clip-out" type="number" min="0" max="${clip.sourceDuration}" step="0.1" value="${clip.out}" aria-label="素材出点"><span>秒</span></div></label><label class="field full"><span>原声音量 <output id="clip-volume-value">${clip.volume}%</output></span><input type="range" id="clip-volume" min="0" max="100" value="${clip.volume}" aria-label="片段原声音量"><small>不影响独立的旁白和音乐轨道；本稿不播放声音。</small></label><label class="field full"><span>字幕内容</span><textarea id="clip-caption-input" rows="2" maxlength="120">${escapeText(clip.subtitle)}</textarea></label></div><p class="modal-error" id="clip-error" role="alert"></p><div class="reorder-actions"><span>在成片中的顺序</span><button class="button" data-action="move-left" ${index===0?'disabled':''}>${icon('left')}前移</button><button class="button" data-action="move-right" ${index===cuts[episode].clips.length-1?'disabled':''}>后移${icon('right')}</button></div>`,
    `<button class="button subtle danger-text" data-action="remove-clip">${icon('trash')}移出剪辑</button><div class="toolbar-spacer"></div>${modalActions('save-clip','保存修改')}`);
}
/** 校验裁切区间后保存片段，非法值不污染时间线。 */
function saveClip(){
  const clip=selected(); if(!clip)return;
  const start=Number($('#clip-in').value),end=Number($('#clip-out').value);
  if(!$('#clip-in').value||!$('#clip-out').value||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>clip.sourceDuration||end-start<.25){$('#clip-error').textContent=`请输入 0–${clip.sourceDuration} 秒内的有效区间，至少保留 0.25 秒。`;return;}
  const volume=Number($('#clip-volume').value),subtitle=$('#clip-caption-input').value.trim();
  commit(cut=>{const target=cut.clips.find(item=>item.id===clip.id);target.in=rounded(start);target.out=rounded(end);target.volume=volume;target.subtitle=subtitle;},'片段设置已保存');closeModal();
}
/** 展示旁白或音乐音量，避免将轨道设置塞进常驻侧栏。 */
function openAudio(kind){
  if(previewCandidate){toast('先采用或退出方案预览');return;}
  const label=kind==='voice'?'旁白':'背景音乐';
  openModal(kind,`${label}设置`,kind==='voice'?'品牌主片 · 示例旁白':'Soft morning · 示例配乐',`<label class="field"><span>音量 <output id="audio-value">${cuts[episode][kind]}%</output></span><input type="range" id="audio-volume" min="0" max="100" value="${cuts[episode][kind]}" aria-label="${label}音量"></label><div class="modal-divider"></div><p class="modal-note">这是音轨交互示例。音量变化会显示在时间线中；当前 HTML 不包含真实音频。</p>`,modalActions('save-audio','保存设置'));
}
/** 显示素材选择弹窗，搜索和类型筛选都只作用于本作品示例素材。 */
function openAssets(){
  if(previewCandidate){toast('先采用或退出方案预览');return;}
  assetSelection=new Set();assetFilter='all';assetSearch='';
  openModal('assets','添加素材','引用项目素材，加入当前剪辑',`<div class="asset-filters" role="group" aria-label="素材类型筛选"><button data-filter="all" class="active">全部</button><button data-filter="shots">本集镜头</button><button data-filter="audio">声音</button></div><label class="search-box">${icon('search')}<input id="asset-search" placeholder="搜索素材名称" aria-label="搜索素材"></label><div class="asset-grid" id="asset-grid"></div>`,modalActions('add-assets','添加所选素材'));
  renderAssets();
}
/** 根据筛选和搜索绘制素材卡片，保留已选项。 */
function renderAssets(){
  const options=[...EPISODES[episode].sources.map(source=>({...source,type:'shots'})),{id:'voice',title:'品牌主片 · 旁白',type:'audio'},{id:'music',title:'Soft morning · 配乐',type:'audio'}].filter(item=>(assetFilter==='all'||item.type===assetFilter)&&item.title.toLowerCase().includes(assetSearch.toLowerCase()));
  $('#asset-grid').innerHTML=options.length?options.map(item=>`<button class="asset-option" data-asset="${item.id}" aria-pressed="${assetSelection.has(item.id)}">${item.image?`<img src="${item.image}" alt="">`:`<span class="asset-audio-icon">${icon(item.id==='voice'?'mic':'music')}</span>`}${assetSelection.has(item.id)?`<span class="asset-check">${icon('check')}</span>`:''}<strong>${escapeText(item.title)}</strong><small>${item.type==='shots'?`${item.duration}s · 已采用 v${item.version}`:'示例声音轨道'}</small></button>`).join(''):'<p class="asset-empty">没有匹配的素材，试试其他关键词。</p>';
  $('[data-action=add-assets]').disabled=!assetSelection.size;
  $('[data-action=add-assets]').textContent=`添加所选素材${assetSelection.size?`（${assetSelection.size}）`:''}`;
}
/** 将选择的镜头引用追加到时间线；声音选项恢复对应轨道音量。 */
function addAssets(){
  const sources=SOURCES.filter(source=>assetSelection.has(source.id));
  if(cuts[episode].clips.length+sources.length>30){toast('交互稿最多保留 30 个片段');return;}
  commit(cut=>{cut.clips.push(...sources.map(makeClip));if(assetSelection.has('voice'))cut.voice=100;if(assetSelection.has('music'))cut.music=25;},'已添加到当前剪辑');closeModal();
}

/** 在主会话追加安全文本消息，不调用外部 Agent。 */
function addMessage(text,user=false){
  const node=document.createElement('div');node.className=user?'user-message':'assistant-message';
  if(user)node.textContent=text;else node.innerHTML=`<div class="assistant-name">${icon('spark')}主 Agent <small>示例回复</small></div><p>${escapeText(text)}</p>`;
  $('#agent-messages').append(node);$('#agent-messages').scrollTop=$('#agent-messages').scrollHeight;
  // 演示消息有界保留，避免长时间试用累积无关 DOM。
  while($('#agent-messages').children.length>22)$('#agent-messages').children[1].remove();
  return node;
}
/** 根据三个明确演示意图建立修改方案；未识别输入不会伪装模型理解。 */
function proposeFromPrompt(prompt){
  addMessage(prompt,true);
  if(!cuts[episode].clips.length){addMessage('先按分镜建立剪辑，再选择片段进行调整。');return;}
  previewCandidate=false;
  const draft=copy(cuts[episode]);
  const changes=[];
  if(/缩短|短一点|两秒|2秒/.test(prompt)){
    const target=/第\s*3|第三/.test(prompt)?draft.clips[2]:draft.clips.find(clip=>clip.id===selectedId);
    if(target){const old=rounded(target.out-target.in);target.out=Math.min(target.sourceDuration,target.in+2);changes.push({label:target.title,before:`${old} 秒`,after:`${rounded(target.out-target.in)} 秒`});}
  }
  if(/音乐|配乐/.test(prompt)){changes.push({label:'背景音乐',before:`${draft.music}%`,after:'15%'});draft.music=15;}
  if(/关闭字幕|隐藏字幕/.test(prompt)){changes.push({label:'字幕显示',before:draft.captions?'显示':'隐藏',after:'隐藏'});draft.captions=false;}
  if(!changes.length){addMessage('当前 HTML 演示支持：缩短选中片段到 2 秒、音乐降低到 15%、隐藏字幕。可以点击下方快捷建议体验。');render();return;}
  candidate={id:crypto.randomUUID(),episode,baseRevision:cuts[episode].revision,cut:draft,changes};
  const node=addMessage('整理了一版修改方案。可以先在右侧预览，再决定是否采用。');
  node.insertAdjacentHTML('beforeend',`<div class="agent-change"><strong>剪辑调整 · ${changes.length} 项修改</strong>${changes.map(change=>`<p class="diff"><span>${escapeText(change.label)}</span><del>${escapeText(change.before)}</del><span>→</span><ins>${escapeText(change.after)}</ins></p>`).join('')}<div class="change-actions"><button class="button" data-action="preview-candidate" data-candidate="${candidate.id}">预览方案</button><button class="button primary" data-action="apply-candidate" data-candidate="${candidate.id}">采用修改</button></div></div>`);
  render();$('#agent-messages').scrollTop=$('#agent-messages').scrollHeight;
}
/** 候选提示固定在剪辑顶部，失效原因直接可见。 */
function renderCandidate(){
  const relevant=candidate&&candidate.episode===episode;
  $('#candidate-strip').hidden=!relevant;
  if(!relevant)return;
  const stale=candidate.baseRevision!==cuts[episode].revision;
  $('#candidate-strip').innerHTML=stale?`${icon('info')}<span>剪辑已修改，Agent 方案需要重新生成</span><button data-action="dismiss-candidate">关闭</button>`:`${icon('spark')}<span>${previewCandidate?'正在预览 Agent 方案 · 尚未采用':`Agent 提出 ${candidate.changes.length} 项剪辑调整`}</span><button data-action="preview-candidate">${previewCandidate?'返回原版':'预览'}</button><button data-action="apply-candidate">采用</button>`;
}
/** 只在候选基线版本仍一致时采用，避免覆盖人工编辑。 */
function applyCandidate(){
  if(!candidate||candidate.episode!==episode||candidate.baseRevision!==cuts[episode].revision){toast('剪辑已经变化，请让 Agent 重新生成方案');return;}
  const proposed=copy(candidate.cut);candidate=null;previewCandidate=false;
  commit(cut=>{cut.clips=proposed.clips;cut.music=proposed.music;cut.voice=proposed.voice;cut.captions=proposed.captions;},'已采用 Agent 修改，可随时撤销');
  addMessage('修改已应用到当前剪辑。可以继续播放检查，也可以撤销。');
}

/** 导出设置使用分段按钮和开关，避免系统原生下拉。 */
function openExport(){
  if(!visibleCut().clips.length)return;
  exportOptions={ratio:'16:9',resolution:'1080p',captions:cuts[episode].captions};
  openModal('export','导出成片',`${EPISODES[episode].title} · ${duration()} 秒`,
    `<div class="export-summary"><img src="${visibleCut().clips[0].image}" alt="成片封面"><div><strong>LUMA · ${EPISODES[episode].title}</strong><small>${visibleCut().clips.length} 个片段 · 24 fps · MP4</small></div></div><div class="field-grid"><div class="field"><span>画面比例</span><div class="segmented"><button data-ratio="16:9" aria-pressed="true">16:9</button><button data-ratio="9:16" aria-pressed="false">9:16</button><button data-ratio="1:1" aria-pressed="false">1:1</button></div><small id="ratio-note">沿用当前横版构图</small></div><div class="field"><span>分辨率</span><div class="segmented"><button data-resolution="1080p" aria-pressed="true">1080p</button><button data-resolution="720p" aria-pressed="false">720p</button></div><small>24 fps · H.264</small></div></div><div class="modal-divider"></div><div class="switch-row"><div><strong>将字幕烧录到视频</strong><small>导出后字幕成为画面的一部分</small></div><button class="switch" data-action="export-captions" role="switch" aria-label="将字幕烧录到视频" aria-checked="${exportOptions.captions}"></button></div><div class="modal-divider"></div><p class="modal-note">HTML 交互稿仅演示导出设置和任务状态，不合成或下载真实 MP4。</p>`,modalActions('start-export','演示导出流程'));
}
/** 演示导出任务有明确标识和取消入口，不产生虚构媒体文件。 */
function startExport(){
  modalMode='exporting';exportProgress=0;
  $('#modal-description').textContent='流程演示 · 未启动真实渲染';
  $('#modal-body').innerHTML=`<div class="export-task"><span>${icon('film')}</span><div><strong>LUMA · ${EPISODES[episode].title}</strong><small>${exportOptions.ratio} · ${exportOptions.resolution} · ${exportOptions.captions?'含字幕':'无字幕'}</small></div></div><div class="progress-track"><span id="export-progress" style="width:0%"></span></div><div class="export-progress-label"><span id="export-stage">准备素材（演示）</span><span id="export-percent">0%</span></div><div class="modal-divider"></div><p class="modal-note">正式接入后，导出任务会进入项目任务中心。关闭页面不应取消后台渲染。</p>`;
  $('#modal-footer').innerHTML='<button class="button" data-action="close-modal">停止演示</button>';
  exportTimer=setInterval(()=>{exportProgress=Math.min(100,exportProgress+10);$('#export-progress').style.width=`${exportProgress}%`;$('#export-percent').textContent=`${exportProgress}%`;$('#export-stage').textContent=exportProgress<30?'准备素材（演示）':exportProgress<80?'合成画面与声音（演示）':'写入成片文件（演示）';if(exportProgress===100){clearInterval(exportTimer);exportTimer=0;modalMode='exported';$('#export-stage').textContent='导出流程演示结束';$('#modal-footer').innerHTML='<span class="modal-note">本次未生成视频文件</span><div class="toolbar-spacer"></div><button class="button primary" data-action="close-modal">返回剪辑</button>'; }},300);
}

/** 统一动作分发；所有具有保存语义的入口走 commit。 */
function act(action){
  if(action==='play')togglePlay();
  else if(action==='previous')stepClip(-1);
  else if(action==='next')stepClip(1);
  else if(action==='theme')document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';
  else if(action==='expand'){$('#shell').classList.toggle('expanded');const expanded=$('#shell').classList.contains('expanded');$('.expand-copy').textContent=expanded?'收起':'展开';$('.expand-button').setAttribute('aria-label',expanded?'收起精剪':'展开精剪');$('.expand-button').title=expanded?'收起精剪':'展开精剪';$('.expand-button [data-icon]').innerHTML=icon(expanded?'collapse':'expand');requestAnimationFrame(()=>{renderTimeline();paintPlayer();});}
  else if(action==='agent'){if(matchMedia('(max-width:1050px)').matches)$('#agent-pane').classList.toggle('open');else $('#agent-input').focus();}
  else if(action==='episodes'){$('#episode-menu').hidden=!$('#episode-menu').hidden;$('#episode-trigger').setAttribute('aria-expanded',String(!$('#episode-menu').hidden));if(!$('#episode-menu').hidden)$('#episode-menu button').focus();}
  else if(action==='undo')historyStep();
  else if(action==='redo')historyStep(true);
  else if(action==='split')splitClip();
  else if(action==='zoom-in'||action==='zoom-out'){zoom=clamp(zoom+(action==='zoom-in'?.25:-.25),.5,3);renderTimeline();paintPlayer();}
  else if(action==='fit'){zoom=.5;renderTimeline();paintPlayer();}
  else if(action==='clip-settings')openClipSettings();
  else if(action==='save-clip')saveClip();
  else if(action==='move-left'||action==='move-right'){const index=cuts[episode].clips.findIndex(clip=>clip.id===selectedId);moveClip(selectedId,index+(action==='move-left'?-1:1));openClipSettings();}
  else if(action==='remove-clip'){const id=selectedId;commit(cut=>{cut.clips=cut.clips.filter(clip=>clip.id!==id);selectedId=cut.clips[0]?.id||null;playhead=0;},'已移出剪辑，原素材保留，可撤销');closeModal();}
  else if(action==='source'){const clip=selected();if(!clip)return;openModal('source','引用来源',`${EPISODES[episode].title} / ${clip.title}`,`<div class="clip-edit-top"><img src="${clip.image}" alt="${escapeText(clip.title)}"><div><strong>${escapeText(clip.title)}</strong><p>分镜 ${SOURCES.find(source=>source.id===clip.sourceId).order} · 已采用 v${clip.version}</p><p>源素材 ${clip.sourceDuration} 秒 · 使用 ${clip.in}–${clip.out} 秒</p></div></div><p class="modal-note">片段引用当前采用的素材版本。以后生成了新版本，这段剪辑仍保持原画面，直到你选择替换。</p>`,'<button class="button primary" data-action="close-modal">知道了</button>');}
  else if(action==='voice'||action==='music')openAudio(action);
  else if(action==='save-audio'){const kind=modalMode;const value=Number($('#audio-volume').value);commit(cut=>{cut[kind]=value;},'音轨设置已保存');closeModal();}
  else if(action==='captions'){if(previewCandidate){toast('先采用或退出方案预览');return;}commit(cut=>{cut.captions=!cut.captions;},cuts[episode].captions?'字幕已隐藏':'字幕已显示');}
  else if(action==='assets')openAssets();
  else if(action==='add-assets')addAssets();
  else if(action==='roughcut'){commit(cut=>{cut.clips=EPISODES[episode].sources.map(makeClip);selectedId=cut.clips[0]?.id;playhead=0;},'已按分镜顺序建立剪辑');}
  else if(action==='close-modal')closeModal();
  else if(action==='preview-candidate'){if(!candidate||candidate.episode!==episode||candidate.baseRevision!==cuts[episode].revision){toast('方案已过期，请重新生成');return;}pause();previewCandidate=!previewCandidate;playhead=0;render();$('#agent-pane').classList.remove('open');}
  else if(action==='apply-candidate')applyCandidate();
  else if(action==='dismiss-candidate'){candidate=null;previewCandidate=false;render();}
  else if(action==='export')openExport();
  else if(action==='export-captions'){exportOptions.captions=!exportOptions.captions;$('[data-action=export-captions]').setAttribute('aria-checked',String(exportOptions.captions));}
  else if(action==='start-export')startExport();
  else if(action==='about')openModal('about','剪辑成片 · 交互规划','独立 HTML 原型，未接入正式项目',`<ul class="about-list"><li>默认右侧预览，展开后使用同一份剪辑。</li><li>播放是示例图片按时间线连续展示，不是实际视频。</li><li>片段裁切、排序、字幕、撤销会保存在此浏览器。</li><li>Agent 只响应三个预设演示意图，不调用模型。</li><li>音轨波形与导出进度为演示，不产生媒体文件。</li></ul>`,'<button class="button primary" data-action="close-modal">开始体验</button>');
}

// 事件委托保证动态面板复用同一套处理逻辑，无重复监听器。
document.addEventListener('click',event=>{
  const target=event.target.closest('button, a');
  if(!event.target.closest('.episode-picker')){$('#episode-menu').hidden=true;$('#episode-trigger').setAttribute('aria-expanded','false');}
  if(!target||target.disabled)return;
  if(target.dataset.action){act(target.dataset.action);return;}
  if(target.dataset.clip){selectClip(target.dataset.clip);return;}
  if(target.dataset.subtitle){selectClip(target.dataset.subtitle);openClipSettings();return;}
  if(target.dataset.episode){pause();episode=target.dataset.episode;selectedId=cuts[episode].clips[0]?.id||null;playhead=0;previewCandidate=false;undoStack=[];redoStack=[];$('#episode-menu').hidden=true;$('#episode-trigger').setAttribute('aria-expanded','false');$('#episode-trigger').focus();render();return;}
  if(target.dataset.prompt){$('#agent-input').value=target.dataset.prompt;$('#agent-input').focus();return;}
  if(target.dataset.filter){assetFilter=target.dataset.filter;document.querySelectorAll('[data-filter]').forEach(button=>button.classList.toggle('active',button===target));renderAssets();return;}
  if(target.dataset.asset){assetSelection.has(target.dataset.asset)?assetSelection.delete(target.dataset.asset):assetSelection.add(target.dataset.asset);renderAssets();return;}
  if(target.dataset.library){openAssets();assetSelection.add(target.dataset.library);renderAssets();return;}
  if(target.dataset.ratio){exportOptions.ratio=target.dataset.ratio;document.querySelectorAll('[data-ratio]').forEach(button=>button.setAttribute('aria-pressed',String(button===target)));$('#ratio-note').textContent=exportOptions.ratio==='16:9'?'沿用当前横版构图':'正式导出前需检查裁切构图；本次仅演示设置';return;}
  if(target.dataset.resolution){exportOptions.resolution=target.dataset.resolution;document.querySelectorAll('[data-resolution]').forEach(button=>button.setAttribute('aria-pressed',String(button===target)));}
});
document.addEventListener('dblclick',event=>{const clip=event.target.closest('[data-clip]');if(clip){selectedId=clip.dataset.clip;openClipSettings();}});
document.addEventListener('input',event=>{
  if(event.target.id==='scrubber'){pause();playhead=Number(event.target.value);paintPlayer();}
  else if(event.target.id==='clip-volume')$('#clip-volume-value').textContent=`${event.target.value}%`;
  else if(event.target.id==='audio-volume')$('#audio-value').textContent=`${event.target.value}%`;
  else if(event.target.id==='asset-search'){assetSearch=event.target.value;renderAssets();}
});
$('#agent-form').addEventListener('submit',event=>{event.preventDefault();const prompt=$('#agent-input').value.trim();if(!prompt)return;$('#agent-input').value='';proposeFromPrompt(prompt);});
$('#agent-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('#agent-form').requestSubmit();}});
$('#ruler').addEventListener('pointerdown',event=>{pause();const rect=$('#ruler').getBoundingClientRect();playhead=clamp((event.clientX-rect.left)/timelineWidth*Math.max(duration(),12),0,duration());paintPlayer();});
$('#video-track').addEventListener('dragstart',event=>{const clip=event.target.closest('[data-clip]');if(!clip||previewCandidate){event.preventDefault();return;}dragId=clip.dataset.clip;event.dataTransfer.setData('text/plain',dragId);event.dataTransfer.effectAllowed='move';});
$('#video-track').addEventListener('dragover',event=>{if(!dragId)return;event.preventDefault();document.querySelectorAll('.drop-target').forEach(node=>node.classList.remove('drop-target'));event.target.closest('[data-clip]')?.classList.add('drop-target');});
$('#video-track').addEventListener('drop',event=>{event.preventDefault();const target=event.target.closest('[data-clip]');if(target&&dragId)moveClip(dragId,cuts[episode].clips.findIndex(clip=>clip.id===target.dataset.clip));dragId=null;document.querySelectorAll('.drop-target').forEach(node=>node.classList.remove('drop-target'));});
$('#video-track').addEventListener('dragend',()=>{dragId=null;document.querySelectorAll('.drop-target').forEach(node=>node.classList.remove('drop-target'));});
$('#modal').addEventListener('cancel',event=>{event.preventDefault();closeModal();});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){$('#episode-menu').hidden=true;$('#episode-trigger').setAttribute('aria-expanded','false');$('#agent-pane').classList.remove('open');}
  if(event.target.closest('input,textarea')||$('#modal').open)return;
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();historyStep(event.shiftKey);}
  if(event.code==='Space'&&!event.target.closest('button,a')){event.preventDefault();togglePlay();}
});
$('#episode-menu').addEventListener('keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const items=[...$('#episode-menu').querySelectorAll('button')];items[(items.indexOf(document.activeElement)+1)%items.length].focus();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
window.addEventListener('pagehide',()=>{pause();clearInterval(exportTimer);});
// 尺寸观察只调整轨道几何，避免展开时丢失当前片段或播放位置。
const resizeObserver=new ResizeObserver(()=>{renderTimeline();paintPlayer();});
resizeObserver.observe($('#timeline-scroll'));
hydrateIcons();render();
