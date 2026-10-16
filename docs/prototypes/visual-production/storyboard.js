/* 分镜顺序预演：当前只使用离线静帧，按镜头设定时长播放，不生成真实视频。 */
'use strict';

/** 唯一播放器的临时状态；暂停后不保留动画帧任务。 */
const storyboardPlayback={key:'',items:[],starts:[],total:0,time:0,playing:false,frame:0,lastStamp:0,lastPaint:0};

/** 返回当前集的播放时间线，明确保留缺图镜头，不把它们静默跳过。 */
function storyboardTimeline(){
  /** 起点数组与镜头顺序一一对应，后续拖动进度用同一份时间线定位。 */
  const items=episodeShots();
  const starts=[];
  let total=0;
  items.forEach(item=>{starts.push(total);total+=Number.isFinite(item.duration)&&item.duration>0?item.duration:3;});
  return {items,starts,total};
}

/** 将秒数转换为分钟和秒，用于播放器可见进度及无障碍描述。 */
function storyboardTime(seconds){return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;}

/** 根据当前总进度返回集内镜头下标；结尾固定停留在最后一个镜头。 */
function storyboardIndex(){
  /** 从末尾查找起点，边界时刻直接进入下一镜头。 */
  for(let index=storyboardPlayback.starts.length-1;index>=0;index--)if(storyboardPlayback.time>=storyboardPlayback.starts[index])return index;
  return 0;
}

/** 重新读取当前集；只有切换项目或集数才重置播放位置。 */
function prepareStoryboard(){
  /** 项目和集数共同限定播放器归属。 */
  const key=`${state.projectId}/${currentEpisode().id}`;
  const timeline=storyboardTimeline();
  if(storyboardPlayback.key!==key){
    pauseStoryboard(false);
    storyboardPlayback.key=key;
    storyboardPlayback.time=timeline.starts[Math.max(0,timeline.items.findIndex(item=>item.id===shotView().detailId))]||0;
  }
  Object.assign(storyboardPlayback,timeline);
  storyboardPlayback.time=Math.min(storyboardPlayback.time,timeline.total);
  if(!timeline.items.length)pauseStoryboard(false);
  /** 当前播放镜头与编辑目标同步，但不会改变已经发出的 Agent 引用。 */
  const selected=timeline.items[storyboardIndex()];
  if(selected){state.shotId=selected.id;shotView().detailId=selected.id;}
}

