/* 本文件只驱动新增右侧模块的离线交互规划；不调用真实生成服务。 */
'use strict';

/** 固定图标路径，避免原型引入额外图标依赖。 */
const ICONS={play:'m8 5 11 7-11 7V5',pause:'M8 5v14M16 5v14',replay:'M3 11a9 9 0 1 1 2 7M3 4v7h7',previous:'M5 5v14M19 5 8 12l11 7V5',next:'M19 5v14M5 5l11 7-11 7V5',sidebar:'M3 3h18v18H3zM9 3v18',sidebarClose:'M3 3h18v18H3zM9 3v18m7-11-3 3 3 3',search:'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0m-1.5 4.5L21 21',info:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v5M12 7h.01',sun:'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',chat:'M4 5h16v11H8l-4 4V5M8 9h8M8 13h5',graph:'M3 3h6v6H3zM15 15h6v6h-6zM15 3h6v6h-6zM9 6h6M6 9v9h9',panels:'M3 3h18v18H3zM9 3v18M9 9h12',film:'M4 3h16v18H4zM8 3v18M16 3v18M4 8h4m8 0h4M4 16h4m8 0h4',expand:'M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6',close:'m6 6 12 12M18 6 6 18',sparkles:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3M20 2v4m-2-2h4',arrow:'M4 12h16m-6-6 6 6-6 6',link:'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1',check:'m5 12 4 4L19 6',clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 6v6l4 2',chevron:'m7 10 5 5 5-5',edit:'M4 20h4L19 9l-4-4L4 16v4M13 6l4 4',compare:'M4 5h16M4 12h16M4 19h16M8 3v4M16 10v4M10 17v4',plus:'M12 5v14M5 12h14',doc:'M5 3h10l4 4v14H5zM15 3v5h4M8 12h8M8 16h6',layers:'m12 3 10 5-10 5L2 8l10-5M2 12l10 5 10-5M2 16l10 5 10-5',timeline:'M3 5h18v4H3zM3 12h7v3H3zM13 12h8v3h-8zM3 18h18v3H3z',export:'M12 16V3m-5 5 5-5 5 5M4 14v7h16v-7',lock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4',unlock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 7.5-2'};
/** 返回固定名称对应的 SVG。 */
function icon(name){return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]||ICONS.info}"/></svg>`;}
/** 转义数据和用户输入，防止规划稿文本成为 HTML。 */
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
/** 原型内状态；工作区标签和 Agent 任务都是临时演示状态。 */
let state={projectId:'promo',shotId:'p1',workspaceTab:'visual',productionStep:'project',reference:null,candidate:null,task:null,theme:'light',focus:false,workspaceOpen:true,projectMenu:false,projectSearch:'',editing:false};
const projects=structuredClone(window.STUDIO_DATA.projects);
/** 只持久化 HTML 规划稿的创作设定，与正式产品和其他原型的数据隔离。 */
const SETTINGS_STORAGE_KEY='dutydeck.visual-production.creative-settings.v1';
/** 可编辑字段白名单，同时用于草稿比较与本地保存校验。 */
const SETTINGS_FIELDS=['title','brief','ratio','fps','voice','music'];
/** 规划稿支持的常用画面比例。 */
const SETTINGS_RATIOS=['16:9','9:16','1:1','4:3','3:4','4:5','21:9'];
/** 规划稿支持的常用视频帧率。 */
const SETTINGS_FRAME_RATES=[24,25,30,50,60];
/** 各项目尚未保存的输入，切换标签或项目时保留且互不覆盖。 */
const settingsDrafts=new Map();
/** 各项目最近一次保存反馈，仅在当前页面有效。 */
const settingsFeedback=new Map();
/** 各影像项目独立记录当前资产类型筛选；空字符串表示全部资产。 */
const assetTypeFilters=new Map();
/** 按项目保存资产浏览位置、搜索词和当前详情，不与镜头选择混用。 */
const assetViews=new Map();
/** 各项目独立保留分镜集数、筛选、详情和列表滚动位置。 */
const shotViews=new Map();
/** 镜头编辑草稿按项目与镜头隔离，重绘或临时切页不会丢失输入。 */
const shotDrafts=new Map();
/** 原型资产条目与锁定状态单独持久化，不写入真实项目目录。 */
const ASSET_STORAGE_KEY='dutydeck.visual-production.assets.v1';
/** 最近成功保存的资产库，只包含当前示例项目。 */
let savedAssetLibraries={};
/** 资产设定的标准类型；现有自定义类型仍可在列表中显示。 */
const ASSET_TYPES=['角色','场景','产品','道具','风格','品牌','声音'];
/** 已成功写入浏览器的设定集合，避免保存一个项目覆盖其他项目。 */
let savedSettings={};
const messages=document.getElementById('messages');
let toastTimer=0;
/** 递增请求编号，隔离同一镜头上的迟到任务结果。 */
let taskSequence=0;
/** 返回当前作品，数据始终来自同一份静态作品合同。 */
function project(){return projects.find(item=>item.id===state.projectId)||projects[0];}
/** 返回当前选中的镜头或图片。 */
function shot(){const current=project();return current.shots.find(item=>item.id===state.shotId)||current.shots[0];}
/** 计算当前作品状态摘要。 */
function readyCount(){return project().shots.filter(item=>item.status==='adopted'&&!item.needsUpdate).length;}
/** 为旧示例数据补出项目下的集数层级，确保镜头不会脱离集数存在。 */
function episodesFor(current){if(!Array.isArray(current.episodes)){current.episodes=[{id:`${current.id}-episode-1`,title:current.kind==='图片'?'主画布':'第 1 集',subtitle:`${current.shots.length} 个镜头 · 初始规划`,shotIds:current.shots.map(item=>item.id),status:'制作中'}];}return current.episodes;}
/** 返回当前作品正在查看的集数。 */
function currentEpisode(){return episodesFor(project()).find(item=>item.id===shotView().episodeId)||episodesFor(project())[0];}
/** 返回 current 的分镜浏览状态；初次进入只显示概览，不自动展开镜头。 */
function shotView(current=project()){
  if(!shotViews.has(current.id))shotViews.set(current.id,{episodeId:episodesFor(current)[0].id,detailId:null,query:'',status:'',scrollTop:0});
  return shotViews.get(current.id);
}
/** 返回当前集的镜头，按集内顺序排列，避免混入其他集。 */
function episodeShots(){return currentEpisode().shotIds.map(id=>project().shots.find(item=>item.id===id)).filter(Boolean);}
/** 根据当前资产建立主 Agent 引用。 */
function referenceAsset(asset){state.reference={type:'asset',projectId:project().id,assetId:asset.id,version:asset.version,title:asset.name,projectTitle:project().title};state.assetRequest=null;state.focus=false;if(window.matchMedia('(max-width:760px)').matches)state.workspaceOpen=false;toast(`已引用资产「${asset.name}」`);render();document.getElementById('prompt').focus();}
/** 资产对话仅展示已引用对象与收到的要求，不借用镜头生成结果。 */
function renderAssetMessages(){
  /** 引用快照和本次资产请求共用项目、资产、版本三项身份。 */
  const reference=state.reference;
  const request=state.assetRequest;
  const matching=request&&request.projectId===reference.projectId&&request.assetId===reference.assetId&&request.version===reference.version;
  messages.innerHTML=`<div class="date-divider">资产协作</div><article class="message"><div class="message-label"><span class="agent-icon">${icon('sparkles')}</span>主 Agent</div><p class="agent-copy">当前引用「${esc(reference.title)}」v${reference.version}，属于「${esc(reference.projectTitle)}」。可以继续描述这项资产需要调整的设定或参考图。</p></article>${matching?`<article class="message"><div class="message-label"><span class="avatar">徐</span>你</div><div class="user-bubble">${esc(request.prompt)}</div></article><article class="message"><div class="message-label"><span class="agent-icon">${icon('sparkles')}</span>主 Agent</div><p class="agent-copy">资产修改要求已记录（演示），尚未生成新的资产候选。</p></article>`:''}${state.task?.projectId===state.projectId?renderTask(state.task):''}`;
  messages.scrollTop=messages.scrollHeight;
}
/** 将 prompt 绑定当前资产引用；本规划稿只演示交接，不触发镜头候选。 */
function submitAssetRequest(prompt){
  /** 重新核对引用归属和版本，防止旧引用落到其他项目。 */
  const reference=state.reference;
  const asset=project().assets.find(item=>item.id===reference.assetId);
  if(reference.projectId!==state.projectId||!asset||asset.version!==reference.version){toast('资产引用已变化，请重新引用');return false;}
  state.assetRequest={projectId:state.projectId,assetId:asset.id,version:asset.version,prompt};
  renderMessages();
  return true;
}
/** 将固定图标占位符替换为 SVG。 */
function hydrate(){document.querySelectorAll('[data-icon]').forEach(node=>{node.innerHTML=icon(node.dataset.icon);});}
/** 显示本地演示反馈。 */
function toast(message){const node=document.getElementById('toast');node.textContent=message;node.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.hidden=true,2800);}
/** 输出主 Agent 的固定起始对话与当前任务状态。 */
function renderMessages(){
  if(state.reference?.type==='asset'){renderAssetMessages();return;}
  /** 会话以显式引用对象为准，浏览另一个镜头不会改变请求目标。 */
  const current=project();
  const selected=state.reference?.type==='shot'?current.shots.find(item=>item.id===state.reference.shotId):shot();
  const task=state.task;
  messages.innerHTML=`<div class="date-divider">影像协作</div><article class="message"><div class="message-label"><span class="agent-icon">${icon('sparkles')}</span>主 Agent</div><p class="agent-copy">${state.reference&&selected?`当前引用「${esc(selected.title)}」，属于「${esc(current.title)}」。告诉我需要调整的画面、运镜或台词。`:'先在右侧选择镜头并引用给我，我会把要求绑定到对应镜头，候选返回后由你确认。'}</p>${task&&task.projectId===current.id?renderTask(task):''}</article>`;
  messages.scrollTop=messages.scrollHeight;
}
/** 渲染一条正在执行或已返回模块的模拟任务。 */
function renderTask(task){return `<div class="task-card ${task.running?'running':''}"><div>${task.running?'<i class="task-spinner"></i>':icon('check')}<strong>${task.running?'正在协作影像创作':'候选已回到影像创作'}</strong>${task.running?'<button class="task-cancel" data-action="cancel-task">取消</button>':''}</div><small>${esc(task.prompt)}</small>${task.running?'':`<div class="task-result"><button data-action="open-shot-result" data-id="${esc(task.shotId)}">查看候选 · ${esc(project().shots.find(item=>item.id===task.shotId)?.title||'当前镜头')}</button></div>`}</div>`;}
/** 右侧工作区渲染入口，根据标签保持三个模块互相独立。 */
function renderWorkspace(){const node=document.getElementById('workspace-content');if(state.workspaceTab==='visual')node.innerHTML=renderVisual();else if(state.workspaceTab==='canvas')node.innerHTML=renderIndependent('原画布','原有画布能力保持独立。影像创作模块不会替换这里的工作流。','graph','打开原画布');else node.innerHTML=renderIndependent('交互设计','页面、流程和交互稿由交互设计模块承接，影像镜头不会混入这里。','panels','打开交互设计');hydrate();}
/** 渲染独立标签的占位内容，明确模块边界。 */
function renderIndependent(title,description,symbol,action){return `<section class="empty-module"><div><span class="empty-icon">${icon(symbol)}</span><strong>${title}</strong><p>${description}</p><button class="button" data-action="switch-module">${icon(symbol)}${action}</button></div></section>`;}
/** 渲染新增的影像创作模块，沿用原影像模块的项目头部和阶段页签。 */
function renderVisual(){
  /** 当前影像项目决定标题与各制作阶段的内容。 */
  const current=project();
  return `<section class="module visual-module">
    <header class="visual-project-header">
      <button class="icon-button project-directory-trigger" data-action="toggle-project-menu" title="影像项目列表" aria-label="打开影像项目列表" aria-expanded="${state.projectMenu}" aria-controls="visual-project-directory">${icon('sidebar')}</button>
      <div class="visual-project-heading"><div class="visual-eyebrow">${esc(current.kind)} · 当前 Agent 项目：创作会话 · 演示已保存</div><div class="visual-title-row"><h1>${esc(current.title)}</h1></div></div>
      <div class="visual-project-actions"><button class="icon-button" data-action="module-focus" title="专注此模块" aria-label="专注此模块">${icon('expand')}</button></div>
    </header>
    <nav class="visual-project-tabs" aria-label="影像项目阶段">${[['project','创作设定','doc'],['assets','资产','layers'],['shots',current.kind==='图片'?'图片创作':'分镜','film'],['canvas','画布','graph'],['edit','剪辑','timeline'],['delivery','交付','export']].map(([id,label,symbol])=>`<button class="visual-project-tab ${state.productionStep===id?'active':''}" data-production-step="${id}">${icon(symbol)}${label}</button>`).join('')}</nav>
    <div class="module-body visual-module-body">${renderProductionStep()}</div>
    ${state.projectMenu?renderProjectMenu():''}
  </section>`;
}
/** 按原影像模块页签渲染当前阶段，项目设定同时承载集数。 */
function renderProductionStep(){if(state.productionStep==='assets')return renderAssetsStep();if(state.productionStep==='shots')return renderShotsStep();if(state.productionStep==='canvas')return renderPhasePlaceholder('画布预览','原画布保持独立；影像项目只在这里引用结果。','graph');if(state.productionStep==='edit')return renderPhasePlaceholder('剪辑','镜头确认后在这里组织时间线、配乐和字幕。','timeline');if(state.productionStep==='delivery')return renderPhasePlaceholder('交付','所有镜头采用后，才能进入渲染和制作清单导出。','export');return renderProjectStep();}
/** 渲染尚未展开的阶段页，保留原模块信息架构和清晰边界。 */
function renderPhasePlaceholder(title,description,symbol){return `<section class="phase-placeholder"><span>${icon(symbol)}</span><h2>${title}</h2><p>${description}</p><button class="button" data-action="phase-note">查看规划范围</button></section>`;}
/** 项目设定页沿用原模块的封面、目标卡和集数入口。 */
function renderProjectStep(){const current=project();const episodes=episodesFor(current);const cover=current.shots[0]?.image||'';return `<section class="project-settings"><article class="project-cover"><img src="${esc(cover)}" alt=""><div class="project-cover-body"><span>${esc(current.kind)} · 创作起点</span><h2>${esc(current.title)}</h2><p>${esc(current.subtitle||'从品牌事实到可记忆的画面')}</p><div class="project-tags"><b>${esc(current.ratio)}</b>${current.kind==='图片'?`<b>${current.shots.length} 张图片</b>`:`<b>${current.shots.reduce((sum,item)=>sum+item.duration,0)} 秒</b><b>${current.fps} fps</b>`}</div></div></article>${renderSettingsSummary(current)}<section class="episode-settings"><div class="section-heading"><div><strong>项目集数</strong><small>项目先拆成集数，镜头归属于具体集数。</small></div><button class="button" data-action="add-episode">${icon('plus')}新增集数</button></div><div class="episode-list">${episodes.map((episode,index)=>`<button class="episode-row ${episode.id===currentEpisode().id?'active':''}" data-action="select-episode" data-id="${esc(episode.id)}"><span class="episode-number">${String(index+1).padStart(2,'0')}</span><span><strong>${esc(episode.title)}</strong><small>${esc(episode.subtitle)} · ${esc(episode.status)}</small></span><span class="row-state ready">${episode.shotIds.length} 镜头</span>${icon('chevron')}</button>`).join('')}</div></section></section>`;}
/** 从 current 提取可保存的字段；返回独立对象，不包含镜头或资产。 */
function projectSettings(current){return {title:current.title,brief:current.brief,ratio:current.ratio,fps:current.fps,voice:current.voice||'',music:current.music||''};}
/** 获取 current 的编辑草稿；首次进入时以已保存值初始化。 */
function settingsDraft(current){if(!settingsDrafts.has(current.id))settingsDrafts.set(current.id,projectSettings(current));return settingsDrafts.get(current.id);}
/** 比较 current 的草稿与已保存值，返回是否有未保存修改。 */
function settingsDirty(current){return SETTINGS_FIELDS.some(field=>settingsDraft(current)[field]!==projectSettings(current)[field]);}
/** 返回 current 的表单；图片项目只显示与静态画面相关的设置。 */
function renderSettingsForm(current){
  /** 当前项目的独立草稿，关闭或切换项目后仍可继续填写。 */
  const draft=settingsDraft(current);
  return `<form id="creative-settings-form" class="creative-settings-form" data-project-id="${esc(current.id)}">
    <label class="creative-field"><span>作品名称</span><input name="title" value="${esc(draft.title)}" required maxlength="80" placeholder="为这个作品命名"></label>
    <label class="creative-field"><span>受众、卖点与品牌约束</span><textarea name="brief" rows="4" required maxlength="3000" placeholder="描述作品目标、面向人群和需要遵守的要求">${esc(draft.brief)}</textarea></label>
    <div class="creative-format-fields">
      <label class="creative-field"><span>画面比例</span><select name="ratio">${SETTINGS_RATIOS.map(ratio=>`<option value="${ratio}" ${draft.ratio===ratio?'selected':''}>${ratio}</option>`).join('')}</select></label>
      ${current.kind==='图片'?'':`<label class="creative-field"><span>帧率</span><select name="fps">${SETTINGS_FRAME_RATES.map(fps=>`<option value="${fps}" ${draft.fps===fps?'selected':''}>${fps} fps</option>`).join('')}</select></label>`}
    </div>
    ${current.kind==='图片'?'':`<div class="creative-sound-fields"><label class="creative-field"><span>配音风格</span><input name="voice" value="${esc(draft.voice)}" maxlength="120" placeholder="例如：温暖、克制的女声"></label><label class="creative-field"><span>音乐方向</span><input name="music" value="${esc(draft.music)}" maxlength="120" placeholder="例如：轻盈钢琴与柔和环境音"></label></div>`}
  </form>`;
}
/** 检查 settings 是否为可恢复的设定；拒绝损坏或超出表单范围的本地数据。 */
function validProjectSettings(settings){return !!settings&&typeof settings==='object'&&!Array.isArray(settings)&&typeof settings.title==='string'&&!!settings.title.trim()&&settings.title.length<=80&&typeof settings.brief==='string'&&!!settings.brief.trim()&&settings.brief.length<=3000&&SETTINGS_RATIOS.includes(settings.ratio)&&SETTINGS_FRAME_RATES.includes(settings.fps)&&typeof settings.voice==='string'&&settings.voice.length<=120&&typeof settings.music==='string'&&settings.music.length<=120;}
/** 恢复当前浏览器已保存的设定，只覆盖已知项目的白名单字段。 */
function restoreProjectSettings(){
  try{
    /** 本地保存记录可能为空或损坏，校验后再应用到演示项目。 */
    const stored=JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)||'{}');
    if(!stored||typeof stored!=='object'||Array.isArray(stored))return;
    projects.forEach(current=>{if(validProjectSettings(stored[current.id])){savedSettings[current.id]=projectSettings(stored[current.id]);Object.assign(current,savedSettings[current.id]);settingsFeedback.set(current.id,'已保存到此浏览器');}});
  }catch{toast('无法读取本地创作设定，已载入演示初始值');}
}
/** 保存 form 所绑定项目的草稿；成功写入后同步展示并使旧制作候选失效。 */
function saveProjectSettings(form){
  /** 表单必须仍属于当前项目，避免切换后误写其他作品。 */
  const current=project();
  if(form.dataset.projectId!==current.id)return;
  /** 文本保存时去掉首尾空白，保持项目标题和列表显示一致。 */
  const next={...settingsDraft(current)};
  ['title','brief','voice','music'].forEach(field=>{next[field]=next[field].trim();});
  form.elements.namedItem('title').setCustomValidity(next.title?'':'请填写作品名称');
  form.elements.namedItem('brief').setCustomValidity(next.brief?'':'请填写创作要求');
  if(!form.reportValidity()||!validProjectSettings(next))return;
  /** 在写入成功前不修改当前项目或清除草稿，保留失败重试机会。 */
  const updated={...savedSettings,[current.id]:next};
  try{localStorage.setItem(SETTINGS_STORAGE_KEY,JSON.stringify(updated));}catch{
    document.getElementById('creative-settings-feedback').textContent='保存失败，草稿仍保留，请重试';
    return;
  }
  /** 只有制作参数变化才清除旧候选；单纯改名不影响已有候选。 */
  const productionChanged=['brief','ratio','fps','voice','music'].some(field=>next[field]!==current[field]);
  if(productionChanged){state.candidate=null;state.task=null;}
  Object.assign(current,next);
  savedSettings=updated;
  settingsDrafts.set(current.id,{...next});
  settingsFeedback.set(current.id,productionChanged?'已保存到此浏览器，后续制作使用新设定':'已保存到此浏览器');
  if(state.reference)state.reference.projectTitle=current.title;
  /** 保存后恢复正文位置与按钮焦点，避免用户被带回项目页顶部。 */
  const scrollTop=document.querySelector('.visual-module-body').scrollTop;
  render();
  document.querySelector('.visual-module-body').scrollTop=scrollTop;
  /** 弹窗不随主页面重建，手动同步去掉首尾空格后的值及保存反馈。 */
  SETTINGS_FIELDS.forEach(field=>{if(form.elements.namedItem(field))form.elements.namedItem(field).value=next[field];});
  syncProjectSettingsFeedback();
  document.getElementById('creative-settings-save').focus({preventScroll:true});
}
/** 放弃当前项目未保存的修改，只重绘表单并保留正文位置。 */
function resetProjectSettings(){
  settingsDrafts.delete(state.projectId);
  document.getElementById('creative-settings-form').outerHTML=renderSettingsForm(project());
  syncProjectSettingsFeedback();
  document.querySelector('#creative-settings-form [name="title"]').focus({preventScroll:true});
}
/** 返回 asset 的显示类型，未标注类型的资产归为“未分类”。 */
function assetType(asset){return asset.type?.trim()||'未分类';}
/** 返回 current 的浏览状态，项目之间的搜索、详情和滚动互不影响。 */
function assetView(current=project()){
  if(!assetViews.has(current.id))assetViews.set(current.id,{query:'',selectedId:null,scrollTop:0,returnShotId:null});
  return assetViews.get(current.id);
}
/** 从 current 的真实资产与镜头关联计算筛选结果和使用数量。 */
function assetCatalog(current){
  /** 各类资产数量和引用次数均来自当前项目，避免把镜头总数当作引用数。 */
  const counts=new Map();
  const uses=new Map();
  current.assets.forEach(asset=>counts.set(assetType(asset),(counts.get(assetType(asset))||0)+1));
  current.shots.forEach(item=>new Set(item.assetIds||[]).forEach(id=>uses.set(id,(uses.get(id)||0)+1)));
  /** 已消失的类型自动回到全部；搜索与类型组合过滤。 */
  const requested=assetTypeFilters.get(current.id)||'';
  const type=counts.has(requested)?requested:'';
  const query=assetView(current).query.trim().toLocaleLowerCase();
  assetTypeFilters.set(current.id,type);
  return {counts,uses,type,visible:current.assets.filter(asset=>(!type||assetType(asset)===type)&&(!query||`${asset.name} ${assetType(asset)} ${asset.description}`.toLocaleLowerCase().includes(query)))};
}
/** 资产页只保留查找和浏览；进入详情后才显示具体操作。 */
function renderAssetsStep(){
  /** 当前项目与独立的资产详情目标，缺失目标安全回退列表。 */
  const current=project();
  const view=assetView(current);
  const selected=current.assets.find(asset=>asset.id===view.selectedId);
  if(selected)return renderAssetDetail(current,selected);
  view.selectedId=null;
  /** 搜索、类型和结果共享同一份统计结果。 */
  const catalog=assetCatalog(current);
  return `<section class="asset-library" aria-label="项目资产库">
    <header class="asset-library-heading"><h2>项目资产</h2><button class="button" data-action="add-asset">${icon('plus')}新增资产</button></header>
    <label class="asset-search">${icon('search')}<input id="asset-search" type="search" value="${esc(view.query)}" placeholder="搜索资产名称或设定" aria-label="搜索资产" autocomplete="off"></label>
    <div class="asset-type-filters" role="group" aria-label="资产类型筛选">${[['',current.assets.length],...catalog.counts].map(([type,count])=>`<button type="button" class="asset-type-filter" data-action="filter-assets" data-asset-type="${esc(type)}" aria-pressed="${type===catalog.type}">${esc(type||'全部')}<span>${count}</span></button>`).join('')}</div>
    <div class="asset-results">${renderAssetResults(current,catalog)}</div>
  </section>`;
}
/** 返回资产结果区域；无资产与无匹配分别提供明确反馈。 */
function renderAssetResults(current,catalog){
  return `<span class="asset-sr-status" role="status">显示 ${catalog.visible.length} / ${current.assets.length} 项资产</span>${catalog.visible.length?`<div class="asset-grid">${catalog.visible.map(asset=>renderAssetCard(asset,catalog.uses.get(asset.id)||0)).join('')}</div>`:`<div class="asset-list-empty">${icon('layers')}<strong>${current.assets.length?'没有找到匹配资产':'还没有项目资产'}</strong><p>${current.assets.length?'试试其他名称或类型':'先建立角色、场景或产品设定，再用于镜头制作。'}</p>${current.assets.length?'<button class="button" data-action="clear-asset-filters">清除筛选</button>':'<button class="button" data-action="add-asset">新增资产</button>'}</div>`}`;
}
/** 卡片仅显示识别信息；asset 为资产对象，useCount 为真实使用镜头数。 */
function renderAssetCard(asset,useCount){
  return `<button type="button" class="asset-card" data-action="open-asset" data-id="${esc(asset.id)}" aria-label="查看资产：${esc(asset.name)}" title="${esc(asset.name)}">
    <span class="asset-card-preview">${asset.image?`<img src="${esc(asset.image)}" alt="">`:`<span class="asset-preview-empty">${icon(assetType(asset)==='声音'?'doc':'layers')}<small>待补充参考图</small></span>`}</span>
    <span class="asset-card-info"><strong>${esc(asset.name)}</strong><span class="asset-card-meta"><span>${esc(assetType(asset))} · ${useCount?`${useCount} 个镜头`:'未使用'}</span><span class="asset-lock-mark" title="${asset.locked?'已锁定':'未锁定'}" aria-label="${asset.locked?'已锁定':'未锁定'}">${icon(asset.locked?'lock':'unlock')}</span></span></span>
  </button>`;
}
/** 返回资产详情；预览和设定优先，使用位置按需展开，操作集中在底部。 */
function renderAssetDetail(current,asset){
  /** 只列出显式引用该资产的镜头，不推测未声明的关系。 */
  const usedShots=current.shots.filter(item=>(item.assetIds||[]).includes(asset.id));
  return `<section class="asset-detail-view" aria-label="资产详情">
    <button class="asset-back" data-action="back-to-assets">${icon('arrow')}返回资产库</button>
    <div class="asset-detail-preview">${asset.image?`<img src="${esc(asset.image)}" alt="${esc(asset.name)}">`:`<div class="asset-preview-empty">${icon('layers')}<span>待补充参考图</span></div>`}</div>
    <div class="asset-detail-heading"><span>${esc(assetType(asset))} · v${asset.version}</span><h2>${esc(asset.name)}</h2></div>
    <section class="asset-description"><h3>资产设定</h3><p>${esc(asset.description||'暂未填写设定')}</p></section>
    <details class="asset-usage"><summary><span>使用位置 <small>${usedShots.length}</small></span>${icon('chevron')}</summary><div>${usedShots.length?usedShots.map(item=>`<button data-action="asset-shot" data-id="${esc(item.id)}"><span>${icon('film')}<strong>${esc(item.title)}</strong></span><small>${esc(episodesFor(current).find(episode=>episode.shotIds.includes(item.id))?.title||'未分集')} · 镜头 ${String((episodesFor(current).find(episode=>episode.shotIds.includes(item.id))?.shotIds.indexOf(item.id)??-1)+1).padStart(2,'0')}</small>${icon('arrow')}</button>`).join(''):'<p>尚未用于镜头</p>'}</div></details>
    <div class="asset-lock-setting"><div><strong>锁定设定</strong><small>后续镜头沿用当前设定与版本</small></div><button class="asset-lock-toggle" role="switch" aria-label="锁定资产设定" aria-checked="${asset.locked}" data-action="toggle-asset-lock" data-id="${esc(asset.id)}"><span></span></button></div>
    <div class="asset-detail-actions"><button class="button primary" data-action="asset-reference" data-id="${esc(asset.id)}">${icon('link')}引用给 Agent</button></div>
  </section>`;
}
/** 仅更新资产页，避免搜索或详情操作重绘旁边 Agent 会话。 */
function renderAssetWorkspace(){document.querySelector('.visual-module-body').innerHTML=renderAssetsStep();}
/** 选择 type 后更新列表，并保留筛选按钮的键盘焦点。 */
function filterAssets(type){assetTypeFilters.set(state.projectId,type);renderAssetWorkspace();document.querySelector('.asset-type-filter[aria-pressed="true"]')?.focus({preventScroll:true});}
/** 打开 id 对应详情，同时记录列表滚动；返回时使用同一资产恢复焦点。 */
function openAsset(id){
  if(!project().assets.some(asset=>asset.id===id))return;
  assetView().scrollTop=document.querySelector('.visual-module-body').scrollTop;
  assetView().returnShotId=null;
  assetView().selectedId=id;
  renderAssetWorkspace();
  document.querySelector('.visual-module-body').scrollTop=0;
  document.querySelector('.asset-back').focus({preventScroll:true});
}
/** 返回资产列表，恢复筛选、滚动与原卡片焦点。 */
function backToAssets(){
  /** 关闭前保存当前资产身份，用稳定 ID 寻找恢复焦点的卡片。 */
  const id=assetView().selectedId;
  assetView().returnShotId=null;
  assetView().selectedId=null;
  renderAssetWorkspace();
  document.querySelector('.visual-module-body').scrollTop=assetView().scrollTop;
  Array.from(document.querySelectorAll('[data-action="open-asset"]')).find(node=>node.dataset.id===id)?.focus({preventScroll:true});
}
/** 清空当前项目的搜索和类型，回到完整资产列表。 */
function clearAssetFilters(){assetView().query='';assetTypeFilters.set(state.projectId,'');renderAssetWorkspace();document.getElementById('asset-search').focus();}
/** 打开资产所引用的镜头，并提供返回资产的来源路径。 */
function openAssetShot(id){
  if(!project().shots.some(item=>item.id===id))return;
  assetView().returnShotId=id;
  openShot(id,true);
  document.querySelector('.asset-shot-return')?.focus({preventScroll:true});
}
/** 写入 nextAssets 成功后再更新 current，失败时保留原资产和操作现场。 */
function persistAssets(current,nextAssets){
  try{
    /** 仅持久化当前原型内的资产设定，不涉及原始素材文件。 */
    const next={...savedAssetLibraries,[current.id]:nextAssets};
    localStorage.setItem(ASSET_STORAGE_KEY,JSON.stringify(next));
    savedAssetLibraries=next;current.assets=nextAssets;
    return true;
  }catch{toast('资产保存失败，请重试');return false;}
}
/** 恢复资产记录；只接受已知项目、已知本地图片路径和完整资产字段。 */
function restoreAssets(){
  try{
    /** 避免恢复记录指向外部图片地址或改变其他示例项目。 */
    const stored=JSON.parse(localStorage.getItem(ASSET_STORAGE_KEY)||'{}');
    if(!stored||typeof stored!=='object'||Array.isArray(stored))return;
    projects.forEach(current=>{
      /** 每个项目单独校验，单个损坏记录不影响其他项目。 */
      const assets=stored[current.id];
      if(!Array.isArray(assets)||new Set(assets.map(asset=>asset?.id)).size!==assets.length)return;
      if(!assets.every(asset=>asset&&typeof asset.id==='string'&&asset.id.length>0&&typeof asset.name==='string'&&!!asset.name.trim()&&asset.name.length<=80&&typeof asset.type==='string'&&asset.type.length<=40&&typeof asset.description==='string'&&asset.description.length<=2000&&Number.isInteger(asset.version)&&asset.version>0&&typeof asset.locked==='boolean'&&typeof asset.image==='string'&&(!asset.image||/^assets\/[a-z0-9-]+\.svg$/.test(asset.image))))return;
      savedAssetLibraries[current.id]=assets.map(({id,name,type,description,version,locked,image})=>({id,name,type,description,version,locked,image}));
      current.assets=savedAssetLibraries[current.id];
    });
  }catch{toast('无法读取资产记录，已载入演示初始资产');}
}
/** 切换资产锁定状态；只有保存成功才更新详情中的状态。 */
function toggleAssetLock(id){
  /** 创建新对象后写入，避免保存失败却显示已经锁定。 */
  const current=project();
  const asset=current.assets.find(item=>item.id===id);
  if(!asset)return;
  if(persistAssets(current,current.assets.map(item=>item.id===id?{...item,locked:!item.locked}:item))){renderAssetWorkspace();document.querySelector('.asset-lock-toggle')?.focus({preventScroll:true});}
}
/** 打开新增资产表单，冻结提交归属并恢复为初始输入。 */
function openAssetCreate(){
  /** 对话框独立于页面重绘，后台任务返回不会清空用户输入。 */
  const form=document.getElementById('asset-create-form');
  form.reset();form.dataset.projectId=state.projectId;
  form.elements.namedItem('type').innerHTML=ASSET_TYPES.map(type=>`<option>${type}</option>`).join('');
  form.elements.namedItem('name').setCustomValidity('');
  form.elements.namedItem('description').setCustomValidity('');
  form.elements.namedItem('type').value=ASSET_TYPES.includes(assetTypeFilters.get(state.projectId))?assetTypeFilters.get(state.projectId):'角色';
  document.getElementById('asset-create-error').textContent='';
  document.getElementById('asset-create-dialog').showModal();
}
/** 创建资产设定条目；未提供参考图时展示明确空状态。 */
function createAsset(form){
  /** 当前项目必须仍与打开表单时一致。 */
  const current=project();
  if(form.dataset.projectId!==current.id){document.getElementById('asset-create-error').textContent='项目已切换，请重新打开表单';return;}
  /** 名称和设定均去除首尾空白，类型使用固定枚举。 */
  const name=form.elements.namedItem('name').value.trim();
  const description=form.elements.namedItem('description').value.trim();
  const type=form.elements.namedItem('type').value;
  form.elements.namedItem('name').setCustomValidity(name?'':'请填写资产名称');
  form.elements.namedItem('description').setCustomValidity(description?'':'请填写资产设定');
  if(!form.reportValidity()||!ASSET_TYPES.includes(type))return;
  /** 新建条目不伪造图片、引用镜头或锁定状态。 */
  const asset={id:`asset-${crypto.randomUUID()}`,name,type,description,image:'',version:1,locked:false};
  if(!persistAssets(current,[...current.assets,asset])){document.getElementById('asset-create-error').textContent='保存失败，输入仍保留，请重试';return;}
  document.getElementById('asset-create-dialog').close();
  assetView().query='';assetTypeFilters.set(current.id,'');
  openAsset(asset.id);
}
/** 视频作品进入顺序播放器；图片作品保留概览与单图详情。 */
function renderShotsStep(){
  if(project().kind!=='图片')return renderStoryboard();
  /** 当前集及其镜头决定编号、统计和详情上下文。 */
  const current=project();
  const items=episodeShots();
  const selected=items.find(item=>item.id===shotView().detailId);
  const isImage=current.kind==='图片';
  if(selected)return renderDetail(selected,items.indexOf(selected)+1);
  shotView().detailId=null;
  return `<section class="shots-panel shot-library" aria-label="${isImage?'图片概览':'分镜概览'}">
    <header class="shot-library-heading"><label class="episode-picker"><span>${isImage?'图片分组':'当前集数'}</span><select id="shot-episode" aria-label="${isImage?'切换图片分组':'切换集数'}">${episodesFor(current).map(episode=>`<option value="${esc(episode.id)}" ${episode.id===currentEpisode().id?'selected':''}>${esc(episode.title)}</option>`).join('')}</select></label><button class="button" data-action="add-shot">${icon('plus')}新增${isImage?'图片':'镜头'}</button></header>
    <div class="shot-episode-summary">${items.length} ${isImage?'张图片':`个镜头 · ${Number(items.reduce((sum,item)=>sum+item.duration,0).toFixed(1))} 秒`}<span>${items.filter(item=>shotStatus(item)==='adopted').length} 已采用</span></div>
    <label class="asset-search">${icon('search')}<input id="shot-search" type="search" aria-label="搜索${isImage?'图片':'镜头'}" placeholder="搜索名称、画面或台词" value="${esc(shotView().query)}" autocomplete="off"></label>
    <div class="asset-type-filters shot-status-filters" role="group" aria-label="制作状态筛选">${[['','全部'],['pending','待制作'],['running','制作中'],['review','待确认'],['adopted','已采用']].map(([value,label])=>`<button class="asset-type-filter" data-action="filter-shots" data-status="${value}" aria-pressed="${shotView().status===value}">${label}<span>${value?items.filter(item=>shotStatus(item)===value).length:items.length}</span></button>`).join('')}</div>
    <div class="shot-results">${renderShotResults(items)}</div>
  </section>`;
}
/** 返回 item 的可筛选制作状态，任务和候选必须同时匹配项目与镜头。 */
function shotStatus(item){
  if(state.task?.running&&state.task.projectId===state.projectId&&state.task.shotId===item.id)return 'running';
  if(state.candidate?.projectId===state.projectId&&state.candidate.shotId===item.id)return 'review';
  if(item.needsUpdate||!item.image)return 'pending';
  return item.status==='adopted'?'adopted':'review';
}
/** 将镜头制作状态转换为轻量、准确的文字。 */
function shotStatusLabel(item){return {pending:item.needsUpdate?'待更新':'待制作',running:'制作中',review:'待确认',adopted:'已采用'}[shotStatus(item)];}
/** 组合搜索与状态；编号始终按集内顺序，不随过滤重新编号。 */
function renderShotResults(items=episodeShots()){
  /** 过滤词仅在当前集作用。 */
  const view=shotView();
  const query=view.query.trim().toLocaleLowerCase();
  const visible=items.filter(item=>(!view.status||shotStatus(item)===view.status)&&(!query||`${item.title} ${item.scene} ${item.dialogue}`.toLocaleLowerCase().includes(query)));
  return `<span class="asset-sr-status" role="status">显示 ${visible.length} / ${items.length} 项</span>${visible.length?`<div class="shot-list">${visible.map(item=>renderShotRow(item,items.indexOf(item))).join('')}</div>`:`<div class="asset-list-empty">${icon('film')}<strong>${items.length?'没有匹配的画面':'这一集还没有镜头'}</strong><p>${items.length?'试试其他名称或制作状态':'从右上角新增第一项，填写描述后引用给 Agent 制作。'}</p>${items.length?'<button class="button" data-action="clear-shot-filters">清除筛选</button>':''}</div>`}`;
}
/** 只更新分镜内容区；列表操作不重绘旁边会话。 */
function renderShotWorkspace(){document.querySelector('.visual-module-body').innerHTML=renderShotsStep();refreshStoryboard();}
/** 打开镜头 id；fromAsset 表示保留资产详情的返回来源。 */
function openShot(id,fromAsset=false){
  /** 用真实集归属定位镜头，禁止回退到其他集的首个镜头。 */
  const episode=episodesFor(project()).find(item=>item.shotIds.includes(id));
  if(!episode)return;
  if(state.productionStep==='shots'&&!shotView().detailId)shotView().scrollTop=document.querySelector('.visual-module-body').scrollTop;
  if(shotView().episodeId!==episode.id){shotView().query='';shotView().status='';shotView().scrollTop=0;}
  shotView().episodeId=episode.id;shotView().detailId=id;
  state.shotId=id;state.productionStep='shots';state.editing=false;
  if(!fromAsset)assetView().returnShotId=null;
  if(project().kind!=='图片')seekStoryboardShot(id);
  render();
  document.querySelector('.visual-module-body').scrollTop=0;
  document.querySelector(project().kind==='图片'?'.shot-back':'.episode-screen')?.focus({preventScroll:true});
}
/** 返回概览，恢复当前集筛选、滚动和原卡片焦点。 */
function backToShots(){
  /** 用稳定镜头 ID 恢复焦点，不依赖过滤后的序号。 */
  const id=shotView().detailId;
  shotView().detailId=null;state.editing=false;assetView().returnShotId=null;
  renderShotWorkspace();
  document.querySelector('.visual-module-body').scrollTop=shotView().scrollTop;
  Array.from(document.querySelectorAll('.shot-row')).find(node=>node.dataset.id===id)?.focus({preventScroll:true});
}
/** 切换集数只切换浏览范围，保留已绑定镜头的 Agent 任务。 */
function selectEpisode(id){
  pauseStoryboard(false);
  if(!episodesFor(project()).some(item=>item.id===id))return;
  Object.assign(shotView(),{episodeId:id,detailId:null,query:'',status:'',scrollTop:0});
  state.productionStep='shots';state.editing=false;assetView().returnShotId=null;
  render();document.querySelector('#shot-episode')?.focus({preventScroll:true});
}
/** 新镜头只创建空白条目，不复制上一镜头图片冒充结果。 */
function addShot(){
  /** 当前集承接新条目，图片项目不带视频时长。 */
  const current=project();
  const item={id:`shot-${crypto.randomUUID()}`,title:`${current.kind==='图片'?'图片':'镜头'} ${episodeShots().length+1}`,duration:current.kind==='图片'?0:3,scene:'',motion:'',dialogue:'',image:'',status:'review',version:0,assetIds:[],takes:[]};
  current.shots.push(item);currentEpisode().shotIds.push(item.id);
  shotDrafts.set(`${current.id}/${item.id}`,shotEditValues(item));
  openShot(item.id);
  editShot();
  document.querySelector('#shot-edit-form [name="title"]')?.focus();
}
/** 返回当前项目的影像侧栏 HTML；使用宿主通用的覆盖式侧栏结构。 */
function renderProjectMenu(){
  return `<div class="project-directory-layer">
    <button class="project-directory-backdrop" data-action="close-project-menu" aria-label="关闭影像项目列表" tabindex="-1"></button>
    <aside class="project-directory" id="visual-project-directory" aria-label="影像项目列表">
      <header><strong>影像项目 <small>${projects.length}</small></strong><button class="icon-button" data-action="close-project-menu" title="收起影像项目列表" aria-label="收起影像项目列表">${icon('sidebarClose')}</button></header>
      <label class="project-directory-search">${icon('search')}<input id="project-search" type="search" aria-label="搜索影像项目" placeholder="搜索影像项目" value="${esc(state.projectSearch)}" autocomplete="off"></label>
      <nav class="project-directory-list" aria-label="当前 Agent 项目的影像项目">${renderProjectList()}</nav>
    </aside>
  </div>`;
}
/** 按名称或类型过滤影像项目，返回行列表或搜索无结果状态。 */
function renderProjectList(){
  /** 搜索仅作用于当前 Agent 项目中的影像项目。 */
  const query=state.projectSearch.trim().toLocaleLowerCase();
  /** 保持示例原有顺序，避免搜索时列表跳动。 */
  const matching=projects.filter(item=>`${item.title} ${item.kind}`.toLocaleLowerCase().includes(query));
  return matching.length?matching.map(item=>`<button class="project-directory-item ${item.id===state.projectId?'active':''}" data-action="project" data-id="${esc(item.id)}" ${item.id===state.projectId?'aria-current="page"':''} title="${esc(item.title)}"><img src="${esc(item.shots[0]?.image||'')}" alt=""><span><strong>${esc(item.title)}</strong><small>${esc(item.kind)} · ${item.shots.length}${item.kind==='图片'?'张图片':'个镜头'}</small></span></button>`).join(''):'<p class="project-directory-empty" role="status">没有匹配的影像项目</p>';
}
/** 根据 open 打开或收起侧栏；不重绘工作区，保留内容滚动和 Agent 输入，关闭后恢复入口焦点。 */
function setProjectMenuOpen(open){
  state.projectMenu=open;
  state.projectSearch='';
  document.querySelector('.project-directory-layer')?.remove();
  document.querySelector('[data-action="toggle-project-menu"]')?.setAttribute('aria-expanded',String(open));
  if(open){
    document.querySelector('.visual-module')?.insertAdjacentHTML('beforeend',renderProjectMenu());
    document.getElementById('project-search')?.focus();
  }else{
    document.querySelector('[data-action="toggle-project-menu"]')?.focus();
  }
}
/** 概览卡片只放识别和进度信息，整个卡片为唯一详情入口。 */
function renderShotRow(item,index){return `<button class="shot-row" data-action="shot" data-id="${esc(item.id)}" aria-label="查看${project().kind==='图片'?'图片':'镜头'} ${String(index+1).padStart(2,'0')}：${esc(item.title)}"><span class="shot-card-preview">${item.image?`<img class="shot-thumb" src="${esc(item.image)}" alt="">`:`<span class="asset-preview-empty">${icon('film')}<small>待制作画面</small></span>`}<span class="shot-number">${String(index+1).padStart(2,'0')}</span>${item.duration?`<span class="shot-duration">${item.duration}s</span>`:''}</span><span class="shot-row-copy"><strong>${esc(item.title)}</strong><span class="shot-card-meta"><span class="row-state ${shotStatus(item)==='adopted'?'ready':'review'}">${shotStatusLabel(item)}</span><small>${item.version?`v${item.version}`:'未制作'}</small></span></span></button>`;}
/** 详情优先显示当前画面；候选保持独立，未经采用不替换预览。 */
function renderDetail(selected,index){
  /** 当前集顺序用于连续浏览；候选和资产只读取明确的绑定。 */
  const items=episodeShots();
  const candidate=state.candidate?.projectId===state.projectId&&state.candidate.shotId===selected.id?state.candidate:null;
  const isImage=project().kind==='图片';
  return `<section class="shot-detail-view" aria-label="${isImage?'图片':'镜头'}详情">
    <div class="shot-detail-navigation"><button class="asset-back shot-back" data-action="back-to-shots">${icon('arrow')}返回${isImage?'图片概览':'分镜'}</button><div><button class="icon-button shot-previous" data-action="shot" data-id="${esc(items[index-2]?.id||'')}" ${index===1?'disabled':''} aria-label="上一${isImage?'张':'镜头'}">${icon('arrow')}</button><span>${index} / ${items.length}</span><button class="icon-button" data-action="shot" data-id="${esc(items[index]?.id||'')}" ${index===items.length?'disabled':''} aria-label="下一${isImage?'张':'镜头'}">${icon('arrow')}</button></div></div>
    ${assetView().returnShotId===selected.id&&assetView().selectedId?`<button class="asset-shot-return" data-action="return-asset-detail">${icon('arrow')}返回资产详情</button>`:''}
    <article class="detail-card"><div class="detail-image">${selected.image?`<img src="${esc(selected.image)}" alt="${esc(selected.scene)}">`:`<div class="asset-preview-empty">${icon('film')}<span>待制作画面</span></div>`}<span class="image-label">${selected.image?'当前画面 · 离线示例':'尚无画面'} · ${esc(project().ratio)}</span></div><div class="detail-content">
      <div class="detail-heading"><div><small>${esc(currentEpisode().title)} · ${isImage?'图片':'镜头'} ${String(index).padStart(2,'0')}${selected.duration?` · ${selected.duration} 秒`:''}${selected.version?` · v${selected.version}`:''}</small><h3>${esc(selected.title)}</h3></div><span class="row-state ${shotStatus(selected)==='adopted'?'ready':'review'}">${shotStatusLabel(selected)}</span></div>
      ${candidate?renderCandidate(candidate):''}
      ${renderShotInfo(selected)}
      <div class="detail-actions"><button class="button" data-action="edit-shot">${icon('edit')}${isImage?'图片设置':'镜头设置'}</button><button class="button ${candidate?'':'primary'}" data-action="reference">${icon('link')}引用给 Agent</button></div>
    </div></article>
  </section>`;
}
/** 返回镜头脚本及关联资产，供图片详情和视频播放器共用。 */
function renderShotInfo(selected){
  /** 仅展示当前镜头明确引用的资产，图片使用构图与文案标签。 */
  const assets=project().assets.filter(asset=>(selected.assetIds||[]).includes(asset.id));
  const isImage=project().kind==='图片';
  return `<section class="shot-script"><div><h4>画面描述</h4><p>${esc(selected.scene||'待填写画面描述')}</p></div><div><h4>${isImage?'构图':'运镜'}</h4><p>${esc(selected.motion||'暂未设置')}</p></div><div><h4>${isImage?'画面文案':'台词 / 旁白'}</h4><p>${esc(selected.dialogue||'无')}</p></div></section>
      <details class="shot-linked-assets"><summary>关联资产 <small>${assets.length}</small>${icon('chevron')}</summary><div>${assets.length?assets.map(asset=>`<span>${icon(asset.locked?'lock':'layers')}${esc(asset.name)}<small>v${asset.version}</small></span>`).join(''):'<p>尚未关联资产，可引用镜头后让 Agent 补充制作要求。</p>'}</div></details>`;
}
/** 渲染候选确认区，采用前不覆盖正式镜头。 */
function renderCandidate(candidate){return `<div class="candidate-box"><div class="candidate-head"><strong>新候选 · 待确认</strong><small>来自主 Agent · v${candidate.version}</small></div><div class="candidate-image"><img src="${esc(candidate.image)}" alt="Agent 候选画面"><div class="candidate-copy"><strong>${esc(candidate.label)}</strong>采用后更新当前画面。</div></div><div class="candidate-actions"><button class="button primary" data-action="adopt">采用候选</button><button class="button" data-action="discard">保留原版</button></div></div>`;}
/** 提取镜头可编辑字段，返回独立草稿；不复制画面与候选状态。 */
function shotEditValues(item){return {title:item.title,duration:item.duration,scene:item.scene,motion:item.motion||'',dialogue:item.dialogue||''};}
/** 打开当前镜头设置弹窗，保留独立镜头草稿。 */
function editShot(){openShotSettings();}
/** 更新引用芯片，使主 Agent 明确当前对象。 */
function renderContext(){const node=document.getElementById('context-copy');node.textContent=state.reference?(state.reference.type==='asset'?`已引用资产：${state.reference.title} · ${state.reference.projectTitle}`:`已引用镜头：${state.reference.title} · ${state.reference.projectTitle}`):'未引用右侧对象';document.querySelector('.chip-close').hidden=!state.reference;}
/** 根据当前状态重绘主题、会话和右侧模块。 */
function render(){if(!storyboardVisible())pauseStoryboard(false);document.documentElement.dataset.theme=state.theme;document.getElementById('app-shell').classList.toggle('focus-mode',state.focus);document.getElementById('workspace-shell').classList.toggle('open',state.workspaceOpen);document.querySelectorAll('[data-workspace-tab]').forEach(node=>node.classList.toggle('active',node.dataset.workspaceTab===state.workspaceTab));renderMessages();renderWorkspace();renderContext();hydrate();refreshStoryboard();refreshShotSettings();refreshProjectSettingsDialog();}
/** 使用当前镜头建立显式引用，并在窄屏或专注模式中显示主 Agent。 */
function referenceCurrent(){
  pauseStoryboard();
  /** 引用包含生成所需身份与版本，后续选择其他镜头不改变它。 */
  const selected=shot();
  if(!selected.scene.trim()){toast('请先填写并保存画面描述');return;}
  state.reference={type:'shot',projectId:state.projectId,episodeId:currentEpisode().id,shotId:selected.id,version:selected.version,title:selected.title,projectTitle:project().title};
  state.focus=false;if(window.matchMedia('(max-width:760px)').matches)state.workspaceOpen=false;
  toast('已引用当前镜头');render();document.getElementById('prompt').focus();
}
/** 发送演示任务；返回结果绑定引用镜头，浏览操作不改变结果归属。 */
function submitTask(prompt){
  if(state.reference?.type==='asset')return submitAssetRequest(prompt);
  /** 必须显式引用有效镜头，避免概览或空集数中误改旧选择。 */
  const reference=state.reference;
  const selected=project().shots.find(item=>item.id===reference?.shotId);
  if(reference?.type!=='shot'||reference.projectId!==state.projectId||!selected||selected.version!==reference.version){toast('请先在镜头详情中引用给 Agent');return false;}
  if(state.task?.running||state.candidate){toast('请先完成当前任务或确认已有候选');return false;}
  /** 请求快照独立于当前浏览选择，版本改变或取消都会阻断迟到结果。 */
  const boundProject=project();
  const baselineVersion=selected.version;
  const requestId=++taskSequence;
  state.task={prompt,running:true,shotId:selected.id,projectId:boundProject.id,requestId};render();
  window.setTimeout(()=>{
    if(!state.task||state.task.requestId!==requestId||selected.version!==baselineVersion)return;
    /** 新条目使用明确的离线演示素材，不提前写入当前画面。 */
    const source=selected.takes?.[0]?.image||selected.image||boundProject.shots.find(item=>item.image)?.image||'';
    state.task.running=false;
    state.candidate={shotId:selected.id,projectId:boundProject.id,label:'Agent 候选（演示）',baselineVersion,version:baselineVersion+1,image:source};
    renderTaskUpdate();toast('候选已返回，请打开对应镜头确认');
  },850);
  return true;
}
/** 异步回流只刷新展示，不抢走正在搜索或编辑的输入焦点和滚动。 */
function renderTaskUpdate(){
  /** 保存当前输入身份及选择区，使用已有 DOM 的安全标识恢复。 */
  const active=document.activeElement;
  const selector=active?.id?`#${CSS.escape(active.id)}`:active?.form?.id&&active.name?`#${CSS.escape(active.form.id)} [name="${CSS.escape(active.name)}"]`:null;
  const start=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement?active.selectionStart:null;
  const end=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement?active.selectionEnd:null;
  const scrollTop=document.querySelector('.visual-module-body')?.scrollTop||0;
  render();
  const restored=selector?document.querySelector(selector):null;
  restored?.focus({preventScroll:true});
  if(start!==null&&restored?.setSelectionRange)restored.setSelectionRange(start,end);
  const body=document.querySelector('.visual-module-body');
  if(body)body.scrollTop=scrollTop;
}
/** 采用前核对项目、镜头和基线版本，避免候选覆盖已修改的设定。 */
function adoptCandidate(){
  /** 只有当前详情对应的有效候选可以被采用。 */
  const selected=shot();
  const candidate=state.candidate;
  if(!candidate||candidate.projectId!==state.projectId||candidate.shotId!==selected.id||candidate.baselineVersion!==selected.version)return;
  if(shotDraftDirty()){toast('请先保存或重置镜头设置');return;}
  selected.status='adopted';selected.needsUpdate=false;selected.version=candidate.version;selected.adoptedVersion=candidate.version;selected.image=candidate.image;
  selected.takes=[{id:`v${selected.version}`,label:'Agent 候选',image:selected.image}];
  state.candidate=null;state.task=null;toast('候选已采用');render();
}
/** 保存当前表单；真实内容变化才更新基线，保存本身不发起生成。 */
function saveEdit(form){
  /** 显式核对表单身份，草稿不允许跨项目或跨镜头提交。 */
  const selected=shot();
  if(form.dataset.projectId!==state.projectId||form.dataset.shotId!==selected.id)return;
  if(Number(form.dataset.version)!==selected.version){document.getElementById('shot-settings-feedback').textContent='镜头版本已变化，请先重置并核对设置';return;}
  const next={...shotDrafts.get(`${state.projectId}/${selected.id}`)};
  ['title','scene','motion','dialogue'].forEach(field=>{next[field]=(next[field]||'').trim();});
  next.duration=project().kind==='图片'?0:Number(next.duration);
  ['title','scene'].forEach(field=>form.elements.namedItem(field).setCustomValidity(next[field]?'':'请填写此项'));
  if(!form.reportValidity())return;
  /** 仅实际变化才推进设定版本，避免无变化保存把已采用镜头标记待更新。 */
  const changed=Object.keys(next).some(field=>next[field]!==selected[field]);
  if(changed){
    if(selected.adoptedVersion===undefined)selected.adoptedVersion=selected.status==='adopted'?selected.version:null;
    Object.assign(selected,next);selected.version+=1;selected.needsUpdate=true;selected.status='review';
    if(state.candidate?.shotId===selected.id)state.candidate=null;
    if(state.task?.shotId===selected.id)state.task=null;
    if(state.reference?.type==='shot'&&state.reference.shotId===selected.id)state.reference=null;
  }
  shotDrafts.set(`${state.projectId}/${selected.id}`,shotEditValues(selected));
  form.dataset.version=selected.version;
  Object.keys(next).forEach(field=>{if(form.elements.namedItem(field))form.elements.namedItem(field).value=next[field];});
  if(project().kind!=='图片')seekStoryboardShot(selected.id);
  state.editing=true;
  render();
  document.getElementById('shot-settings-feedback').textContent=changed?'已保存，画面待重新生成':'已保存，设置未变化';
  document.querySelector('[data-action="reset-shot-settings"]').hidden=true;
  document.getElementById('shot-settings-save').focus({preventScroll:true});
}
/** 打开规划说明弹窗。 */
function openPlanning(){const dialog=document.getElementById('planning-modal');if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}
/** 处理页面内所有按钮和表单事件。 */
document.addEventListener('click',event=>{const target=event.target instanceof Element?event.target.closest('[data-action],[data-workspace-tab],[data-phase],[data-suggestion],[data-production-step]'):null;if(!target)return;const action=target.dataset.action;const tab=target.dataset.workspaceTab;if(tab){state.projectMenu=false;state.projectSearch='';state.workspaceTab=tab;if(tab==='chat')state.workspaceOpen=false;else state.workspaceOpen=true;render();return;}if(target.dataset.phase){state.phase=target.dataset.phase;render();return;}if(target.dataset.suggestion){document.getElementById('prompt').value=target.dataset.suggestion;document.getElementById('prompt').focus();return;}if(action==='theme'){state.theme=state.theme==='light'?'dark':'light';render();return;}if(action==='planning'){openPlanning();return;}if(action==='close-modal'){document.getElementById('planning-modal').close();return;}if(action==='focus'||action==='module-focus'){state.focus=!state.focus;state.workspaceOpen=true;render();return;}if(action==='close-workspace'){state.projectMenu=false;state.projectSearch='';state.workspaceOpen=false;state.focus=false;render();return;}if(target.dataset.productionStep){state.productionStep=target.dataset.productionStep;if(state.productionStep==='shots'&&shotView().detailId){state.shotId=shotView().detailId;state.editing=false;}render();return;}if(action==='go-step'||action==='open-step'){state.productionStep=target.dataset.step||'project';render();return;}if(action==='reset-settings'){resetProjectSettings();return;}if(action==='toggle-project-menu'){setProjectMenuOpen(!state.projectMenu);return;}if(action==='close-project-menu'){setProjectMenuOpen(false);return;}if(action==='project'){if(target.dataset.id===state.projectId){setProjectMenuOpen(false);return;}state.projectId=target.dataset.id||state.projectId;state.shotId=project().shots[0]?.id||'';state.productionStep='project';state.editing=false;state.projectMenu=false;state.projectSearch='';state.reference=null;state.candidate=null;state.task=null;render();document.querySelector('[data-action="toggle-project-menu"]')?.focus();return;}if(action==='shot'){openShot(target.dataset.id);return;}if(action==='open-shot-result'){state.workspaceTab='visual';state.workspaceOpen=true;openShot(target.dataset.id);return;}if(action==='back-to-shots'){backToShots();return;}if(action==='select-episode'){selectEpisode(target.dataset.id);return;}if(action==='filter-shots'){shotView().status=target.dataset.status;renderShotWorkspace();document.querySelector('.shot-status-filters [aria-pressed="true"]')?.focus({preventScroll:true});return;}if(action==='clear-shot-filters'){shotView().query='';shotView().status='';renderShotWorkspace();document.getElementById('shot-search').focus();return;}if(action==='reference'){referenceCurrent();return;}if(action==='open-asset'){openAsset(target.dataset.id);return;}if(action==='back-to-assets'){backToAssets();return;}if(action==='clear-asset-filters'){clearAssetFilters();return;}if(action==='asset-shot'){openAssetShot(target.dataset.id);return;}if(action==='return-asset-detail'){state.productionStep='assets';assetView().returnShotId=null;render();document.querySelector('.asset-back')?.focus({preventScroll:true});return;}if(action==='filter-assets'){filterAssets(target.dataset.assetType||'');return;}if(action==='asset-reference'){const asset=project().assets.find(item=>item.id===target.dataset.id);if(asset)referenceAsset(asset);return;}if(action==='toggle-asset-lock'){toggleAssetLock(target.dataset.id);return;}if(action==='add-episode'){const current=project();const episodes=episodesFor(current);episodes.push({id:`${current.id}-episode-${episodes.length+1}`,title:`第 ${episodes.length+1} 集`,subtitle:'新建叙事单元 · 待整理',shotIds:[],status:'未开始'});toast('已建立新集数');render();return;}if(action==='add-asset'){openAssetCreate();return;}if(action==='close-asset-create'){document.getElementById('asset-create-dialog').close();return;}if(action==='add-shot'){addShot();return;}if(action==='clear-reference'){state.reference=null;render();return;}if(action==='cancel-task'){state.task=null;state.candidate=null;toast('已取消生成，迟到结果会被丢弃');render();return;}if(action==='edit-shot'){editShot();return;}if(action==='close-shot-settings'){document.getElementById('shot-settings-dialog').close();return;}if(action==='reset-shot-settings'){resetShotSettings();return;}if(action==='adopt'){adoptCandidate();return;}if(action==='discard'){state.candidate=null;state.task=null;toast('保留正式版本');render();return;}if(action==='phase-note'){toast('这里保留原影像模块的阶段入口，后续接入真实生产能力');return;}if(action==='switch-module'){toast('这是宿主中的独立工作区标签');return;}});
/** 表单提交把任务交给主 Agent，空输入时保持页面状态。 */
document.getElementById('composer').addEventListener('submit',event=>{event.preventDefault();const input=document.getElementById('prompt');const prompt=input.value.trim();if(!prompt){toast('先告诉主 Agent 要修改什么');input.focus();return;}if(submitTask(prompt)!==false)input.value='';});
/** 搜索只替换分镜结果，保留输入焦点和光标。 */
document.addEventListener('input',event=>{
  if(!(event.target instanceof HTMLInputElement)||event.target.id!=='shot-search')return;
  shotView().query=event.target.value;
  document.querySelector('.shot-results').innerHTML=renderShotResults();
});
/** 原生集数菜单支持键盘选择，切换后只展示该集镜头。 */
document.addEventListener('change',event=>{if(event.target instanceof HTMLSelectElement&&event.target.id==='shot-episode')selectEpisode(event.target.value);});
/** 输入立即保留草稿，但直到显式保存才改变镜头设定。 */
document.addEventListener('input',event=>{
  /** 只读取当前镜头表单允许的字段。 */
  const input=event.target;
  if(!(input instanceof HTMLInputElement||input instanceof HTMLTextAreaElement)||input.form?.id!=='shot-edit-form'||!['title','duration','scene','motion','dialogue'].includes(input.name))return;
  const key=`${input.form.dataset.projectId}/${input.form.dataset.shotId}`;
  if(shotDrafts.has(key))shotDrafts.get(key)[input.name]=input.value;
  input.setCustomValidity('');
  syncShotSettingsFeedback();
});
/** 镜头设定表单不会把保存动作发送为 Agent 消息。 */
document.addEventListener('submit',event=>{if(event.target instanceof HTMLFormElement&&event.target.id==='shot-edit-form'){event.preventDefault();saveEdit(event.target);}});
/** 资产搜索只替换结果网格，输入焦点和已输入文字保持稳定。 */
document.addEventListener('input',event=>{
  if(!(event.target instanceof HTMLInputElement)||event.target.id!=='asset-search')return;
  assetView().query=event.target.value;
  document.querySelector('.asset-results').innerHTML=renderAssetResults(project(),assetCatalog(project()));
});
/** 新增资产仅提交设定表单；输入时清除此前的空白校验。 */
document.getElementById('asset-create-form').addEventListener('submit',event=>{event.preventDefault();createAsset(event.currentTarget);});
document.getElementById('asset-create-form').addEventListener('input',event=>{if(event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement)event.target.setCustomValidity('');});
/** 关闭新增对话框后恢复新增入口焦点；点击遮罩同样可关闭。 */
document.getElementById('asset-create-dialog').addEventListener('close',()=>document.querySelector('[data-action="add-asset"]')?.focus({preventScroll:true}));
document.getElementById('asset-create-dialog').addEventListener('click',event=>{if(event.target===event.currentTarget)event.currentTarget.close();});
/** 创作设定独立提交，不把保存动作作为消息发给 Agent。 */
document.addEventListener('submit',event=>{
  if(!(event.target instanceof HTMLFormElement)||event.target.id!=='creative-settings-form')return;
  event.preventDefault();
  saveProjectSettings(event.target);
});
/** 按项目保存内存草稿并更新反馈，输入时不重绘页面。 */
document.addEventListener('input',event=>{
  /** 只接收创作表单中已声明的文本和下拉控件。 */
  const input=event.target;
  if(!(input instanceof HTMLInputElement||input instanceof HTMLTextAreaElement||input instanceof HTMLSelectElement)||input.form?.id!=='creative-settings-form'||!SETTINGS_FIELDS.includes(input.name))return;
  if(input.form.dataset.projectId!==state.projectId)return;
  settingsDraft(project())[input.name]=input.name==='fps'?Number(input.value):input.value;
  input.setCustomValidity('');
  /** 草稿变化反馈与重置入口保持一致，不提前修改已保存标题。 */
  syncProjectSettingsFeedback();
});
/** 只更新搜索结果，避免整页重绘导致输入失焦或工作区滚动归零。 */
document.addEventListener('input',event=>{
  if(!(event.target instanceof HTMLInputElement)||event.target.id!=='project-search')return;
  state.projectSearch=event.target.value;
  document.querySelector('.project-directory-list').innerHTML=renderProjectList();
});
/** Escape 优先关闭影像列表；原生规划弹窗打开时由弹窗自行处理。 */
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.key!=='Escape'||!state.projectMenu||document.querySelector('dialog[open]'))return;
  event.preventDefault();
  setProjectMenuOpen(false);
});
/** 关闭弹窗时恢复原生 dialog 的可访问状态。 */
document.getElementById('planning-modal').addEventListener('click',event=>{if(event.target===event.currentTarget)event.currentTarget.close();});
restoreProjectSettings();
restoreAssets();
render();