/** 渲染集数、横向分镜条、大播放器和当前镜头辅助区。 */
function renderStoryboard(){
  prepareStoryboard();
  /** 页面只呈现一个大画面，所有缩略图沿集内顺序横向排列。 */
  const items=storyboardPlayback.items;
  const selected=items[storyboardIndex()];
  return `<section class="storyboard-workspace" aria-label="分镜播放器">
    <header class="shot-library-heading"><label class="episode-picker"><span>当前集数</span><select id="shot-episode" aria-label="切换集数">${episodesFor(project()).map(episode=>`<option value="${esc(episode.id)}" ${episode.id===currentEpisode().id?'selected':''}>${esc(episode.title)}</option>`).join('')}</select></label><button class="button" data-action="add-shot">${icon('plus')}新增镜头</button></header>
    <div class="storyboard-strip-heading"><span>${items.length} 个镜头 · ${storyboardTime(storyboardPlayback.total)}</span><div><button class="icon-button" data-storyboard-action="scroll-back" aria-label="向前浏览分镜">${icon('arrow')}</button><button class="icon-button" data-storyboard-action="scroll-forward" aria-label="向后浏览分镜">${icon('arrow')}</button></div></div>
    ${selected?`<div class="storyboard-strip" role="group" aria-label="按播放顺序排列的分镜">${items.map((item,index)=>`<button class="storyboard-shot" data-storyboard-action="select" data-id="${esc(item.id)}" aria-label="镜头 ${String(index+1).padStart(2,'0')}：${esc(item.title)}" aria-current="${selected.id===item.id?'true':'false'}"><span class="storyboard-thumbnail">${item.image?`<img src="${esc(item.image)}" alt="">`:`<span class="storyboard-missing">${icon('film')}待制作</span>`}<span class="shot-number">${String(index+1).padStart(2,'0')}</span><span class="shot-duration">${item.duration||3}s</span></span><span class="storyboard-shot-name">${esc(item.title)}</span></button>`).join('')}</div>`:'<div class="storyboard-empty-strip">这一集还没有镜头，新增后即可预演。</div>'}
    <div class="episode-player">
      <button class="episode-screen" data-storyboard-action="toggle" aria-label="播放分镜" ${selected?'':'disabled'}>
        <img class="episode-frame" src="${esc(selected?.image||'')}" alt="${esc(selected?.scene||'')}" ${selected?.image?'':'hidden'}>
        <span class="episode-placeholder" ${selected?.image?'hidden':''}>${icon('film')}<span>${selected?'此镜头画面待制作':'添加镜头后开始预演'}</span></span>
        <span class="episode-mode">静帧预演</span><span class="episode-frame-number">${selected?`${String(storyboardIndex()+1).padStart(2,'0')} / ${items.length}`:''}</span>
        <span class="episode-play-overlay">${icon('play')}</span>
        <span class="episode-caption">${esc(selected?.dialogue||'')}</span>
      </button>
      <div class="episode-controls"><button class="icon-button episode-toggle" data-storyboard-action="toggle" aria-label="播放分镜" ${selected?'':'disabled'}>${icon('play')}</button><span class="episode-time">${storyboardTime(storyboardPlayback.time)} / ${storyboardTime(storyboardPlayback.total)}</span><div class="episode-controls-spacer"></div><button class="icon-button" data-storyboard-action="previous" aria-label="上一镜头" ${selected?'':'disabled'}>${icon('previous')}</button><button class="icon-button" data-storyboard-action="next" aria-label="下一镜头" ${selected?'':'disabled'}>${icon('next')}</button></div>
      <input class="episode-seek" type="range" aria-label="整集播放进度" min="0" max="${storyboardPlayback.total||1}" step="0.01" value="${storyboardPlayback.time}" ${selected?'':'disabled'}>
    </div>
    <div class="storyboard-current">${selected?renderStoryboardCurrent(selected):''}</div>
  </section>`;
}

/** 渲染当前镜头的辅助信息；脚本折叠，编辑和候选无需离开播放器。 */
function renderStoryboardCurrent(selected){
  /** 候选必须匹配当前镜头，未经采用不进入整集预演。 */
  const candidate=state.candidate?.projectId===state.projectId&&state.candidate.shotId===selected.id?state.candidate:null;
  return `${assetView().returnShotId===selected.id&&assetView().selectedId?`<button class="asset-shot-return" data-action="return-asset-detail">${icon('arrow')}返回资产详情</button>`:''}
    <div class="storyboard-current-heading detail-heading"><div><h3>${esc(selected.title)}</h3><small>镜头 ${String(storyboardIndex()+1).padStart(2,'0')} · ${selected.duration||3} 秒${selected.version?` · v${selected.version}`:''}</small></div><span class="row-state ${shotStatus(selected)==='adopted'?'ready':'review'}">${shotStatusLabel(selected)}</span></div>
    <div class="storyboard-current-actions"><button class="button" data-action="edit-shot">${icon('edit')}镜头设置</button><button class="button" data-action="reference">${icon('link')}引用给 Agent</button></div>
    ${candidate?renderCandidate(candidate):''}
`;
}

/** 让当前分镜保持在横向可视区域内，只修改横向滚动。 */
function revealStoryboardShot(){
  /** 使用相对容器几何，避免 scrollIntoView 拉动整页或播放器。 */
  const strip=document.querySelector('.storyboard-strip');
  const active=strip?.querySelector('[aria-current="true"]');
  if(!strip||!active)return;
  const area=strip.getBoundingClientRect();
  const card=active.getBoundingClientRect();
  if(card.left<area.left)strip.scrollLeft-=area.left-card.left;
  else if(card.right>area.right)strip.scrollLeft+=card.right-area.right;
}

/** 增量更新播放器，播放期间不重绘 Agent、输入表单或整个工作区。 */
function updateStoryboard(){
  /** 播放状态与当前镜头取自唯一时间线，不使用 DOM 反推业务身份。 */
  const screen=document.querySelector('.episode-screen');
  if(!screen)return;
  const selected=storyboardPlayback.items[storyboardIndex()];
  const ended=storyboardPlayback.total>0&&storyboardPlayback.time>=storyboardPlayback.total;
  const label=storyboardPlayback.playing?'暂停分镜':ended?'重新播放分镜':'播放分镜';
  screen.classList.toggle('is-playing',storyboardPlayback.playing);
  screen.setAttribute('aria-label',label);
  document.querySelector('.episode-toggle').setAttribute('aria-label',label);
  document.querySelector('.episode-toggle').innerHTML=icon(storyboardPlayback.playing?'pause':ended?'replay':'play');
  document.querySelector('.episode-play-overlay').innerHTML=icon(ended?'replay':storyboardPlayback.playing?'pause':'play');
  document.querySelector('.episode-time').textContent=`${storyboardTime(storyboardPlayback.time)} / ${storyboardTime(storyboardPlayback.total)}`;
  document.querySelector('.episode-seek').value=storyboardPlayback.time;
  document.querySelector('.episode-seek').setAttribute('aria-valuetext',`${storyboardTime(storyboardPlayback.time)}，共 ${storyboardTime(storyboardPlayback.total)}`);
  document.querySelector('[data-storyboard-action="previous"]').disabled=!selected||storyboardIndex()===0;
  document.querySelector('[data-storyboard-action="next"]').disabled=!selected||storyboardIndex()===storyboardPlayback.items.length-1;
  if(!selected)return;
  /** 仅在镜头或画面版本变化时更新内容；缺图也保持该镜头的时长与位置。 */
  const frame=document.querySelector('.episode-frame');
  if(screen.dataset.shotId!==selected.id||frame.getAttribute('src')!==(selected.image||'')){
    screen.dataset.shotId=selected.id;
    frame.setAttribute('src',selected.image||'');frame.alt=selected.scene;frame.hidden=!selected.image;
    document.querySelector('.episode-placeholder').hidden=!!selected.image;
    document.querySelector('.episode-placeholder>span').textContent='此镜头画面待制作';
    document.querySelector('.episode-frame-number').textContent=`${String(storyboardIndex()+1).padStart(2,'0')} / ${storyboardPlayback.items.length}`;
    document.querySelector('.episode-caption').textContent=selected.dialogue||'';
    document.querySelectorAll('.storyboard-shot').forEach(node=>node.setAttribute('aria-current',String(node.dataset.id===selected.id)));
    state.shotId=selected.id;shotView().detailId=selected.id;
    document.querySelector('.storyboard-current').innerHTML=renderStoryboardCurrent(selected);
    revealStoryboardShot();
  }
}

/** 停止动画帧；refresh 决定是否立即同步可见播放控件。 */
function pauseStoryboard(refresh=true){
  storyboardPlayback.playing=false;
  cancelAnimationFrame(storyboardPlayback.frame);storyboardPlayback.frame=0;
  if(refresh)updateStoryboard();
}

/** 判断播放器是否仍可见，切走页面、关闭模块或编辑时不后台播放。 */
function storyboardVisible(){return !document.hidden&&state.workspaceOpen&&state.workspaceTab==='visual'&&state.productionStep==='shots'&&project().kind!=='图片'&&!state.editing&&storyboardPlayback.key===`${state.projectId}/${currentEpisode().id}`;}

/** 播放时每帧累计真实经过时间，界面最多每 100ms 更新一次。 */
function tickStoryboard(stamp){
  if(!storyboardPlayback.playing||!storyboardVisible()){pauseStoryboard();return;}
  /** 跨镜头必须立即同步目标，避免编辑动作读到上一镜头的身份。 */
  const previousIndex=storyboardIndex();
  storyboardPlayback.time=Math.min(storyboardPlayback.total,storyboardPlayback.time+(stamp-storyboardPlayback.lastStamp)/1000);
  storyboardPlayback.lastStamp=stamp;
  if(storyboardPlayback.time>=storyboardPlayback.total){pauseStoryboard();return;}
  if(previousIndex!==storyboardIndex()||stamp-storyboardPlayback.lastPaint>=100){updateStoryboard();storyboardPlayback.lastPaint=stamp;}
  storyboardPlayback.frame=requestAnimationFrame(tickStoryboard);
}

/** 点击大画面或播放键切换播放状态，结尾再次点击从头重播。 */
function toggleStoryboard(){
  if(storyboardPlayback.playing){pauseStoryboard();return;}
  if(state.editing){toast('请先保存或取消镜头编辑，再继续预演');return;}
  if(!storyboardPlayback.items.length||!storyboardVisible())return;
  if(storyboardPlayback.time>=storyboardPlayback.total)storyboardPlayback.time=0;
  storyboardPlayback.playing=true;storyboardPlayback.lastStamp=performance.now();storyboardPlayback.lastPaint=0;
  updateStoryboard();storyboardPlayback.frame=requestAnimationFrame(tickStoryboard);
}

/** 手动定位到 id 镜头的起点；选择只暂停预演，不清除草稿或候选。 */
function seekStoryboardShot(id){
  pauseStoryboard(false);
  prepareStoryboard();
  /** 同集镜头共用起点，跨集调用必须先完成集数切换。 */
  const index=storyboardPlayback.items.findIndex(item=>item.id===id);
  if(index<0)return;
  storyboardPlayback.time=storyboardPlayback.starts[index];
  state.shotId=id;shotView().detailId=id;
  state.editing=false;
  updateStoryboard();
}

/** 外部重绘后恢复播放器控件及分镜可见位置，禁止重启已暂停的预演。 */
function refreshStoryboard(){
  if(!storyboardVisible())pauseStoryboard(false);
  if(document.querySelector('.episode-screen')){updateStoryboard();revealStoryboardShot();}
}

/** 播放器事件独立委托，避免复用会打开独立详情的图片卡片事件。 */
document.addEventListener('click',event=>{
  /** 仅处理播放器拥有的按钮。 */
  const target=event.target instanceof Element?event.target.closest('[data-storyboard-action]'):null;
  if(!target)return;
  const action=target.dataset.storyboardAction;
  if(action==='toggle'){toggleStoryboard();return;}
  if(action==='select'){seekStoryboardShot(target.dataset.id);return;}
  if(action==='previous'||action==='next'){
    const selected=storyboardPlayback.items[storyboardIndex()+(action==='next'?1:-1)];
    if(selected)seekStoryboardShot(selected.id);
    return;
  }
  const strip=document.querySelector('.storyboard-strip');
  if(strip)strip.scrollLeft+=(action==='scroll-forward'?1:-1)*strip.clientWidth*.8;
});

/** 拖动整集进度定位画面并暂停，避免鼠标或键盘操作与播放竞争。 */
document.addEventListener('input',event=>{
  if(!(event.target instanceof HTMLInputElement)||!event.target.matches('.episode-seek'))return;
  if(state.editing){event.target.value=storyboardPlayback.time;toast('请先保存或取消镜头编辑');return;}
  pauseStoryboard(false);storyboardPlayback.time=Number(event.target.value);updateStoryboard();
});

/** 页面切入后台立即释放动画帧，恢复可见后由用户主动继续播放。 */
document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseStoryboard();});
